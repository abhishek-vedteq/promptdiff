import { writeFileSync } from "node:fs";
import path from "node:path";
import { APICallError } from "ai";
import { describe, expect, it } from "vitest";
import { EXIT_CHANGED, EXIT_ERROR, EXIT_OK, runCommand } from "../src/commands/run.js";
import { MockProvider } from "../src/providers/mock.js";
import type { DiffReport } from "../src/types.js";
import { Sink, makeRepo, tempDir } from "./helpers.js";

const CASES = '{"id":"a","input":"hello"}\n{"id":"b","input":"bye"}\n';

function setup(config = "model: mock:m\n") {
  const repo = makeRepo({ "prompts/p.md": "Version one\n", "cases.jsonl": CASES, "promptdiff.config.yaml": config });
  return repo;
}

async function run(repo: string, cli: Record<string, unknown>, provider = new MockProvider(), env: NodeJS.ProcessEnv = {}) {
  const stdout = new Sink();
  const stderr = new Sink();
  const code = await runCommand("prompts/p.md", { cache: false, ...cli }, {
    cwd: repo,
    env,
    stdout,
    stderr,
    createProvider: () => provider,
    retry: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 1 },
    userConfigFile: path.join(tempDir(), "config.json"),
  });
  return { code, stdout: stdout.data, stderr: stderr.data, provider };
}

