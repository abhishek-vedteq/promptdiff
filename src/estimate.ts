import { cacheKey, type ResultCache } from "./cache.js";
import type { TestCase } from "./cases.js";
import { estimateCost, type PricingTable } from "./pricing.js";

/** Rough token count. Real tokenizers vary by model; ~4 characters per token is typical for English. */
export const estimateTokens = (chars: number) => Math.ceil(chars / 4);

/** Output length assumed for uncached calls when there's no cached history to learn from. */
export const DEFAULT_OUTPUT_TOKENS = 500;

export interface PlannedCall {
  version: "base" | "head";
  caseId: string;
  runIndex: number;
  inputTokens: number;
  cached: boolean;
}

export interface CostLine {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  /** Undefined when the model has no pricing entry. */
  cost?: number;
}

export interface RunPlan {
  totalCalls: number;
  cachedCalls: number;
  /** Calls to the model under test that will actually hit the API. */
  generation: CostLine;
  /** Calls to the judge model (llm-rubric checks and semantic comparison). */
  judge: CostLine;
  /** Output tokens assumed per uncached generation call. */
  assumedOutputTokens: number;
  /** Total estimated cost, or undefined if any part can't be priced. */
  cost?: number;
  /** Cost if every uncached call used the full max output tokens (only when maxOutputTokens is set). */
  worstCaseCost?: number;
}

export interface PlanOptions {
  cases: TestCase[];
  /** Renders the prompt for a case (handles template variables). */
  promptFor: (version: "base" | "head", tc: TestCase) => string;
  /** Serialized input for a case, as used in cache keys. */
  inputFor: (tc: TestCase) => string;
  runs: number;
  modelSpec: string;
  temperature?: number;
  maxOutputTokens?: number;
  cache?: ResultCache;
  pricing: PricingTable;
  /** Judge calls expected per generated output (llm-rubric checks for the case). */
  judgeCallsPerOutput?: (tc: TestCase) => number;
  /** Whether each case needs one semantic-comparison judge call. */
  semanticCompare?: boolean;
  judgeSpec?: string;
}

/** Judge prompts are small; reasoning models may think more, so this errs high. */
const JUDGE_OVERHEAD_TOKENS = 300;
const JUDGE_OUTPUT_TOKENS = 150;

/**
 * Estimates how many API calls and tokens a run will use, and what it will cost,
 * before anything is sent. Cached results count as free.
 */
export async function planRun(opts: PlanOptions): Promise<RunPlan> {
  const calls: PlannedCall[] = [];
  const cachedOutputTokens: number[] = [];

  for (const tc of opts.cases) {
    for (const version of ["base", "head"] as const) {
      const prompt = opts.promptFor(version, tc);
      const input = opts.inputFor(tc);
      for (let runIndex = 0; runIndex < opts.runs; runIndex++) {
        const key = cacheKey({
          prompt,
          model: opts.modelSpec,
          temperature: opts.temperature,
          maxOutputTokens: opts.maxOutputTokens,
          input,
          runIndex,
        });
        const hit = await opts.cache?.get(key);
        if (hit?.outputTokens !== undefined) cachedOutputTokens.push(hit.outputTokens);
        calls.push({ version, caseId: tc.id, runIndex, inputTokens: estimateTokens(prompt.length + input.length), cached: !!hit });
      }
    }
  }

  const learned = cachedOutputTokens.length
    ? Math.round(cachedOutputTokens.reduce((a, b) => a + b, 0) / cachedOutputTokens.length)
    : undefined;
  const assumedOutputTokens = Math.min(learned ?? DEFAULT_OUTPUT_TOKENS, opts.maxOutputTokens ?? Infinity);

  const uncached = calls.filter((c) => !c.cached);
  const generation: CostLine = {
    calls: uncached.length,
    inputTokens: uncached.reduce((n, c) => n + c.inputTokens, 0),
    outputTokens: uncached.length * assumedOutputTokens,
  };
  generation.cost = generation.calls === 0 ? 0 : estimateCost(opts.pricing, opts.modelSpec, generation.inputTokens, generation.outputTokens);

  // Judge calls only happen for outputs that aren't cached (cached outputs have cached grades).
  const casesById = new Map(opts.cases.map((tc) => [tc.id, tc]));
  let judgeCalls = 0;
  let judgeInput = 0;
  const casesNeedingCompare = new Set<string>();
  for (const call of uncached) {
    const tc = casesById.get(call.caseId)!;
    const n = opts.judgeCallsPerOutput?.(tc) ?? 0;
    judgeCalls += n;
    judgeInput += n * (estimateTokens(opts.inputFor(tc).length) + assumedOutputTokens + JUDGE_OVERHEAD_TOKENS);
    casesNeedingCompare.add(call.caseId);
  }
  if (opts.semanticCompare) {
    for (const id of casesNeedingCompare) {
      const tc = casesById.get(id)!;
      judgeCalls++;
      judgeInput += estimateTokens(opts.inputFor(tc).length) + 2 * opts.runs * assumedOutputTokens + JUDGE_OVERHEAD_TOKENS;
    }
  }
  const judge: CostLine = { calls: judgeCalls, inputTokens: judgeInput, outputTokens: judgeCalls * JUDGE_OUTPUT_TOKENS };
  judge.cost = judgeCalls === 0 ? 0 : opts.judgeSpec ? estimateCost(opts.pricing, opts.judgeSpec, judge.inputTokens, judge.outputTokens) : undefined;

  const cost = generation.cost !== undefined && judge.cost !== undefined ? generation.cost + judge.cost : undefined;
  let worstCaseCost: number | undefined;
  if (opts.maxOutputTokens !== undefined && generation.calls > 0) {
    const worstGen = estimateCost(opts.pricing, opts.modelSpec, generation.inputTokens, generation.calls * opts.maxOutputTokens);
    worstCaseCost = worstGen !== undefined && judge.cost !== undefined ? worstGen + judge.cost : undefined;
  }

  return {
    totalCalls: calls.length,
    cachedCalls: calls.length - uncached.length,
    generation,
    judge,
    assumedOutputTokens,
    cost,
    worstCaseCost,
  };
}

/** Tracks actual spend during a run and refuses to start calls once the budget is used up. */
export class Budget {
  spent = 0;
  constructor(readonly limit?: number) {}

  add(cost: number | undefined): void {
    if (cost !== undefined) this.spent += cost;
  }

  get exhausted(): boolean {
    return this.limit !== undefined && this.spent >= this.limit;
  }
}
