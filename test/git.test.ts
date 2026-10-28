import { writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PromptdiffError } from "../src/errors.js";
import { getRepoRoot, readFileAtRef, toRepoPath } from "../src/git.js";
import { gitIn, makeRepo, tempDir } from "./helpers.js";

describe("git", () => {
  it("reads a file at a ref, independent of working copy edits", async () => {
    const repo = makeRepo({ "prompts/support.md": "v1\n" });
    writeFileSync(path.join(repo, "prompts/support.md"), "v2\n");
    expect(await readFileAtRef("prompts/support.md", "HEAD", repo)).toBe("v1\n");
    expect(await readFileAtRef("prompts/support.md", "main", repo)).toBe("v1\n");
  });

  it("reads older commits and other refs", async () => {
    const repo = makeRepo({ "p.md": "one" });
    writeFileSync(path.join(repo, "p.md"), "two");
    gitIn(repo, "commit", "-qam", "second");
    gitIn(repo, "tag", "v2");
    expect(await readFileAtRef("p.md", "HEAD~1", repo)).toBe("one");
    expect(await readFileAtRef("p.md", "v2", repo)).toBe("two");
  });

  it("resolves paths relative to a subdirectory", async () => {
    const repo = makeRepo({ "prompts/a/b.md": "deep" });
    const sub = path.join(repo, "prompts");
    expect(await toRepoPath("a/b.md", sub)).toBe("prompts/a/b.md");
    expect(await readFileAtRef("a/b.md", "HEAD", sub)).toBe("deep");
    expect(await readFileAtRef("../prompts/a/b.md", "HEAD", sub)).toBe("deep");
  });

  it("errors clearly when the file doesn't exist at the ref", async () => {
    const repo = makeRepo({ "a.md": "x" });
    writeFileSync(path.join(repo, "new.md"), "uncommitted");
    await expect(readFileAtRef("new.md", "HEAD", repo)).rejects.toThrow(/does not exist at ref "HEAD"/);
  });

  it("errors clearly for unknown refs", async () => {
    const repo = makeRepo({ "a.md": "x" });
    await expect(readFileAtRef("a.md", "no-such-branch", repo)).rejects.toThrow(/Unknown git ref: no-such-branch/);
  });

  it("refuses refs that look like options", async () => {
    const repo = makeRepo({ "a.md": "x" });
    await expect(readFileAtRef("a.md", "--output=/tmp/pwn", repo)).rejects.toThrow(PromptdiffError);
  });

  it("does not interpret shell metacharacters", async () => {
    const repo = makeRepo({ "a.md": "x" });
    await expect(readFileAtRef("a.md", "HEAD; echo pwned", repo)).rejects.toThrow(/Unknown git ref/);
  });

  it("errors outside a git repository", async () => {
    const dir = tempDir();
    await expect(getRepoRoot(dir)).rejects.toThrow(/Not inside a git repository/);
  });
});
