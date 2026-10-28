import type { CaseStatus, VariationStats } from "./analysis.js";
import type { AssertionResult, CheckTally } from "./assertions.js";
import type { Judgement, JudgeUsage } from "./judge.js";

export interface RunOutput {
  runIndex: number;
  text: string;
  inputTokens?: number;
  outputTokens?: number;
  latencyMs: number;
  /** USD; undefined if the model has no pricing entry or usage is unknown. */
  cost?: number;
  cached: boolean;
  error?: string;
  /** Results of the case's assertions against this output (absent when the case has none). */
  checks?: AssertionResult[];
}

export interface CaseChecks {
  base: CheckTally;
  head: CheckTally;
  /** Head passes a smaller share of checks than base. */
  regression: boolean;
  /** Head passes a larger share of checks than base. */
  fixed: boolean;
}

export interface VersionTotals {
  inputTokens: number;
  outputTokens: number;
  /** Undefined if any call's cost is unknown. */
  cost?: number;
  /** Mean latency across calls (cached calls report their original latency). */
  avgLatencyMs: number;
  calls: number;
}

export interface CaseResult {
  id: string;
  /** The final user message (the whole input for single-turn cases). */
  input: string;
  /** Present for multi-turn cases. */
  messages?: { role: "user" | "assistant"; content: string }[];
  /** Template variables used for this case. */
  vars?: Record<string, string | number | boolean>;
  status: CaseStatus;
  stats?: VariationStats;
  base: RunOutput[];
  head: RunOutput[];
  baseTotals: VersionTotals;
  headTotals: VersionTotals;
  checks?: CaseChecks;
  /** The judge's verdict, with --compare semantic. */
  judgement?: Judgement;
}

export interface DiffReport {
  meta: {
    tool: "promptdiff";
    version: string;
    file: string;
    baseRef: string;
    headRef: string;
    model: string;
    temperature?: number;
    maxOutputTokens?: number;
    runs: number;
    /** How outputs were compared: word overlap, or an LLM judge. */
    compare: "words" | "semantic";
    /** Model used for llm-rubric checks and semantic comparison, if any. */
    judgeModel?: string;
    promptChanged: boolean;
    pricingKnown: boolean;
    startedAt: string;
    durationMs: number;
  };
  prompts: { base: string; head: string };
  cases: CaseResult[];
  summary: {
    total: number;
    identical: number;
    noise: number;
    changed: number;
    errors: number;
    base: VersionTotals;
    head: VersionTotals;
    /** Calls made to the judge model. */
    judge?: JudgeUsage;
    /** Base + head + judge cost; undefined if any part is unknown. */
    totalCost?: number;
    checks?: {
      base: CheckTally;
      head: CheckTally;
      regressions: number;
      fixed: number;
      /** Cases where at least one head check failed. */
      headFailures: number;
    };
  };
}
