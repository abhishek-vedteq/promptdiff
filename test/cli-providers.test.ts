import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { runCommand } from "../src/commands/run.js";
import { FatalProviderError } from "../src/errors.js";
import { ClaudeCodeProvider, CodexProvider, parseClaudeOutput, parseCodexOutput } from "../src/providers/cli.js";
import { getStatusCode, isRetryable } from "../src/retry.js";
import type { DiffReport } from "../src/types.js";
import { Sink, fakeBin, makeRepo, tempDir } from "./helpers.js";

const posixOnly = process.platform === "win32" ? describe.skip : describe;

// Real output captured from `claude -p --output-format json` (trimmed).
const CLAUDE_OK = JSON.stringify({
  type: "result", subtype: "success", is_error: false, result: "OK", api_error_status: null,
  usage: { input_tokens: 2, cache_creation_input_tokens: 572, cache_read_input_tokens: 0, output_tokens: 4 },
});
// Real output captured from `codex exec --json`.
const CODEX_OK = [
  '{"type":"thread.started","thread_id":"01a1"}',
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"OK"}}',
  '{"type":"turn.completed","usage":{"input_tokens":14327,"cached_input_tokens":6912,"output_tokens":5,"reasoning_output_tokens":0}}',
].join("\n");

describe("parsing CLI output", () => {
  it("reads Claude Code's JSON result and token usage", () => {
    expect(parseClaudeOutput(CLAUDE_OK, "")).toEqual({ text: "OK", inputTokens: 574, outputTokens: 4 });
  });

  it("turns Claude Code errors into retryable or fatal errors", () => {
    const rateLimited = JSON.stringify({ type: "result", is_error: true, result: "API Error: 429 rate limited", api_error_status: 429 });
    let err: unknown;
    try {
      parseClaudeOutput(rateLimited, "");
    } catch (e) {
      err = e;
    }
    expect(getStatusCode(err)).toBe(429);
    expect(isRetryable(err)).toBe(true);
    expect(() => parseClaudeOutput("", "Not logged in · Please run /login")).toThrow(FatalProviderError);
  });

  it("reads Codex's JSONL events and token usage", () => {
    expect(parseCodexOutput(CODEX_OK, "", 0)).toEqual({ text: "OK", inputTokens: 14327, outputTokens: 5 });
  });

  it("turns Codex failures into errors", () => {
    expect(() => parseCodexOutput('{"type":"turn.failed","error":{"message":"401 Unauthorized"}}', "", 1)).toThrow(FatalProviderError);
    let err: unknown;
    try {
      parseCodexOutput('{"type":"error","message":"Rate limit reached"}', "", 1);
    } catch (e) {
      err = e;
    }
    expect(isRetryable(err)).toBe(true);
    expect(() => parseCodexOutput("", "boom", 1)).toThrow(/codex: boom/);
  });
});

