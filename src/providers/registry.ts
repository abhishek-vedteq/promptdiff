import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogle } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { PromptdiffError } from "../errors.js";
import { AiSdkProvider } from "./ai-sdk.js";
import { ClaudeCodeProvider, CodexProvider } from "./cli.js";
import { mockProviderDefinition } from "./mock.js";
import type { Credential, ProviderDefinition } from "./types.js";
import { verifyWithRequest } from "./verify.js";

function apiKeyOf(credential: Credential, provider: string): string {
  if (credential.kind !== "api-key") throw new PromptdiffError(`${provider} needs an API key.`);
  return credential.key;
}

/**
 * To add a provider: install its AI SDK package, then add an entry here.
 * Anything implementing `Provider` works, not just AI SDK providers.
 */
const definitions: ProviderDefinition[] = [
  {
    id: "anthropic",
    displayName: "Anthropic",
    envVar: "ANTHROPIC_API_KEY",
    keyUrl: "https://console.anthropic.com/settings/keys",
    aliases: ["claude"],
    kind: "api",
    verifyKey: (key, fetchImpl) =>
      verifyWithRequest("https://api.anthropic.com/v1/models?limit=1", { "x-api-key": key, "anthropic-version": "2023-06-01" }, "Anthropic", fetchImpl),
    create: (credential) => {
      const anthropic =
        credential.kind === "auth-token"
          ? // OAuth tokens (from `ant auth login` or ANTHROPIC_AUTH_TOKEN) go in a Bearer header with the OAuth beta flag.
            createAnthropic({ authToken: credential.token, headers: { "anthropic-beta": "oauth-2025-04-20" } })
          : createAnthropic({ apiKey: apiKeyOf(credential, "Anthropic") });
      return new AiSdkProvider("anthropic", (model) => anthropic(model));
    },
  },
  {
    id: "openai",
    displayName: "OpenAI",
    envVar: "OPENAI_API_KEY",
    keyUrl: "https://platform.openai.com/api-keys",
    kind: "api",
    verifyKey: (key, fetchImpl) => verifyWithRequest("https://api.openai.com/v1/models", { Authorization: `Bearer ${key}` }, "OpenAI", fetchImpl),
    create: (credential) => {
      const openai = createOpenAI({ apiKey: apiKeyOf(credential, "OpenAI") });
      return new AiSdkProvider("openai", (model) => openai(model));
    },
  },
  {
    id: "google",
    displayName: "Google Gemini",
    envVar: "GOOGLE_GENERATIVE_AI_API_KEY",
    keyUrl: "https://aistudio.google.com/app/apikey",
    aliases: ["gemini"],
    kind: "api",
    verifyKey: (key, fetchImpl) =>
      verifyWithRequest("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1", { "x-goog-api-key": key }, "Google", fetchImpl),
    create: (credential) => {
      const google = createGoogle({ apiKey: apiKeyOf(credential, "Google") });
      return new AiSdkProvider("google", (model) => google(model));
    },
  },
  {
    id: "claude-code",
    displayName: "Claude Code (your Claude login)",
    envVar: "",
    keyUrl: "",
    kind: "cli",
    requiresKey: false,
    capabilities: { multiTurn: false, temperature: false, maxOutputTokens: false },
    create: () => new ClaudeCodeProvider(),
  },
  {
    id: "codex",
    displayName: "Codex CLI (your ChatGPT or OpenAI login)",
    envVar: "",
    keyUrl: "",
    kind: "cli",
    requiresKey: false,
    capabilities: { multiTurn: false, temperature: false, maxOutputTokens: false },
    create: () => new CodexProvider(),
  },
  // Offline provider for demos and tests: --model mock:any
  mockProviderDefinition(),
];

const registry = new Map<string, ProviderDefinition>();
for (const def of definitions) {
  registry.set(def.id, def);
  for (const alias of def.aliases ?? []) registry.set(alias, def);
}

export function listProviders(): ProviderDefinition[] {
  return definitions.filter((d) => !d.hidden);
}

/** Registers an extra provider at runtime (used by tests and library consumers). */
export function registerProvider(def: ProviderDefinition): void {
  const existing = definitions.findIndex((d) => d.id === def.id);
  if (existing >= 0) definitions[existing] = def;
  else definitions.push(def);
  registry.set(def.id, def);
  for (const alias of def.aliases ?? []) registry.set(alias, def);
}

export function getProviderDefinition(id: string): ProviderDefinition {
  const def = registry.get(id.toLowerCase());
  if (!def) {
    throw new PromptdiffError(`Unknown provider "${id}".`, {
      hint: `Supported providers: ${listProviders().map((d) => d.id).join(", ")}`,
    });
  }
  return def;
}

export interface ModelSpec {
  provider: string;
  model: string;
}

/** Parses "provider:model-id". Only the first colon splits, so model ids may contain colons. */
export function parseModelSpec(spec: string): ModelSpec {
  const idx = spec.indexOf(":");
  if (idx <= 0 || idx === spec.length - 1) {
    throw new PromptdiffError(`Invalid model "${spec}". Use the form <provider>:<model-id>.`, {
      hint: "Examples: --model anthropic:claude-opus-5-5, --model claude-code:default, --model codex:default  (providers: " +
        listProviders().map((d) => d.id).join(", ") + ")",
    });
  }
  const provider = getProviderDefinition(spec.slice(0, idx)).id;
  return { provider, model: spec.slice(idx + 1) };
}
