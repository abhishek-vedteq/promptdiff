import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCommand } from "../src/commands/run.js";
import { loadPrompt } from "../src/prompt-source.js";
import { discoverPrompts } from "../src/prompts.js";
import { MockProvider } from "../src/providers/mock.js";
import { extractPythonPrompts, findPython, listPythonPrompts } from "../src/python-prompts.js";
import type { DiffReport } from "../src/types.js";
import { Sink, makeRepo, tempDir } from "./helpers.js";

const python = await findPython();
const describeIfPython = python ? describe : describe.skip;

/** A Python project using the patterns real prompt files use. */
const FIXTURE: Record<string, string> = {
  "src/app/__init__.py": "",
  "src/app/prompts/__init__.py": "from .shared import OUTPUT_FORMAT\nfrom .support import *\n",
  "src/app/prompts/shared.py": [
    'OUTPUT_FORMAT = "Reply in JSON with keys: answer, confidence."',
    'TONES = {"warm": "Be friendly and kind.", "formal": "Be precise and formal."}',
    'RULES = ["Never invent order numbers", "", "Escalate legal questions"]',
  ].join("\n"),
  "src/app/prompts/support.py": [
    "import textwrap",
    "from inspect import cleandoc",
    "from app.prompts import shared",
    "from .shared import OUTPUT_FORMAT, TONES, RULES",
    "",
    'COMPANY = "Acme"',
    "MAX_SENTENCES = 4",
    "",
    'SYSTEM_PROMPT: str = textwrap.dedent(f"""',
    "    You are the support assistant for {COMPANY!r}.",
    "    {TONES['warm']} Use at most {MAX_SENTENCES} sentences ({MAX_SENTENCES / 3:.2f} per topic).",
    '""").strip()',
    "",
    'RULES_PROMPT = "Rules:\\n" + "\\n".join(f"{i}. {r}" for i, r in enumerate(RULES, 1) if r)',
    "",
    'FULL_PROMPT = (',
    '    "Part one. "',
    "    'Part two. '",
    '    f"{shared.OUTPUT_FORMAT}"',
    ")",
    "",
    'LEGACY_INSTRUCTION = "Hello %s, you have %d tickets." % (COMPANY, 3) + " {x}".format(x="ok")',
    'SORTED_PROMPT = ", ".join(sorted(TONES, key=lambda k: len(TONES[k])))',
    "",
    "class Prompts:",
    '    BASE = cleandoc("""',
    "        Base instructions.",
    "          Indented line.",
    '    """)',
    '    REFUND = BASE + "\\nHandle refunds within 5 days."',
    "",
    "def build_user_prompt(name):",
    '    return f"Hi {name}"',
  ].join("\n"),
  "src/app/prompts/runtime.py": "import datetime\n\nDATED_PROMPT = f\"Today is {datetime.date.today()}\"\nBUILT_PROMPT = build()\n",
};

const NAMES = ["SYSTEM_PROMPT", "RULES_PROMPT", "FULL_PROMPT", "LEGACY_INSTRUCTION", "SORTED_PROMPT", "Prompts.BASE", "Prompts.REFUND"];

/** What Python itself produces when it imports the fixture (safe: these are our own test files). */
function runtimeValues(root: string): Record<string, string> {
  const script = [
    "import json, sys",
    "sys.path.insert(0, 'src')",
    "import app.prompts.support as m",
    `names = ${JSON.stringify(NAMES)}`,
    "out = {}",
    "for n in names:",
    "    v = m",
    "    for part in n.split('.'):",
    "        v = getattr(v, part)",
    "    out[n] = v",
    "print(json.dumps(out))",
  ].join("\n");
  return JSON.parse(execFileSync(python!.file, [...python!.args, "-c", script], { cwd: root, encoding: "utf8" }));
}

