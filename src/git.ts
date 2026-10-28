import { execFile } from "node:child_process";
import path from "node:path";
import { PromptdiffError } from "./errors.js";

export interface GitResult {
  stdout: string;
  stderr: string;
}

/**
 * Runs git with an argument array via execFile (never through a shell),
 * so refs and paths can't be used for shell injection.
 */
export function git(args: string[], cwd: string): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd, maxBuffer: 64 * 1024 * 1024, windowsHide: true, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error) {
          reject(Object.assign(error, { stdout, stderr }));
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

function isMissingGit(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === "ENOENT";
}

const MISSING_GIT = () =>
  new PromptdiffError("git is not installed or not on your PATH.", {
    hint: "Install git from https://git-scm.com/downloads and try again.",
  });

/** Returns the absolute path of the repository root containing `cwd`. */
export async function getRepoRoot(cwd: string): Promise<string> {
  try {
    const { stdout } = await git(["rev-parse", "--show-toplevel"], cwd);
    return path.resolve(stdout.trim());
  } catch (err) {
    if (isMissingGit(err)) throw MISSING_GIT();
    throw new PromptdiffError(`Not inside a git repository: ${cwd}`, {
      hint: "promptdiff compares a prompt against an earlier git version. Run it from inside a git repo (or run `git init` and commit your prompt first).",
      cause: err,
    });
  }
}

/** Verifies that `ref` resolves to a commit. */
export async function assertRefExists(ref: string, cwd: string): Promise<void> {
  if (ref.startsWith("-")) {
    throw new PromptdiffError(`Invalid git ref: ${ref}`);
  }
  try {
    await git(["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`], cwd);
  } catch (err) {
    if (isMissingGit(err)) throw MISSING_GIT();
    throw new PromptdiffError(`Unknown git ref: ${ref}`, {
      hint: "Check the branch, tag, or commit name. `git branch -a` lists branches. If this is a new repo, make a first commit.",
      cause: err,
    });
  }
}

/**
 * Converts a user-supplied file path into the form `git show <ref>:<path>` expects:
 * relative to the repo root, with forward slashes (also on Windows).
 */
export async function toRepoPath(file: string, cwd: string): Promise<string> {
  const { stdout } = await git(["rev-parse", "--show-prefix"], cwd);
  const prefix = stdout.trim();
  const relFromCwd = path.relative(cwd, path.resolve(cwd, file));
  if (relFromCwd.startsWith("..") || path.isAbsolute(relFromCwd)) {
    // Outside cwd: fall back to resolving against the repo root.
    const root = await getRepoRoot(cwd);
    const rel = path.relative(root, path.resolve(cwd, file));
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new PromptdiffError(`File is outside the git repository: ${file}`);
    }
    return rel.split(path.sep).join("/");
  }
  return path.posix.normalize(prefix + relFromCwd.split(path.sep).join("/"));
}

/** Reads `file` as it exists at git `ref`. */
export async function readFileAtRef(file: string, ref: string, cwd: string): Promise<string> {
  await getRepoRoot(cwd);
  await assertRefExists(ref, cwd);
  const repoPath = await toRepoPath(file, cwd);
  try {
    const { stdout } = await git(["show", `${ref}:${repoPath}`], cwd);
    return stdout;
  } catch (err) {
    throw new PromptdiffError(`File "${repoPath}" does not exist at ref "${ref}".`, {
      hint: `Check the path and that it was committed on ${ref}: git log --oneline ${ref} -- ${repoPath}`,
      cause: err,
    });
  }
}
