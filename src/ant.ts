import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PromptdiffError } from "./errors.js";
import { findExecutable, runProgram } from "./exec.js";

/**
 * Support for Anthropic's official `ant` CLI login (`ant auth login`), which signs in
 * through the browser and stores a short-lived OAuth token for the Claude API.
 * promptdiff asks `ant` for a fresh token instead of reading its files.
 */

export const ANT_INSTALL_HINT = [
  "Install Anthropic's `ant` CLI:",
  "  macOS (Homebrew):  brew install anthropics/tap/ant",
  "  Go:                go install github.com/anthropics/anthropic-cli/v2/cmd/ant@latest",
  "  Other platforms:   https://github.com/anthropics/anthropic-cli/releases",
].join("\n");

export function antConfigDir(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string {
  if (env.ANTHROPIC_CONFIG_DIR) return env.ANTHROPIC_CONFIG_DIR;
  if (platform === "win32") return path.join(env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "Anthropic");
  return path.join(os.homedir(), ".config", "anthropic");
}

export function findAnt(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return findExecutable("ant", env);
}

/** True when `ant` is installed and has at least one logged-in profile. Doesn't run `ant`. */
export function antLoginAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  if (!findAnt(env)) return false;
  try {
    return readdirSync(path.join(antConfigDir(env), "credentials")).some((f) => f.endsWith(".json"));
  } catch {
    return false;
  }
}

/** Environment for running `ant` so a stray API key or token variable doesn't shadow the profile. */
function antEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = { ...env };
  delete out.ANTHROPIC_API_KEY;
  delete out.ANTHROPIC_AUTH_TOKEN;
  return out;
}

/**
 * Returns a function that yields a current access token, re-asking `ant` every few minutes
 * (`print-credentials` refreshes the token when needed). Each token is passed to `onToken`
 * so it can be redacted from error messages.
 */
export function antTokenSource(env: NodeJS.ProcessEnv = process.env, onToken?: (token: string) => void): () => Promise<string> {
  let cached: { token: string; at: number } | undefined;
  let pending: Promise<string> | undefined;
  const TTL_MS = 4 * 60 * 1000;
  return async () => {
    if (cached && Date.now() - cached.at < TTL_MS) return cached.token;
    pending ??= (async () => {
      const ant = findAnt(env);
      if (!ant) throw new PromptdiffError("The `ant` CLI isn't installed.", { hint: ANT_INSTALL_HINT });
      const res = await runProgram(ant, ["auth", "print-credentials", "--access-token"], { env: antEnv(env), timeoutMs: 30_000 });
      const token = res.stdout.trim();
      if (res.code !== 0 || !token || /\s/.test(token)) {
        throw new PromptdiffError("Couldn't get a token from your `ant` login.", {
          hint: "Run `ant auth login` (or `promptdiff login anthropic`) to sign in again.",
        });
      }
      onToken?.(token);
      cached = { token, at: Date.now() };
      return token;
    })().finally(() => {
      pending = undefined;
    });
    return pending;
  };
}

/** Runs `ant auth login` attached to the terminal, so it can open the browser. */
export function antLogin(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const ant = findAnt(env);
  if (!ant) return Promise.reject(new PromptdiffError("The `ant` CLI isn't installed.", { hint: ANT_INSTALL_HINT }));
  return runInteractive(ant, ["auth", "login"], antEnv(env));
}

/** Runs a command with the terminal attached (for browser logins). Resolves to whether it succeeded. */
export function runInteractive(file: string, args: string[], env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  return new Promise((resolve) => {
    const shell = process.platform === "win32" && /\.(cmd|bat)$/i.test(file);
    const child = spawn(file, args, { stdio: "inherit", env, shell });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}
