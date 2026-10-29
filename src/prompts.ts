import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { diffLines } from "diff";
import { extractPrompt, isCodeFile, listPromptExports } from "./code-prompts.js";
import { compilePattern } from "./config/resolve.js";
import { git } from "./git.js";
import { fileLister, refReader, workingReader } from "./prompt-source.js";
import { extractDataPrompt, isDataFile, listDataPrompts } from "./data-prompts.js";
import { extractPythonPrompts, isPythonFile, listPythonPrompts, type PythonExtraction } from "./python-prompts.js";

const PROMPT_EXTENSIONS = new Set([".md", ".mdx", ".txt", ".prompt", ".prompty", ".jinja", ".jinja2", ".j2", ".hbs", ".mustache", ".tmpl", ".tpl", ".xml"]);
const NOT_PROMPTS = /^(readme|changelog|contributing|license|code_of_conduct|security|claude|agents)(\..*)?$/i;

/** Whether a path looks like a prompt file (by extension, skipping READMEs and the like). */
export function isPromptLike(file: string): boolean {
  const base = path.basename(file);
  return PROMPT_EXTENSIONS.has(path.extname(file).toLowerCase()) && !NOT_PROMPTS.test(base);
}

/** Paths that mention "prompt" sort first. */
const rank = (f: string) => (/prompt/i.test(f) ? 0 : 1);
const byRank = (a: string, b: string) => rank(a) - rank(b) || a.localeCompare(b);

/** Prompt-like files that differ between `base` and the working copy, relative to cwd. */
export async function changedPromptFiles(cwd: string, base = "HEAD"): Promise<string[]> {
  try {
    const { stdout } = await git(["diff", "--name-only", "--relative", base, "--"], cwd);
    return stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((f) => f && isPromptLike(f) && existsSync(path.join(cwd, f)))
      .sort(byRank);
  } catch {
    return [];
  }
}

/** Prompt-like files tracked by git under cwd (for completion). */
export async function trackedPromptFiles(cwd: string): Promise<string[]> {
  try {
    const { stdout } = await git(["ls-files", "--", "."], cwd);
    return stdout.split("\n").map((l) => l.trim()).filter((f) => f && isPromptLike(f)).sort(byRank);
  } catch {
    return [];
  }
}

export interface PromptFileStatus {
  path: string;
  changed: boolean;
  added?: number;
  removed?: number;
}

/**
 * Tracked prompt-like files, with lines added/removed since `base`.
 * Changed files come first.
 */
export async function promptFilesWithStatus(cwd: string, base = "HEAD"): Promise<PromptFileStatus[]> {
  const tracked = await trackedPromptFiles(cwd);
  const stats = new Map<string, { added?: number; removed?: number }>();
  try {
    const { stdout } = await git(["diff", "--numstat", "--relative", base, "--"], cwd);
    for (const line of stdout.split("\n")) {
      const [a, r, file] = line.split("\t");
      if (!file) continue;
      stats.set(file, { added: a === "-" ? undefined : Number(a), removed: r === "-" ? undefined : Number(r) });
    }
  } catch {
    // unknown base ref: show everything as unchanged
  }
  const files = tracked.filter((f) => existsSync(path.join(cwd, f))).map((f): PromptFileStatus => ({ path: f, changed: stats.has(f), ...stats.get(f) }));
  return [...files.filter((f) => f.changed), ...files.filter((f) => !f.changed)];
}

// ── Discovery, including prompts that live in code ──────────────────────────

export interface DiscoveredPrompt extends PromptFileStatus {
  /** Set when a prompt in code couldn't be read (shown, and explained on compare). */
  error?: string;
}

const NOT_SOURCE = /(\.spec\.|\.test\.|\.stories\.|\.d\.ts$|__snapshots__|__tests__|__mocks__)/;
/** Hidden folders (.claude, .github, .codex…) hold tool config, not app prompts. */
const HIDDEN_DIR = /(^|\/)\.[^/]+\//;

/**
 * Lists prompts under cwd: plain prompt files, and exported prompt constants in code files.
 * With `patterns` (from the `prompts:` setting), lists exactly what they match. Otherwise lists
 * files whose path mentions "prompt", falling back to every prompt-like text file.
 * Each entry is marked changed when its text differs from `base`.
 */
