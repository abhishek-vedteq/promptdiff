import { APICallError, RetryError } from "ai";

export interface RetryOptions {
  /** Retries after the first attempt. */
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Injected for tests. */
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
}

export const DEFAULT_RETRY: RetryOptions = { maxRetries: 5, baseDelayMs: 1000, maxDelayMs: 30_000 };

const NETWORK_CODES = new Set([
  "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "EPIPE",
  "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT",
]);

/** Unwraps the AI SDK's RetryError to the underlying error. */
export function unwrapError(err: unknown): unknown {
  return RetryError.isInstance(err) ? err.lastError : err;
}

export function getStatusCode(err: unknown): number | undefined {
  const e = unwrapError(err);
  if (APICallError.isInstance(e)) return e.statusCode;
  const status = (e as { status?: unknown; statusCode?: unknown } | null)?.status ??
    (e as { statusCode?: unknown } | null)?.statusCode;
  return typeof status === "number" ? status : undefined;
}

export function isNetworkError(err: unknown): boolean {
  let e: unknown = unwrapError(err);
  for (let depth = 0; e && depth < 5; depth++) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code && NETWORK_CODES.has(code)) return true;
    if (e instanceof TypeError && /fetch failed/i.test(e.message)) return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/** 429 (rate limit), 408/409, 5xx, 529 (overloaded), and network errors are retried. */
export function isRetryable(err: unknown): boolean {
  const status = getStatusCode(err);
  if (status !== undefined) return status === 408 || status === 409 || status === 429 || status >= 500;
  const e = unwrapError(err);
  if (APICallError.isInstance(e)) return e.isRetryable;
  return isNetworkError(e);
}

function retryAfterMs(err: unknown): number | undefined {
  const e = unwrapError(err);
  if (!APICallError.isInstance(e)) return undefined;
  const value = e.responseHeaders?.["retry-after"];
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

export function backoffDelay(attempt: number, opts: RetryOptions, err?: unknown): number {
  const hinted = err !== undefined ? retryAfterMs(err) : undefined;
  if (hinted !== undefined) return Math.min(hinted, opts.maxDelayMs);
  const exp = opts.baseDelayMs * 2 ** (attempt - 1);
  const jitter = Math.random() * opts.baseDelayMs;
  return Math.min(exp + jitter, opts.maxDelayMs);
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Calls `fn`, retrying transient failures with exponential backoff and jitter. */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = DEFAULT_RETRY): Promise<T> {
  const sleep = opts.sleep ?? defaultSleep;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= opts.maxRetries || !isRetryable(err)) throw err;
      const delayMs = backoffDelay(attempt + 1, opts, err);
      opts.onRetry?.({ attempt: attempt + 1, delayMs, error: err });
      await sleep(delayMs);
    }
  }
}
