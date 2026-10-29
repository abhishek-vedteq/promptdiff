import { existsSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { BatchClient, BatchRequest } from "../src/batch.js";
import { runCommand } from "../src/commands/run.js";
import { MockProvider } from "../src/providers/mock.js";
import type { DiffReport } from "../src/types.js";
import { Sink, makeRepo, tempDir } from "./helpers.js";

/** A batch service that finishes after `polls` status checks; optionally fails some items. */
function fakeBatch(polls = 2, failIds = new Set<string>()) {
  const started: BatchRequest[][] = [];
  let checks = 0;
  const client: BatchClient = {
    async start(requests) {
      started.push(requests);
      return { version: 2, id: `batch_${started.length}`, provider: "fake" };
    },
    async status() {
      checks++;
      return { state: checks >= polls ? "completed" : "pending", total: started.at(-1)?.length, completed: checks >= polls ? started.at(-1)?.length : 0 };
    },
    async *results() {
      for (const r of started.at(-1) ?? []) {
        if (failIds.has(r.id)) yield { id: r.id, error: "overloaded" };
        else yield { id: r.id, text: `batched: ${r.system.trim()} / ${r.messages[0]!.content}`, inputTokens: 3, outputTokens: 4 };
      }
    },
  };
  return { client, started, checks: () => checks };
}

function repo() {
  const dir = makeRepo({ "p.md": "Old\n", "cases.jsonl": '{"id": "a", "input": "hi"}\n{"id": "b", "input": "yo"}', "promptdiff.config.yaml": "model: anthropic:some-model\n" });
  writeFileSync(path.join(dir, "p.md"), "New\n");
  return dir;
}

const deps = (dir: string, client: BatchClient, provider = new MockProvider()) => ({
  cwd: dir,
  env: { ANTHROPIC_API_KEY: "sk-ant-test-batch-0001" },
  stdout: new Sink(),
  stderr: new Sink(),
  createProvider: () => provider,
  createBatchClient: () => client,
  batchSleep: async () => {},
  userConfigFile: path.join(tempDir(), "c.json"),
});

describe("--batch", () => {
  it("sends every call in one batch and compares the results, with no direct calls", async () => {
    const dir = repo();
    const fake = fakeBatch();
    const provider = new MockProvider();
    const d = deps(dir, fake.client, provider);
    await runCommand("p.md", { json: true, batch: true }, d);
    expect(fake.started).toHaveLength(1);
    expect(fake.started[0]).toHaveLength(4); // 2 cases × 2 versions
    expect(new Set(fake.started[0]!.map((r) => r.model))).toEqual(new Set(["some-model"]));
    expect(provider.calls).toHaveLength(0);
    const report = JSON.parse(d.stdout.data) as DiffReport;
    expect(report.cases[0]!.head[0]!.text).toBe("batched: New / hi");
    expect(report.summary.changed).toBe(2);
    expect(d.stderr.data).toContain("Batch done: 4 of 4 results");
    expect(readdirSync(path.join(dir, ".promptdiff", "batches"))).toEqual([]); // state cleaned up
  });

  it("resumes a batch that was started before instead of paying twice", async () => {
    const dir = repo();
    const first = fakeBatch(99);
    const controller = new AbortController();
    const d1 = { ...deps(dir, first.client), signal: controller.signal, batchSleep: async () => controller.abort() };
    await expect(runCommand("p.md", { json: true, batch: true }, d1)).rejects.toThrow(/keeps running at the provider/);
    expect(readdirSync(path.join(dir, ".promptdiff", "batches"))).toHaveLength(1);

    // The same batch finishes; a new run must not start another one.
    const second = fakeBatch(1);
    second.started.push(first.started[0]!);
    const startSpy = second.client.start;
    let startedAgain = false;
    second.client.start = async (r) => ((startedAgain = true), startSpy(r));
    await runCommand("p.md", { json: true, batch: true }, deps(dir, second.client));
    expect(startedAgain).toBe(false);
  });

  it("runs failed batch items one by one, and refuses --no-cache", async () => {
    const dir = repo();
    const probe = fakeBatch();
    await runCommand("p.md", { json: true, batch: true, dryRun: true }, deps(dir, probe.client));
    const provider = new MockProvider();
    const failing = fakeBatch(1, new Set<string>());
    const d = deps(dir, failing.client, provider);
    failing.client.results = async function* () {
      for (const [i, r] of (failing.started.at(-1) ?? []).entries()) yield i === 0 ? { id: r.id, error: "overloaded" } : { id: r.id, text: "ok", inputTokens: 1, outputTokens: 1 };
    };
    await runCommand("p.md", { json: true, batch: true }, d);
    expect(provider.calls).toHaveLength(1);
    expect(d.stderr.data).toContain("1 failed and will run one by one");
    await expect(runCommand("p.md", { batch: true, cache: false }, deps(dir, failing.client))).rejects.toThrow(/can't be combined with --no-cache/);
    expect(existsSync(path.join(dir, ".promptdiff"))).toBe(true);
  });
});
