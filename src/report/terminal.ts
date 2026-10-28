import { Chalk, type ChalkInstance } from "chalk";
import type { CaseStatus } from "../analysis.js";
import type { CaseResult, DiffReport, VersionTotals } from "../types.js";
import { leftSide, rightSide, wordDiff, wrapSegments, type Segment } from "./diff.js";
import { formatCost, formatInt, formatMs, formatPercentChange } from "./format.js";
import { accentWith, glyph, nest, pill, rule, wordmark } from "../ui/theme.js";

export interface TerminalOptions {
  /** chalk color level: 0 = no color. */
  colorLevel: 0 | 1 | 2 | 3;
  /** Terminal width; side-by-side layout is used when >= 100 and sideBySide isn't false. */
  width: number;
  sideBySide: boolean;
  /** Show diffs for "noise" cases too. */
  verbose: boolean;
  /** When not side by side, show "before" and "after" as two blocks instead of one interleaved diff. */
  stacked?: boolean;
}

const STATUS_LABEL: Record<CaseStatus, string> = {
  changed: "CHANGED",
  noise: "NOISE",
  identical: "SAME",
  error: "ERROR",
};

const STATUS_PILL: Record<CaseStatus, "yellow" | "cyan" | "green" | "red"> = {
  changed: "yellow",
  noise: "cyan",
  identical: "green",
  error: "red",
};

function paint(c: ChalkInstance, segs: Segment[], plainMarkers: boolean): string {
  return segs
    .map((s) => {
      if (s.kind === "same") return s.text;
      if (plainMarkers) return s.kind === "removed" ? `[-${s.text}-]` : `{+${s.text}+}`;
      return s.kind === "removed" ? c.red.strikethrough(s.text) : c.green.bold(s.text);
    })
    .join("");
}

const visibleLength = (segs: Segment[]) => segs.reduce((n, s) => n + s.text.length, 0);

function renderSideBySide(c: ChalkInstance, base: string, head: string, width: number, labels: [string, string]): string[] {
  const colWidth = Math.floor((width - 7) / 2);
  const segments = wordDiff(base, head);
  const left = wrapSegments(leftSide(segments), colWidth);
  const right = wrapSegments(rightSide(segments), colWidth);
  const rows = Math.max(left.length, right.length);
  const sep = c.dim(" │ ");
  const header = (label: string) => c.dim(label.length > colWidth ? label.slice(0, colWidth) : label.padEnd(colWidth));
  const out = [`  ${header(labels[0])}${sep}${header(labels[1])}`];
  for (let i = 0; i < rows; i++) {
    const l = left[i] ?? [];
    const r = right[i] ?? [];
    out.push(`  ${paint(c, l, false)}${" ".repeat(Math.max(0, colWidth - visibleLength(l)))}${sep}${paint(c, r, false)}`);
  }
  return out;
}

function renderInline(c: ChalkInstance, base: string, head: string, width: number, plain: boolean): string[] {
  let segments = wordDiff(base, head);
  // Without color, the [-…-] / {+…+} markers take up space too, so wrap with them included.
  if (plain) {
    segments = segments.map((s) => (s.kind === "same" ? s : { kind: "same", text: s.kind === "removed" ? `[-${s.text}-]` : `{+${s.text}+}` }));
  }
  const lines = wrapSegments(segments, Math.max(20, width - 4));
  return lines.map((l) => `  ${paint(c, l, plain)}`);
}

function renderStacked(c: ChalkInstance, base: string, head: string, width: number, labels: [string, string], plain: boolean): string[] {
  const segments = wordDiff(base, head);
  const block = (segs: Segment[]) => wrapSegments(segs, Math.max(20, width - 4)).map((l) => `  ${paint(c, l, plain)}`);
  return [
    `  ${c.red.bold("−")} ${c.dim(labels[0])}`,
    ...block(leftSide(segments)),
    "  ",
    `  ${c.green.bold("+")} ${c.dim(labels[1])}`,
    ...block(rightSide(segments)),
  ];
}

function metricLine(c: ChalkInstance, b: VersionTotals, h: VersionTotals, runs: number): string {
  const per = (n: number, calls: number) => (calls ? n / calls : 0);
  const delta = (x: number | undefined, y: number | undefined) => {
    const d = formatPercentChange(x, y);
    return d ? c.dim(` (${d})`) : "";
  };
  const bOut = per(b.outputTokens, b.calls);
  const hOut = per(h.outputTokens, h.calls);
  const parts = [
    `output tokens ${formatInt(bOut)} → ${formatInt(hOut)}${delta(bOut, hOut)}`,
    `latency ${formatMs(b.avgLatencyMs)} → ${formatMs(h.avgLatencyMs)}${delta(b.avgLatencyMs, h.avgLatencyMs)}`,
    b.cost === undefined && h.cost === undefined
      ? "cost unknown"
      : `cost ${formatCost(b.cost)} → ${formatCost(h.cost)}${delta(b.cost, h.cost)}`,
  ];
  const suffix = runs > 1 ? c.dim(` (avg per run; cost for all ${runs} runs)`) : "";
  return "  " + c.dim(parts.join(" · ")) + suffix;
}