posixOnly("CLI providers with fake claude/codex binaries", () => {
  let savedPath: string | undefined;
  const record = path.join(tempDir(), "calls.jsonl");
  // Records argv, stdin, and cwd, then answers like the real CLI would.
  const recorder = (reply: string) => `
    const fs = require("fs");
    let stdin = ""; process.stdin.on("data", (d) => (stdin += d)).on("end", () => {
      fs.appendFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2), stdin, cwd: process.cwd() }) + "\\n");
      const args = process.argv.slice(2);
      const file = args.find((a) => a.startsWith("model_instructions_file="));
      const system = file ? fs.readFileSync(file.slice(file.indexOf("'") + 1, -1), "utf8") : args[args.indexOf("--system-prompt") + 1];
      process.stdout.write(${reply});
    });`;

  beforeEach(() => {
    savedPath = process.env.PATH;
    writeFileSync(record, "");
  });
  afterEach(() => {
    process.env.PATH = savedPath;
  });
  const calls = () => readFileSync(record, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const withBin = (dir: string) => `${dir}${path.delimiter}${savedPath}`;

  it("claude-code: replaces the system prompt, disables tools and settings, sends input on stdin", async () => {
    process.env.PATH = withBin(fakeBin("claude", recorder('JSON.stringify({ type: "result", is_error: false, result: "reply to: " + stdin + " | " + system, usage: { input_tokens: 10, output_tokens: 3 } })')));
    const res = await new ClaudeCodeProvider().generate({ model: "default", system: "Be terse.\nAlways.", messages: [{ role: "user", content: "hi there" }] });
    expect(res).toEqual({ text: "reply to: hi there | Be terse.\nAlways.", inputTokens: 10, outputTokens: 3 });
    const [call] = calls();
    expect(call.argv).toEqual(expect.arrayContaining(["-p", "--output-format", "json", "--tools", "", "--setting-sources", "", "--strict-mcp-config", "--no-session-persistence"]));
    expect(call.argv).not.toContain("--model");
    expect(call.cwd).toMatch(/promptdiff-cli-/);

    await new ClaudeCodeProvider().generate({ model: "claude-sonnet-5-5", system: "x", messages: [{ role: "user", content: "y" }] });
    expect(calls()[1].argv).toEqual(expect.arrayContaining(["--model", "claude-sonnet-5-5"]));
  });

  it("codex: passes the prompt as the model instructions file and input on stdin", async () => {
    process.env.PATH = withBin(fakeBin("codex", recorder(`[
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "codex says " + stdin.trim() + " | " + system } }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 100, output_tokens: 7 } }),
    ].join("\\n")`)));
    const res = await new CodexProvider().generate({ model: "default", system: "You are Codex-tested.", messages: [{ role: "user", content: "ping" }] });
    expect(res).toEqual({ text: "codex says ping | You are Codex-tested.", inputTokens: 100, outputTokens: 7 });
    const [call] = calls();
    expect(call.argv.slice(0, 7)).toEqual(["exec", "--json", "--skip-git-repo-check", "--ephemeral", "--sandbox", "read-only", "-C"]);
    expect(call.argv.at(-1)).toBe("-");
  });

  it("rejects conversations and unsafe model ids", async () => {
    await expect(new ClaudeCodeProvider().generate({ model: "default", system: "x", messages: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }, { role: "user", content: "c" }] })).rejects.toThrow(/single-turn/);
    process.env.PATH = withBin(fakeBin("claude", recorder('""')));
    await expect(new ClaudeCodeProvider().generate({ model: "x; rm -rf /", system: "x", messages: [{ role: "user", content: "a" }] })).rejects.toThrow(/Invalid model id/);
  });

  it("runs end to end through `promptdiff` with --model claude-code:default", async () => {
    process.env.PATH = withBin(fakeBin("claude", recorder('JSON.stringify({ type: "result", is_error: false, result: system.split("\\n")[0] + " / " + stdin, usage: { input_tokens: 5, output_tokens: 5 } })')));
    const repo = makeRepo({ "p.md": "Old prompt\n", "cases.jsonl": '{"id": "a", "input": "hello"}', "promptdiff.config.yaml": "model: claude-code:default\ntemperature: 0.5\n" });
    writeFileSync(path.join(repo, "p.md"), "New prompt\n");
    const stdout = new Sink();
    const stderr = new Sink();
    await runCommand("p.md", { cache: false, json: true }, { cwd: repo, env: process.env, stdout, stderr, userConfigFile: path.join(tempDir(), "c.json") });
    const report = JSON.parse(stdout.data) as DiffReport;
    expect(report.cases[0]!.base[0]!.text).toBe("Old prompt / hello");
    expect(report.cases[0]!.head[0]!.text).toBe("New prompt / hello");
    expect(report.meta.temperature).toBeUndefined();
    expect(stderr.data).toContain("doesn't support temperature");
  });

  it("skips multi-turn cases (or refuses if that's all there is), and explains a missing CLI", async () => {
    process.env.PATH = withBin(fakeBin("claude", recorder('""')));
    const repo = makeRepo({
      "p.md": "x",
      "cases.jsonl": '{"id": "convo", "messages": [{"role": "user", "content": "a"}, {"role": "assistant", "content": "b"}, {"role": "user", "content": "c"}]}',
      "promptdiff.config.yaml": "model: claude-code:default\n",
    });
    const deps = { cwd: repo, stdout: new Sink(), stderr: new Sink(), userConfigFile: path.join(tempDir(), "c.json") };
    await expect(runCommand("p.md", { cache: false }, { ...deps, env: process.env })).rejects.toThrow(/can't run multi-turn cases, and every case uses "messages"/);
    await expect(runCommand("p.md", { cache: false }, { ...deps, env: { PATH: tempDir() } })).rejects.toThrow(/needs the `claude` command/);
    expect(calls()).toHaveLength(0);
  });
});

describe("automatic model selection", () => {
  it("uses the detected model when none is configured, and says so", async () => {
    const repo = makeRepo({ "p.md": "x", "cases.jsonl": '{"input": "hi"}' });
    const stdout = new Sink();
    const stderr = new Sink();
    const { MockProvider } = await import("../src/providers/mock.js");
    await runCommand("p.md", { cache: false, json: true }, {
      cwd: repo, env: {}, stdout, stderr, userConfigFile: path.join(tempDir(), "c.json"),
      createProvider: () => new MockProvider(),
      detectModel: async () => ({ model: "mock:auto", reason: "found your test login" }),
    });
    expect(JSON.parse(stdout.data).meta.model).toBe("mock:auto");
    expect(stderr.data).toContain("Using mock:auto: found your test login.");
  });

  it("explains every way to set things up when nothing is found", async () => {
    const repo = makeRepo({ "p.md": "x", "cases.jsonl": '{"input": "hi"}' });
    await expect(
      runCommand("p.md", {}, { cwd: repo, env: {}, stdout: new Sink(), stderr: new Sink(), userConfigFile: path.join(tempDir(), "c.json"), detectModel: async () => undefined }),
    ).rejects.toMatchObject({ hint: expect.stringContaining("promptdiff login") });
  });
});
