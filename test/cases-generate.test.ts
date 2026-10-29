import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseCases } from "../src/cases.js";
import { GENERATE_MARKER, casesGenerateCommand, generateCases } from "../src/commands/cases.js";
import { MockProvider } from "../src/providers/mock.js";
import { Sink, makeRepo, tempDir } from "./helpers.js";

describe("generating test cases", () => {
  it("asks for varied cases, fills template variables, and cleans up ids", async () => {
    const provider = new MockProvider((req) => {
      expect(req.system.startsWith(GENERATE_MARKER)).toBe(true);
      expect(req.messages[0]!.content).toContain("Write 3 test cases");
      expect(req.messages[0]!.content).toContain("{{company}}");
      return { text: 'Here you go:\n[{"id": "Refund Request", "input": "Refund please", "vars": {"company": "Acme"}}, {"id": "refund request", "input": "Again?", "checks": ["Asks for the order number"]}]' };
    });
    const cases = await generateCases({ provider, modelId: "m", prompt: "Support for {{company}}.", count: 3, withChecks: true });
    expect(cases).toEqual([
      { id: "refund-request", input: "Refund please", vars: { company: "Acme" } },
      { id: "refund-request-2", input: "Again?", assert: [{ type: "llm-rubric", value: "Asks for the order number" }] },
    ]);
  });

  it("explains output it can't use", async () => {
    const provider = new MockProvider(() => ({ text: "Sorry, I can't do that." }));
    await expect(generateCases({ provider, modelId: "m", prompt: "x", count: 3 })).rejects.toThrow(/expected format/);
  });

  it("writes the prompt's own test-case file, refuses to overwrite, and appends without id clashes", async () => {
    const repo = makeRepo({
      "src/prompts/email.prompt.ts": "export const EMAIL_PROMPT = `Write emails for {{company}}.`;",
      "promptdiff.config.yaml": "model: mock:m\nprompts:\n  - path: src/prompts/*.prompt.ts\n    cases: tests/email.jsonl\n",
    });
    const deps = { cwd: repo, env: {}, out: new Sink(), createProvider: () => new MockProvider(), userConfigFile: path.join(tempDir(), "c.json") };
    const file = await casesGenerateCommand("src/prompts/email.prompt.ts#EMAIL_PROMPT", { count: "3" }, deps);
    expect(file).toBe(path.join(repo, "tests/email.jsonl"));
    const first = parseCases(readFileSync(file, "utf8"));
    expect(first.map((c) => c.id)).toEqual(["mock-case-1", "mock-case-2", "mock-case-3"]);
    expect(first[0]!.vars).toEqual({ company: "sample company" });
    expect(deps.out.data).toContain("Wrote 3 test cases to tests/email.jsonl");

    await expect(casesGenerateCommand("src/prompts/email.prompt.ts#EMAIL_PROMPT", { count: "3" }, deps)).rejects.toThrow(/already exists/);
    await casesGenerateCommand("src/prompts/email.prompt.ts#EMAIL_PROMPT", { count: "2", append: true }, deps);
    const all = parseCases(readFileSync(file, "utf8"));
    expect(all.map((c) => c.id)).toEqual(["mock-case-1", "mock-case-2", "mock-case-3", "mock-case-4", "mock-case-5"]);
  });

  it("validates the count", async () => {
    const repo = makeRepo({ "p.md": "x" });
    writeFileSync(path.join(repo, "promptdiff.config.yaml"), "model: mock:m\n");
    await expect(casesGenerateCommand("p.md", { count: "0" }, { cwd: repo, env: {}, out: new Sink() })).rejects.toThrow(/1 to 100/);
  });
});