export async function discoverPrompts(
  cwd: string,
  base = "HEAD",
  patterns?: { path: string }[],
  configDir = cwd,
): Promise<DiscoveredPrompt[]> {
  const repoRoot = await getRepoRootSafe(cwd);
  if (!repoRoot) return [];
  const prefix = (await git(["rev-parse", "--show-prefix"], cwd)).stdout.trim();
  const tracked = (await git(["ls-files", "--", "."], cwd)).stdout.split("\n").filter(Boolean);

  // Repo paths that differ from base (for deciding which code prompts to re-check).
  let changedRepoPaths = new Set<string>();
  let baseExists = true;
  try {
    changedRepoPaths = new Set((await git(["diff", "--name-only", base, "--"], repoRoot)).stdout.split("\n").filter(Boolean));
  } catch {
    baseExists = false;
  }
  const textStatus = new Map((await promptFilesWithStatus(cwd, base)).map((f) => [f.path, f]));

  type Candidate = { file: string; names?: string[]; python?: boolean; data?: boolean; error?: string };
  const candidates: Candidate[] = [];
  const readWorking = (f: string) => readFile(path.join(cwd, f), "utf8").catch(() => undefined);
  const exportsOf = async (f: string, only?: string) => {
    if (only) return [only];
    const source = await readWorking(f);
    if (source === undefined) return [];
    try {
      return listPromptExports(f, source);
    } catch {
      return [];
    }
  };
  /** Adds a code file: TS/JS names are listed now; Python names in one batch afterwards. */
  const addCode = async (f: string, only?: string) => {
    if (isDataFile(f)) {
      let names = only ? [only] : [];
      if (!only) {
        try {
          names = listDataPrompts(f, (await readWorking(f)) ?? "");
        } catch {
          names = [];
        }
      }
      if (names.length) candidates.push({ file: f, names, data: true });
      return;
    }
    if (isPythonFile(f)) {
      candidates.push({ file: f, python: true, names: only ? [only] : undefined });
      return;
    }
    const names = await exportsOf(f, only);
    if (names.length) candidates.push({ file: f, names });
  };

  if (patterns?.length) {
    const compiled = patterns.map((p) => compilePattern(p.path));
    for (const f of tracked) {
      const rel = path.relative(configDir, path.join(cwd, f));
      for (const pat of compiled) {
        if (!pat.match(rel)) continue;
        if (isCodeFile(f) || isPythonFile(f) || isDataFile(f)) await addCode(f, pat.name);
        else candidates.push({ file: f });
        break;
      }
    }
  } else {
    for (const f of tracked) {
      if (!/prompt/i.test(f) || NOT_SOURCE.test(f) || HIDDEN_DIR.test(f) || /(^|\/)test_[^/]*\.py$/.test(f)) continue;
      if (isPromptLike(f)) candidates.push({ file: f });
      else if ((isCodeFile(f) && !/\.(tsx|jsx)$/.test(f)) || isPythonFile(f) || (isDataFile(f) && !/(^|\/)(package|tsconfig|package-lock|composer)\.json$/.test(f))) await addCode(f);
    }
    if (candidates.length === 0) {
      for (const f of tracked) if (isPromptLike(f) && !NOT_SOURCE.test(f) && !HIDDEN_DIR.test(f)) candidates.push({ file: f });
    }
  }

  // List names in Python files, all in one call.
  const pythonToList = candidates.filter((cand) => cand.python && !cand.names);
  if (pythonToList.length) {
    try {
      const sources = [];
      for (const cand of pythonToList) {
        const source = await readWorking(cand.file);
        if (source !== undefined) sources.push({ path: cand.file, source });
      }
      const listed = await listPythonPrompts(sources);
      for (const cand of pythonToList) cand.names = listed.get(cand.file) ?? [];
    } catch (err) {
      for (const cand of pythonToList) {
        cand.names = [];
        cand.error = (err as Error).message;
      }
    }
  }

  const workingRead = workingReader(repoRoot);
  const baseRead = refReader(repoRoot, base);
  const workingFiles = fileLister(repoRoot, "working");
  const baseFiles = fileLister(repoRoot, { ref: base });
  const repoPathOf = (f: string) => path.posix.normalize(prefix + f);

  // Read Python prompts in two batches: the working copy, then (for changed ones) the base.
  const pyKey = (file: string, name: string) => `${file}#${name}`;
  const pyNow = new Map<string, PythonExtraction>();
  const pyBefore = new Map<string, PythonExtraction>();
  const pyItems = candidates.filter((cand) => cand.python).flatMap((cand) => (cand.names ?? []).map((name) => ({ file: repoPathOf(cand.file), name })));
  if (pyItems.length) {
    try {
      const now = await extractPythonPrompts(repoRoot, undefined, pyItems);
      pyItems.forEach((it, i) => pyNow.set(pyKey(it.file, it.name), now[i]!));
      const changedItems = pyItems.filter((it) => baseExists && (pyNow.get(pyKey(it.file, it.name))?.files ?? []).some((f) => changedRepoPaths.has(f)));
      const before = await extractPythonPrompts(repoRoot, base, changedItems);
      changedItems.forEach((it, i) => pyBefore.set(pyKey(it.file, it.name), before[i]!));
    } catch (err) {
      for (const it of pyItems) pyNow.set(pyKey(it.file, it.name), { error: (err as Error).message });
    }
  }

  const stats = (before: string | undefined, now: string) => {
    let added = 0;
    let removed = 0;
    for (const part of diffLines(before ?? "", now)) {
      if (part.added) added += part.count ?? 0;
      if (part.removed) removed += part.count ?? 0;
    }
    return { added, removed };
  };

  const out: DiscoveredPrompt[] = [];
  for (const cand of candidates) {
    if (cand.error) {
      out.push({ path: cand.file, changed: false, error: cand.error });
      continue;
    }
    if (!cand.names) {
      const st = textStatus.get(cand.file);
      if (st) out.push(st);
      else if (existsSync(path.join(cwd, cand.file))) out.push({ path: cand.file, changed: false });
      continue;
    }
    const repoPath = repoPathOf(cand.file);
    for (const name of cand.names) {
      const spec = `${cand.file}#${name}`;
      if (cand.data) {
        try {
          const now = extractDataPrompt(cand.file, (await readWorking(cand.file)) ?? "", name);
          if (!baseExists || !changedRepoPaths.has(repoPath)) {
            out.push({ path: spec, changed: false });
            continue;
          }
          const baseSource = await baseRead(repoPath);
          let before: string | undefined;
          try {
            before = baseSource === undefined ? undefined : extractDataPrompt(cand.file, baseSource, name);
          } catch {
            before = undefined;
          }
          out.push(before === now ? { path: spec, changed: false } : { path: spec, changed: true, ...stats(before, now) });
        } catch (err) {
          out.push({ path: spec, changed: false, error: (err as Error).message });
        }
        continue;
      }
      if (cand.python) {
        const now = pyNow.get(pyKey(repoPath, name));
        if (!now || now.text === undefined) {
          out.push({ path: spec, changed: false, error: now?.error ?? "couldn't read" });
          continue;
        }
        const before = pyBefore.get(pyKey(repoPath, name));
        if (!before || before.text === now.text) {
          out.push({ path: spec, changed: false });
          continue;
        }
        out.push({ path: spec, changed: true, ...stats(before.text, now.text) });
        continue;
      }
      try {
        const now = await extractPrompt(repoPath, name, workingRead, { listFiles: workingFiles });
        if (!baseExists || !now.files.some((f) => changedRepoPaths.has(f))) {
          out.push({ path: spec, changed: false });
          continue;
        }
        let before: string | undefined;
        try {
          before = (await extractPrompt(repoPath, name, baseRead, { listFiles: baseFiles })).text;
        } catch {
          before = undefined; // new prompt, or unreadable at base
        }
        if (before === now.text) {
          out.push({ path: spec, changed: false });
          continue;
        }
        out.push({ path: spec, changed: true, ...stats(before, now.text) });
      } catch (err) {
        out.push({ path: spec, changed: false, error: (err as Error).message });
      }
    }
  }
  return [...out.filter((p) => p.changed), ...out.filter((p) => !p.changed)];
}

async function getRepoRootSafe(cwd: string): Promise<string | undefined> {
  try {
    return path.resolve((await git(["rev-parse", "--show-toplevel"], cwd)).stdout.trim());
  } catch {
    return undefined;
  }
}
