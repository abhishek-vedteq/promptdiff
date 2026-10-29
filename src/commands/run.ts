import { writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import chalk, { chalkStderr } from "chalk";
import { ResultCache, cacheKey, defaultCacheDir } from "../cache.js";
import { tally } from "../assertions.js";
import { caseInputKey, caseMessages, loadCases, validateAssertionSchemas, type TestCase } from "../cases.js";
import { resolveCredential, type ResolvedCredential } from "../auth.js";
import { missingKeyError, readUserConfig, redactSecrets } from "../config/keys.js";
import { PROJECT_CONFIG_FILE, loadProjectConfig } from "../config/project.js";
import { casesForPrompt, resolveRunOptions, type CliRunOptions, type ResolvedRunOptions } from "../config/resolve.js";
import { PromptdiffError } from "../errors.js";
import { detectDefaultModel, type DetectedModel } from "../detect.js";
import { runBatch, type BatchClient, type BatchRequest } from "../batch.js";
import { Budget, planRun, type RunPlan } from "../estimate.js";
import { findExecutable } from "../exec.js";
import { Judge } from "../judge.js";
import { getRepoRoot } from "../git.js";
import { loadPrompt } from "../prompt-source.js";
import { buildCaseInputs } from "../run-code.js";
import { readSnapshot, snapshotPath, writeSnapshot } from "../snapshots.js";
import { resolveGitHubContext, upsertComment } from "../github.js";
import { PROJECT_PRICING_FILE, hasPrice, loadBuiltinPricing, loadPricingFile } from "../pricing.js";
import { getProviderDefinition, parseModelSpec } from "../providers/registry.js";
import type { Credential, Provider, ProviderDefinition } from "../providers/types.js";
import { renderHtml } from "../report/html.js";
import { renderJson } from "../report/json.js";
import { commentMarker, renderMarkdown } from "../report/markdown.js";
import { renderPlan } from "../report/plan.js";
import { renderTerminal } from "../report/terminal.js";
import { formatCost } from "../report/format.js";
import { Progress } from "../ui/progress.js";
import { glyph } from "../ui/theme.js";
import { missingVariables, renderTemplate, templateVariables } from "../templates.js";
import type { RetryOptions } from "../retry.js";
import { runDiff, sumTotals } from "../runner.js";
import type { DiffReport } from "../types.js";
import { getVersion } from "../version.js";

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_CHANGED = 2;

export interface RunDeps {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdout: { write(s: string): unknown; isTTY?: boolean; columns?: number };
  stderr: { write(s: string): unknown; isTTY?: boolean };
  /** Overrides provider construction (tests). */
  createProvider?: (providerId: string, credential: Credential) => Provider;
  /** Overrides automatic model detection (tests). */
  detectModel?: () => Promise<DetectedModel | undefined>;
  retry?: RetryOptions;
  userConfigFile?: string;
  /** Whether we can ask the user questions (defaults to stdin and stderr both being terminals). */
  interactive?: boolean;
  /** Asks a yes/no question. */
  confirm?: (question: string) => Promise<boolean>;
  /** Overrides color detection for stdout and stderr (the interactive app renders its own output). */
  colorLevel?: 0 | 1 | 2 | 3;
  /** Receives progress text instead of the built-in spinner; undefined means "done". */
  onProgress?: (text: string | undefined) => void;
  /** Overrides the provider's batch client (tests). */
  createBatchClient?: (providerId: string) => BatchClient;
  /** Overrides the wait between batch status checks (tests). */
  batchSleep?: (ms: number) => Promise<void>;
  /** Receives the cost plan before anything runs. */
  onPlan?: (plan: RunPlan) => void;
  /** Receives the finished report (the interactive app renders it itself). */
  onReport?: (report: DiffReport) => void;
  /** Aborting it stops the run (wired to Ctrl+C by the CLI). */
  signal?: AbortSignal;
  /** Overrides fetch for GitHub API calls (tests). */
  fetch?: Parameters<typeof upsertComment>[3];
}

async function askYesNo(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}

const defaultDeps = (): RunDeps => ({
  cwd: process.cwd(),
  env: process.env,
  stdout: process.stdout,
  stderr: process.stderr,
});

function stderrColorLevel(deps: RunDeps): 0 | 1 | 2 | 3 {
  if (deps.colorLevel !== undefined) return deps.colorLevel;
  if (deps.env.NO_COLOR !== undefined && deps.env.NO_COLOR !== "") return 0;
  return deps.stderr === process.stderr ? chalkStderr.level : 0;
}

function colorLevel(deps: RunDeps): 0 | 1 | 2 | 3 {
  if (deps.colorLevel !== undefined) return deps.colorLevel;
  if (deps.env.NO_COLOR !== undefined && deps.env.NO_COLOR !== "") return 0;
  if (deps.stdout !== process.stdout) return 0;
  return chalk.level;
}

/**
 * Sets up prompt templating. Templating is on when the config or any case defines `vars`;
 * then every placeholder must have a value, checked up front so a typo can't waste a run.
 */
function preparePrompts(args: {
  basePrompt: string;
  headPrompt: string;
  baseRef: string;
  headRef: string;
  cases: TestCase[];
  defaults: Record<string, string | number | boolean>;
  casesLabel: string;
  stderr: RunDeps["stderr"];
}): (version: "base" | "head", tc: TestCase) => string {
  const { basePrompt, headPrompt, cases, defaults } = args;
  const raw = (version: "base" | "head") => (version === "base" ? basePrompt : headPrompt);
  const templating = Object.keys(defaults).length > 0 || cases.some((tc) => Object.keys(tc.vars).length > 0);

  if (!templating) {
    const names = [...new Set([...templateVariables(basePrompt), ...templateVariables(headPrompt)])];
    if (names.length) {
      args.stderr.write(`note: the prompt contains ${names.map((n) => `{{${n}}}`).join(", ")} but no case defines "vars", so it's sent as-is.\n`);
    }
    return raw;
  }

  const problems: string[] = [];
  for (const tc of cases) {
    const vars = { ...defaults, ...tc.vars };
    for (const [version, ref] of [["base", args.baseRef], ["head", args.headRef]] as const) {
      const missing = missingVariables(raw(version), vars);
      if (missing.length) {
        problems.push(`${args.casesLabel}:${tc.line} (case "${tc.id}"): no value for ${missing.map((m) => `{{${m}}}`).join(", ")} used in the prompt at ${ref}`);
      }
    }
  }
  if (problems.length) {
    const shown = problems.slice(0, 5).join("\n  ");
    const more = problems.length > 5 ? `\n  …and ${problems.length - 5} more` : "";
    throw new PromptdiffError(`Missing template variables:\n  ${shown}${more}`, {
      hint: 'Add them to each case\'s "vars", or set defaults under `vars:` in promptdiff.config.yaml.',
    });
  }
  return (version, tc) => renderTemplate(raw(version), { ...defaults, ...tc.vars });
}

/**
 * Some providers (installed CLIs) can't take conversations or sampling settings.
 * Conversations are an error, since they'd be meaningless; settings are dropped with a warning.
 */
function checkCapabilities(providerId: string, cases: TestCase[], opts: ResolvedRunOptions, stderr: RunDeps["stderr"]): TestCase[] {
  const caps = getProviderDefinition(providerId).capabilities ?? {};
  let usable = cases;
  if (caps.multiTurn === false) {
    const multi = cases.filter((tc) => tc.messages && tc.messages.length > 1);
    usable = cases.filter((tc) => !multi.includes(tc));
    if (usable.length === 0) {
      throw new PromptdiffError(`The ${providerId} provider can't run multi-turn cases, and every case uses "messages".`, {
        hint: "Use an API provider (anthropic, openai, google) for conversation cases, or add single-turn \"input\" cases.",
      });
    }
    if (multi.length) {
      stderr.write(`note: skipping ${multi.length} multi-turn case${multi.length === 1 ? "" : "s"} (${multi.map((tc) => `"${tc.id}"`).join(", ")}): the ${providerId} provider can only run single-turn cases.\n`);
    }
  }
  if (caps.temperature === false && opts.temperature !== undefined) {
    stderr.write(`note: the ${providerId} provider doesn't support temperature; ignoring temperature ${opts.temperature}.\n`);
    opts.temperature = undefined;
  }
  if (caps.maxOutputTokens === false && opts.maxOutputTokens !== undefined) {
    stderr.write(`note: the ${providerId} provider doesn't support max output tokens; ignoring maxOutputTokens ${opts.maxOutputTokens}.\n`);
    opts.maxOutputTokens = undefined;
  }
  return usable;
}

/** --batch: sends every uncached call as one batch job and fills the cache with the results. */
async function prefetchWithBatch(a: {
  def: ProviderDefinition;
  credential: Credential;
  deps: RunDeps;
  opts: ResolvedRunOptions;
  cases: TestCase[];
  promptFor: (version: "base" | "head", tc: TestCase) => string;
  modelSpec: string;
  modelId: string;
  cache?: ResultCache;
  skipBase: boolean;
  repoRoot: string;
  vs: boolean;
}): Promise<void> {
  if (!a.cache) throw new PromptdiffError("--batch needs the result cache, so it can't be combined with --no-cache.");
  if (a.vs) throw new PromptdiffError("--batch can't be combined with --vs yet.");
  const client = a.deps.createBatchClient?.(a.def.id) ?? a.def.createBatchClient?.(a.credential);
  if (!client) {
    throw new PromptdiffError(`${a.def.displayName} doesn't support batches in promptdiff.`, { hint: "Batches work with anthropic:, openai:, and google: models. Drop --batch to run normally." });
  }
  const requests: BatchRequest[] = [];
  for (const tc of a.cases) {
    for (const version of a.skipBase ? (["head"] as const) : (["base", "head"] as const)) {
      const system = a.promptFor(version, tc);
      for (let runIndex = 0; runIndex < a.opts.runs; runIndex++) {
        const id = cacheKey({ prompt: system, model: a.modelSpec, temperature: a.opts.temperature, maxOutputTokens: a.opts.maxOutputTokens, input: caseInputKey(tc), runIndex });
        if (requests.some((r) => r.id === id) || (await a.cache.get(id))) continue;
        requests.push({ id, model: a.modelId, system, messages: caseMessages(tc), temperature: a.opts.temperature, maxOutputTokens: a.opts.maxOutputTokens });
      }
    }
  }
  if (requests.length === 0) return;
  const started = Date.now();
  const items = await runBatch({
    client,
    requests,
    stateDir: path.join(a.repoRoot, ".promptdiff", "batches"),
    signal: a.deps.signal,
    sleep: a.deps.batchSleep,
    onProgress: (p) => {
      const done = p.completed !== undefined && p.total ? ` ${p.completed}/${p.total} done ·` : "";
      const line = `Batch ${p.batchId}${p.resumed ? " (resumed)" : ""}: ${p.state} ·${done} ${Math.round((Date.now() - started) / 1000)}s`;
      if (a.deps.onProgress) a.deps.onProgress(line);
      else a.deps.stderr.write(line + "\n");
    },
  });
  let failed = 0;
  for (const item of items) {
    if ("error" in item) {
      failed++;
      continue;
    }
    await a.cache.set(item.id, { text: item.text, inputTokens: item.inputTokens, outputTokens: item.outputTokens, latencyMs: 0, createdAt: new Date().toISOString() });
  }
  a.deps.stderr.write(`Batch done: ${items.length - failed} of ${requests.length} results${failed ? `; ${failed} failed and will run one by one` : ""}.\n`);
}

/** Runs `promptdiff <file>` and returns the process exit code. */
export async function runCommand(file: string, cli: CliRunOptions, partialDeps: Partial<RunDeps> = {}): Promise<number> {
  const deps = { ...defaultDeps(), ...partialDeps };
  const { cwd } = deps;
  const started = Date.now();

  const project = await loadProjectConfig(cwd, cli.config);
  const userConfig = await readUserConfig(deps.userConfigFile);

  let detected: DetectedModel | undefined;
  if (!cli.model && !project.config.model) {
    detected = await (deps.detectModel ?? (() => detectDefaultModel(userConfig, deps.env)))();
    if (detected) {
      deps.stderr.write(`Using ${detected.model}: ${detected.reason}.\n  ${glyph.gutter} Set \`model:\` in ${PROJECT_CONFIG_FILE} or pass --model to choose another.\n`);
    }
  }
  const opts = resolveRunOptions(cli, project.config, project.file, cwd, detected?.model);
  // A `prompts:` entry can name its own test cases.
  if (!cli.cases) {
    const own = casesForPrompt(project.config, project.file, cwd, file);
    if (own) opts.casesFile = own;
  }
  // Fail fast on GitHub setup problems, before spending anything.
  const github = opts.githubComment ? await resolveGitHubContext(deps.env, opts.pr) : undefined;
  const spec = parseModelSpec(opts.model);
  const def = getProviderDefinition(spec.provider);

  const credentialFor = (providerId: string): ResolvedCredential => {
    const d = getProviderDefinition(providerId);
    const resolved = resolveCredential(d, userConfig, deps.env);
    if (!resolved) throw missingKeyError(d);
    if (d.kind === "cli" && !deps.createProvider) {
      const bin = providerId === "claude-code" ? "claude" : providerId;
      if (!findExecutable(bin, deps.env)) {
        throw new PromptdiffError(`--model ${providerId}:… needs the \`${bin}\` command, which isn't installed or isn't on your PATH.`, {
          hint: providerId === "codex" ? "Install it with `npm install -g @openai/codex`, then run `codex login`." : "Install Claude Code (https://claude.com/claude-code), then run `claude` to log in.",
        });
      }
    }
    return resolved;
  };
  const credential = credentialFor(def.id);

  const repoRoot = await getRepoRoot(cwd);
  // --vs: same prompt (the head version) on two models; the "sides" are models, not git versions.
  const vsSpec = opts.vsModel ? parseModelSpec(opts.vsModel) : undefined;
  const vsModelSpec = vsSpec ? `${vsSpec.provider}:${vsSpec.model}` : undefined;
  if (opts.snapshot && vsModelSpec) throw new PromptdiffError("--snapshot and --vs can't be used together.");
  const snapshotFile = snapshotPath(project.file ? path.dirname(project.file) : cwd, file);
  const snapshot = opts.snapshot ? await readSnapshot(snapshotFile, file) : undefined;
  const baseRef = vsModelSpec ? `${spec.provider}:${spec.model}` : snapshot ? `approved ${snapshot.approvedAt.slice(0, 10)}` : opts.base;
  const headRef = vsModelSpec ?? opts.head ?? "working copy";
  // A plain file, or an exported constant in a code file ("file.ts#NAME").
  const headPrompt = (await loadPrompt(file, opts.head ? { ref: opts.head } : "working", cwd)).text;
  const basePrompt = vsModelSpec || snapshot ? headPrompt : (await loadPrompt(file, { ref: opts.base }, cwd)).text;
  if (snapshot && snapshot.model !== `${spec.provider}:${spec.model}`) {
    deps.stderr.write(`note: the approved outputs came from ${snapshot.model}; this run uses ${spec.provider}:${spec.model}.\n`);
  }

  validateAssertionSchemas(opts.assertions, project.file ? path.relative(cwd, project.file) : "config");
  const relCases = path.relative(cwd, opts.casesFile);
  const casesLabel = !relCases || relCases.startsWith("..") ? opts.casesFile : relCases;
  const loaded = await buildCaseInputs(await loadCases(opts.casesFile, casesLabel), { cwd, repoRoot, allowed: opts.runCode });
  let cases = checkCapabilities(def.id, loaded, opts, deps.stderr);
  if (vsSpec) cases = checkCapabilities(vsSpec.provider, cases, opts, deps.stderr);
  const rubricCount = (tc: TestCase) => [...opts.assertions, ...tc.assert].filter((a) => a.type === "llm-rubric").length;
  const needsJudge = opts.compare === "semantic" || cases.some((tc) => rubricCount(tc) > 0);
  const judgeSpec = needsJudge ? parseModelSpec(opts.judgeModel) : undefined;
  const judgeCredential = judgeSpec ? credentialFor(judgeSpec.provider) : undefined;
  const judgeModelSpec = judgeSpec ? `${judgeSpec.provider}:${judgeSpec.model}` : undefined;
  // Read lazily: OAuth tokens are added to these lists as they're fetched.
  const redact = (s: string) => redactSecrets(s, [...credential.secrets, ...(judgeCredential?.secrets ?? [])]);
  const promptFor = preparePrompts({ basePrompt, headPrompt, baseRef, headRef, cases, defaults: opts.vars, casesLabel, stderr: deps.stderr });

  const pricing = {
    ...loadBuiltinPricing(),
    ...(await loadPricingFile(opts.pricingFile ?? path.join(cwd, PROJECT_PRICING_FILE), opts.pricingFile !== undefined)),
  };
  const modelSpec = `${spec.provider}:${spec.model}`;
  const provider = deps.createProvider ? deps.createProvider(spec.provider, credential.credential) : def.create(credential.credential);
  let headModel: { provider: Provider; modelSpec: string; modelId: string } | undefined;
  if (vsSpec && vsModelSpec) {
    const vsCredential = credentialFor(vsSpec.provider);
    credential.secrets.push(...vsCredential.secrets);
    headModel = {
      provider: deps.createProvider ? deps.createProvider(vsSpec.provider, vsCredential.credential) : getProviderDefinition(vsSpec.provider).create(vsCredential.credential),
      modelSpec: vsModelSpec,
      modelId: vsSpec.model,
    };
  }
  const cache = opts.cache ? new ResultCache(defaultCacheDir(repoRoot)) : undefined;

  // Estimate cost before spending anything.
  const plan = await planRun({
    cases,
    promptFor,
    inputFor: caseInputKey,
    runs: opts.runs,
    modelSpec,
    headModelSpec: vsModelSpec,
    skipBase: !!snapshot,
    temperature: opts.temperature,
    maxOutputTokens: opts.maxOutputTokens,
    cache,
    pricing,
    judgeCallsPerOutput: rubricCount,
    semanticCompare: opts.compare === "semantic",
    judgeSpec: judgeModelSpec,
  });
  deps.onPlan?.(plan);
  const describePlan = () => renderPlan(plan, modelSpec, judgeModelSpec);
  if (opts.dryRun) {
    deps.stdout.write(opts.json ? JSON.stringify({ plan }, null, 2) + "\n" : describePlan() + "\n");
    return EXIT_OK;
  }
  if (opts.maxCost !== undefined && plan.cost === undefined) {
    const unpriced = plan.generation.cost === undefined ? modelSpec : judgeModelSpec;
    throw new PromptdiffError(`Can't enforce --max-cost: "${unpriced}" isn't in the pricing table.`, {
      hint: `Add it to ${PROJECT_PRICING_FILE}, e.g. {"models": {"${unpriced}": {"input": <USD per 1M>, "output": <USD per 1M>}}}`,
    });
  }
  if (opts.maxCost !== undefined && plan.cost !== undefined && plan.cost > opts.maxCost) {
    throw new PromptdiffError(`Estimated cost ~$${plan.cost.toFixed(4)} is over the --max-cost budget of $${opts.maxCost}.`, {
      hint: `${describePlan()}\nReduce --runs or the number of cases, set maxOutputTokens, or raise --max-cost.`,
    });
  }
  const interactive = deps.interactive ?? (process.stdin.isTTY === true && deps.stderr.isTTY === true);
  if (deps.stderr.isTTY) deps.stderr.write(renderPlan(plan, modelSpec, judgeModelSpec, stderrColorLevel(deps)) + "\n");
  const expensive = plan.cost !== undefined ? plan.cost > opts.confirmAbove : plan.generation.calls >= 100;
  if (expensive && interactive && !opts.yes) {
    if (!deps.stderr.isTTY) deps.stderr.write(describePlan() + "\n");
    const ok = await (deps.confirm ?? askYesNo)("Continue? [y/N] ");
    if (!ok) throw new PromptdiffError("Cancelled. Nothing was sent.", { hint: "Use --yes to skip this question, or --dry-run to only see the estimate." });
  }
  const budget = new Budget(opts.maxCost);
  const judge = judgeSpec
    ? new Judge({
        provider: deps.createProvider ? deps.createProvider(judgeSpec.provider, judgeCredential!.credential) : getProviderDefinition(judgeSpec.provider).create(judgeCredential!.credential),
        modelId: judgeSpec.model,
        modelSpec: judgeModelSpec!,
        cache,
        pricing,
        retry: deps.retry,
        budget,
      })
    : undefined;

  if (opts.batch) {
    await prefetchWithBatch({ def, credential: credential.credential, deps, opts, cases, promptFor, modelSpec, modelId: spec.model, cache, skipBase: !!snapshot, repoRoot, vs: !!vsModelSpec });
  }

  const spinner = new Progress(deps.stderr, stderrColorLevel(deps));
  const progress = deps.onProgress
    ? { update: (t: string) => deps.onProgress!(t), log: (l: string) => deps.stderr.write(l + "\n"), stop: () => deps.onProgress!(undefined) }
    : spinner;
  if (deps.onProgress) deps.onProgress(`Running prompts… 0/${plan.totalCalls}`);
  else spinner.start(`Running prompts… 0/${plan.totalCalls}`);
  const results = await runDiff({
    provider,
    modelSpec,
    modelId: spec.model,
    headModel,
    baseline: snapshot ? new Map(Object.entries(snapshot.cases).map(([id, c]) => [id, c.outputs])) : undefined,
    basePrompt,
    headPrompt,
    promptFor,
    cases,
    runs: opts.runs,
    concurrency: opts.concurrency,
    temperature: opts.temperature,
    maxOutputTokens: opts.maxOutputTokens,
    cache,
    pricing,
    defaultAssertions: opts.assertions,
    budget,
    judge,
    semantic: opts.compare === "semantic",
    retry: deps.retry,
    redact,
    signal: deps.signal,
    onProgress: (done, total) =>
      progress.update(`Running prompts… ${done}/${total}${budget.spent > 0 ? ` · ${formatCost(budget.spent)} spent` : ""}`),
    onRetry: (msg) => progress.log(`  ${glyph.warn} retrying ${msg}`),
  }).finally(() => progress.stop());

  const count = (s: string) => results.filter((r) => r.status === s).length;
  const withChecks = results.filter((r) => r.checks);
  const checks = withChecks.length
    ? {
        base: tally(results.flatMap((r) => r.base.map((o) => o.checks ?? []))),
        head: tally(results.flatMap((r) => r.head.map((o) => o.checks ?? []))),
        regressions: withChecks.filter((r) => r.checks!.regression).length,
        fixed: withChecks.filter((r) => r.checks!.fixed).length,
        headFailures: withChecks.filter((r) => r.checks!.head.passed < r.checks!.head.total).length,
      }
    : undefined;
  const report: DiffReport = {
    meta: {
      tool: "promptdiff",
      version: getVersion(),
      file: file.split(path.sep).join("/"),
      baseRef,
      headRef,
      model: modelSpec,
      temperature: opts.temperature,
      maxOutputTokens: opts.maxOutputTokens,
      runs: opts.runs,
      compare: opts.compare,
      ...(judgeModelSpec ? { judgeModel: judgeModelSpec } : {}),
      promptChanged: basePrompt !== headPrompt,
      pricingKnown: hasPrice(pricing, modelSpec) && (!vsModelSpec || hasPrice(pricing, vsModelSpec)),
      ...(vsModelSpec ? { vsModel: vsModelSpec } : {}),
      ...(snapshot ? { snapshot: true } : {}),
      startedAt: new Date(started).toISOString(),
      durationMs: Date.now() - started,
    },
    prompts: { base: basePrompt, head: headPrompt },
    cases: results,
    summary: {
      total: results.length,
      identical: count("identical"),
      noise: count("noise"),
      changed: count("changed"),
      errors: count("error"),
      base: sumTotals(results.map((r) => r.baseTotals)),
      head: sumTotals(results.map((r) => r.headTotals)),
      ...(judge ? { judge: judge.usage } : {}),
      totalCost: undefined,
      checks,
    },
  };

  const parts = [report.summary.base.cost, report.summary.head.cost, judge ? judge.usage.cost : 0];
  report.summary.totalCost = parts.every((c) => c !== undefined) ? parts.reduce((a, b) => a! + b!, 0) : undefined;

  deps.onReport?.(report);
  if (opts.json) {
    deps.stdout.write(renderJson(report));
  } else if (opts.markdown === "-") {
    deps.stdout.write(renderMarkdown(report));
  } else {
    deps.stdout.write(
      renderTerminal(report, {
        colorLevel: colorLevel(deps),
        width: deps.stdout.columns ?? 100,
        sideBySide: deps.stdout.isTTY === true,
        verbose: opts.verbose,
      }),
    );
  }
  if (opts.html) {
    await writeFile(opts.html, renderHtml(report));
    deps.stderr.write(`HTML report written to ${path.relative(cwd, opts.html) || opts.html}\n`);
  }

  if (opts.markdown && opts.markdown !== "-") {
    await writeFile(opts.markdown, renderMarkdown(report));
    deps.stderr.write(`Markdown report written to ${path.relative(cwd, opts.markdown) || opts.markdown}\n`);
  }
  if (opts.approve) {
    const saved = await writeSnapshot(snapshotFile, report);
    deps.stderr.write(`Approved ${saved} case${saved === 1 ? "" : "s"}: saved to ${path.relative(cwd, snapshotFile)} (commit it so others compare against it too).\n`);
  }
  if (github) {
    const { action, url } = await upsertComment(github, commentMarker(report.meta.file), renderMarkdown(report), deps.fetch);
    deps.stderr.write(`PR comment ${action}: ${url}\n`);
  }

  if (report.summary.errors > 0) return EXIT_ERROR;
  if (opts.failOnChange && report.summary.changed > 0) return EXIT_CHANGED;
  if (opts.failOnRegression && (checks?.regressions ?? 0) > 0) return EXIT_CHANGED;
  if (opts.failOnCheck && (checks?.headFailures ?? 0) > 0) return EXIT_CHANGED;
  return EXIT_OK;
}
