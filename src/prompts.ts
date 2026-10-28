import { existsSync } from "node:fs";
import path from "node:path";
import { git } from "./git.js";

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
