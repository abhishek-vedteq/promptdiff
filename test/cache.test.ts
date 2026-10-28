import path from "node:path";
import { describe, expect, it } from "vitest";
import { ResultCache, cacheKey } from "../src/cache.js";
import { MockProvider } from "../src/providers/mock.js";
import { runDiff } from "../src/runner.js";
import { makeCase, tempDir } from "./helpers.js";

const parts = { prompt: "p", model: "mock:m", temperature: 0.5, input: "i", runIndex: 0 };

describe("cacheKey", () => {
  it("is stable", () => {
    expect(cacheKey(parts)).toBe(cacheKey({ ...parts }));
    expect(cacheKey(parts)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when any component changes", () => {
    const base = cacheKey(parts);
    for (const change of [
      { prompt: "p2" },
      { model: "mock:other" },
      { temperature: 0.6 },
      { temperature: undefined },
      { input: "i2" },
      { runIndex: 1 },
      { maxOutputTokens: 100 },
    ]) {
      expect(cacheKey({ ...parts, ...change })).not.toBe(base);
    }
  });

  it("does not collide when fields shift content", () => {
    expect(cacheKey({ ...parts, prompt: "ab", input: "c" })).not.toBe(cacheKey({ ...parts, prompt: "a", input: "bc" }));
  });
});

describe("ResultCache", () => {
  it("round-trips values and misses cleanly", async () => {
    const cache = new ResultCache(path.join(tempDir(), "cache"));
    const key = cacheKey(parts);
    expect(await cache.get(key)).toBeUndefined();
    await cache.set(key, { text: "hi", inputTokens: 1, outputTokens: 2, latencyMs: 3, createdAt: "now" });
    expect(await cache.get(key)).toMatchObject({ text: "hi", outputTokens: 2 });
  });

  it("makes re-runs free", async () => {
    const cache = new ResultCache(path.join(tempDir(), "cache"));
    const provider = new MockProvider();
    const opts = {
      provider,
      modelSpec: "mock:m",
      modelId: "m",
      basePrompt: "old",
      headPrompt: "new",
      cases: [makeCase("a", "x", { line: 1 }), makeCase("b", "y", { line: 2 })],
      runs: 2,
      concurrency: 2,
      cache,
      pricing: {},
    };
    const first = await runDiff(opts);
    expect(provider.calls).toHaveLength(8);
    expect(first[0]!.base.every((o) => !o.cached)).toBe(true);

    const second = await runDiff(opts);
    expect(provider.calls).toHaveLength(8); // no new calls
    expect(second[0]!.base.every((o) => o.cached)).toBe(true);
    expect(second.map((r) => r.status)).toEqual(first.map((r) => r.status));

    await runDiff({ ...opts, headPrompt: "newer" });
    expect(provider.calls).toHaveLength(12); // only head calls re-run
  });
});
