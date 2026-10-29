/**
 * Opt-in (--run-code): build a test case's user message by calling a function from the project,
 * e.g. {"from": {"call": "src/email.prompt.ts#createUserPrompt", "args": [{...}]}}.
 * This runs the project's code (with tsx for TypeScript, node for JS, python for Python),
 * so it never happens unless the user asks for it.
 */
import { createHash } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TestCase } from "./cases.js";
import { PromptdiffError } from "./errors.js";
import { findExecutable, runProgram } from "./exec.js";
import { findPython, isPythonFile } from "./python-prompts.js";

export interface BuildCall {
  /** "path/to/file.ts#functionName", relative to cwd. */
  call: string;
  args: unknown[];
}

const MARKER = "\u0000PROMPTDIFF\u0000";

const JS_RUNNER = `import { pathToFileURL } from "node:url";
let input = ""; for await (const chunk of process.stdin) input += chunk;
const out = [];
for (const r of JSON.parse(input)) {
  try {
    const mod = await import(pathToFileURL(r.file).href);
    const fn = mod[r.name] ?? mod.default?.[r.name];
    if (typeof fn !== "function") throw new Error(r.name + " isn't an exported function of " + r.file);
    out.push({ value: await fn(...r.args) });
  } catch (e) { out.push({ error: String(e && e.message || e) }); }
}
process.stdout.write(${JSON.stringify(MARKER)} + JSON.stringify(out));
`;

const PY_RUNNER = `import importlib, json, os, sys
reqs = json.loads(sys.stdin.read())
out = []
for r in reqs:
    try:
        root, rel = r["root"], os.path.relpath(r["file"], r["root"])
        if root not in sys.path: sys.path.insert(0, root)
        mod = importlib.import_module(rel[:-3].replace(os.sep, "."))
        fn = getattr(mod, r["name"])
        out.append({"value": fn(*r["args"])})
    except Exception as e:
        out.append({"error": f"{type(e).__name__}: {e}"})
sys.stdout.write(${JSON.stringify(MARKER)} + json.dumps(out, default=str))
`;

function writeRunner(name: string, source: string): string {
  const file = path.join(os.tmpdir(), `promptdiff-${name}-${createHash("sha256").update(source).digest("hex").slice(0, 10)}${name === "py" ? ".py" : ".mjs"}`);
  if (!existsSync(file)) writeFileSync(file, source);
  return file;
}

/** The project's tsx, searched upward from a file (TypeScript needs it; plain JS runs on node). */
function findTsx(from: string, stop: string): string | undefined {
  for (let dir = path.dirname(from); ; dir = path.dirname(dir)) {
    for (const name of ["tsx", "tsx.cmd"]) {
      const candidate = path.join(dir, "node_modules", ".bin", name);
      if (existsSync(candidate)) return candidate;
    }
    if (dir === stop || path.dirname(dir) === dir) break;
  }
  return findExecutable("tsx");
}

/** Python import root for a file: the first folder above it that isn't a package (no __init__.py). */
function pythonRoot(file: string, stop: string): string {
  let dir = path.dirname(file);
  while (existsSync(path.join(dir, "__init__.py")) && dir !== stop) dir = path.dirname(dir);
  return dir;
}

function toMessages(value: unknown, where: string): Pick<TestCase, "input" | "messages"> {
  if (typeof value === "string") return { input: value };
  if (Array.isArray(value) && value.every((m) => m && typeof m === "object" && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")) {
    return { messages: value as TestCase["messages"] };
  }
  throw new PromptdiffError(`${where} returned ${Array.isArray(value) ? "a list" : typeof value}, not text.`, {
    hint: "The function should return the user message as a string (or a list of {role, content} messages).",
  });
}

/**
 * Replaces each case's "from" with the message its function returns.
 * Throws unless `allowed` (the user opted in with --run-code).
 */
export async function buildCaseInputs(cases: TestCase[], opts: { cwd: string; repoRoot: string; allowed: boolean }): Promise<TestCase[]> {
  const todo = cases.filter((tc) => tc.from);
  if (todo.length === 0) return cases;
  if (!opts.allowed) {
    throw new PromptdiffError(`${todo.length} test case${todo.length === 1 ? " builds its" : "s build their"} message by calling your code ("from"), which needs --run-code.`, {
      hint: "promptdiff only runs your project's code when you ask. Add --run-code (or `runCode: true` in promptdiff.config.yaml) if you trust these functions.",
    });
  }

  const results = new Map<TestCase, unknown>();
  const groups = { js: [] as TestCase[], py: [] as TestCase[] };
  for (const tc of todo) (isPythonFile(tc.from!.call.split("#")[0]!) ? groups.py : groups.js).push(tc);

  const run = async (kind: "js" | "py", list: TestCase[]) => {
    if (!list.length) return;
    const requests = list.map((tc) => {
      const hash = tc.from!.call.lastIndexOf("#");
      const file = path.resolve(opts.cwd, tc.from!.call.slice(0, hash));
      if (!existsSync(file)) throw new PromptdiffError(`${tc.from!.call}: file not found (case "${tc.id}", line ${tc.line}).`);
      return { file, name: tc.from!.call.slice(hash + 1), args: tc.from!.args, root: pythonRoot(file, opts.repoRoot) };
    });
    let program: string;
    let args: string[];
    if (kind === "py") {
      const py = await findPython();
      if (!py) throw new PromptdiffError("Building cases with Python functions needs Python 3, which wasn't found.");
      program = py.file;
      args = [...py.args, writeRunner("py", PY_RUNNER)];
    } else {
      const needsTsx = requests.some((r) => /\.(ts|tsx|mts|cts)$/.test(r.file));
      const tsx = needsTsx ? findTsx(requests[0]!.file, opts.repoRoot) : undefined;
      if (needsTsx && !tsx) {
        throw new PromptdiffError("Calling TypeScript functions needs tsx, which isn't installed in this project.", { hint: "Install it in the project (npm i -D tsx), then run again." });
      }
      program = tsx ?? process.execPath;
      args = [writeRunner("js", JS_RUNNER)];
    }
    const res = await runProgram(program, args, { stdin: JSON.stringify(requests), cwd: opts.repoRoot, timeoutMs: 120_000 });
    const at = res.stdout.lastIndexOf(MARKER);
    if (at < 0) throw new PromptdiffError(`Running your code to build test cases failed: ${(res.stderr.trim().split("\n").pop() ?? "") || `exit code ${res.code}`}`);
    const out = JSON.parse(res.stdout.slice(at + MARKER.length)) as ({ value: unknown } | { error: string })[];
    list.forEach((tc, i) => {
      const r = out[i]!;
      if ("error" in r) throw new PromptdiffError(`${tc.from!.call} failed for case "${tc.id}" (line ${tc.line}): ${r.error}`);
      results.set(tc, r.value);
    });
  };
  await run("js", groups.js);
  await run("py", groups.py);

  return cases.map((tc) => {
    if (!tc.from) return tc;
    const built = toMessages(results.get(tc), tc.from.call);
    return { ...tc, ...built, from: undefined };
  });
}
