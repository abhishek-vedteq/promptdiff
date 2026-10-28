import path from "node:path";
import { describe, expect, it } from "vitest";
import { ResultCache, cacheKey } from "../src/cache.js";
import { Budget, DEFAULT_OUTPUT_TOKENS, planRun, type PlanOptions } from "../src/estimate.js";
import { makeCase, tempDir } from "./helpers.js";

const base = (extra: Partial<PlanOptions> = {}): PlanOptions => ({
  cases: [makeCase("a", "x".repeat(400)), makeCase("b", "y".repeat(400))],
  promptFor: (v) => (v === "base" ? "p".repeat(400) : "q".repeat(400)),
  inputFor: (tc) => tc.input ?? "",
  runs: 2,
  modelSpec: "anthropic:m",
  pricing: { "anthropic:m": { input: 1, output: 10 } },
  ...extra,
});

describe("planRun", () => {
  it("counts calls and estimates tokens and cost", async () => {
    const plan = await planRun(base());
    expect(plan.totalCalls).toBe(8);
    expect(plan.generation.calls).toBe(8);
    expect(plan.generation.inputTokens).toBe(8 * 200); // (400 + 400 chars) / 4
    expect(plan.generation.outputTokens).toBe(8 * DEFAULT_OUTPUT_TOKENS);
    expect(plan.cost).toBeCloseTo((1600 * 1 + 4000 * 10) / 1e6);
    expect(plan.worstCaseCost).toBeUndefined();
  });

  it("treats cached calls as free and learns output length from the cache", async () => {
    const cache = new ResultCache(path.join(tempDir(), "c"));
    const opts = base({ cache });
    const key = cacheKey({ prompt: "p".repeat(400), model: "anthropic:m", input: "x".repeat(400), runIndex: 0 });
    await cache.set(key, { text: "t", inputTokens: 1, outputTokens: 40, latencyMs: 1, createdAt: "" });
    const plan = await planRun(opts);
    expect(plan.cachedCalls).toBe(1);
    expect(plan.generation.calls).toBe(7);
    expect(plan.assumedOutputTokens).toBe(40);
  });

  it("caps assumed output at maxOutputTokens and reports a worst case", async () => {
    const plan = await planRun(base({ maxOutputTokens: 100 }));
    expect(plan.assumedOutputTokens).toBe(100);
    const big = await planRun(base({ maxOutputTokens: 4000 }));
    expect(big.worstCaseCost).toBeGreaterThan(big.cost!);
  });

  it("reports unknown cost for unpriced models", async () => {
    expect((await planRun(base({ pricing: {} }))).cost).toBeUndefined();
  });
});

describe("Budget", () => {
  it("is exhausted once spend reaches the limit", () => {
    const b = new Budget(1);
    b.add(0.6);
    expect(b.exhausted).toBe(false);
    b.add(0.4);
    expect(b.exhausted).toBe(true);
    expect(new Budget().exhausted).toBe(false);
  });
});
