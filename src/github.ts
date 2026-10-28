import { readFile } from "node:fs/promises";
import { PromptdiffError } from "./errors.js";

export interface GitHubContext {
  token: string;
  /** "owner/name" */
  repo: string;
  pr: number;
  apiUrl: string;
}

type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

/**
 * Works out where to comment from GitHub Actions' environment:
 * GITHUB_TOKEN (or GH_TOKEN), GITHUB_REPOSITORY, and the PR number from
 * --pr or the event payload at GITHUB_EVENT_PATH.
 */
export async function resolveGitHubContext(env: NodeJS.ProcessEnv, prFlag?: string): Promise<GitHubContext> {
  const token = env.GITHUB_TOKEN || env.GH_TOKEN;
  if (!token) {
    throw new PromptdiffError("--github-comment needs a GitHub token.", {
      hint: "In GitHub Actions, add `env: GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}` to the step, and `permissions: pull-requests: write` to the job.",
    });
  }
  const repo = env.GITHUB_REPOSITORY;
  if (!repo || !/^[^/]+\/[^/]+$/.test(repo)) {
    throw new PromptdiffError("--github-comment needs GITHUB_REPOSITORY (owner/name).", {
      hint: "GitHub Actions sets it automatically. Elsewhere, set it yourself, e.g. GITHUB_REPOSITORY=acme/support-bot.",
    });
  }

  let pr: number | undefined;
  if (prFlag !== undefined) {
    pr = Number(prFlag);
    if (!Number.isInteger(pr) || pr <= 0) throw new PromptdiffError(`--pr must be a pull request number, got "${prFlag}"`);
  } else if (env.GITHUB_EVENT_PATH) {
    try {
      const event = JSON.parse(await readFile(env.GITHUB_EVENT_PATH, "utf8")) as {
        pull_request?: { number?: number };
        issue?: { number?: number; pull_request?: unknown };
        number?: number;
      };
      pr = event.pull_request?.number ?? (event.issue?.pull_request ? event.issue.number : undefined) ?? event.number;
    } catch {
      // handled below
    }
  }
  if (!pr) {
    throw new PromptdiffError("Couldn't tell which pull request to comment on.", {
      hint: "Run in a `pull_request` workflow, or pass --pr <number>.",
    });
  }
  return { token, repo, pr, apiUrl: (env.GITHUB_API_URL || "https://api.github.com").replace(/\/$/, "") };
}

async function call(ctx: GitHubContext, fetchImpl: FetchLike, method: string, path: string, body?: unknown) {
  const res = await fetchImpl(`${ctx.apiUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${ctx.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "promptdiff",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 200);
    const hint =
      res.status === 403 || res.status === 404
        ? "Give the job `permissions: pull-requests: write`. Note that pull requests from forks get a read-only token."
        : undefined;
    throw new PromptdiffError(`GitHub API ${method} ${path} failed with HTTP ${res.status}: ${detail}`, { hint });
  }
  return res.json();
}

/** Creates the PR comment, or updates the existing one with the same marker so re-runs don't spam the PR. */
export async function upsertComment(
  ctx: GitHubContext,
  marker: string,
  body: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<{ action: "created" | "updated"; url: string }> {
  for (let page = 1; page <= 10; page++) {
    const comments = (await call(ctx, fetchImpl, "GET", `/repos/${ctx.repo}/issues/${ctx.pr}/comments?per_page=100&page=${page}`)) as {
      id: number;
      body?: string;
    }[];
    const existing = comments.find((c) => c.body?.includes(marker));
    if (existing) {
      const updated = (await call(ctx, fetchImpl, "PATCH", `/repos/${ctx.repo}/issues/comments/${existing.id}`, { body })) as { html_url: string };
      return { action: "updated", url: updated.html_url };
    }
    if (comments.length < 100) break;
  }
  const created = (await call(ctx, fetchImpl, "POST", `/repos/${ctx.repo}/issues/${ctx.pr}/comments`, { body })) as { html_url: string };
  return { action: "created", url: created.html_url };
}
