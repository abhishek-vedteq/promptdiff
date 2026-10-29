import path from "node:path";
import { ResultCache, defaultCacheDir } from "../cache.js";
import { loadCases, type TestCase } from "../cases.js";
import { loadProjectConfig } from "../config/project.js";
import { casesForPrompt } from "../config/resolve.js";
import { PromptdiffError } from "../errors.js";
import { assertRefExists, getRepoRoot, git, toRepoPath } from "../git.js";
import { loadPrompt, parsePromptSpec } from "../prompt-source.js";
import { setupModel } from "../model-setup.js";
import type { Credential, Provider } from "../providers/types.js";
import { loadBuiltinPricing } from "../pricing.js";
import type { RetryOptions } from "../retry.js";
import { runDiff } from "../runner.js";

export interface BisectOptions {
  good: string;
  bad?: string;
  case?: string[];
  model?: string;
  cases?: string;
  config?: string;
  cache?: boolean;
}

export interface BisectDeps {
  cwd: string;
  env: NodeJS.ProcessEnv;
  out: { write(s: string): unknown };
  createProvider?: (providerId: string, credential: Credential) => Provider;
  userConfigFile?: string;
  retry?: RetryOptions;
}

export interface BisectResult {
  /** The first version whose checks fail: a commit hash, or "working copy". */
  firstBad: string;
  subject?: string;
  failures: string[];
  steps: number;
}

const WORKING = "working copy";

/**
 * Finds the first version of a prompt whose checks fail, by binary search over the commits
 * that changed the prompt (or a file it's built from) between --good and --bad.
 */
