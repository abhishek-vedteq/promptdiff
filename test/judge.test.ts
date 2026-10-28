import { writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ResultCache } from "../src/cache.js";
import { EXIT_OK, runCommand } from "../src/commands/run.js";
import { COMPARE_SYSTEM, GRADE_SYSTEM, Judge, parseJudgeReply } from "../src/judge.js";
import { MockProvider, defaultMockHandler } from "../src/providers/mock.js";
import type { GenerateRequest } from "../src/providers/types.js";
import type { DiffReport } from "../src/types.js";
import { z } from "zod";
import { Sink, makeRepo, tempDir } from "./helpers.js";

describe("parseJudgeReply", () => {
  const schema = z.object({ pass: z.boolean(), reason: z.string() });
  it("accepts bare JSON, fenced JSON, and JSON with stray text", () => {
    expect(parseJudgeReply('{"reason": "ok", "pass": true}', schema)).toEqual({ reason: "ok", pass: true });
    expect(parseJudgeReply('```json\n{"reason": "x", "pass": false}\n```', schema).pass).toBe(false);
    expect(parseJudgeReply('Here you go: {"reason": "x", "pass": true} hope that helps', schema).pass).toBe(true);
  });
  it("rejects replies without the expected JSON", () => {
    expect(() => parseJudgeReply("I think it passes", schema)).toThrow(/unexpected reply/);
    expect(() => parseJudgeReply('{"verdict": "yes"}', schema)).toThrow(/unexpected reply/);
  });
});

describe("Judge", () => {
  it("grades rubrics with the right prompt and caches results", async () => {
    const provider = new MockProvider(() => ({ text: '{"reason": "asks for the order number", "pass": true}', inputTokens: 100, outputTokens: 10 }));
    const cache = new ResultCache(path.join(tempDir(), "c"));
    const judge = new Judge({ provider, modelId: "j", modelSpec: "mock:j", cache, pricing: { "mock:j": { input: 1, output: 1 } } });
    const r = await judge.grade("Asks for the order number", "What's your order number?", "Refund please");
    expect(r).toEqual({ pass: true, reason: "asks for the order number" });
    expect(provider.calls[0]!.system).toBe(GRADE_SYSTEM);
    expect(provider.calls[0]!.model).toBe("j");
    expect(provider.calls[0]!.messages[0]!.content).toContain("<rubric>\nAsks for the order number\n</rubric>");

    await judge.grade("Asks for the order number", "What's your order number?", "Refund please");
    expect(provider.calls).toHaveLength(1);
    expect(judge.usage).toMatchObject({ calls: 2, cachedCalls: 1, inputTokens: 100, outputTokens: 10 });
    expect(judge.usage.cost).toBeCloseTo(110 / 1e6);
  });

  it("compares versions with every sample", async () => {
    const provider = new MockProvider(() => ({ text: '{"summary": "B asks for the order number", "verdict": "different"}' }));
    const judge = new Judge({ provider, modelId: "j", modelSpec: "mock:j", pricing: {} });
    const r = await judge.compare("Refund please", ["a1", "a2"], ["b1", "b2"]);
    expect(r).toEqual({ verdict: "different", summary: "B asks for the order number" });
    const user = provider.calls[0]!.messages[0]!.content;
    expect(provider.calls[0]!.system).toBe(COMPARE_SYSTEM);
    for (const s of ["a1", "a2", "b1", "b2", "<version_a>", "<version_b>"]) expect(user).toContain(s);
    expect(judge.usage.cost).toBeUndefined();
  });
});

describe("runCommand with a judge", () => {
  async function run(files: Record<string, string>, cli: Record<string, unknown>, providers: Record<string, MockProvider>, env: NodeJS.ProcessEnv = {}) {
    const repo = makeRepo(files);
    writeFileSync(path.join(repo, "p.md"), "Version two\n");
    const stdout = new Sink();
    const code = await runCommand("p.md", { cache: false, json: true, ...cli }, {
      cwd: repo, env, stdout, stderr: new Sink(),
      createProvider: (id) => providers[id] ?? providers.mock!,
      userConfigFile: path.join(tempDir(), "c.json"),
    });
    return { code, report: JSON.parse(stdout.data) as DiffReport };
  }

  it("--compare semantic lets the judge downgrade wording-only changes to noise", async () => {
    // The model's wording changes between versions, but the judge says the meaning is the same.
    const provider = new MockProvider((req: GenerateRequest) => {
      if (req.system.startsWith("You are promptdiff's evaluator.")) {
        return { text: '{"summary": "No meaningful difference", "verdict": "same"}', inputTokens: 1, outputTokens: 1 };
      }
      return { text: req.system.includes("two") ? "Your refund is on its way." : "We've sent your refund.", inputTokens: 1, outputTokens: 1 };
    });
    const files = { "p.md": "Version one\n", "cases.jsonl": '{"id": "a", "input": "refund?"}', "promptdiff.config.yaml": "model: mock:m\n" };

    const words = await run(files, {}, { mock: provider });
    expect(words.report.cases[0]!.status).toBe("changed");

    const semantic = await run(files, { compare: "semantic" }, { mock: provider });
    expect(semantic.report.cases[0]!.status).toBe("noise");
    expect(semantic.report.cases[0]!.judgement).toEqual({ verdict: "same", summary: "No meaningful difference" });
    expect(semantic.report.meta).toMatchObject({ compare: "semantic", judgeModel: "mock:m" });
    expect(semantic.report.summary.judge!.calls).toBe(1);
  });

  it("grades llm-rubric checks with a separate judge model and its own key", async () => {
    const model = new MockProvider();
    const judge = new MockProvider(defaultMockHandler);
    const files = {
      "p.md": "Version one\n",
      "cases.jsonl": '{"id": "a", "input": "refund?", "assert": [{"type": "llm-rubric", "value": "one appears in the response"}]}',
      "promptdiff.config.yaml": "model: mock:m\njudge: openai:judge-model\n",
    };
    await expect(run(files, {}, { mock: model, openai: judge })).rejects.toThrow(/No API key found for OpenAI/);

    const { code, report } = await run(files, {}, { mock: model, openai: judge }, { OPENAI_API_KEY: "sk-test-judge-key-1234" });
    expect(code).toBe(EXIT_OK);
    expect(judge.calls.every((c) => c.model === "judge-model")).toBe(true);
    expect(judge.calls).toHaveLength(2); // one grade per output
    const c = report.cases[0]!;
    expect(c.checks).toMatchObject({ base: { passed: 1 }, head: { passed: 0 }, regression: true });
    expect(c.head[0]!.checks![0]!.reason).toMatch(/mock judge/);
  });

  it("includes judge calls in the cost estimate", async () => {
    const files = {
      "p.md": "Version one\n",
      "cases.jsonl": '{"input": "x", "assert": [{"type": "llm-rubric", "value": "polite"}, {"type": "llm-rubric", "value": "short"}]}',
      "promptdiff.config.yaml": "model: mock:m\nruns: 2\ncompare: semantic\n",
    };
    const repo = makeRepo(files);
    const stdout = new Sink();
    await runCommand("p.md", { cache: false, json: true, dryRun: true }, {
      cwd: repo, env: {}, stdout, stderr: new Sink(), createProvider: () => new MockProvider(), userConfigFile: path.join(tempDir(), "c.json"),
    });
    const { plan } = JSON.parse(stdout.data);
    expect(plan.generation.calls).toBe(4);
    expect(plan.judge.calls).toBe(4 * 2 + 1); // 2 rubrics per output + 1 comparison
  });
});
