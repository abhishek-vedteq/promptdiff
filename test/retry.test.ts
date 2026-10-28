import { APICallError } from "ai";
import { describe, expect, it, vi } from "vitest";
import { isRetryable, withRetry } from "../src/retry.js";

const apiError = (statusCode: number, headers?: Record<string, string>) =>
  new APICallError({ message: `HTTP ${statusCode}`, url: "https://x", requestBodyValues: {}, statusCode, responseHeaders: headers });

const fast = { maxRetries: 3, baseDelayMs: 10, maxDelayMs: 1000 };

describe("retry", () => {
  it("classifies errors", () => {
    expect(isRetryable(apiError(429))).toBe(true);
    expect(isRetryable(apiError(529))).toBe(true);
    expect(isRetryable(apiError(500))).toBe(true);
    expect(isRetryable(apiError(400))).toBe(false);
    expect(isRetryable(apiError(401))).toBe(false);
    expect(isRetryable(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } }))).toBe(true);
    expect(isRetryable(new Error("boom"))).toBe(false);
  });

  it("retries rate limits with exponential backoff, then succeeds", async () => {
    const sleeps: number[] = [];
    const fn = vi.fn()
      .mockRejectedValueOnce(apiError(429))
      .mockRejectedValueOnce(apiError(503))
      .mockResolvedValue("ok");
    const result = await withRetry(fn, { ...fast, sleep: async (ms) => void sleeps.push(ms) });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleeps[0]).toBeGreaterThanOrEqual(10);
    expect(sleeps[1]).toBeGreaterThanOrEqual(20);
  });

  it("honors retry-after", async () => {
    const sleeps: number[] = [];
    const fn = vi.fn().mockRejectedValueOnce(apiError(429, { "retry-after": "0.5" })).mockResolvedValue("ok");
    await withRetry(fn, { ...fast, sleep: async (ms) => void sleeps.push(ms) });
    expect(sleeps).toEqual([500]);
  });

  it("does not retry client errors and gives up after maxRetries", async () => {
    const bad = vi.fn().mockRejectedValue(apiError(400));
    await expect(withRetry(bad, { ...fast, sleep: async () => {} })).rejects.toThrow("HTTP 400");
    expect(bad).toHaveBeenCalledTimes(1);

    const limited = vi.fn().mockRejectedValue(apiError(429));
    await expect(withRetry(limited, { ...fast, sleep: async () => {} })).rejects.toThrow("HTTP 429");
    expect(limited).toHaveBeenCalledTimes(4);
  });
});
