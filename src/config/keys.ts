import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { PromptdiffError } from "../errors.js";
import type { ProviderDefinition } from "../providers/types.js";
import { userConfigPath } from "./paths.js";

const userConfigSchema = z.object({
  keys: z.record(z.string(), z.string()).default({}),
});

export type UserConfig = z.infer<typeof userConfigSchema>;

export async function readUserConfig(file = userConfigPath()): Promise<UserConfig> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { keys: {} };
    throw err;
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new PromptdiffError(`User config file is not valid JSON: ${file}`, {
      hint: "Fix or delete the file, then set your keys again with `promptdiff config set`.",
    });
  }
  const parsed = userConfigSchema.safeParse(json);
  if (!parsed.success) {
    throw new PromptdiffError(`User config file has an unexpected format: ${file}`, {
      hint: "Fix or delete the file, then set your keys again with `promptdiff config set`.",
    });
  }
  return parsed.data;
}

/**
 * Writes the config atomically and restricts it to the current user (0600).
 * On Windows, POSIX modes are mostly ignored; the file lives under the
 * per-user %APPDATA% directory, which is already private to the user.
 */
export async function writeUserConfig(config: UserConfig, file = userConfigPath()): Promise<void> {
  const dir = path.dirname(file);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  await chmod(tmp, 0o600).catch(() => {});
  try {
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
  await chmod(file, 0o600).catch(() => {});
}

export async function setKey(provider: string, key: string, file = userConfigPath()): Promise<void> {
  const config = await readUserConfig(file);
  config.keys[provider] = key;
  await writeUserConfig(config, file);
}

export async function removeKey(provider: string, file = userConfigPath()): Promise<boolean> {
  const config = await readUserConfig(file);
  if (!(provider in config.keys)) return false;
  delete config.keys[provider];
  await writeUserConfig(config, file);
  return true;
}

/** "sk-ant-api03-abc...wxyz" -> "sk-...wxyz". Short keys are fully masked. */
export function maskKey(key: string): string {
  if (key.length < 12) return "****";
  return `${key.slice(0, 3)}...${key.slice(-4)}`;
}

export function missingKeyError(def: ProviderDefinition): PromptdiffError {
  const lines = [
    `Set it up interactively:`,
    `    promptdiff login ${def.id}`,
    `Or save a key directly (stored in ${userConfigPath()}):`,
    `    promptdiff config set ${def.id}`,
    `Or use an environment variable (takes precedence; best for CI):`,
    `    macOS/Linux:  export ${def.envVar}=<your-key>`,
    `    PowerShell:   $env:${def.envVar}="<your-key>"`,
  ];
  if (def.keyUrl) lines.push(`Get a key at ${def.keyUrl}`);
  if (def.id === "anthropic") {
    lines.push(
      "Other options:",
      "    Sign in with your browser (Anthropic's `ant` CLI):  promptdiff login anthropic",
      "    Use your Claude Code login instead:                 --model claude-code:default",
    );
  }
  if (def.id === "openai") lines.push("Or use your Codex CLI login instead:  --model codex:default");
  return new PromptdiffError(`No API key found for ${def.displayName}.`, { hint: lines.join("\n") });
}

/** Replaces any occurrence of known secrets in a message with its masked form. */
export function redactSecrets(message: string, secrets: Iterable<string>): string {
  let out = message;
  for (const secret of secrets) {
    if (secret.length >= 8) out = out.split(secret).join(maskKey(secret));
  }
  return out;
}