function truncate(s: string, n: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n - 1) + "…" : one;
}

function checksLines(c: ChalkInstance, cr: CaseResult): string[] {
  const k = cr.checks!;
  const frac = (t: { passed: number; total: number }) => {
    const text = `${t.passed}/${t.total}`;
    return t.passed === t.total ? c.green(`${text} ✓`) : c.red(`${text} ✗`);
  };
  const tag = k.regression ? c.red.bold("  REGRESSION") : k.fixed ? c.green.bold("  FIXED") : "";
  const lines = [`  checks: base ${frac(k.base)} · head ${frac(k.head)}${tag}`];
  // Each distinct failure on the new prompt, with how many runs it failed in.
  const failures = new Map<string, { count: number; reason?: string }>();
  for (const o of cr.head) {
    for (const r of o.checks ?? []) {
      if (r.pass) continue;
      const f = failures.get(r.label) ?? { count: 0, reason: r.reason };
      f.count++;
      failures.set(r.label, f);
    }
  }
  for (const [label, f] of failures) {
    const runs = cr.head.length > 1 ? ` (${f.count}/${cr.head.length} runs)` : "";
    lines.push(c.red(`    ✗ ${label}${runs}`) + (f.reason ? c.dim(` — ${f.reason}`) : ""));
  }
  return lines;
}

/** Detail lines are built with a two-space indent; this re-indents them behind the │ gutter. */
const NEST_EXTRA = 2;

export function renderCase(cr: CaseResult, report: DiffReport, opts: TerminalOptions): string {
  const c = new Chalk({ level: opts.colorLevel });
  const badge = pill(c, STATUS_LABEL[cr.status], STATUS_PILL[cr.status]);
  const turns = cr.messages && cr.messages.length > 1 ? c.dim(`(${cr.messages.length}-message conversation) `) : "";
  const heading = `${badge} ${c.bold(cr.id)}  ${turns}${c.dim(truncate(cr.input, Math.max(20, opts.width - cr.id.length - 14)))}`;
  const lines: string[] = [];
  const done = () => [heading, ...nest(lines.map((l) => l.replace(/^ {2}/, "")), c)].join("\n");

  if (cr.status === "error") {
    const errors = [...cr.base.map((o) => ["base", o] as const), ...cr.head.map((o) => ["head", o] as const)]
      .filter(([, o]) => o.error && o.error !== "aborted");
    for (const [v, o] of errors.slice(0, 3)) lines.push(c.red(`  ${v} run ${o.runIndex + 1}: ${o.error}`));
    if (errors.length > 3) lines.push(c.red(`  …and ${errors.length - 3} more errors`));
    return done();
  }

  const showDiff = cr.status === "changed" || (cr.status === "noise" && opts.verbose);
  if (showDiff) {
    const base = cr.base[0]?.text ?? "";
    const head = cr.head[0]?.text ?? "";
    const plain = opts.colorLevel === 0;
    const sbs = opts.sideBySide && !plain && opts.width >= 100;
    const runNote = report.meta.runs > 1 ? " · run 1" : "";
    const width = opts.width - NEST_EXTRA;
    const labels: [string, string] = [`before (${report.meta.baseRef})${runNote}`, `after (${report.meta.headRef})${runNote}`];
    lines.push(
      ...(sbs
        ? renderSideBySide(c, base, head, width, labels)
        : opts.stacked
          ? renderStacked(c, base, head, width, labels, plain)
          : renderInline(c, base, head, width, plain)),
    );
  }
  if (cr.judgement?.summary) lines.push(`  ${accentWith(c)("judge")} ${cr.judgement.summary}`);
  if (cr.judgement?.error) lines.push(c.dim(`  judge failed (${cr.judgement.error}); status is based on word overlap`));
  if (cr.checks) lines.push(...checksLines(c, cr));
  if (cr.status !== "identical") {
    lines.push(metricLine(c, cr.baseTotals, cr.headTotals, report.meta.runs));
    if (cr.stats && report.meta.runs > 1) {
      const f = (v: number | undefined) => (v === undefined ? "–" : v.toFixed(2));
      lines.push(c.dim(`  word distance: within base ${f(cr.stats.withinBase)}, within head ${f(cr.stats.withinHead)}, between versions ${f(cr.stats.between)}`));
    }
  }
  return done();
}

