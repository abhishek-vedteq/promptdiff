import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { FatalProviderError, PromptdiffError } from "../errors.js";
import { findExecutable, runProgram } from "../exec.js";
import type { GenerateRequest, GenerateResponse, Provider } from "./types.js";

/** Model id meaning "whatever the CLI is configured to use". */
export const DEFAULT_CLI_MODEL = "default";

const CALL_TIMEOUT_MS = 10 * 60 * 1000;
const SAFE_MODEL_ID = /^[\w.:/@-]+$/;

/** An empty scratch directory, so the CLI doesn't pick up CLAUDE.md / AGENTS.md or project files. */
let scratch: string | undefined;
function scratchDir(): string {
  scratch ??= mkdtempSync(path.join(os.tmpdir(), "promptdiff-cli-"));
  return scratch;
}

function checkModel(model: string): void {
  if (!SAFE_MODEL_ID.test(model)) {
    throw new PromptdiffError(`Invalid model id "${model}". Use letters, digits, and . : / @ - _ only.`);
  }
}

function requireBinary(name: string, installHint: string): string {
  const file = findExecutable(name);
  if (!file) {
    throw new FatalProviderError(`The \`${name}\` command isn't installed or isn't on your PATH.`, { hint: installHint });
  }
  return file;
}

function singleTurn(req: GenerateRequest, provider: string): string {
  if (req.messages.length !== 1) {
    throw new FatalProviderError(`The ${provider} provider only supports single-turn cases ("input"), not "messages".`);
  }
  return req.messages[0]!.content;
}

const LOGIN_PATTERN = /not logged in|please run .*login|\/login|authenticat|unauthori[sz]ed|invalid api key|401/i;

/** Error carrying an HTTP-like status, so the retry logic treats 429/5xx as transient. */
class CliCallError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

/**
 * Runs prompts through the user's installed Claude Code (`claude -p`), using whatever
 * account it's logged in with. promptdiff never reads Claude Code's credentials.
 *
 * Tools, MCP servers, settings, slash commands, and session history are all turned off,
 * and the prompt under test replaces Claude Code's system prompt.
 */
export class ClaudeCodeProvider implements Provider {
  readonly id = "claude-code";

  async generate(req: GenerateRequest): Promise<GenerateResponse> {
    const input = singleTurn(req, "claude-code");
    const bin = requireBinary("claude", "Install Claude Code (https://claude.com/claude-code), then run `claude` once to log in.");
    if (process.platform === "win32" && /\.(cmd|bat)$/i.test(bin)) {
      throw new FatalProviderError("This `claude` is an npm .cmd shim, which can't safely receive multi-line prompts on Windows.", {
        hint: "Install Claude Code with the native installer (https://claude.com/claude-code) so `claude.exe` is on your PATH.",
      });
    }
    if (process.platform === "win32" && req.system.length > 30_000) {
      throw new FatalProviderError("Prompts over 30,000 characters can't be passed to `claude` on Windows (command-line length limit).");
    }
    const args = [
      "-p",
      "--output-format", "json",
      "--system-prompt", req.system,
      "--tools", "",
      "--setting-sources", "",
      "--strict-mcp-config",
      "--no-session-persistence",
      "--disable-slash-commands",
    ];
    if (req.model !== DEFAULT_CLI_MODEL) {
      checkModel(req.model);
      args.push("--model", req.model);
    }
    const res = await runProgram(bin, args, { stdin: input, cwd: scratchDir(), timeoutMs: CALL_TIMEOUT_MS, signal: req.signal });
    return parseClaudeOutput(res.stdout, res.stderr);
  }
}

interface ClaudeResult {
  type?: string;
  is_error?: boolean;
  result?: string;
  api_error_status?: number | null;
  usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
}

