import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseCases } from "../src/cases.js";
import { runCommand } from "../src/commands/run.js";
import { MockProvider } from "../src/providers/mock.js";
import { findPython } from "../src/python-prompts.js";
import { buildCaseInputs } from "../src/run-code.js";
import { Sink, makeRepo, tempDir } from "./helpers.js";

const python = await findPython();

describe("test cases built by calling project code (--run-code)", () => {
  const files = {
    "src/build.mjs": 'export function createUserPrompt(input) { return `Write to ${input.name} about ${input.role}.`; }\nexport function broken() { throw new Error("no role"); }',
    "app/__init__.py": "",
    "app/prompts.py": 'def build_user_prompt(name):\n    return f"Hello {name}, how can I help?"\n',
    "p.md": "Be helpful.",
    "promptdiff.config.yaml": "model: mock:m\n",
  };

  it("refuses to run code unless asked", async () => {
    const repo = makeRepo(files);
    const cases = parseCases('{"id": "a", "from": {"call": "src/build.mjs#createUserPrompt", "args": [{"name": "Ada", "role": "PM"}]}}');
    await expect(buildCaseInputs(cases, { cwd: repo, repoRoot: repo, allowed: false })).rejects.toThrow(/needs --run-code/);
  });

  it("builds messages with JavaScript functions", async () => {
    const repo = makeRepo(files);
    const cases = parseCases('{"id": "a", "from": {"call": "src/build.mjs#createUserPrompt", "args": [{"name": "Ada", "role": "PM"}]}}\n{"id": "b", "input": "plain"}');
    const built = await buildCaseInputs(cases, { cwd: repo, repoRoot: repo, allowed: true });
    expect(built.map((c) => c.input)).toEqual(["Write to Ada about PM.", "plain"]);
    expect(built[0]!.from).toBeUndefined();
  });

  (python ? it : it.skip)("builds messages with Python functions", async () => {
    const repo = makeRepo(files);
    const built = await buildCaseInputs(parseCases('{"id": "a", "from": {"call": "app/prompts.py#build_user_prompt", "args": ["Ada"]}}'), { cwd: repo, repoRoot: repo, allowed: true });
    expect(built[0]!.input).toBe("Hello Ada, how can I help?");
  });

  it("reports errors from the function with the case", async () => {
    const repo = makeRepo(files);
    const cases = parseCases('{"id": "bad", "from": {"call": "src/build.mjs#broken"}}');
    await expect(buildCaseInputs(cases, { cwd: repo, repoRoot: repo, allowed: true })).rejects.toThrow(/src\/build\.mjs#broken failed for case "bad" \(line 1\): no role/);
  });

  it("validates the case shape", () => {
    expect(() => parseCases('{"input": "x", "from": {"call": "a.ts#f"}}', "c.jsonl")).toThrow(/exactly one of/);
    expect(() => parseCases('{"from": {"call": "a.ts"}}', "c.jsonl")).toThrow(/c\.jsonl:1/);
  });

  it("runs end to end with --run-code", async () => {
    const repo = makeRepo({ ...files, "cases.jsonl": '{"id": "a", "from": {"call": "src/build.mjs#createUserPrompt", "args": [{"name": "Bo", "role": "SWE"}]}}' });
    const provider = new MockProvider();
    const stdout = new Sink();
    await runCommand("p.md", { cache: false, json: true, runCode: true }, { cwd: repo, env: {}, stdout, stderr: new Sink(), createProvider: () => provider, userConfigFile: path.join(tempDir(), "c.json") });
    expect(provider.calls[0]!.messages[0]!.content).toBe("Write to Bo about SWE.");
  });
});
