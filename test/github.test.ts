import { writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCommand } from "../src/commands/run.js";
import { resolveGitHubContext, upsertComment, type GitHubContext } from "../src/github.js";
import { MockProvider } from "../src/providers/mock.js";
import { MAX_MARKDOWN_LENGTH, commentMarker, renderMarkdown } from "../src/report/markdown.js";
import type { DiffReport } from "../src/types.js";
import { Sink, makeRepo, tempDir } from "./helpers.js";

type Call = { url: string; method: string; body?: string; headers?: Record<string, string> };

function fakeGitHub(existing: { id: number; body: string }[] = []) {
  const calls: Call[] = [];
  const fetchImpl = async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body, headers: init?.headers });
    const json = method === "GET" ? existing : { html_url: `https://github.com/acme/bot/pull/7#issuecomment-${method === "PATCH" ? existing[0]!.id : 99}` };
    return { ok: true, status: 200, json: async () => json, text: async () => "" };
  };
  return { calls, fetchImpl };
}

const ctx: GitHubContext = { token: "ghs_secret", repo: "acme/bot", pr: 7, apiUrl: "https://api.github.com" };

describe("GitHub comments", () => {
  it("creates a comment when none exists", async () => {
    const gh = fakeGitHub([{ id: 1, body: "unrelated" }]);
    const r = await upsertComment(ctx, "<!-- promptdiff:p.md -->", "hello", gh.fetchImpl);
    expect(r.action).toBe("created");
    expect(gh.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "GET https://api.github.com/repos/acme/bot/issues/7/comments?per_page=100&page=1",
      "POST https://api.github.com/repos/acme/bot/issues/7/comments",
    ]);
    expect(gh.calls[0]!.headers!.Authorization).toBe("Bearer ghs_secret");
  });

  it("updates its own comment instead of posting again", async () => {
    const gh = fakeGitHub([{ id: 5, body: "<!-- promptdiff:p.md -->\nold" }]);
    const r = await upsertComment(ctx, "<!-- promptdiff:p.md -->", "new", gh.fetchImpl);
    expect(r.action).toBe("updated");
    expect(gh.calls[1]).toMatchObject({ method: "PATCH", url: "https://api.github.com/repos/acme/bot/issues/comments/5", body: '{"body":"new"}' });
  });

  it("explains permission errors", async () => {
    const fetchImpl = async () => ({ ok: false, status: 403, json: async () => ({}), text: async () => "Resource not accessible by integration" });
    await expect(upsertComment(ctx, "m", "b", fetchImpl)).rejects.toMatchObject({ hint: expect.stringContaining("pull-requests: write") });
  });

  it("reads the PR number from the Actions event or --pr", async () => {
    const dir = tempDir();
    const event = path.join(dir, "event.json");
    writeFileSync(event, JSON.stringify({ pull_request: { number: 42 } }));
    const env = { GITHUB_TOKEN: "t", GITHUB_REPOSITORY: "acme/bot", GITHUB_EVENT_PATH: event };
    expect((await resolveGitHubContext(env)).pr).toBe(42);
    expect((await resolveGitHubContext(env, "9")).pr).toBe(9);
    await expect(resolveGitHubContext({ GITHUB_REPOSITORY: "acme/bot" })).rejects.toThrow(/needs a GitHub token/);
    await expect(resolveGitHubContext({ GITHUB_TOKEN: "t", GITHUB_REPOSITORY: "acme/bot" })).rejects.toThrow(/which pull request/);
  });
});

async function changedReport(cases: string): Promise<{ report: DiffReport; repo: string }> {
  const repo = makeRepo({ "p.md": "Version one\n", "cases.jsonl": cases, "promptdiff.config.yaml": "model: mock:m\n" });
  writeFileSync(path.join(repo, "p.md"), "Version two\n");
  const stdout = new Sink();
  await runCommand("p.md", { cache: false, json: true }, {
    cwd: repo, env: {}, stdout, stderr: new Sink(), createProvider: () => new MockProvider(), userConfigFile: path.join(tempDir(), "c.json"),
  });
  return { report: JSON.parse(stdout.data) as DiffReport, repo };
}

describe("Markdown report", () => {
  it("summarizes, lists cases to review with diffs, and carries the marker", async () => {
    const { report } = await changedReport('{"id": "a", "input": "hi", "assert": [{"type": "contains", "value": "one"}]}\n{"id": "b", "input": "x"}');
    const md = renderMarkdown(report);
    expect(md.startsWith(commentMarker("p.md"))).toBe(true);
    expect(md).toContain("🔴 **1 regression**");
    expect(md).toContain("<b>a</b> 🔴 regression · 🟡 changed");
    expect(md).toContain("```diff\n- [Version one] You said: hi\n+ [Version two] You said: hi\n```");
    expect(md).toContain('- ❌ `contains "one"` — text not found');
    expect(md).toMatch(/\| 2 \| 0 \| 0 \|/);
  });

  it("stays under GitHub's size limit", async () => {
    const lines = Array.from({ length: 400 }, (_, i) => JSON.stringify({ id: `case-${i}`, input: "x".repeat(400) }));
    const { report } = await changedReport(lines.join("\n"));
    const md = renderMarkdown(report);
    expect(md.length).toBeLessThan(MAX_MARKDOWN_LENGTH + 2000);
    expect(md).toMatch(/…and \d+ more cases not shown/);
  });

  it("uses a longer fence when outputs contain backticks", async () => {
    const { report } = await changedReport('{"id": "a", "input": "```code```"}');
    expect(renderMarkdown(report)).toContain("````diff");
  });
});

describe("runCommand --github-comment", () => {
  it("posts the report, and checks GitHub setup before spending anything", async () => {
    const repo = makeRepo({ "p.md": "v1", "cases.jsonl": '{"input": "x"}', "promptdiff.config.yaml": "model: mock:m\n" });
    const provider = new MockProvider();
    const deps = { cwd: repo, stdout: new Sink(), stderr: new Sink(), createProvider: () => provider, userConfigFile: path.join(tempDir(), "c.json") };

    await expect(runCommand("p.md", { githubComment: true }, { ...deps, env: {} })).rejects.toThrow(/GitHub token/);
    expect(provider.calls).toHaveLength(0);

    const gh = fakeGitHub();
    const stderr = new Sink();
    await runCommand("p.md", { githubComment: true, pr: "3", cache: false }, {
      ...deps, stderr, env: { GITHUB_TOKEN: "t", GITHUB_REPOSITORY: "acme/bot" }, fetch: gh.fetchImpl,
    });
    expect(gh.calls.at(-1)!.method).toBe("POST");
    expect(JSON.parse(gh.calls.at(-1)!.body!).body).toContain("### promptdiff: `p.md`");
    expect(stderr.data).toContain("PR comment created");
  });
});
