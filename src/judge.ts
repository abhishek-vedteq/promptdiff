import { z } from "zod";
import { cacheKey, type ResultCache } from "./cache.js";
import { caseMessages, type TestCase } from "./cases.js";
import { FatalProviderError, PromptdiffError } from "./errors.js";
import type { Budget } from "./estimate.js";
import { estimateCost, type PricingTable } from "./pricing.js";
import type { Provider } from "./providers/types.js";
import { DEFAULT_RETRY, withRetry, type RetryOptions } from "./retry.js";

/** Every judge system prompt starts with this, so the offline mock provider can recognize judge calls. */
export const JUDGE_MARKER = "You are promptdiff's evaluator.";

export const GRADE_SYSTEM = `${JUDGE_MARKER} You grade one response from an AI assistant against a rubric.

Judge only what the rubric asks about, and ignore everything else about the response. If the rubric is clearly met, it passes. If it's clearly not met, or met only partly, it fails.

Reply with only a JSON object and no other text:
{"reason": "<one sentence explaining the decision>", "pass": true or false}`;

export const COMPARE_SYSTEM = `${JUDGE_MARKER} You compare how two versions of an AI assistant's system prompt (A = old, B = new) respond to the same conversation.

You may get several sampled responses per version. Samples from the same version vary randomly, and that variation is not a change.

Decide whether B's responses differ from A's in a way that would matter to the team building this assistant, such as: different facts or numbers; different actions, decisions, or recommendations; asking the user for different information; refusing instead of helping or the reverse; a different language or format; or a clear change in tone or length.

Ignore rewording that keeps the same meaning, and differences no bigger than those between samples of the same version.

Reply with only a JSON object and no other text:
{"summary": "<one short sentence describing how B differs from A, or 'No meaningful difference'>", "verdict": "same" or "different"}`;

const gradeSchema = z.object({ pass: z.boolean(), reason: z.string().default("") });
const compareSchema = z.object({ verdict: z.enum(["same", "different"]), summary: z.string().default("") });

export interface Judgement {
  verdict?: "same" | "different";
  summary?: string;
  /** Set when the judge call failed; the case keeps its word-based status. */
  error?: string;
}

export interface JudgeUsage {
  calls: number;
  cachedCalls: number;
  inputTokens: number;
  outputTokens: number;
  /** Undefined if the judge model isn't in the pricing table. */
  cost?: number;
}

export interface JudgeOptions {
  provider: Provider;
  /** Model id passed to the provider. */
  modelId: string;
  /** "provider:model-id" for cache keys and pricing. */
  modelSpec: string;
  cache?: ResultCache;
  pricing: PricingTable;
  retry?: RetryOptions;
  budget?: Budget;
}

/** Extracts and validates the JSON object in a judge reply (tolerates code fences or stray text). */
export function parseJudgeReply<T>(text: string, schema: z.ZodType<T>): T {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const parsed = schema.safeParse(JSON.parse(text.slice(start, end + 1)));
      if (parsed.success) return parsed.data;
    } catch {
      // fall through
    }
  }
  const preview = text.replace(/\s+/g, " ").trim().slice(0, 120);
  throw new PromptdiffError(`judge gave an unexpected reply: ${JSON.stringify(preview)}`);
}

/** Formats a case's conversation for the judge. */
export function transcript(tc: TestCase): string {
  const msgs = caseMessages(tc);
  if (msgs.length === 1) return msgs[0]!.content;
  return msgs.map((m) => `[${m.role}]\n${m.content}`).join("\n\n");
}

/** Uses a model to grade rubrics and to compare two versions' outputs by meaning. */
export class Judge {
  readonly usage: JudgeUsage = { calls: 0, cachedCalls: 0, inputTokens: 0, outputTokens: 0, cost: 0 };

  constructor(private readonly opts: JudgeOptions) {}

  get modelSpec(): string {
    return this.opts.modelSpec;
  }

  async grade(rubric: string, output: string, conversation: string): Promise<{ pass: boolean; reason: string }> {
    const user = `<conversation>\n${conversation}\n</conversation>\n\n<response>\n${output}\n</response>\n\n<rubric>\n${rubric}\n</rubric>`;
    return parseJudgeReply(await this.ask(GRADE_SYSTEM, user), gradeSchema);
  }

  async compare(conversation: string, baseOutputs: string[], headOutputs: string[]): Promise<{ verdict: "same" | "different"; summary: string }> {
    const samples = (outputs: string[]) => outputs.map((o, i) => `<response sample="${i + 1}">\n${o}\n</response>`).join("\n");
    const user =
      `<conversation>\n${conversation}\n</conversation>\n\n` +
      `<version_a>\n${samples(baseOutputs)}\n</version_a>\n\n<version_b>\n${samples(headOutputs)}\n</version_b>`;
    return parseJudgeReply(await this.ask(COMPARE_SYSTEM, user), compareSchema);
  }

  private async ask(system: string, user: string): Promise<string> {
    const key = cacheKey({ prompt: system, model: this.opts.modelSpec, input: user, runIndex: 0 });
    const hit = await this.opts.cache?.get(key);
    this.usage.calls++;
    if (hit) {
      this.usage.cachedCalls++;
      return hit.text;
    }
    if (this.opts.budget?.exhausted) {
      throw new FatalProviderError("budget reached before the judge call");
    }
    const started = performance.now();
    const res = await withRetry(
      () => this.opts.provider.generate({ model: this.opts.modelId, system, messages: [{ role: "user", content: user }] }),
      this.opts.retry ?? DEFAULT_RETRY,
    );
    const cost = estimateCost(this.opts.pricing, this.opts.modelSpec, res.inputTokens, res.outputTokens);
    this.usage.inputTokens += res.inputTokens ?? 0;
    this.usage.outputTokens += res.outputTokens ?? 0;
    this.usage.cost = this.usage.cost !== undefined && cost !== undefined ? this.usage.cost + cost : undefined;
    this.opts.budget?.add(cost);
    await this.opts.cache?.set(key, {
      text: res.text,
      inputTokens: res.inputTokens,
      outputTokens: res.outputTokens,
      latencyMs: performance.now() - started,
      createdAt: new Date().toISOString(),
    });
    return res.text;
  }
}
