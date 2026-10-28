import { cliLoginCheckers, resolveCredential, type CliLogin } from "./auth.js";
import type { UserConfig } from "./config/keys.js";
import { getProviderDefinition } from "./providers/registry.js";

/** Models used when none is configured, by how the user is logged in. */
export const DEFAULT_MODELS = {
  anthropic: "anthropic:claude-opus-5-5",
  "claude-code": "claude-code:default",
  codex: "codex:default",
} as const;

export interface DetectedModel {
  model: string;
  /** Why this model was picked, shown to the user. */
  reason: string;
}

/**
 * Picks a model when none is configured: Anthropic API credentials first (fast, exact
 * token counts), then a logged-in Claude Code, then a logged-in Codex CLI.
 * OpenAI and Google keys alone aren't enough, because there's no model id to assume.
 */
export async function detectDefaultModel(
  config: UserConfig,
  env: NodeJS.ProcessEnv = process.env,
  checkers: Record<string, (env?: NodeJS.ProcessEnv) => Promise<CliLogin>> = cliLoginCheckers,
): Promise<DetectedModel | undefined> {
  const anthropic = resolveCredential(getProviderDefinition("anthropic"), config, env);
  if (anthropic) return { model: DEFAULT_MODELS.anthropic, reason: `found Anthropic credentials (${anthropic.label})` };
  for (const id of ["claude-code", "codex"] as const) {
    const login = await checkers[id]?.(env);
    if (login?.loggedIn) {
      return { model: DEFAULT_MODELS[id], reason: `found your ${id === "codex" ? "Codex" : "Claude Code"} login${login.method ? ` (${login.method})` : ""}` };
    }
  }
  return undefined;
}
