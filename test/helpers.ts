import type { TestCase } from "../src/cases.js";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export function tempDir(prefix = "promptdiff-test-"): string {
  return realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)));
}

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

export function gitIn(dir: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: dir, env: GIT_ENV, encoding: "utf8" });
}

export function writeFiles(dir: string, files: Record<string, string>): void {
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
}

/** Creates a repo with one commit on branch "main" containing `files`. */
export function makeRepo(files: Record<string, string>): string {
  const dir = tempDir();
  gitIn(dir, "init", "-q", "-b", "main");
  writeFiles(dir, files);
  gitIn(dir, "add", "-A");
  gitIn(dir, "commit", "-q", "-m", "initial");
  return dir;
}

export class Sink {
  data = "";
  isTTY = false;
  columns = 120;
  write(s: string) {
    this.data += s;
    return true;
  }
}

/** Builds a TestCase with defaults for fields a test doesn't care about. */
export function makeCase(id: string, input: string, extra: Partial<TestCase> = {}): TestCase {
  return { id, input, vars: {}, assert: [], line: 1, ...extra };
}

/**
 * Creates a fake executable (a Node script) in a fresh directory and returns that directory,
 * for use in PATH. The shebang points at this Node binary, so it works with any PATH.
 */
export function fakeBin(name: string, script: string): string {
  const dir = tempDir("promptdiff-bin-");
  const file = path.join(dir, name);
  writeFileSync(file, `#!${process.execPath}\n${script}\n`);
  chmodSync(file, 0o755);
  return dir;
}
