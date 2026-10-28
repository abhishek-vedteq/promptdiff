import { Chalk } from "chalk";
import type { RunPlan } from "../estimate.js";
import { accentWith, nest } from "../ui/theme.js";
import { formatCost, formatInt } from "./format.js";

/** A short description of what a run will do and cost. */
export function renderPlan(plan: RunPlan, model: string, judgeModel?: string, colorLevel: 0 | 1 | 2 | 3 = 0): string {
  const c = new Chalk({ level: colorLevel });
  const lines: string[] = [];
  const g = plan.generation;
  lines.push(
    `Plan: ${plan.totalCalls} calls to ${model}` +
      (plan.cachedCalls ? ` (${plan.cachedCalls} cached, ${g.calls} new)` : "") +
      (plan.judge.calls ? ` + ${plan.judge.calls} judge calls${judgeModel && judgeModel !== model ? ` to ${judgeModel}` : ""}` : ""),
  );
  if (g.calls + plan.judge.calls === 0) {
    lines.push("Everything is cached: this run is free.");
    return format(lines, c);
  }
  lines.push(
    `~${formatInt(g.inputTokens + plan.judge.inputTokens)} input + ~${formatInt(g.outputTokens + plan.judge.outputTokens)} output tokens` +
      ` (assuming ~${formatInt(plan.assumedOutputTokens)} output tokens per response)`,
  );
  if (plan.cost === undefined) {
    lines.push("Estimated cost: unknown (model not in the pricing table)");
  } else {
    lines.push(
      `Estimated cost: ~${formatCost(plan.cost)}` +
        (plan.worstCaseCost !== undefined && plan.worstCaseCost > plan.cost ? ` (at most ~${formatCost(plan.worstCaseCost)} if every response hits max tokens)` : ""),
    );
  }
  return format(lines, c);
}

function format(lines: string[], c: InstanceType<typeof Chalk>): string {
  const [head, ...rest] = lines;
  return [accentWith(c)(head ?? ""), ...nest(rest.map((l) => c.dim(l)), c)].join("\n");
}
