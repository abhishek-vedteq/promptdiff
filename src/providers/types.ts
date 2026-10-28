export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface GenerateRequest {
  /** Provider-specific model id, e.g. "claude-opus-5-5". Passed through untouched. */
  model: string;
  /** The prompt under test, sent as the system prompt. */
  system: string;
  /** The conversation: the test case input as a single user message, or a multi-turn case's messages. */
  messages: ChatMessage[];
  temperature?: number;
  maxOutputTokens?: number;
  signal?: AbortSignal;
}

export interface GenerateResponse {
  text: string;
  /** Undefined when the provider doesn't report usage. */
  inputTokens?: number;
  outputTokens?: number;
}

/** A configured client for one provider (API key already bound). */
export interface Provider {
  readonly id: string;
  generate(request: GenerateRequest): Promise<GenerateResponse>;
}

/** How a provider authenticates. */
export type Credential =
  | { kind: "api-key"; key: string }
  /** A short-lived OAuth token; called before requests so it can be refreshed. */
  | { kind: "auth-token"; token: () => Promise<string> }
  /** The provider handles its own login (e.g. an installed CLI). */
  | { kind: "none" };

export interface ProviderCapabilities {
  /** Accepts multi-turn conversations. Default true. */
  multiTurn?: boolean;
  /** Honors temperature. Default true. */
  temperature?: boolean;
  /** Honors maxOutputTokens. Default true. */
  maxOutputTokens?: boolean;
}

/** Describes a provider and how to construct it. Register new providers in registry.ts. */
export interface ProviderDefinition {
  /** Used in --model <id>:<model> and `promptdiff config set <id>`. */
  id: string;
  displayName: string;
  /** Environment variable that overrides the stored key. */
  envVar: string;
  /** Where users can create a key; shown in "missing key" errors. */
  keyUrl: string;
  aliases?: string[];
  /** False for providers that don't need a key (installed CLIs, the offline mock). Default true. */
  requiresKey?: boolean;
  /** Hidden from `config list` and help text. */
  hidden?: boolean;
  /** "api" calls a model API; "cli" runs an installed command-line tool that has its own login. */
  kind?: "api" | "cli";
  capabilities?: ProviderCapabilities;
  /** Checks that an API key works without spending tokens (e.g. by listing models). Throws if not. */
  verifyKey?: (key: string, fetchImpl?: typeof fetch) => Promise<void>;
  create(credential: Credential): Provider;
}
