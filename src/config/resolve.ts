import path from "node:path";
import picomatch from "picomatch";
import type { Assertion } from "../assertions.js";
import { PromptdiffError } from "../errors.js";
import type { ProjectConfig } from "./project.js";

/** Options as they come from the command line (all optional, strings unparsed where noted). */
export interface CliRunOptions {
  base?: string;
  head?: string;
  model?: string;
  cases?: string;
  temperature?: string;
  maxTokens?: string;
  runs?: string;
  concurrency?: string;
  cache?: boolean;
  json?: boolean;
  html?: string;
  markdown?: string;
  githubComment?: boolean;
  pr?: string;
  failOnChange?: boolean;
  failOnRegression?: boolean;
  failOnCheck?: boolean;
  maxCost?: string;
  compare?: string;
  judge?: string;
  yes?: boolean;
  dryRun?: boolean;
  config?: string;
  verbose?: boolean;
}

export interface ResolvedRunOptions {
  base: string;
  /** Undefined means "the working copy". */
  head?: string;
  model: string;
  casesFile: string;
  temperature?: number;
  maxOutputTokens?: number;
  runs: number;
  concurrency: number;
  cache: boolean;
  json: boolean;
  html?: string;
  /** File path, or "-" for stdout. */
  markdown?: string;
  githubComment: boolean;
  pr?: string;
  failOnChange: boolean;
  failOnRegression: boolean;
  failOnCheck: boolean;
  maxCost?: number;
  confirmAbove: number;
  compare: "words" | "semantic";
  /** Judge model spec; defaults to the main model. */
  judgeModel: string;
  yes: boolean;
  dryRun: boolean;
  /** Default template variables from the config file. */
  vars: Record<string, string | number | boolean>;
  /** Assertions from the config file, applied to every case. */
  assertions: Assertion[];
  pricingFile?: string;
  verbose: boolean;
}

export const DEFAULTS = {
  base: "HEAD",
  cases: "cases.jsonl",
  runs: 1,
  concurrency: 4,
  confirmAbove: 1,
} as const;

function parseNumber(name: string, value: string | undefined, opts: { int?: boolean; min?: number; max?: number }) {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || (opts.int && !Number.isInteger(n))) {
    throw new PromptdiffError(`--${name} must be ${opts.int ? "an integer" : "a number"}, got "${value}"`);
  }
  if ((opts.min !== undefined && n < opts.min) || (opts.max !== undefined && n > opts.max)) {
    throw new PromptdiffError(`--${name} must be between ${opts.min} and ${opts.max}, got ${n}`);
  }
  return n;
}

export interface PromptPattern {
  /** Glob (or "glob#NAME"), relative to the config file's directory. */
  path: string;
  cases?: string;
}

export function promptPatterns(project: ProjectConfig): PromptPattern[] {
  return (project.prompts ?? []).map((p) => (typeof p === "string" ? { path: p } : p));
}

/** Splits "glob#NAME" into a matcher for the file and an optional export name. */
export function compilePattern(pattern: string): { match: (file: string) => boolean; name?: string } {
  const hash = pattern.lastIndexOf("#");
  const glob = hash > 0 ? pattern.slice(0, hash) : pattern;
  const name = hash > 0 ? pattern.slice(hash + 1) : undefined;
  const isMatch = picomatch(glob.replace(/^\.\//, ""), { dot: true });
  return { match: (file) => isMatch(file.split(path.sep).join("/").replace(/^\.\//, "")), name };
}

/** The test-case file for a prompt, if its `prompts:` entry names one. Absolute path. */
export function casesForPrompt(project: ProjectConfig, projectFile: string | undefined, cwd: string, prompt: string): string | undefined {
  const configDir = projectFile ? path.dirname(projectFile) : cwd;
  const hash = prompt.lastIndexOf("#");
  const file = hash > 0 ? prompt.slice(0, hash) : prompt;
  const name = hash > 0 ? prompt.slice(hash + 1) : undefined;
  const rel = path.relative(configDir, path.resolve(cwd, file));
  for (const p of promptPatterns(project)) {
    if (!p.cases) continue;
    const { match, name: only } = compilePattern(p.path);
    if (match(rel) && (!only || only === name)) return path.resolve(configDir, p.cases);
  }
  return undefined;
}

function parseCompare(value: string | undefined): "words" | "semantic" | undefined {
  if (value === undefined) return undefined;
  if (value === "words" || value === "semantic") return value;
  throw new PromptdiffError(`--compare must be "words" or "semantic", got "${value}"`);
}

/**
 * Merges settings with precedence: CLI flags > project config file > built-in defaults.
 * Paths from the config file are resolved relative to the config file's directory;
 * paths from flags are resolved relative to cwd.
 */
export function resolveRunOptions(
  cli: CliRunOptions,
  project: ProjectConfig,
  projectFile: string | undefined,
  cwd: string,
  /** Model picked automatically from the user's logins, used when none is configured. */
  detectedModel?: string,
): ResolvedRunOptions {
  const configDir = projectFile ? path.dirname(projectFile) : cwd;

  const model = cli.model ?? project.model ?? detectedModel;
  if (!model) {
    throw new PromptdiffError("No model specified, and no login was found to pick one automatically.", {
      hint: [
        "Run `promptdiff login` to set up a provider, or choose a model:",
        "  --model anthropic:claude-opus-5-5   (Anthropic API key or `ant` browser login)",
        "  --model claude-code:default         (your Claude Code login)",
        "  --model codex:default               (your Codex CLI login)",
        "  --model openai:<model-id> / google:<model-id>",
        "or set `model:` in promptdiff.config.yaml.",
      ].join("\n"),
    });
  }

  const casesFile = cli.cases
    ? path.resolve(cwd, cli.cases)
    : path.resolve(configDir, project.cases ?? DEFAULTS.cases);

  return {
    base: cli.base ?? project.base ?? DEFAULTS.base,
    head: cli.head,
    model,
    casesFile,
    temperature: parseNumber("temperature", cli.temperature, { min: 0, max: 2 }) ?? project.temperature,
    maxOutputTokens: parseNumber("max-tokens", cli.maxTokens, { int: true, min: 1, max: 1_000_000 }) ?? project.maxOutputTokens,
    runs: parseNumber("runs", cli.runs, { int: true, min: 1, max: 50 }) ?? project.runs ?? DEFAULTS.runs,
    concurrency: parseNumber("concurrency", cli.concurrency, { int: true, min: 1, max: 64 }) ?? project.concurrency ?? DEFAULTS.concurrency,
    cache: cli.cache !== false,
    json: cli.json === true,
    html: cli.html ? path.resolve(cwd, cli.html) : undefined,
    markdown: cli.markdown === "-" ? "-" : cli.markdown ? path.resolve(cwd, cli.markdown) : undefined,
    githubComment: cli.githubComment === true,
    pr: cli.pr,
    failOnChange: cli.failOnChange === true,
    failOnRegression: cli.failOnRegression === true,
    failOnCheck: cli.failOnCheck === true,
    assertions: project.assert ?? [],
    vars: project.vars ?? {},
    compare: parseCompare(cli.compare) ?? project.compare ?? "words",
    judgeModel: cli.judge ?? project.judge ?? model,
    maxCost: parseNumber("max-cost", cli.maxCost, { min: 0, max: 1_000_000 }) ?? project.maxCost,
    confirmAbove: project.confirmAbove ?? DEFAULTS.confirmAbove,
    yes: cli.yes === true,
    dryRun: cli.dryRun === true,
    pricingFile: project.pricing ? path.resolve(configDir, project.pricing) : undefined,
    verbose: cli.verbose === true,
  };
}
