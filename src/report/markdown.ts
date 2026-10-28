import { diffLines } from "diff";
import type { CaseResult, DiffReport } from "../types.js";
import { formatCost, formatInt, formatMs, formatPercentChange } from "./format.js";

/** GitHub rejects comments over 65,536 characters; leave headroom. */
export const MAX_MARKDOWN_LENGTH = 60_000;

/** Hidden marker that identifies promptdiff's comment for a given prompt file, so it can be updated in place. */
export const commentMarker = (file: string) => `<!-- promptdiff:${file} -->`;

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const oneLine = (s: string, n = 100) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

/** A code fence longer than any run of backticks in the content. */
function fence(content: string): string {
  const longest = Math.max(2, ...[...content.matchAll(/`+/g)].map((m) => m[0].length));
  return "`".repeat(longest + 1);
}

/** Line-based diff of the first run's outputs, as a ```diff block. */
function diffBlock(base: string, head: string): string {
  const lines: string[] = [];
  for (const part of diffLines(base.replace(/\r\n/g, "\n"), head.replace(/\r\n/g, "\n"))) {
    const prefix = part.added ? "+ " : part.removed ? "- " : "  ";
    for (const line of part.value.replace(/\n$/, "").split("\n")) lines.push(prefix + line);
  }
  const body = lines.join("\n");
  const f = fence(body);
  return `${f}diff\n${body}\n${f}`;
}

function caseSection(cr: CaseResult, report: DiffReport): string {
  const tags = [
    cr.checks?.regression ? "🔴 regression" : "",
    cr.checks?.fixed ? "🟢 fixed" : "",
    cr.status === "changed" ? "🟡 changed" : "",
    cr.status === "error" ? "🔴 error" : "",
  ].filter(Boolean).join(" · ");
  const headline = cr.judgement?.summary && cr.status === "changed" ? cr.judgement.summary : oneLine(cr.input);
  const out: string[] = [];
  out.push(`<details><summary><b>${escapeHtml(cr.id)}</b> ${tags} — ${escapeHtml(headline)}</summary>`, "");
  out.push(`**Input:** ${oneLine(cr.input, 300)}`, "");

  if (cr.status === "error") {
    const errors = [...cr.base, ...cr.head].map((o) => o.error).filter((e): e is string => !!e && e !== "aborted");
    out.push(...[...new Set(errors)].slice(0, 3).map((e) => `- ${e}`), "");
  } else {
    if (cr.judgement?.summary) out.push(`**Judge:** ${cr.judgement.summary}`, "");
    const failed = new Map<string, string | undefined>();
    for (const o of cr.head) for (const r of o.checks ?? []) if (!r.pass && !failed.has(r.label)) failed.set(r.label, r.reason);
    if (cr.checks) {
      out.push(`**Checks:** base ${cr.checks.base.passed}/${cr.checks.base.total} · head ${cr.checks.head.passed}/${cr.checks.head.total}`);
      for (const [label, reason] of failed) out.push(`- ❌ \`${label.replace(/`/g, "'")}\`${reason ? ` — ${reason}` : ""}`);
      out.push("");
    }
    if (cr.status === "changed" || cr.checks?.regression) {
      const runNote = report.meta.runs > 1 ? " (run 1 of each)" : "";
      out.push(`Base → head${runNote}:`, "", diffBlock(cr.base[0]?.text ?? "", cr.head[0]?.text ?? ""), "");
    }
    const b = cr.baseTotals;
    const h = cr.headTotals;
    const per = (n: number, calls: number) => (calls ? n / calls : 0);
    out.push(
      `<sub>output tokens ${formatInt(per(b.outputTokens, b.calls))} → ${formatInt(per(h.outputTokens, h.calls))} ` +
        `${formatPercentChange(per(b.outputTokens, b.calls), per(h.outputTokens, h.calls))} · ` +
        `latency ${formatMs(b.avgLatencyMs)} → ${formatMs(h.avgLatencyMs)} · cost ${formatCost(b.cost)} → ${formatCost(h.cost)}</sub>`,
      "",
    );
  }
  out.push("</details>", "");
  return out.join("\n");
}

/** A GitHub-flavored Markdown report, sized to fit in a PR comment. */
export function renderMarkdown(report: DiffReport, maxLength = MAX_MARKDOWN_LENGTH): string {
  const { meta, summary: s } = report;
  const head: string[] = [];
  head.push(commentMarker(meta.file));
  head.push(`### promptdiff: \`${meta.file}\``);
  head.push(
    `\`${meta.baseRef}\` → \`${meta.headRef}\` · \`${meta.model}\` · ${meta.runs} run${meta.runs === 1 ? "" : "s"} per case · ` +
      `compared by ${meta.compare === "semantic" ? `meaning (judge: \`${meta.judgeModel}\`)` : "word overlap"}`,
    "",
  );

  const verdict = s.errors
    ? `🔴 **${s.errors} case${s.errors === 1 ? "" : "s"} failed to run.**`
    : s.checks?.regressions
      ? `🔴 **${s.checks.regressions} regression${s.checks.regressions === 1 ? "" : "s"}**: the new prompt fails checks the old one passed.`
      : s.changed
        ? `🟡 **${s.changed} of ${s.total} cases changed.**`
        : `🟢 **No meaningful changes** across ${s.total} cases.`;
  head.push(verdict, "");

  head.push("| Changed | Noise | Identical |" + (s.errors ? " Errors |" : "") + (s.checks ? " Checks (base → head) |" : ""));
  head.push("| ---: | ---: | ---: |" + (s.errors ? " ---: |" : "") + (s.checks ? " :---: |" : ""));
  head.push(
    `| ${s.changed} | ${s.noise} | ${s.identical} |` +
      (s.errors ? ` ${s.errors} |` : "") +
      (s.checks ? ` ${s.checks.base.passed}/${s.checks.base.total} → ${s.checks.head.passed}/${s.checks.head.total}${s.checks.fixed ? ` (${s.checks.fixed} fixed)` : ""} |` : ""),
  );
  head.push("");

  head.push(`| | base (\`${cell(meta.baseRef)}\`) | head (\`${cell(meta.headRef)}\`) | change |`, "| --- | ---: | ---: | ---: |");
  head.push(`| output tokens | ${formatInt(s.base.outputTokens)} | ${formatInt(s.head.outputTokens)} | ${formatPercentChange(s.base.outputTokens, s.head.outputTokens)} |`);
  head.push(`| avg latency | ${formatMs(s.base.avgLatencyMs)} | ${formatMs(s.head.avgLatencyMs)} | ${formatPercentChange(s.base.avgLatencyMs, s.head.avgLatencyMs)} |`);
  head.push(`| est. cost | ${formatCost(s.base.cost)} | ${formatCost(s.head.cost)} | ${formatPercentChange(s.base.cost, s.head.cost)} |`);
  head.push("");

  const rank = (cr: CaseResult) => (cr.checks?.regression ? 0 : cr.status === "error" ? 1 : cr.status === "changed" ? 2 : 3);
  const notable = report.cases.filter((cr) => rank(cr) < 3).sort((a, b) => rank(a) - rank(b));
  const quiet = report.cases.filter((cr) => rank(cr) === 3);

  const footer: string[] = [];
  if (quiet.length) {
    footer.push(
      `<details><summary>${quiet.length} unchanged or noise case${quiet.length === 1 ? "" : "s"}</summary>`,
      "",
      quiet.map((cr) => `\`${cr.id}\` (${cr.status})`).join(" · "),
      "",
      "</details>",
      "",
    );
  }
  const cost = s.totalCost !== undefined ? ` · total cost ${formatCost(s.totalCost)}` : "";
  footer.push(`<sub>Generated by [promptdiff](https://www.npmjs.com/package/promptdiff) v${meta.version}${cost}</sub>`);

  const sections: string[] = [];
  let length = head.join("\n").length + footer.join("\n").length + 200;
  let omitted = 0;
  if (notable.length) sections.push("#### Cases to review", "");
  for (const cr of notable) {
    const section = caseSection(cr, report);
    if (length + section.length > maxLength) {
      omitted++;
      continue;
    }
    sections.push(section);
    length += section.length;
  }
  if (omitted) sections.push(`_…and ${omitted} more case${omitted === 1 ? "" : "s"} not shown to keep this comment under GitHub's size limit. See the HTML or JSON report._`, "");

  return [...head, ...sections, ...footer].join("\n") + "\n";
}
