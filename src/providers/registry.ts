import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogle } from "@ai-sdk/google";
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { createAzure } from "@ai-sdk/azure";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { aiSdkBatchClient } from "../batch.js";
import { PromptdiffError } from "../errors.js";
import { AiSdkProvider } from "./ai-sdk.js";
import { ClaudeCodeProvider, CodexProvider } from "./cli.js";
import { mockProviderDefinition } from "./mock.js";
import type { Credential, ProviderDefinition } from "./types.js";
import { verifyWithRequest } from "./verify.js";

const ollamaBaseURL = (env: NodeJS.ProcessEnv) => (env.OLLAMA_BASE_URL ?? "http://localhost:11434/v1").replace(/\/$/, "");

/** OAuth tokens (from `ant auth login` or ANTHROPIC_AUTH_TOKEN) go in a Bearer header with the OAuth beta flag. */
function anthropicFor(credential: Credential) {
  return credential.kind === "auth-token"
    ? createAnthropic({ authToken: credential.token, headers: { "anthropic-beta": "oauth-2025-04-20" } })
    : createAnthropic({ apiKey: apiKeyOf(credential, "Anthropic") });
}

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
      const anthropic = anthropicFor(credential);
      return new AiSdkProvider("anthropic", (model) => anthropic(model));
    },
    createBatchClient: (credential) => aiSdkBatchClient(anthropicFor(credential)),
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
    createBatchClient: (credential) => aiSdkBatchClient(createOpenAI({ apiKey: apiKeyOf(credential, "OpenAI") })),
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
    createBatchClient: (credential) => aiSdkBatchClient(createGoogle({ apiKey: apiKeyOf(credential, "Google") })),
  },
  {
    id: "ollama",
    displayName: "Ollama (local models)",
    envVar: "",
    keyUrl: "",
    kind: "api",
    requiresKey: false,
    checkReady: async (env) => {
      const base = ollamaBaseURL(env);
      try {
        const res = await fetch(`${base}/models`, { signal: AbortSignal.timeout(1500) });
        if (!res.ok) return { ready: false, detail: `not responding at ${base}` };
        const body = (await res.json()) as { data?: { id: string }[] };
        const models = body.data?.map((m) => m.id) ?? [];
        return { ready: true, detail: `running, ${models.length} model${models.length === 1 ? "" : "s"}${models.length ? `: ${models.slice(0, 3).join(", ")}${models.length > 3 ? ", …" : ""}` : ""}` };
      } catch {
        return { ready: false, detail: `not running (start it with \`ollama serve\`)` };
      }
    },
    create: () => {
      const ollama = createOpenAICompatible({ name: "ollama", baseURL: ollamaBaseURL(process.env) });
      return new AiSdkProvider("ollama", (model) => ollama(model));
    },
  },
  {
    id: "azure",
    displayName: "Azure OpenAI",
    envVar: "AZURE_API_KEY",
    keyUrl: "https://portal.azure.com",
    kind: "api",
    create: (credential) => {
      const env = process.env;
      if (!env.AZURE_RESOURCE_NAME && !env.AZURE_OPENAI_BASE_URL) {
        throw new PromptdiffError("Azure OpenAI needs your resource name.", {
          hint: "Set AZURE_RESOURCE_NAME (the <name> in https://<name>.openai.azure.com), or AZURE_OPENAI_BASE_URL. The model id is your deployment name: --model azure:<deployment>.",
        });
      }
      const azure = createAzure({
        apiKey: apiKeyOf(credential, "Azure OpenAI"),
        ...(env.AZURE_OPENAI_BASE_URL ? { baseURL: env.AZURE_OPENAI_BASE_URL } : { resourceName: env.AZURE_RESOURCE_NAME }),
      });
      return new AiSdkProvider("azure", (deployment) => azure(deployment));
    },
  },
  {
    id: "bedrock",
    displayName: "AWS Bedrock",
    envVar: "AWS_BEARER_TOKEN_BEDROCK",
    keyUrl: "https://console.aws.amazon.com/bedrock",
    kind: "api",
    ambient: (env) => (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY ? `AWS credentials from AWS_ACCESS_KEY_ID (${env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? "no region set"})` : undefined),
    create: (credential) => {
      const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
      if (!region) throw new PromptdiffError("AWS Bedrock needs a region.", { hint: "Set AWS_REGION, e.g. export AWS_REGION=us-east-1" });
      const bedrock = createAmazonBedrock({ region, ...(credential.kind === "api-key" ? { apiKey: credential.key } : {}) });
      return new AiSdkProvider("bedrock", (model) => bedrock(model));
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
