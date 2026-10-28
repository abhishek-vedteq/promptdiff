import { writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { cacheKey } from "../src/cache.js";
import { caseInputKey, caseLabel, caseMessages, parseCases } from "../src/cases.js";
import { runCommand } from "../src/commands/run.js";
import { MockProvider } from "../src/providers/mock.js";
import { missingVariables, renderTemplate, templateVariables } from "../src/templates.js";
import type { DiffReport } from "../src/types.js";
import { Sink, makeRepo, tempDir } from "./helpers.js";

describe("templates", () => {
  it("finds, checks, and renders placeholders", () => {
    const t = "Hi {{name}}, you're on the {{ plan }} plan. {{name}}!";
    expect(templateVariables(t)).toEqual(["name", "plan"]);
    expect(missingVariables(t, { name: "Ada" })).toEqual(["plan"]);
    expect(renderTemplate(t, { name: "Ada", plan: "Pro" })).toBe("Hi Ada, you're on the Pro plan. Ada!");
    expect(renderTemplate("{{n}} items, vip={{vip}}", { n: 3, vip: true })).toBe("3 items, vip=true");
  });

  it("leaves things that aren't placeholders alone", () => {
    expect(templateVariables("{{ not valid }} {{1abc}} {x} {{}}")).toEqual([]);
  });
});

describe("multi-turn cases", () => {
  it("parses conversations", () => {
    const [c] = parseCases(
      '{"id": "follow-up", "messages": [{"role": "user", "content": "Hi"}, {"role": "assistant", "content": "Hello!"}, {"role": "user", "content": "Refund?"}], "vars": {"name": "Ada"}}',
    );
    expect(caseMessages(c!)).toHaveLength(3);
    expect(caseLabel(c!)).toBe("Refund?");
    expect(c!.vars).toEqual({ name: "Ada" });
  });

  it("validates conversations", () => {
    const bad = [
      '{"input": "x", "messages": [{"role": "user", "content": "y"}]}',
      '{"id": "x"}',
      '{"messages": [{"role": "user", "content": "a"}, {"role": "assistant", "content": "b"}]}',
      '{"messages": [{"role": "assistant", "content": "a"}, {"role": "user", "content": "b"}]}',
      '{"messages": [{"role": "system", "content": "a"}]}',
      '{"input": "x", "vars": {"bad-name": 1}}',
    ];
    for (const line of bad) expect(() => parseCases(line, "c.jsonl"), line).toThrow(/^c\.jsonl:1:/);
  });

  it("keeps single-turn cache keys unchanged", () => {
    const [single, multi] = parseCases('{"input": "hi"}\n{"messages": [{"role": "user", "content": "hi"}]}');
    expect(caseInputKey(single!)).toBe("hi");
    const parts = { prompt: "p", model: "m:m", runIndex: 0 };
    expect(cacheKey({ ...parts, input: caseInputKey(single!) })).not.toBe(cacheKey({ ...parts, input: caseInputKey(multi!) }));
  });
});

describe("runCommand with templates and conversations", () => {
  async function run(files: Record<string, string>, edit?: string) {
    const repo = makeRepo({ "promptdiff.config.yaml": "model: mock:m\n", ...files });
    if (edit) writeFileSync(path.join(repo, "p.md"), edit);
    const provider = new MockProvider();
    const stdout = new Sink();
    const stderr = new Sink();
    const code = await runCommand("p.md", { cache: false, json: true }, {
      cwd: repo, env: {}, stdout, stderr, createProvider: () => provider, userConfigFile: path.join(tempDir(), "c.json"),
    });
    return { code, provider, report: JSON.parse(stdout.data) as DiffReport, stderr: stderr.data };
  }

  it("renders vars into each version of the prompt, with config defaults", async () => {
    const { provider, report } = await run(
      {
        "p.md": "Support for {{company}}. Customer: {{name}}",
        "cases.jsonl": '{"id": "a", "input": "hi", "vars": {"name": "Ada"}}\n{"id": "b", "input": "yo", "vars": {"name": "Bo", "company": "Beta"}}',
        "promptdiff.config.yaml": "model: mock:m\nvars:\n  company: Acme\n",
      },
      "Friendly support for {{company}}. Customer: {{name}}",
    );
    const systems = provider.calls.map((c) => c.system).sort();
    expect(systems).toEqual([
      "Friendly support for Acme. Customer: Ada",
      "Friendly support for Beta. Customer: Bo",
      "Support for Acme. Customer: Ada",
      "Support for Beta. Customer: Bo",
    ]);
    expect(report.cases[0]!.vars).toEqual({ name: "Ada" });
  });

  it("refuses to run when a variable is missing, before any API call", async () => {
    await expect(
      run(
        { "p.md": "Hi {{name}}", "cases.jsonl": '{"id": "a", "input": "x", "vars": {"name": "A"}}\n{"id": "b", "input": "y", "vars": {"other": 1}}' },
        "Hi {{name}} from {{team}}",
      ),
    ).rejects.toThrow(/cases\.jsonl:1 \(case "a"\): no value for \{\{team\}\}[\s\S]*cases\.jsonl:2 \(case "b"\): no value for \{\{name\}\}/);
  });

  it("sends prompts literally (with a note) when nothing uses vars", async () => {
    const { provider, stderr } = await run({ "p.md": "Use {{braces}} literally", "cases.jsonl": '{"input": "x"}' });
    expect(provider.calls[0]!.system).toBe("Use {{braces}} literally");
    expect(stderr).toContain("no case defines \"vars\"");
  });

  it("sends multi-turn conversations", async () => {
    const convo = [{ role: "user", content: "Hi" }, { role: "assistant", content: "Hello! How can I help?" }, { role: "user", content: "Refund please" }];
    const { provider, report } = await run({ "p.md": "Be nice", "cases.jsonl": JSON.stringify({ id: "c", messages: convo }) });
    expect(provider.calls[0]!.messages).toEqual(convo);
    expect(report.cases[0]!.input).toBe("Refund please");
    expect(report.cases[0]!.messages).toEqual(convo);
  });
});