export function renderSummary(report: DiffReport, opts: TerminalOptions): string {
  const c = new Chalk({ level: opts.colorLevel });
  const { summary: s, meta } = report;
  const inside: string[] = [];
  inside.push(
    `${c.yellow.bold(`${s.changed} changed`)} ${glyph.sep} ${c.cyan(`${s.noise} noise`)} ${glyph.sep} ${c.green(`${s.identical} identical`)}` +
      (s.errors ? ` ${glyph.sep} ${c.red.bold(`${s.errors} errors`)}` : "") +
      c.dim(`   ${s.total} case${s.total === 1 ? "" : "s"} × ${meta.runs} run${meta.runs === 1 ? "" : "s"} × 2 versions`),
  );
  inside.push("");
  const rows: [string, string, string, string][] = [
    ["", `base (${meta.baseRef})`, `head (${meta.headRef})`, "change"],
    ["input tokens", formatInt(s.base.inputTokens), formatInt(s.head.inputTokens), formatPercentChange(s.base.inputTokens, s.head.inputTokens)],
    ["output tokens", formatInt(s.base.outputTokens), formatInt(s.head.outputTokens), formatPercentChange(s.base.outputTokens, s.head.outputTokens)],
    ["avg latency", formatMs(s.base.avgLatencyMs), formatMs(s.head.avgLatencyMs), formatPercentChange(s.base.avgLatencyMs, s.head.avgLatencyMs)],
    ["est. cost", formatCost(s.base.cost), formatCost(s.head.cost), formatPercentChange(s.base.cost, s.head.cost)],
  ];
  const widths = [0, 1, 2, 3].map((i) => Math.max(...rows.map((r) => r[i]!.length)));
  for (const [i, r] of rows.entries()) {
    const text = `${r[0].padEnd(widths[0]!)}   ${r[1].padStart(widths[1]!)}   ${r[2].padStart(widths[2]!)}   ${r[3].padStart(widths[3]!)}`;
    inside.push(i === 0 ? c.dim(text) : text);
  }
  if (s.checks) {
    const k = s.checks;
    const pct = (t: { passed: number; total: number }) => (t.total ? ` (${Math.round((t.passed / t.total) * 100)}%)` : "");
    inside.push("");
    inside.push(
      `checks passed: base ${k.base.passed}/${k.base.total}${pct(k.base)} ${glyph.sep} head ${k.head.passed}/${k.head.total}${pct(k.head)}` +
        (k.regressions ? ` ${glyph.sep} ${c.red.bold(`${k.regressions} regressed`)}` : "") +
        (k.fixed ? ` ${glyph.sep} ${c.green.bold(`${k.fixed} fixed`)}` : ""),
    );
  }
  if (s.judge) {
    inside.push(
      c.dim(
        `judge: ${s.judge.calls} calls${s.judge.cachedCalls ? ` (${s.judge.cachedCalls} cached)` : ""}, ` +
          `${formatInt(s.judge.inputTokens)} in / ${formatInt(s.judge.outputTokens)} out tokens, cost ${formatCost(s.judge.cost)}`,
      ),
    );
  }
  if (s.totalCost !== undefined && s.totalCost > 0) inside.push(`total cost of this run: ${c.bold(formatCost(s.totalCost))}`);

  const notes: string[] = [];
  if (meta.compare === "semantic") notes.push(c.dim(`Compared by meaning (--compare semantic): "noise" means the judge found no difference that matters.`));
  const viaCli = /^(claude-code|codex):/.test(meta.model);
  if (viaCli) notes.push(c.dim(`Ran through your ${meta.model.startsWith("codex") ? "Codex" : "Claude Code"} login, so there's no per-token cost; calls count against that account's usage limits.`));
  else if (!meta.pricingKnown) notes.push(c.dim(`Cost unknown: "${meta.model}" isn't in the pricing table. Add it to promptdiff.pricing.json to see costs.`));
  if (meta.runs === 1 && s.changed > 0 && meta.compare === "words") {
    notes.push(c.dim("Tip: use --runs 3 or --compare semantic to tell real changes from run-to-run randomness."));
  }
  if (!meta.promptChanged) notes.push(c.yellow(`Note: the prompt is identical in ${meta.baseRef} and ${meta.headRef}.`));

  const width = Math.min(opts.width, 100);
  return ["", rule(c, width, "Summary"), ...inside.map((l) => (l ? `  ${l}` : "")), ...(notes.length ? ["", ...notes.map((n) => `  ${n}`)] : [])].join("\n");
}

export function renderHeader(report: DiffReport, opts: TerminalOptions): string {
  const c = new Chalk({ level: opts.colorLevel });
  const { meta } = report;
  const width = Math.min(opts.width, 100);
  const details = [
    `${c.bold(meta.file)}  ${c.red(meta.baseRef)} ${c.dim(glyph.arrow)} ${c.green(meta.headRef)}`,
    c.dim(
      [meta.model, `${meta.runs} run${meta.runs === 1 ? "" : "s"} per case`, `compared by ${meta.compare === "semantic" ? "meaning" : "words"}`, ...(meta.judgeModel && meta.judgeModel !== meta.model ? [`judge ${meta.judgeModel}`] : [])].join(` ${glyph.sep} `),
    ),
  ];
  return [`${wordmark(c)} ${c.dim(`v${meta.version}`)}`, ...details, rule(c, width)].join("\n");
}

export function renderTerminal(report: DiffReport, opts: TerminalOptions): string {
  const cases = report.cases.map((cr) => renderCase(cr, report, opts));
  return [renderHeader(report, opts), "", cases.join("\n\n"), renderSummary(report, opts), ""].join("\n");
}
