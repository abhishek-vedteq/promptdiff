import type { GenerateRequest, GenerateResponse, Provider, ProviderDefinition } from "./types.js";

export type MockHandler = (req: GenerateRequest, callIndex: number) => GenerateResponse | Promise<GenerateResponse>;

/**
 * A provider that never touches the network. Used in tests, and handy for
 * trying the CLI without an API key: --model mock:echo
 */
export class MockProvider implements Provider {
  readonly id = "mock";
  calls: GenerateRequest[] = [];

  constructor(private readonly handler: MockHandler = defaultMockHandler) {}

  async generate(req: GenerateRequest): Promise<GenerateResponse> {
    const index = this.calls.length;
    this.calls.push(req);
    return this.handler(req, index);
  }
}

const JUDGE_PREFIX = "You are promptdiff's evaluator.";
const block = (text: string, tag: string) => text.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1]?.trim() ?? "";

/** Offline stand-in for the LLM judge: rubrics pass when the response mentions the rubric's first word. */
function mockJudge(req: GenerateRequest): GenerateResponse {
  const user = req.messages[0]?.content ?? "";
  if (user.includes("<rubric>")) {
    const word = block(user, "rubric").split(/\s+/)[0]?.toLowerCase() ?? "";
    const pass = block(user, "response").toLowerCase().includes(word);
    return { text: JSON.stringify({ reason: `mock judge: response ${pass ? "mentions" : "doesn't mention"} "${word}"`, pass }), inputTokens: 50, outputTokens: 20 };
  }
  const same = block(user, "version_a").replace(/sample="\d+"/g, "") === block(user, "version_b").replace(/sample="\d+"/g, "");
  return {
    text: JSON.stringify({ summary: same ? "No meaningful difference" : "mock judge: B's responses differ from A's", verdict: same ? "same" : "different" }),
    inputTokens: 80,
    outputTokens: 20,
  };
}

/** Deterministic: the reply depends only on the system prompt and input. */
export const defaultMockHandler: MockHandler = (req) => {
  if (req.system.startsWith(JUDGE_PREFIX)) return mockJudge(req);
  const firstLine = req.system.split("\n").find((l) => l.trim() !== "")?.trim() ?? "";
  const last = req.messages[req.messages.length - 1]?.content ?? "";
  const text = `[${firstLine}] You said: ${last}`;
  const inputChars = req.messages.reduce((n, m) => n + m.content.length, req.system.length);
  return {
    text,
    inputTokens: Math.ceil(inputChars / 4),
    outputTokens: Math.ceil(text.length / 4),
  };
};

export function mockProviderDefinition(provider: Provider = new MockProvider()): ProviderDefinition {
  return {
    id: "mock",
    displayName: "Mock (offline)",
    envVar: "PROMPTDIFF_MOCK_KEY",
    keyUrl: "",
    requiresKey: false,
    hidden: true,
    create: () => provider,
  };
}
