/**
 * Prompts in Python code, read by python/extract_prompts.py using Python's own parser.
 * The project's code is never run; see that file for what can be read.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PromptdiffError } from "./errors.js";
import { findExecutable, runProgram } from "./exec.js";

export const isPythonFile = (file: string) => file.toLowerCase().endsWith(".py");

const HELPER = fileURLToPath(new URL("../python/extract_prompts.py", import.meta.url));

interface PythonCommand {
  file: string;
  args: string[];
}

let found: Promise<PythonCommand | undefined> | undefined;

/**
 * Finds a working Python 3: python3, python, or (on Windows) the py launcher.
 * Each candidate is test-run, which skips the Windows Store "python3" stub.
 */
export function findPython(env: NodeJS.ProcessEnv = process.env): Promise<PythonCommand | undefined> {
  found ??= (async () => {
    const candidates: PythonCommand[] = [];
    if (env.PROMPTDIFF_PYTHON) candidates.push({ file: env.PROMPTDIFF_PYTHON, args: [] });
    for (const name of ["python3", "python"]) {
      const file = findExecutable(name, env);
      if (file) candidates.push({ file, args: [] });
    }
    const py = process.platform === "win32" ? findExecutable("py", env) : undefined;
    if (py) candidates.push({ file: py, args: ["-3"] });
    for (const cmd of candidates) {
      try {
        const res = await runProgram(cmd.file, [...cmd.args, "-c", "import sys; print(sys.version_info[0])"], { timeoutMs: 15_000 });
        if (res.code === 0 && res.stdout.trim() === "3") return cmd;
      } catch {
        // try the next one
      }
    }
    return undefined;
  })();
  return found;
}

async function runHelper<T>(request: unknown): Promise<T> {
  const python = await findPython();
  if (!python) {
    throw new PromptdiffError("Reading prompts from Python files needs Python 3, which wasn't found.", {
      hint: "Install Python 3 (https://www.python.org/downloads/) so `python3` or `python` is on your PATH, or set PROMPTDIFF_PYTHON to its path.",
    });
  }
  if (!existsSync(HELPER)) throw new PromptdiffError(`promptdiff's Python helper is missing (${HELPER}). Reinstall promptdiff.`);
  const res = await runProgram(python.file, [...python.args, "-X", "utf8", HELPER], { stdin: JSON.stringify(request), timeoutMs: 120_000 });
  if (res.code !== 0) {
    const last = res.stderr.trim().split("\n").slice(-1)[0] ?? "";
    throw new PromptdiffError(`Reading the Python prompt failed: ${last || `exit code ${res.code}`}`);
  }
  return JSON.parse(res.stdout) as T;
}

/** Prompt-like names in Python files ("SYSTEM_PROMPT", "Prompts.SUPPORT"), in one Python call. */
export async function listPythonPrompts(files: { path: string; source: string }[]): Promise<Map<string, string[]>> {
  if (files.length === 0) return new Map();
  const res = await runHelper<{ names: Record<string, string[]> }>({ mode: "list", files });
  return new Map(Object.entries(res.names));
}

export interface PythonExtraction {
  text?: string;
  files?: string[];
  error?: string;
  hint?: string;
}

/** Reads prompts from Python files at a git ref (or the working copy when ref is undefined). */
export async function extractPythonPrompts(repoRoot: string, ref: string | undefined, items: { file: string; name: string }[]): Promise<PythonExtraction[]> {
  if (items.length === 0) return [];
  const res = await runHelper<{ results: PythonExtraction[] }>({ mode: "extract", repoRoot, ref: ref ?? null, items });
  return res.results;
}

/** Like extractPythonPrompts for one prompt, throwing a readable error on failure. */
export async function extractPythonPrompt(repoRoot: string, ref: string | undefined, file: string, name: string): Promise<{ text: string; files: string[] }> {
  const [r] = await extractPythonPrompts(repoRoot, ref, [{ file, name }]);
  if (!r || r.error !== undefined || r.text === undefined) {
    throw new PromptdiffError(r?.error ?? `Couldn't read ${file}#${name}`, { hint: r?.hint });
  }
  return { text: r.text, files: r.files ?? [file] };
}
