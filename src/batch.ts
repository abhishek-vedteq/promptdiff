/**
 * Batch mode (--batch): send every uncached call as one provider batch job, which providers
 * price at about half. Results arrive later (minutes to hours), go into the result cache, and
 * the normal comparison then reads them from there. The batch id is saved, so stopping and
 * re-running resumes waiting instead of paying for a second batch.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { experimental_getBatchResults, experimental_getBatchStatus, experimental_startBatch, type Experimental_BatchProvider, type Experimental_BatchReference } from "ai";
import { PromptdiffError } from "./errors.js";
import type { ChatMessage } from "./providers/types.js";

export interface BatchRequest {
  /** Becomes the cache key, so results can be matched back. */
  id: string;
  model: string;
  system: string;
  messages: ChatMessage[];
  temperature?: number;
  maxOutputTokens?: number;
}

export type BatchItem = { id: string; text: string; inputTokens?: number; outputTokens?: number } | { id: string; error: string };

export interface BatchProgress {
  state: "pending" | "completed" | "failed";
  total?: number;
  completed?: number;
  failed?: number;
}

/** The three operations promptdiff needs from a batch service (real: the AI SDK; tests: a fake). */
export interface BatchClient {
  start(requests: BatchRequest[]): Promise<Experimental_BatchReference>;
  status(ref: Experimental_BatchReference): Promise<BatchProgress>;
  results(ref: Experimental_BatchReference): AsyncIterable<BatchItem>;
}

/** A BatchClient backed by an AI SDK provider instance (anthropic, openai, google…). */
export function aiSdkBatchClient(provider: Experimental_BatchProvider): BatchClient {
  return {
    async start(requests) {
      const started = await experimental_startBatch({
        provider,
        requests: requests.map((r) => ({
          id: r.id,
          type: "text" as const,
          model: r.model,
          instructions: r.system,
          messages: r.messages.map((m) => ({ role: m.role, content: m.content })),
          ...(r.temperature !== undefined ? { temperature: r.temperature } : {}),
          ...(r.maxOutputTokens !== undefined ? { maxOutputTokens: r.maxOutputTokens } : {}),
        })),
      });
      return { version: started.version, id: started.id, provider: started.provider };
    },
    async status(ref) {
      const s = await experimental_getBatchStatus({ provider, batch: ref });
      return { state: s.status, total: s.requestCounts?.total, completed: s.requestCounts?.completed, failed: s.requestCounts?.failed };
    },
    async *results(ref) {
      for await (const item of experimental_getBatchResults({ provider, batch: ref })) {
        if (item.type !== "text") continue;
        if (item.status === "succeeded") {
          yield { id: item.id, text: item.text, inputTokens: item.usage.inputTokens, outputTokens: item.usage.outputTokens };
        } else {
          yield { id: item.id, error: item.status === "failed" ? (item.error?.message ?? "failed") : item.status };
        }
      }
    },
  };
}

export interface RunBatchOptions {
  client: BatchClient;
  requests: BatchRequest[];
  /** Where to remember the batch id, for resuming. */
  stateDir: string;
  onProgress?: (p: BatchProgress & { batchId: string; resumed: boolean }) => void;
  signal?: AbortSignal;
  /** Injected for tests. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });

/** Submits (or resumes) a batch, waits for it, and returns every item's result. */
export async function runBatch(opts: RunBatchOptions): Promise<BatchItem[]> {
  if (opts.requests.length === 0) return [];
  const fingerprint = createHash("sha256").update(opts.requests.map((r) => r.id).sort().join("\n")).digest("hex").slice(0, 20);
  const stateFile = path.join(opts.stateDir, `${fingerprint}.json`);

  let ref: Experimental_BatchReference | undefined;
  let resumed = false;
  try {
    ref = JSON.parse(await readFile(stateFile, "utf8")) as Experimental_BatchReference;
    resumed = true;
  } catch {
    ref = undefined;
  }
  if (!ref) {
    ref = await opts.client.start(opts.requests);
    await mkdir(opts.stateDir, { recursive: true });
    await writeFile(stateFile, JSON.stringify(ref));
  }

  // Poll: quickly at first, then every minute.
  const sleep = opts.sleep ?? ((ms: number) => defaultSleep(ms, opts.signal));
  let delay = 5_000;
  for (;;) {
    if (opts.signal?.aborted) {
      throw new PromptdiffError(`Stopped waiting. The batch (${ref.id}) keeps running at the provider.`, {
        hint: "Run the same command again to pick up its results; nothing is charged twice.",
      });
    }
    const progress = await opts.client.status(ref);
    opts.onProgress?.({ ...progress, batchId: ref.id, resumed });
    if (progress.state === "failed") {
      await rm(stateFile, { force: true });
      throw new PromptdiffError(`The batch (${ref.id}) failed at the provider.`, { hint: "Run again to submit a new batch, or drop --batch to run calls one by one." });
    }
    if (progress.state === "completed") break;
    await sleep(delay);
    delay = Math.min(delay * 2, 60_000);
  }

  const items: BatchItem[] = [];
  for await (const item of opts.client.results(ref)) items.push(item);
  await rm(stateFile, { force: true });
  return items;
}
