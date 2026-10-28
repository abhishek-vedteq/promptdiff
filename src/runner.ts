import pLimit from "p-limit";
import { classify, type CaseStatus } from "./analysis.js";
import { evaluateAssertions, passRate, tally, type Assertion, type RubricGrader } from "./assertions.js";
import { transcript, type Judge, type Judgement } from "./judge.js";
import { cacheKey, type ResultCache } from "./cache.js";
import { caseInputKey, caseLabel, caseMessages, type TestCase } from "./cases.js";
import type { Budget } from "./estimate.js";
import { FatalProviderError, errorMessage } from "./errors.js";
import { estimateCost, type PricingTable } from "./pricing.js";
import type { Provider } from "./providers/types.js";
import { DEFAULT_RETRY, getStatusCode, isNetworkError, withRetry, type RetryOptions } from "./retry.js";
import type { CaseChecks, CaseResult, RunOutput, VersionTotals } from "./types.js";

export interface RunnerOptions {
  provider: Provider;
  /** "provider:model-id", used for cache keys and pricing. */
  modelSpec: string;
  /** Model id passed to the provider. */
  modelId: string;
  basePrompt: string;
  headPrompt: string;
  /** Renders the prompt for a case (template variables). Defaults to the raw base/head prompt. */
  promptFor?: (version: "base" | "head", tc: TestCase) => string;
  cases: TestCase[];
  runs: number;
  concurrency: number;
  temperature?: number;
  maxOutputTokens?: number;
  cache?: ResultCache;
  pricing: PricingTable;
  /** Assertions applied to every case (from the config file), before each case's own. */
  defaultAssertions?: Assertion[];
  /** Grades llm-rubric assertions and, with `semantic`, compares versions by meaning. */
  judge?: Judge;
  /** Let the judge decide whether non-identical outputs differ in a way that matters. */
  semantic?: boolean;
  retry?: RetryOptions;
  /** Aborting it cancels the run. */
  signal?: AbortSignal;
  /** Stops starting new API calls once actual spend reaches the limit. */
  budget?: Budget;
  onProgress?: (done: number, total: number) => void;
  onRetry?: (message: string) => void;
  /** Used to scrub API keys from error messages. */
  redact?: (message: string) => string;
}

type Version = "base" | "head";

/** Errors that will fail every request, so the whole run should stop. */
function toFatal(err: unknown, opts: RunnerOptions): FatalProviderError | undefined {
  const status = getStatusCode(err);
  const msg = (opts.redact ?? ((s: string) => s))(errorMessage(err));
  if (status === 401 || status === 403) {
    return new FatalProviderError(`${opts.provider.id} rejected the API key (HTTP ${status}): ${msg}`, {
      hint: `Check the key with \`promptdiff config list\`, or set a new one with \`promptdiff config set ${opts.provider.id}\`.`,
    });
  }
  if (status === 404) {
    return new FatalProviderError(`${opts.provider.id} returned 404 for model "${opts.modelId}": ${msg}`, {
      hint: "Check the model id is spelled correctly and that your account has access to it.",
    });
  }
  return undefined;
}

function describeError(err: unknown, opts: RunnerOptions): string {
  const redact = opts.redact ?? ((s: string) => s);
  const status = getStatusCode(err);
  if (isNetworkError(err)) {
    return redact(`Network error contacting ${opts.provider.id} (${errorMessage(err)}). Check your internet connection or proxy settings.`);
  }
  if (status !== undefined) return redact(`HTTP ${status}: ${errorMessage(err)}`);
  return redact(errorMessage(err));
}

export function totals(outputs: RunOutput[]): VersionTotals {
  let inputTokens = 0;
  let outputTokens = 0;
  let cost: number | undefined = 0;
  let latency = 0;
  for (const o of outputs) {
    inputTokens += o.inputTokens ?? 0;
    outputTokens += o.outputTokens ?? 0;
    latency += o.latencyMs;
    cost = cost !== undefined && o.cost !== undefined ? cost + o.cost : undefined;
  }
  return {
    inputTokens,
    outputTokens,
    cost: outputs.length ? cost : undefined,
    avgLatencyMs: outputs.length ? latency / outputs.length : 0,
    calls: outputs.length,
  };
}

