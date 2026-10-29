import { writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { bisectCommand } from "../src/commands/bisect.js";
import { MockProvider } from "../src/providers/mock.js";
import { Sink, gitIn, makeRepo, tempDir } from "./helpers.js";

/** A repo whose prompt changes over 5 commits; "mentions the order number" breaks at commit 3. */
function history() {
  const repo = makeRepo({
    "prompt.md": "v1: ask for the order number",
    "cases.jsonl": '{"id": "refund", "input": "refund please", "assert": [{"type": "contains", "value": "order number"}]}\n{"id": "other", "input": "hi"}',
    "promptdiff.config.yaml": "model: mock:m\n",
  });
  const commit = (text: string, msg: string) => {
    writeFileSync(path.join(repo, "prompt.md"), text);
    gitIn(repo, "commit", "-qam", msg);
  };
  commit("v2: ask for the order number politely", "Polite wording");
  commit("v3: be brief", "Make it brief");
  commit("v4: be brief and warm", "Warmer");
  gitIn(repo, "add", "-A");
  return repo;
}

describe("promptdiff bisect", () => {
  it("finds the first commit where checks fail, with few model calls", async () => {
    const repo = history();
    const provider = new MockProvider((req) => ({ text: req.system, inputTokens: 1, outputTokens: 1 }));
    const out = new Sink();
    const result = await bisectCommand("prompt.md", { good: "HEAD~3", bad: "HEAD" }, {
      cwd: repo, env: {}, out, createProvider: () => provider, userConfigFile: path.join(tempDir(), "c.json"),
    });
    expect(result.subject).toBe("Make it brief");
    expect(result.failures).toEqual(['refund: contains "order number" (text not found)']);
    expect(out.data).toContain("First bad version:");
    expect(result.steps).toBeLessThanOrEqual(4);
  });

  it("checks the working copy when --bad isn't given", async () => {
    const repo = makeRepo({
      "prompt.md": "ask for the order number",
      "cases.jsonl": '{"id": "refund", "input": "x", "assert": [{"type": "contains", "value": "order number"}]}',
      "promptdiff.config.yaml": "model: mock:m\n",
    });
    writeFileSync(path.join(repo, "prompt.md"), "be brief");
    const provider = new MockProvider((req) => ({ text: req.system }));
    const result = await bisectCommand("prompt.md", { good: "HEAD" }, { cwd: repo, env: {}, out: new Sink(), createProvider: () => provider, userConfigFile: path.join(tempDir(), "c.json") });
    expect(result.firstBad).toBe("working copy");
  });

  it("needs checks, a good --good, and a bad end", async () => {
    const deps = (repo: string) => ({ cwd: repo, env: {}, out: new Sink(), createProvider: () => new MockProvider((r) => ({ text: r.system })), userConfigFile: path.join(tempDir(), "c.json") });
    const noChecks = makeRepo({ "prompt.md": "x", "cases.jsonl": '{"input": "hi"}', "promptdiff.config.yaml": "model: mock:m\n" });
    await expect(bisectCommand("prompt.md", { good: "HEAD" }, deps(noChecks))).rejects.toThrow(/needs checks/);

    const repo = history();
    await expect(bisectCommand("prompt.md", { good: "HEAD~1", bad: "HEAD" }, deps(repo))).rejects.toThrow(/already fail at --good/);
    await expect(bisectCommand("prompt.md", { good: "HEAD~3", bad: "HEAD~2" }, deps(repo))).rejects.toThrow(/pass at HEAD~2 too/);
  });
});
