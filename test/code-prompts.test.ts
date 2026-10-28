import { writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { extractPrompt, listPromptExports } from "../src/code-prompts.js";
import { runCommand } from "../src/commands/run.js";
import { casesForPrompt } from "../src/config/resolve.js";
import { loadPrompt, parsePromptSpec } from "../src/prompt-source.js";
import { discoverPrompts } from "../src/prompts.js";
import { MockProvider } from "../src/providers/mock.js";
import type { DiffReport } from "../src/types.js";
import { Sink, gitIn, makeRepo, tempDir, writeFiles } from "./helpers.js";

/** An in-memory repo for the evaluator. */
const files = (map: Record<string, string>) => ({
  read: async (p: string) => map[p],
  listFiles: async () => Object.keys(map),
});

const run = async (map: Record<string, string>, file: string, name: string) => {
  const f = files(map);
  return extractPrompt(file, name, f.read, { listFiles: f.listFiles });
};

describe("extracting prompts from code", () => {
  it("reads template literals, same-file constants, and `as const`", async () => {
    const r = await run(
      {
        "p.ts": [
          'const TONE = "warm";',
          "const LIMIT = 4 as const;",
          "export const SYSTEM_PROMPT = `Be ${TONE}. Use at most ${LIMIT} sentences.`;",
        ].join("\n"),
      },
      "p.ts",
      "SYSTEM_PROMPT",
    );
    expect(r.text).toBe("Be warm. Use at most 4 sentences.");
    expect(r.files).toEqual(["p.ts"]);
  });

  it("follows relative imports, re-export barrels, and .js extensions in TS imports", async () => {
    const r = await run(
      {
        "src/prompts/email.prompt.ts": 'import { FORMAT } from "../shared";\nimport { RULES } from "./rules.js";\nexport const EMAIL_PROMPT = `Write an email.\\n${RULES}\\n${FORMAT}`;',
        "src/shared/index.ts": 'export * from "./format";\nexport { other as unused } from "./other";',
        "src/shared/format.ts": 'export const FORMAT = "Return JSON.";',
        "src/shared/other.ts": "export const other = 1;",
        "src/prompts/rules.ts": 'export const RULES = ["Be brief", "Be kind"].map((r, i) => `${i + 1}. ${r}`).join("\\n");',
      },
      "src/prompts/email.prompt.ts",
      "EMAIL_PROMPT",
    );
    expect(r.text).toBe("Write an email.\n1. Be brief\n2. Be kind\nReturn JSON.");
    expect(r.files.sort()).toEqual(["src/prompts/email.prompt.ts", "src/prompts/rules.ts", "src/shared/format.ts", "src/shared/index.ts"]);
  });

  it("follows workspace packages and tsconfig path aliases", async () => {
    const r = await run(
      {
        "packages/types/package.json": JSON.stringify({ name: "@acme/types", exports: { ".": "./src/index.ts" } }),
        "packages/types/src/index.ts": 'export { CATALOG } from "./catalog";',
        "packages/types/src/catalog.ts": 'export const CATALOG = [{ value: "a", aliases: ["x"] }, { value: "b" }] as const;',
        "apps/web/tsconfig.json": '{ // comment\n "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["./src/*"] }, }, }',
        "apps/web/src/lib/guidance.ts": [
          'import { CATALOG } from "@acme/types";',
          "export const GUIDANCE = CATALOG.map((entry) => {",
          '  const extra = "aliases" in entry ? ` (aka ${entry.aliases.join(", ")})` : "";',
          "  return `- ${entry.value}${extra}`;",
          '}).join("\\n");',
        ].join("\n"),
        "apps/web/src/app/chat/sys.ts": 'import { GUIDANCE } from "@/lib/guidance";\nexport const systemInstruction = `Categories:\\n${GUIDANCE}`;',
      },
      "apps/web/src/app/chat/sys.ts",
      "systemInstruction",
    );
    expect(r.text).toBe("Categories:\n- a (aka x)\n- b");
  });

  it("supports common string building and dedent", async () => {
    const src = {
      "p.ts": [
        'import dedent from "dedent";',
        'const PARTS = { greeting: "Hi", items: ["a", "b"] };',
        'export const A_PROMPT = "One. " + PARTS.greeting.toUpperCase() + " " + PARTS.items.length + " " + JSON.stringify(PARTS.items);',
        "export const B_PROMPT = dedent`",
        "    Line one",
        "      indented",
        "  `;",
        'export const C_PROMPT = `  padded  `.trim() + [1, 2].filter((n) => n > 1).join("");',
      ].join("\n"),
    };
    expect((await run(src, "p.ts", "A_PROMPT")).text).toBe('One. HI 2 ["a","b"]');
    expect((await run(src, "p.ts", "B_PROMPT")).text).toBe("Line one\n  indented");
    expect((await run(src, "p.ts", "C_PROMPT")).text).toBe("padded2");
  });

  it("explains what it can't read, with the location", async () => {
    await expect(run({ "p.ts": "export const SYSTEM_PROMPT = `Today is ${new Date().toDateString()}`;" }, "p.ts", "SYSTEM_PROMPT")).rejects.toThrow(
      /p\.ts:1: can't read the prompt here .*new Date/,
    );
    await expect(run({ "p.ts": 'import { buildIt } from "./b";\nexport const P_PROMPT = buildIt();', "b.ts": "export function buildIt() {}" }, "p.ts", "P_PROMPT")).rejects.toThrow(
      /calls buildIt\(\)/,
    );
    await expect(run({ "p.ts": 'import { X } from "lodash";\nexport const P_PROMPT = X;' }, "p.ts", "P_PROMPT")).rejects.toThrow(/imported from "lodash", which isn't a file in this repo/);
    await expect(run({ "p.ts": "export const NUM_PROMPT = 5;" }, "p.ts", "NUM_PROMPT")).rejects.toThrow(/isn't text \(it's number\)/);
    await expect(run({ "p.ts": 'export const SYSTEM_PROMPT = "x";' }, "p.ts", "OTHER")).rejects.toMatchObject({
      message: 'p.ts doesn\'t export "OTHER".',
      hint: "Prompt-like exports in this file: SYSTEM_PROMPT",
    });
  });

  it("lists exports that look like prompts", () => {
    const src = [
      "export const SYSTEM_PROMPT = `a`;",
      "export const systemInstruction = 'b';",
      "export const OUTPUT_FORMAT = 'c';",
      "export function buildUserPrompt() { return ''; }",
      "export const PROMPT_TEMPLATES = { a: 'x' };",
      "export const makePrompt = () => 'x';",
      "const PRIVATE_PROMPT = 'd';",
      "export const useNotificationPromptStore = create(() => ({ open: false }));",
      'export const JOINED_PROMPT = ["a", "b"].join("\\n");',
    ].join("\n");
    expect(listPromptExports("p.ts", src)).toEqual(["SYSTEM_PROMPT", "systemInstruction", "JOINED_PROMPT"]);
  });

  it("parses prompt specs", () => {
    expect(parsePromptSpec("src/p.ts#SYSTEM_PROMPT")).toEqual({ file: "src/p.ts", name: "SYSTEM_PROMPT" });
    expect(parsePromptSpec("prompts/support.md")).toEqual({ file: "prompts/support.md" });
    expect(parsePromptSpec("weird#file.md")).toEqual({ file: "weird#file.md" });
    expect(parsePromptSpec("app/prompts.py#Prompts.SUPPORT")).toEqual({ file: "app/prompts.py", name: "Prompts.SUPPORT" });
  });
});

describe("prompts in code across git versions", () => {
  function repo() {
    return makeRepo({
      "src/prompts/email.prompt.ts": 'import { FORMAT } from "./shared";\nexport const EMAIL_SYSTEM_PROMPT = `Write a short email.\\n${FORMAT}`;\nexport const OTHER_PROMPT = "unchanged";',
      "src/prompts/shared.ts": 'export const FORMAT = "Return plain text.";',
      "docs/guide.md": "# not a prompt",
      "cases.jsonl": '{"id": "a", "input": "hello"}',
      "promptdiff.config.yaml": "model: mock:m\n",
    });
  }

  it("loads the base and working versions, following imports at each version", async () => {
    const dir = repo();
    writeFileSync(path.join(dir, "src/prompts/shared.ts"), 'export const FORMAT = "Return JSON.";');
    expect((await loadPrompt("src/prompts/email.prompt.ts#EMAIL_SYSTEM_PROMPT", { ref: "HEAD" }, dir)).text).toBe("Write a short email.\nReturn plain text.");
    expect((await loadPrompt("src/prompts/email.prompt.ts#EMAIL_SYSTEM_PROMPT", "working", dir)).text).toBe("Write a short email.\nReturn JSON.");
  });

  it("refuses to send a whole code file as a prompt, and suggests the constants", async () => {
    const dir = repo();
    await expect(loadPrompt("src/prompts/email.prompt.ts", "working", dir)).rejects.toMatchObject({
      message: "src/prompts/email.prompt.ts is a code file. Which prompt in it should be compared?",
      hint: expect.stringContaining("src/prompts/email.prompt.ts#EMAIL_SYSTEM_PROMPT"),
    });
  });

  it("discovers prompts in code, marking a prompt changed when a file it imports changes", async () => {
    const dir = repo();
    writeFileSync(path.join(dir, "src/prompts/shared.ts"), 'export const FORMAT = "Return JSON.\\nBe brief.";');
    const found = await discoverPrompts(dir, "HEAD");
    expect(found).toEqual([
      { path: "src/prompts/email.prompt.ts#EMAIL_SYSTEM_PROMPT", changed: true, added: 2, removed: 1 },
      { path: "src/prompts/email.prompt.ts#OTHER_PROMPT", changed: false },
    ]);
  });

  it("with a prompts: setting, lists exactly what it matches", async () => {
    const dir = repo();
    writeFiles(dir, { "prompts/support.md": "plain prompt", "notes.md": "not listed" });
    gitIn(dir, "add", "-A");
    gitIn(dir, "commit", "-qm", "more");
    const found = await discoverPrompts(dir, "HEAD", [{ path: "src/**/*.prompt.ts#OTHER_PROMPT" }, { path: "prompts/*.md" }]);
    expect(found.map((p) => p.path).sort()).toEqual(["prompts/support.md", "src/prompts/email.prompt.ts#OTHER_PROMPT"]);
  });

  it("each prompts: entry can have its own test cases", () => {
    const cwd = tempDir();
    const project = { prompts: [{ path: "src/email/**/*.prompt.ts", cases: "tests/email.jsonl" }, "src/**/*.prompt.ts"] };
    expect(casesForPrompt(project, path.join(cwd, "promptdiff.config.yaml"), cwd, "src/email/a.prompt.ts#X")).toBe(path.join(cwd, "tests/email.jsonl"));
    expect(casesForPrompt(project, path.join(cwd, "promptdiff.config.yaml"), cwd, "src/other/b.prompt.ts#Y")).toBeUndefined();
  });

  it("runs a comparison on a prompt in code, using that prompt's own test cases", async () => {
    const dir = repo();
    writeFiles(dir, {
      "tests/email.jsonl": '{"id": "email-case", "input": "write to Bo"}',
      "promptdiff.config.yaml": "model: mock:m\nprompts:\n  - path: src/prompts/*.prompt.ts\n    cases: tests/email.jsonl\n",
    });
    writeFileSync(path.join(dir, "src/prompts/shared.ts"), 'export const FORMAT = "Return JSON.";');
    const provider = new MockProvider((req) => ({ text: `${req.system} | ${req.messages[0]!.content}`, inputTokens: 1, outputTokens: 1 }));
    const stdout = new Sink();
    await runCommand("src/prompts/email.prompt.ts#EMAIL_SYSTEM_PROMPT", { cache: false, json: true }, {
      cwd: dir, env: {}, stdout, stderr: new Sink(), createProvider: () => provider, userConfigFile: path.join(tempDir(), "c.json"),
    });
    const report = JSON.parse(stdout.data) as DiffReport;
    expect(new Set(provider.calls.map((c) => c.system))).toEqual(new Set(["Write a short email.\nReturn plain text.", "Write a short email.\nReturn JSON."]));
    expect(report.cases.map((c) => c.id)).toEqual(["email-case"]);
    expect(report.meta.file).toBe("src/prompts/email.prompt.ts#EMAIL_SYSTEM_PROMPT");
    expect(report.summary.changed).toBe(1);
  });
});