describe("runCommand", () => {
  it("reports identical when the prompt is unchanged", async () => {
    const repo = setup();
    const { code, stdout } = await run(repo, {});
    expect(code).toBe(EXIT_OK);
    expect(stdout).toMatch(/0 changed · 0 noise · 2 identical/);
  });

  it("sends the prompt as system and the case as user input", async () => {
    const repo = setup();
    writeFileSync(path.join(repo, "prompts/p.md"), "Version two\n");
    const { provider } = await run(repo, { json: true });
    const systems = new Set(provider.calls.map((c) => c.system));
    expect(systems).toEqual(new Set(["Version one\n", "Version two\n"]));
    expect(new Set(provider.calls.map((c) => c.messages[0]!.content))).toEqual(new Set(["hello", "bye"]));
    expect(provider.calls[0]!.model).toBe("m");
    expect(provider.calls[0]!.temperature).toBeUndefined();
  });

  it("detects changes and returns 2 only with --fail-on-change", async () => {
    const repo = setup();
    writeFileSync(path.join(repo, "prompts/p.md"), "Version two\n");
    expect((await run(repo, {})).code).toBe(EXIT_OK);
    const { code, stdout } = await run(repo, { json: true, failOnChange: true });
    expect(code).toBe(EXIT_CHANGED);
    const report = JSON.parse(stdout) as DiffReport;
    expect(report.summary.changed).toBe(2);
    expect(report.meta.headRef).toBe("working copy");
    expect(report.cases[0]!.base[0]!.text).toContain("Version one");
  });

  it("CLI flags override the project config", async () => {
    const repo = setup("model: mock:from-config\nruns: 2\n");
    const { provider } = await run(repo, { model: "mock:from-flag", runs: "3" });
    expect(provider.calls[0]!.model).toBe("from-flag");
    expect(provider.calls).toHaveLength(2 * 2 * 3);
  });

  it("returns 1 and records errors when calls keep failing", async () => {
    const repo = setup();
    const failing = new MockProvider(() => {
      throw new APICallError({ message: "overloaded", url: "x", requestBodyValues: {}, statusCode: 529 });
    });
    const { code, stdout } = await run(repo, {}, failing);
    expect(code).toBe(EXIT_ERROR);
    expect(stdout).toContain("ERROR");
    expect(stdout).toContain("HTTP 529");
  });

  it("aborts on auth errors without leaking the key", async () => {
    const repo = setup("model: anthropic:some-model\n");
    const key = "sk-ant-api03-THISISSECRET-wxyz";
    const failing = new MockProvider(() => {
      throw new APICallError({ message: `invalid x-api-key ${key}`, url: "x", requestBodyValues: {}, statusCode: 401 });
    });
    const err = await run(repo, {}, failing, { ANTHROPIC_API_KEY: key }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("rejected the API key");
    expect((err as Error).message).not.toContain("THISISSECRET");
    expect((err as Error).message).toContain("sk-...wxyz");
  });

  it("explains how to set a missing key", async () => {
    const repo = setup("model: openai:some-model\n");
    await expect(run(repo, {})).rejects.toMatchObject({
      message: expect.stringContaining("No API key found for OpenAI"),
      hint: expect.stringContaining("promptdiff config set openai"),
    });
  });

  it("compares two refs with --head", async () => {
    const repo = setup();
    const { code, stdout } = await run(repo, { base: "main", head: "HEAD", json: true });
    expect(code).toBe(EXIT_OK);
    expect(JSON.parse(stdout).meta.headRef).toBe("HEAD");
  });

  it("writes an HTML report", async () => {
    const repo = setup();
    writeFileSync(path.join(repo, "prompts/p.md"), "Version two\n");
    const { stderr } = await run(repo, { html: "out/../report.html" });
    expect(stderr).toContain("HTML report written to report.html");
  });

  it("shows cost when the model is priced", async () => {
    const repo = makeRepo({
      "prompts/p.md": "v1",
      "cases.jsonl": CASES,
      "promptdiff.config.yaml": "model: mock:m\n",
      "promptdiff.pricing.json": '{"models": {"mock:m": {"input": 1, "output": 1}}}',
    });
    const report = JSON.parse((await run(repo, { json: true })).stdout) as DiffReport;
    expect(report.meta.pricingKnown).toBe(true);
    expect(report.summary.base.cost).toBeGreaterThan(0);
  });
});

describe("runCommand with assertions", () => {
  const cases = [
    '{"id": "a", "input": "hello", "assert": [{"type": "contains", "value": "Version one"}]}',
    '{"id": "b", "input": "bye"}',
  ].join("\n");

  it("flags regressions, applies config assertions, and fails with --fail-on-regression", async () => {
    const repo = makeRepo({
      "prompts/p.md": "Version one\n",
      "cases.jsonl": cases,
      "promptdiff.config.yaml": 'model: mock:m\nassert:\n  - type: max-words\n    value: 50\n',
    });
    writeFileSync(path.join(repo, "prompts/p.md"), "Version two\n");
    const { code, stdout } = await run(repo, { json: true, failOnRegression: true });
    expect(code).toBe(EXIT_CHANGED);
    const report = JSON.parse(stdout) as DiffReport;
    const a = report.cases.find((c) => c.id === "a")!;
    expect(a.checks).toMatchObject({ base: { passed: 2, total: 2 }, head: { passed: 1, total: 2 }, regression: true });
    expect(report.cases.find((c) => c.id === "b")!.checks).toMatchObject({ head: { passed: 1, total: 1 }, regression: false });
    expect(report.summary.checks).toMatchObject({ regressions: 1, fixed: 0, headFailures: 1 });

    const text = await run(repo, {});
    expect(text.code).toBe(EXIT_OK);
    expect(text.stdout).toContain("REGRESSION");
    expect(text.stdout).toContain('✗ contains "Version one"');
  });

  it("--fail-on-check fails when any new-prompt check fails, even without a regression", async () => {
    const repo = makeRepo({
      "prompts/p.md": "Version one\n",
      "cases.jsonl": '{"input": "x", "assert": [{"type": "contains", "value": "never"}]}',
      "promptdiff.config.yaml": "model: mock:m\n",
    });
    expect((await run(repo, { failOnRegression: true })).code).toBe(EXIT_OK);
    expect((await run(repo, { failOnCheck: true })).code).toBe(EXIT_CHANGED);
  });
});

describe("runCommand cost controls", () => {
  const priced = (cases = CASES) =>
    makeRepo({
      "prompts/p.md": "Version one\n",
      "cases.jsonl": cases,
      "promptdiff.config.yaml": "model: mock:m\n",
      "promptdiff.pricing.json": '{"models": {"mock:m": {"input": 1000, "output": 1000}}}',
    });

  it("--dry-run estimates without calling the model", async () => {
    const repo = priced();
    const { code, stdout, provider } = await run(repo, { dryRun: true });
    expect(code).toBe(EXIT_OK);
    expect(provider.calls).toHaveLength(0);
    expect(stdout).toMatch(/Plan: 4 calls to mock:m/);
    expect(stdout).toMatch(/Estimated cost: ~\$/);
    const json = JSON.parse((await run(repo, { dryRun: true, json: true })).stdout);
    expect(json.plan.generation.calls).toBe(4);
  });

  it("refuses to start when the estimate is over --max-cost", async () => {
    const repo = priced();
    const provider = new MockProvider();
    await expect(run(repo, { maxCost: "0.01" }, provider)).rejects.toThrow(/over the --max-cost budget/);
    expect(provider.calls).toHaveLength(0);
  });

  it("refuses --max-cost for unpriced models", async () => {
    const repo = setup();
    await expect(run(repo, { maxCost: "5" })).rejects.toThrow(/Can't enforce --max-cost/);
  });

  it("stops mid-run once actual spend reaches the budget", async () => {
    const repo = priced();
    // Each response is far longer than the estimate assumed.
    const provider = new MockProvider(() => ({ text: "long", inputTokens: 10, outputTokens: 1_000_000 }));
    await expect(run(repo, { maxCost: "10", concurrency: "1" }, provider)).rejects.toThrow(/Stopped: spent/);
    expect(provider.calls.length).toBeLessThan(4);
  });

  it("asks before expensive runs in a terminal, and --yes skips the question", async () => {
    const repo = priced();
    const provider = new MockProvider();
    const questions: string[] = [];
    const deps = {
      cwd: repo,
      env: {},
      stdout: new Sink(),
      stderr: new Sink(),
      createProvider: () => provider,
      userConfigFile: path.join(tempDir(), "c.json"),
      interactive: true,
      confirm: async (q: string) => (questions.push(q), false),
    };
    await expect(runCommand("prompts/p.md", { cache: false }, deps)).rejects.toThrow(/Cancelled/);
    expect(questions).toHaveLength(1);
    expect(provider.calls).toHaveLength(0);

    expect(await runCommand("prompts/p.md", { cache: false, yes: true }, deps)).toBe(EXIT_OK);
    expect(questions).toHaveLength(1);
    expect(provider.calls).toHaveLength(4);
  });
});

describe("runCommand --vs (model vs model)", () => {
  it("runs the same prompt on two models and compares them", async () => {
    const repo = makeRepo({ "prompts/p.md": "Be brief.\n", "cases.jsonl": '{"id": "a", "input": "hello"}', "promptdiff.config.yaml": "model: mock:model-a\n" });
    writeFileSync(path.join(repo, "prompts/p.md"), "Be brief. (edited)\n");
    const a = new MockProvider((req) => ({ text: `A says ${req.messages[0]!.content}`, inputTokens: 1, outputTokens: 1 }));
    const b = new MockProvider((req) => ({ text: `B replies to ${req.messages[0]!.content}`, inputTokens: 1, outputTokens: 2 }));
    const stdout = new Sink();
    await runCommand("prompts/p.md", { cache: false, json: true, vs: "openai:model-b" }, {
      cwd: repo, env: { OPENAI_API_KEY: "sk-test-vs-key-0001" }, stdout, stderr: new Sink(),
      createProvider: (id) => (id === "openai" ? b : a), userConfigFile: path.join(tempDir(), "c.json"),
    });
    const report = JSON.parse(stdout.data) as DiffReport;
    // Both models get the working-copy prompt; base/head are now the two models.
    expect(a.calls.map((c) => [c.model, c.system])).toEqual([["model-a", "Be brief. (edited)\n"]]);
    expect(b.calls.map((c) => [c.model, c.system])).toEqual([["model-b", "Be brief. (edited)\n"]]);
    expect(report.meta).toMatchObject({ baseRef: "mock:model-a", headRef: "openai:model-b", vsModel: "openai:model-b" });
    expect(report.cases[0]).toMatchObject({ status: "changed" });
    expect(report.summary.head.outputTokens).toBe(2);
  });
});

describe("approved snapshots", () => {
  it("--approve saves outputs; --snapshot compares against them without re-running the old prompt", async () => {
    const repo = makeRepo({ "prompts/p.md": "Version one\n", "cases.jsonl": CASES, "promptdiff.config.yaml": "model: mock:m\n" });
    const { readFileSync, existsSync } = await import("node:fs");
    const first = await run(repo, { approve: true, json: true });
    const file = path.join(repo, "promptdiff-snapshots", "prompts_p.md.json");
    expect(existsSync(file)).toBe(true);
    expect(first.stderr).toContain("Approved 2 cases");
    expect(JSON.parse(readFileSync(file, "utf8")).cases.a.outputs[0].text).toBe("[Version one] You said: hello");

    writeFileSync(path.join(repo, "prompts/p.md"), "Version two\n");
    const provider = new MockProvider();
    const second = await run(repo, { snapshot: true, json: true }, provider);
    const report = JSON.parse(second.stdout) as DiffReport;
    expect(provider.calls.every((c) => c.system === "Version two\n")).toBe(true); // only the new prompt ran
    expect(provider.calls).toHaveLength(2);
    expect(report.meta).toMatchObject({ snapshot: true, baseRef: expect.stringMatching(/^approved \d{4}-\d\d-\d\d$/) });
    expect(report.summary.changed).toBe(2);
  });

  it("--snapshot explains when nothing has been approved", async () => {
    const repo = setup();
    await expect(run(repo, { snapshot: true })).rejects.toMatchObject({ message: "No approved outputs for prompts/p.md yet.", hint: expect.stringContaining("--approve") });
  });
});
