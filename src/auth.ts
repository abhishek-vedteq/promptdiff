import { antLoginAvailable, antTokenSource } from "./ant.js";
import { maskKey, type UserConfig } from "./config/keys.js";
import { runProgram, findExecutable } from "./exec.js";
import type { Credential, ProviderDefinition } from "./providers/types.js";

export type CredentialSource = "env" | "env-token" | "config" | "ant" | "cli" | "none";

export interface ResolvedCredential {
  credential: Credential;
  source: CredentialSource;
  /** Human-readable description, with any secret masked. */
  label: string;
  /** Secrets to scrub from error messages. Tokens fetched later are appended. */
  secrets: string[];
}

/**
 * Finds credentials for a provider. First match wins:
 * 1. the provider's API key environment variable (e.g. ANTHROPIC_API_KEY)
 * 2. Anthropic only: ANTHROPIC_AUTH_TOKEN (an OAuth token)
 * 3. a key saved with `promptdiff login` / `promptdiff config set`
 * 4. Anthropic only: a browser login made with Anthropic's `ant` CLI
 * CLI providers (claude-code, codex) use their own login and need nothing here.
 */
export function resolveCredential(def: ProviderDefinition, config: UserConfig, env: NodeJS.ProcessEnv = process.env): ResolvedCredential | undefined {
  if (def.requiresKey === false) {
    return { credential: { kind: "none" }, source: def.kind === "cli" ? "cli" : "none", label: def.kind === "cli" ? "uses the CLI's own login" : "no key needed", secrets: [] };
  }
  const fromEnv = def.envVar ? env[def.envVar]?.trim() : undefined;
  if (fromEnv) return { credential: { kind: "api-key", key: fromEnv }, source: "env", label: `${maskKey(fromEnv)} from ${def.envVar}`, secrets: [fromEnv] };

  if (def.id === "anthropic") {
    const token = env.ANTHROPIC_AUTH_TOKEN?.trim();
    if (token) {
      return { credential: { kind: "auth-token", token: async () => token }, source: "env-token", label: `token ${maskKey(token)} from ANTHROPIC_AUTH_TOKEN`, secrets: [token] };
    }
  }

  const saved = config.keys[def.id]?.trim();
  if (saved) return { credential: { kind: "api-key", key: saved }, source: "config", label: `${maskKey(saved)} saved by promptdiff`, secrets: [saved] };

  if (def.id === "anthropic" && antLoginAvailable(env)) {
    const secrets: string[] = [];
    return {
      credential: { kind: "auth-token", token: antTokenSource(env, (t) => secrets.push(t)) },
      source: "ant",
      label: "browser login via `ant` CLI",
      secrets,
    };
  }
  return undefined;
}

export interface CliLogin {
  installed: boolean;
  loggedIn: boolean;
  /** e.g. "claude.ai (max)" or "ChatGPT" */
  method?: string;
}

/** Asks the installed Claude Code whether it's logged in (no network call, no credentials read). */
export async function claudeCodeLogin(env: NodeJS.ProcessEnv = process.env): Promise<CliLogin> {
  const bin = findExecutable("claude", env);
  if (!bin) return { installed: false, loggedIn: false };
  try {
    const res = await runProgram(bin, ["auth", "status", "--json"], { env, timeoutMs: 15_000 });
    const status = JSON.parse(res.stdout) as { loggedIn?: boolean; authMethod?: string; subscriptionType?: string };
    const method = status.authMethod ? `${status.authMethod}${status.subscriptionType ? ` (${status.subscriptionType})` : ""}` : undefined;
    return { installed: true, loggedIn: status.loggedIn === true, method };
  } catch {
    return { installed: true, loggedIn: false };
  }
}

/** Asks the installed Codex CLI whether it's logged in. */
export async function codexLogin(env: NodeJS.ProcessEnv = process.env): Promise<CliLogin> {
  const bin = findExecutable("codex", env);
  if (!bin) return { installed: false, loggedIn: false };
  try {
    const res = await runProgram(bin, ["login", "status"], { env, timeoutMs: 15_000 });
    const out = `${res.stdout}\n${res.stderr}`;
    const m = out.match(/Logged in using (.+)/i);
    return { installed: true, loggedIn: res.code === 0 && !!m, method: m?.[1]?.trim() };
  } catch {
    return { installed: true, loggedIn: false };
  }
}

export const cliLoginCheckers: Record<string, (env?: NodeJS.ProcessEnv) => Promise<CliLogin>> = {
  "claude-code": claudeCodeLogin,
  codex: codexLogin,
};