export async function bisectCommand(prompt: string, opts: BisectOptions, partial: Partial<BisectDeps> = {}): Promise<BisectResult> {
  const deps: BisectDeps = { cwd: process.cwd(), env: process.env, out: process.stdout, ...partial };
  const { cwd } = deps;
  const project = await loadProjectConfig(cwd, opts.config);
  const repoRoot = await getRepoRoot(cwd);
  await assertRefExists(opts.good, cwd);
  if (opts.bad) await assertRefExists(opts.bad, cwd);

  // Test cases, restricted to --case if given; they must have checks to decide good from bad.
  const configDir = project.file ? path.dirname(project.file) : cwd;
  const casesFile = opts.cases
    ? path.resolve(cwd, opts.cases)
    : (casesForPrompt(project.config, project.file, cwd, prompt) ?? path.resolve(configDir, project.config.cases ?? "cases.jsonl"));
  let cases: TestCase[] = await loadCases(casesFile, path.relative(cwd, casesFile));
  if (opts.case?.length) {
    cases = cases.filter((tc) => opts.case!.includes(tc.id));
    if (!cases.length) throw new PromptdiffError(`No test case with id ${opts.case.map((c) => `"${c}"`).join(", ")}.`);
  }
  const defaults = project.config.assert ?? [];
  if (!defaults.length && !cases.some((tc) => tc.assert.length)) {
    throw new PromptdiffError("bisect needs checks to tell good answers from bad ones, and these test cases have none.", {
      hint: 'Add checks to the case that went wrong, e.g. "assert": [{"type": "llm-rubric", "value": "Asks for the order number"}]. See docs/assertions.md.',
    });
  }

  // Candidate versions: commits after --good that touched the prompt or what it's built from.
  const badLabel = opts.bad ?? WORKING;
  const current = await loadPrompt(prompt, opts.bad ? { ref: opts.bad } : "working", cwd);
  const goodPrompt = await loadPrompt(prompt, { ref: opts.good }, cwd);
  // Prompts in code: every file they're built from (repo paths). Plain files: just the file.
  const files = parsePromptSpec(prompt).name
    ? [...new Set([...current.files, ...goodPrompt.files])]
    : [await toRepoPath(parsePromptSpec(prompt).file, cwd)];
  const range = `${opts.good}..${opts.bad ?? "HEAD"}`;
  const log = (await git(["log", "--reverse", "--format=%H%x09%s", range, "--", ...files], repoRoot)).stdout.trim();
  const commits = log ? log.split("\n").map((l) => ({ ref: l.split("\t")[0]!, subject: l.split("\t").slice(1).join("\t") })) : [];
  if (!opts.bad) commits.push({ ref: WORKING, subject: "uncommitted changes" });

  const model = await setupModel({ model: opts.model ?? project.config.model, env: deps.env, userConfigFile: deps.userConfigFile, createProvider: deps.createProvider });
  const cache = opts.cache === false ? undefined : new ResultCache(defaultCacheDir(repoRoot));
  const pricing = loadBuiltinPricing();
  const dummy = new Map(cases.map((tc) => [tc.id, [{ text: "" }]]));
  let steps = 0;

  /** Runs the cases on one version of the prompt; returns the checks that failed. */
  const failuresAt = async (ref: string): Promise<string[]> => {
    steps++;
    const text = (await loadPrompt(prompt, ref === WORKING ? "working" : { ref }, cwd)).text;
    const results = await runDiff({
      provider: model.provider,
      modelSpec: model.modelSpec,
      modelId: model.modelId,
      basePrompt: text,
      headPrompt: text,
      cases,
      runs: 1,
      concurrency: 4,
      cache,
      pricing,
      defaultAssertions: defaults,
      baseline: dummy, // only the version under test is run
      retry: deps.retry,
    });
    const failed: string[] = [];
    for (const cr of results) {
      for (const o of cr.head) {
        if (o.error) failed.push(`${cr.id}: ${o.error}`);
        for (const r of o.checks ?? []) if (!r.pass) failed.push(`${cr.id}: ${r.label}${r.reason ? ` (${r.reason})` : ""}`);
      }
    }
    return failed;
  };
  const short = (ref: string) => (ref === WORKING ? WORKING : ref.slice(0, 8));

  deps.out.write(`Checking ${cases.length} case${cases.length === 1 ? "" : "s"} (${cases.map((tc) => tc.id).join(", ")}) with ${model.modelSpec}.\n`);
  deps.out.write(`${commits.length} version${commits.length === 1 ? "" : "s"} changed the prompt between ${opts.good} and ${badLabel}; about ${Math.ceil(Math.log2(commits.length + 1)) + 2} checks to go.\n`);

  const goodFailures = await failuresAt(opts.good);
  if (goodFailures.length) {
    throw new PromptdiffError(`The checks already fail at --good ${opts.good}, so there's nothing to search.`, { hint: goodFailures.slice(0, 5).join("\n") });
  }
  deps.out.write(`  ✓ ${opts.good} (good)\n`);
  if (commits.length === 0) throw new PromptdiffError(`The prompt didn't change between ${opts.good} and ${badLabel}.`);
  const lastFailures = await failuresAt(commits.at(-1)!.ref);
  if (!lastFailures.length) {
    throw new PromptdiffError(`The checks pass at ${badLabel} too, so there's no bad version to find.`, {
      hint: "If the answers did get worse, add a check that describes what's wrong now, then run bisect again.",
    });
  }
  deps.out.write(`  ✗ ${short(commits.at(-1)!.ref)} (bad)\n`);

  // Invariant: everything before lo is good; commits[hi] is bad.
  let lo = 0;
  let hi = commits.length - 1;
  let hiFailures = lastFailures;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const failures = await failuresAt(commits[mid]!.ref);
    deps.out.write(`  ${failures.length ? "✗" : "✓"} ${short(commits[mid]!.ref)} ${commits[mid]!.subject}\n`);
    if (failures.length) {
      hi = mid;
      hiFailures = failures;
    } else lo = mid + 1;
  }
  const first = commits[hi]!;
  deps.out.write(`\nFirst bad version: ${short(first.ref)}  ${first.subject}\n`);
  for (const f of hiFailures.slice(0, 8)) deps.out.write(`  ✗ ${f}\n`);
  if (first.ref !== WORKING) deps.out.write(`See the change: git show ${short(first.ref)}\n`);
  return { firstBad: first.ref, subject: first.subject, failures: hiFailures, steps };
}