describeIfPython("prompts in Python code", () => {
  it("reads every pattern exactly as Python produces it at runtime", async () => {
    const root = tempDir();
    for (const [f, text] of Object.entries(FIXTURE)) {
      const full = path.join(root, f);
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, text);
    }
    const expected = runtimeValues(root);
    const results = await extractPythonPrompts(root, undefined, NAMES.map((name) => ({ file: "src/app/prompts/support.py", name })));
    NAMES.forEach((name, i) => {
      expect(results[i]!.error, name).toBeUndefined();
      expect(results[i]!.text, name).toBe(expected[name]);
    });
    expect(results[2]!.files).toEqual(expect.arrayContaining(["src/app/prompts/support.py", "src/app/prompts/shared.py", "src/app/prompts/__init__.py"]));
  });

  it("lists prompt-like names, including class attributes, and skips functions and containers", async () => {
    const listed = await listPythonPrompts([{ path: "support.py", source: FIXTURE["src/app/prompts/support.py"]! }]);
    expect(listed.get("support.py")).toEqual(["SYSTEM_PROMPT", "RULES_PROMPT", "FULL_PROMPT", "LEGACY_INSTRUCTION", "SORTED_PROMPT", "Prompts.BASE", "Prompts.REFUND"]);
    const shared = await listPythonPrompts([{ path: "x.py", source: "TONES_PROMPT = {'a': 'b'}\nMY_PROMPT = make()\nOK_PROMPT = '\\n'.join(['a'])" }]);
    expect(shared.get("x.py")).toEqual(["OK_PROMPT"]);
  });

  it("explains runtime values with the file and line, and suggests names", async () => {
    const root = tempDir();
    writeFileSync(path.join(root, "p.py"), FIXTURE["src/app/prompts/runtime.py"]!);
    const [dated, built, missing] = await extractPythonPrompts(root, undefined, [
      { file: "p.py", name: "DATED_PROMPT" },
      { file: "p.py", name: "BUILT_PROMPT" },
      { file: "p.py", name: "NOPE" },
    ]);
    expect(dated!.error).toMatch(/p\.py:3: can't read the prompt here .*datetime/);
    expect(built!.error).toMatch(/p\.py:4: .*calls build\(\)/);
    expect(missing!.error).toBe('p.py has no top-level "NOPE".');
    expect(missing!.hint).toBe("Prompt-like names in this file: DATED_PROMPT"); // BUILT_PROMPT is a function call, so not suggested
  });

  it("compares git versions, discovers Python prompts, and runs end to end", async () => {
    const repo = makeRepo({
      ...FIXTURE,
      "cases.jsonl": '{"id": "refund", "input": "I want a refund"}',
      "promptdiff.config.yaml": "model: mock:m\n",
    });
    // Change only the shared module: prompts that use it change too.
    writeFileSync(path.join(repo, "src/app/prompts/shared.py"), FIXTURE["src/app/prompts/shared.py"]!.replace("answer, confidence", "answer"));

    const spec = "src/app/prompts/support.py#FULL_PROMPT";
    expect((await loadPrompt(spec, { ref: "HEAD" }, repo)).text).toContain("keys: answer, confidence.");
    expect((await loadPrompt(spec, "working", repo)).text).toContain("keys: answer.");
    await expect(loadPrompt("src/app/prompts/support.py", "working", repo)).rejects.toMatchObject({
      hint: expect.stringContaining("src/app/prompts/support.py#SYSTEM_PROMPT"),
    });

    const found = await discoverPrompts(repo, "HEAD");
    const byPath = Object.fromEntries(found.map((p) => [p.path, p]));
    expect(byPath[spec]).toMatchObject({ changed: true, added: 1, removed: 1 });
    expect(byPath["src/app/prompts/support.py#SYSTEM_PROMPT"]).toMatchObject({ changed: false });
    expect(byPath["src/app/prompts/runtime.py#DATED_PROMPT"]?.error).toMatch(/datetime/);

    const provider = new MockProvider((req) => ({ text: req.system, inputTokens: 1, outputTokens: 1 }));
    const stdout = new Sink();
    await runCommand(spec, { cache: false, json: true }, {
      cwd: repo, env: {}, stdout, stderr: new Sink(), createProvider: () => provider, userConfigFile: path.join(tempDir(), "c.json"),
    });
    const report = JSON.parse(stdout.data) as DiffReport;
    expect(report.summary.changed).toBe(1);
    expect(report.cases[0]!.head[0]!.text).toContain("keys: answer.");
  });
});