export function parseClaudeOutput(stdout: string, stderr: string): GenerateResponse {
  let result: ClaudeResult | undefined;
  for (const line of stdout.trim().split("\n").reverse()) {
    try {
      const parsed = JSON.parse(line) as ClaudeResult;
      if (parsed && parsed.type === "result") {
        result = parsed;
        break;
      }
    } catch {
      // not JSON
    }
  }
  if (!result) {
    const detail = (stderr || stdout).trim().slice(0, 300);
    if (LOGIN_PATTERN.test(detail)) {
      throw new FatalProviderError("Claude Code isn't logged in.", { hint: "Run `claude` and log in, or `promptdiff login claude-code`." });
    }
    throw new CliCallError(`claude returned no result${detail ? `: ${detail}` : ""}`);
  }
  if (result.is_error) {
    const message = result.result ?? "unknown error";
    if (LOGIN_PATTERN.test(message) && !result.api_error_status) {
      throw new FatalProviderError(`Claude Code couldn't authenticate: ${message}`, { hint: "Run `claude` and log in, or `promptdiff login claude-code`." });
    }
    throw new CliCallError(`claude: ${message}`, result.api_error_status ?? undefined);
  }
  const u = result.usage ?? {};
  return {
    text: result.result ?? "",
    inputTokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
    outputTokens: u.output_tokens,
  };
}

/**
 * Runs prompts through the user's installed Codex CLI (`codex exec`), using whatever
 * account it's logged in with. promptdiff never reads Codex's credentials.
 *
 * The prompt under test replaces Codex's built-in instructions. Codex still adds its own
 * context (tool definitions, environment info), so token counts are higher than a raw API call.
 */
export class CodexProvider implements Provider {
  readonly id = "codex";

  async generate(req: GenerateRequest): Promise<GenerateResponse> {
    const input = singleTurn(req, "codex");
    const bin = requireBinary("codex", "Install the Codex CLI (`npm install -g @openai/codex`), then run `codex login`.");
    const dir = scratchDir();
    const file = path.join(dir, `instructions-${createHash("sha256").update(req.system).digest("hex").slice(0, 16)}.md`);
    writeFileSync(file, req.system);
    if (file.includes("'")) throw new PromptdiffError(`Temp directory path contains a quote, which Codex config can't express: ${file}`);
    const args = [
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--ephemeral",
      "--sandbox", "read-only",
      "-C", dir,
      // TOML literal string: no escaping needed for Windows backslashes.
      "-c", `model_instructions_file='${file}'`,
    ];
    if (req.model !== DEFAULT_CLI_MODEL) {
      checkModel(req.model);
      args.push("-m", req.model);
    }
    args.push("-");
    const res = await runProgram(bin, args, { stdin: input, cwd: dir, timeoutMs: CALL_TIMEOUT_MS, signal: req.signal });
    return parseCodexOutput(res.stdout, res.stderr, res.code);
  }
}

interface CodexEvent {
  type?: string;
  message?: string;
  error?: { message?: string };
  item?: { type?: string; text?: string };
  usage?: { input_tokens?: number; output_tokens?: number };
}

export function parseCodexOutput(stdout: string, stderr: string, code: number | null): GenerateResponse {
  let text: string | undefined;
  let usage: CodexEvent["usage"];
  let error: string | undefined;
  for (const line of stdout.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    let event: CodexEvent;
    try {
      event = JSON.parse(line) as CodexEvent;
    } catch {
      continue;
    }
    if (event.type === "item.completed" && event.item?.type === "agent_message") text = event.item.text ?? "";
    else if (event.type === "turn.completed") usage = event.usage;
    else if (event.type === "turn.failed") error = event.error?.message ?? "turn failed";
    else if (event.type === "error") error = event.message ?? "error";
  }
  if (error || text === undefined) {
    const detail = error ?? ((stderr.trim() || `exited with code ${code}`).slice(0, 300));
    if (LOGIN_PATTERN.test(detail)) {
      throw new FatalProviderError(`Codex isn't logged in: ${detail}`, { hint: "Run `codex login`, or `promptdiff login codex`." });
    }
    const status = /\b(429|rate.?limit)/i.test(detail) ? 429 : /\b5\d\d\b|overloaded/i.test(detail) ? 503 : undefined;
    throw new CliCallError(`codex: ${detail}`, status);
  }
  return {
    text,
    inputTokens: usage?.input_tokens,
    // output_tokens already includes reasoning tokens.
    outputTokens: usage?.output_tokens,
  };
}
