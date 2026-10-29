import { readFile } from "node:fs/promises";
import path from "node:path";
import { extractPrompt, isCodeFile, listPromptExports, type SourceReader } from "./code-prompts.js";
import { PromptdiffError } from "./errors.js";
import { DATA_PATH, extractDataPrompt, isDataFile, listDataPrompts } from "./data-prompts.js";
import { extractPythonPrompt, isPythonFile, listPythonPrompts } from "./python-prompts.js";
import { assertRefExists, getRepoRoot, git, readFileAtRef, toRepoPath } from "./git.js";

/**
 * A prompt reference: a plain file ("prompts/support.md"), or an exported constant in a
 * code file ("src/prompts/email.prompt.ts#EMAIL_SYSTEM_PROMPT").
 */
export interface PromptSpec {
  file: string;
  /** Export name, for prompts in code. */
  name?: string;
}

export function parsePromptSpec(spec: string): PromptSpec {
  const hash = spec.lastIndexOf("#");
  if (hash > 0 && hash < spec.length - 1) {
    const file = spec.slice(0, hash);
    const name = spec.slice(hash + 1);
    // NAME; Class.NAME for attributes of a Python class; a key path for YAML/JSON
    const valid = isDataFile(file) ? DATA_PATH : isPythonFile(file) ? /^[A-Za-z_]\w*(\.[A-Za-z_]\w*)?$/ : /^[A-Za-z_$][\w$]*$/;
    if (valid.test(name)) return { file, name };
  }
  return { file: spec };
}

/** Which version of a prompt to load: a git ref, or the working copy. */
export type PromptVersion = { ref: string } | "working";

/** Reads repo files at a git ref (undefined if missing). */
export function refReader(repoRoot: string, ref: string): SourceReader {
  return async (repoPath) => {
    try {
      return (await git(["show", `${ref}:${repoPath}`], repoRoot)).stdout;
    } catch {
      return undefined;
    }
  };
}

/** Lists repo files at a git ref, or in the working copy (tracked and untracked, not ignored). */
export function fileLister(repoRoot: string, version: PromptVersion): () => Promise<string[]> {
  let cached: Promise<string[]> | undefined;
  return () =>
    (cached ??= git(
      version === "working" ? ["ls-files", "--cached", "--others", "--exclude-standard"] : ["ls-tree", "-r", "--name-only", version.ref],
      repoRoot,
    ).then((r) => r.stdout.split("\n").filter(Boolean), () => []));
}

/** Reads repo files from the working copy (undefined if missing). */
export function workingReader(repoRoot: string): SourceReader {
  return async (repoPath) => {
    try {
      return await readFile(path.join(repoRoot, ...repoPath.split("/")), "utf8");
    } catch {
      return undefined;
    }
  };
}

export interface LoadedPrompt {
  text: string;
  /** Repo paths the prompt was built from (just the file itself for plain files). */
  files: string[];
}

/** Loads one version of a prompt. Errors explain what's missing and how to fix it. */
export async function loadPrompt(spec: string, version: PromptVersion, cwd: string): Promise<LoadedPrompt> {
  const { file, name } = parsePromptSpec(spec);
  const where = version === "working" ? "the working copy" : `"${version.ref}"`;

  if (!name) {
    if (isCodeFile(file) || isPythonFile(file) || isDataFile(file)) await rejectWholeCodeFile(file, cwd);
    if (version === "working") {
      try {
        return { text: await readFile(path.resolve(cwd, file), "utf8"), files: [file] };
      } catch {
        throw new PromptdiffError(`File not found in the working copy: ${file}`, {
          hint: "Check the path, or pass --head <ref> to compare two committed versions.",
        });
      }
    }
    return { text: await readFileAtRef(file, version.ref, cwd), files: [file] };
  }

  const repoRoot = await getRepoRoot(cwd);
  if (version !== "working") await assertRefExists(version.ref, cwd);
  const repoPath = await toRepoPath(file, cwd);
  const read = version === "working" ? workingReader(repoRoot) : refReader(repoRoot, version.ref);
  if ((await read(repoPath)) === undefined) {
    throw new PromptdiffError(`File "${repoPath}" does not exist in ${where}.`, {
      hint: version === "working" ? "Check the path." : `Check that it was committed on ${version.ref}: git log --oneline ${version.ref} -- ${repoPath}`,
    });
  }
  try {
    if (isDataFile(repoPath)) return { text: extractDataPrompt(repoPath, (await read(repoPath))!, name), files: [repoPath] };
    if (isPythonFile(repoPath)) return await extractPythonPrompt(repoRoot, version === "working" ? undefined : version.ref, repoPath, name);
    return await extractPrompt(repoPath, name, read, { listFiles: fileLister(repoRoot, version) });
  } catch (err) {
    if (err instanceof PromptdiffError && version !== "working") {
      throw new PromptdiffError(`In the ${version.ref} version: ${err.message}`, { hint: err.hint });
    }
    throw err;
  }
}

/** A code file without "#NAME" would send source code as the prompt; explain instead. */
async function rejectWholeCodeFile(file: string, cwd: string): Promise<never> {
  let names: string[] = [];
  try {
    const source = await readFile(path.resolve(cwd, file), "utf8");
    names = isDataFile(file)
      ? listDataPrompts(file, source)
      : isPythonFile(file)
        ? ((await listPythonPrompts([{ path: file, source }])).get(file) ?? [])
        : listPromptExports(file, source);
  } catch {
    // fall through with no suggestions
  }
  throw new PromptdiffError(`${file} ${isDataFile(file) ? "holds several values" : "is a code file"}. Which prompt in it should be compared?`, {
    hint: names.length
      ? `Add the name of the exported constant after #, e.g.\n${names.slice(0, 6).map((n) => `  ${file}#${n}`).join("\n")}`
      : `Add the name of the variable holding the prompt after #, e.g. ${file}#SYSTEM_PROMPT`,
  });
}