export function sumTotals(list: VersionTotals[]): VersionTotals {
  let calls = 0;
  let latency = 0;
  let cost: number | undefined = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  for (const t of list) {
    calls += t.calls;
    latency += t.avgLatencyMs * t.calls;
    inputTokens += t.inputTokens;
    outputTokens += t.outputTokens;
    cost = cost !== undefined && t.cost !== undefined ? cost + t.cost : undefined;
  }
  return { inputTokens, outputTokens, cost: calls ? cost : undefined, avgLatencyMs: calls ? latency / calls : 0, calls };
}

/**
 * Runs every case `runs` times against both prompt versions (with a concurrency
 * limit, retries, and caching), then classifies each case.
 */
export async function runDiff(opts: RunnerOptions): Promise<CaseResult[]> {
  const limit = pLimit(opts.concurrency);
  const controller = new AbortController();
  let fatal: FatalProviderError | undefined;
  const stop = (err: FatalProviderError) => {
    if (fatal) return;
    fatal = err;
    controller.abort();
    limit.clearQueue();
  };
  const onCancel = () =>
    stop(new FatalProviderError("Cancelled.", { hint: "Finished results are cached, so running again picks up where this left off." }));
  if (opts.signal?.aborted) onCancel();
  opts.signal?.addEventListener("abort", onCancel, { once: true });
  const total = opts.cases.length * opts.runs * 2;
  let done = 0;
  opts.onProgress?.(0, total);

  const runOne = async (tc: TestCase, version: Version, runIndex: number): Promise<RunOutput> => {
    const prompt = opts.promptFor ? opts.promptFor(version, tc) : version === "base" ? opts.basePrompt : opts.headPrompt;
    const key = cacheKey({
      prompt,
      model: opts.modelSpec,
      temperature: opts.temperature,
      maxOutputTokens: opts.maxOutputTokens,
      input: caseInputKey(tc),
      runIndex,
    });
    const assertions = [...(opts.defaultAssertions ?? []), ...tc.assert];
    const judge = opts.judge;
    const grade: RubricGrader | undefined = judge ? (rubric, output) => judge.grade(rubric, output, transcript(tc)) : undefined;
    const finish = async (out: RunOutput): Promise<RunOutput> => {
      if (assertions.length > 0 && !out.error) {
        out.checks = await evaluateAssertions(assertions, out.text, grade);
      }
      done++;
      opts.onProgress?.(done, total);
      return out;
    };

    const hit = await opts.cache?.get(key);
    if (hit) {
      return finish({
        runIndex,
        text: hit.text,
        inputTokens: hit.inputTokens,
        outputTokens: hit.outputTokens,
        latencyMs: hit.latencyMs,
        cost: estimateCost(opts.pricing, opts.modelSpec, hit.inputTokens, hit.outputTokens),
        cached: true,
      });
    }
    if (fatal) return finish({ runIndex, text: "", latencyMs: 0, cached: false, error: "skipped after fatal error" });
    if (opts.budget?.exhausted) {
      stop(budgetError(opts.budget));
      return finish({ runIndex, text: "", latencyMs: 0, cached: false, error: "skipped: budget reached" });
    }

    try {
      let latencyMs = 0;
      const res = await withRetry(async () => {
        const started = performance.now();
        const r = await opts.provider.generate({
          model: opts.modelId,
          system: prompt,
          messages: caseMessages(tc),
          temperature: opts.temperature,
          maxOutputTokens: opts.maxOutputTokens,
          signal: controller.signal,
        });
        latencyMs = performance.now() - started;
        return r;
      }, {
        ...(opts.retry ?? DEFAULT_RETRY),
        onRetry: ({ attempt, delayMs, error }) =>
          opts.onRetry?.(`case "${tc.id}" (${version} run ${runIndex + 1}): ${describeError(error, opts)}; retry ${attempt} in ${(delayMs / 1000).toFixed(1)}s`),
      });
      const cost = estimateCost(opts.pricing, opts.modelSpec, res.inputTokens, res.outputTokens);
      opts.budget?.add(cost);
      await opts.cache?.set(key, {
        text: res.text,
        inputTokens: res.inputTokens,
        outputTokens: res.outputTokens,
        latencyMs,
        createdAt: new Date().toISOString(),
      });
      return finish({
        runIndex,
        text: res.text,
        inputTokens: res.inputTokens,
        outputTokens: res.outputTokens,
        latencyMs,
        cost,
        cached: false,
      });
    } catch (err) {
      const f = toFatal(err, opts);
      if (f) stop(f);
      return finish({ runIndex, text: "", latencyMs: 0, cached: false, error: describeError(err, opts) });
    }
  };

  // clearQueue() leaves queued promises pending forever, so race them against the abort.
  const abortPromise = aborted(controller.signal);
  const settle = (ps: Promise<RunOutput>[]) => Promise.all(ps.map((p) => Promise.race([p, abortPromise])));

  const evaluateCase = async (tc: TestCase, base: Promise<RunOutput>[], head: Promise<RunOutput>[]): Promise<CaseResult | undefined> => {
    const baseOut = await settle(base);
    const headOut = await settle(head);
    if (fatal) return undefined;
    const hasError = [...baseOut, ...headOut].some((o) => o.error);
    const classified = hasError ? undefined : classify(baseOut.map((o) => o.text), headOut.map((o) => o.text));
    let status: CaseStatus = classified?.status ?? "error";

    let judgement: Judgement | undefined;
    if (opts.semantic && opts.judge && classified && status !== "identical") {
      const judge = opts.judge;
      const compared = await Promise.race([
        limit(() =>
          judge
            .compare(transcript(tc), baseOut.map((o) => o.text), headOut.map((o) => o.text))
            .then((r): Judgement => r)
            .catch((err: unknown): Judgement => ({ error: describeError(err, opts) })),
        ),
        abortPromise.then((): Judgement => ({ error: "aborted" })),
      ]);
      judgement = compared;
      if (compared.verdict) status = compared.verdict === "different" ? "changed" : "noise";
    }

    return {
      id: tc.id,
      input: caseLabel(tc),
      ...(tc.messages ? { messages: tc.messages } : {}),
      ...(Object.keys(tc.vars).length ? { vars: tc.vars } : {}),
      status,
      stats: classified?.stats,
      ...(judgement ? { judgement } : {}),
      checks: hasError ? undefined : caseChecks(baseOut, headOut),
      base: baseOut,
      head: headOut,
      baseTotals: totals(baseOut),
      headTotals: totals(headOut),
    };
  };

  const pending = opts.cases.map((tc) => {
    const runs = (version: Version) =>
      Array.from({ length: opts.runs }, (_, i) => limit(() => runOne(tc, version, i)));
    return evaluateCase(tc, runs("base"), runs("head"));
  });
  const results = await Promise.all(pending);
  opts.signal?.removeEventListener("abort", onCancel);
  if (fatal) throw fatal;
  return results.filter((r): r is CaseResult => r !== undefined);
}

function budgetError(budget: Budget): FatalProviderError {
  return new FatalProviderError(
    `Stopped: spent $${budget.spent.toFixed(4)}, reaching the --max-cost budget of $${budget.limit}.`,
    { hint: "Completed results are cached, so re-running with a higher --max-cost only pays for the remaining calls." },
  );
}

function caseChecks(base: RunOutput[], head: RunOutput[]): CaseChecks | undefined {
  if (!base.some((o) => o.checks?.length)) return undefined;
  const b = tally(base.map((o) => o.checks ?? []));
  const h = tally(head.map((o) => o.checks ?? []));
  return { base: b, head: h, regression: passRate(h) < passRate(b), fixed: passRate(h) > passRate(b) };
}

function aborted(signal: AbortSignal): Promise<RunOutput> {
  return new Promise((resolve) => {
    const done = () => resolve({ runIndex: -1, text: "", latencyMs: 0, cached: false, error: "aborted" });
    if (signal.aborted) done();
    else signal.addEventListener("abort", done, { once: true });
  });
}
