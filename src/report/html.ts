import type { CaseStatus } from "../analysis.js";
import type { CaseResult, DiffReport, RunOutput } from "../types.js";
import { leftSide, rightSide, wordDiff, type Segment } from "./diff.js";
import { formatCost, formatInt, formatMs, formatPercentChange } from "./format.js";

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function segmentsHtml(segs: Segment[]): string {
  return segs
    .map((s) => {
      const t = escapeHtml(s.text);
      if (s.kind === "removed") return `<del>${t}</del>`;
      if (s.kind === "added") return `<ins>${t}</ins>`;
      return t;
    })
    .join("");
}

const STATUS_TEXT: Record<CaseStatus, string> = {
  changed: "changed",
  noise: "noise",
  identical: "identical",
  error: "error",
};

function runsTable(label: string, outputs: RunOutput[]): string {
  return outputs
    .map(
      (o) => `<div class="run"><div class="runhead">${escapeHtml(label)} run ${o.runIndex + 1}` +
        ` · ${o.outputTokens ?? "?"} out tokens · ${formatMs(o.latencyMs)}${o.cached ? " · cached" : ""}</div>` +
        `<pre>${escapeHtml(o.error ? `ERROR: ${o.error}` : o.text)}</pre></div>`,
    )
    .join("");
}

function inputHtml(cr: CaseResult): string {
  const vars = cr.vars
    ? `<div class="label">Variables</div><pre>${escapeHtml(Object.entries(cr.vars).map(([k, v]) => `${k} = ${String(v)}`).join("\n"))}</pre>`
    : "";
  if (!cr.messages || cr.messages.length <= 1) {
    return `<div class="label">Input</div><pre class="inputfull">${escapeHtml(cr.input)}</pre>${vars}`;
  }
  const turns = cr.messages.map((m) => `<div class="turn ${m.role}"><span class="role">${m.role}</span>${escapeHtml(m.content)}</div>`).join("");
  return `<div class="label">Conversation</div><div class="convo">${turns}</div>${vars}`;
}

function checksHtml(cr: CaseResult): string {
  const k = cr.checks!;
  const list = (label: "base" | "head", outputs: RunOutput[]) => {
    const failed = new Map<string, string | undefined>();
    for (const o of outputs) for (const r of o.checks ?? []) if (!r.pass && !failed.has(r.label)) failed.set(r.label, r.reason);
    const items = [...failed].map(([l, reason]) => `<li class="fail">✗ ${escapeHtml(l)}${reason ? ` <span class="why">— ${escapeHtml(reason)}</span>` : ""}</li>`);
    return `<div><div class="label">${label} checks: ${k[label].passed}/${k[label].total} passed</div>${items.length ? `<ul class="checks">${items.join("")}</ul>` : ""}</div>`;
  };
  return `<div class="grid">${list("base", cr.base)}${list("head", cr.head)}</div>`;
}

function caseHtml(cr: CaseResult, report: DiffReport): string {
  const base = cr.base[0]?.text ?? "";
  const head = cr.head[0]?.text ?? "";
  const segs = wordDiff(base, head);
  const b = cr.baseTotals;
  const h = cr.headTotals;
  const per = (n: number, calls: number) => (calls ? n / calls : 0);
  const metrics = [
    `output tokens ${formatInt(per(b.outputTokens, b.calls))} → ${formatInt(per(h.outputTokens, h.calls))} ${formatPercentChange(per(b.outputTokens, b.calls), per(h.outputTokens, h.calls))}`,
    `latency ${formatMs(b.avgLatencyMs)} → ${formatMs(h.avgLatencyMs)}`,
    `cost ${formatCost(b.cost)} → ${formatCost(h.cost)}`,
  ];
  if (cr.stats && report.meta.runs > 1) {
    const f = (v: number | undefined) => (v === undefined ? "–" : v.toFixed(2));
    metrics.push(`distance within base ${f(cr.stats.withinBase)} / head ${f(cr.stats.withinHead)} / between ${f(cr.stats.between)}`);
  }
  const checks = cr.checks ? checksHtml(cr) : "";
  const open = cr.status === "changed" || cr.status === "error" || cr.checks?.regression ? " open" : "";
  return `<details class="case ${cr.status}"${open}>
<summary><span class="badge ${cr.status}">${STATUS_TEXT[cr.status]}</span>${cr.checks?.regression ? ' <span class="badge error">regression</span>' : cr.checks?.fixed ? ' <span class="badge identical">fixed</span>' : ""} <strong>${escapeHtml(cr.id)}</strong> <span class="input">${escapeHtml(cr.judgement?.summary && cr.status === "changed" ? cr.judgement.summary : cr.input.slice(0, 160))}</span></summary>
<div class="body">
${inputHtml(cr)}
<div class="grid">
<div><div class="label">base (${escapeHtml(report.meta.baseRef)})</div><pre>${segmentsHtml(leftSide(segs))}</pre></div>
<div><div class="label">head (${escapeHtml(report.meta.headRef)})</div><pre>${segmentsHtml(rightSide(segs))}</pre></div>
</div>
${cr.judgement?.summary ? `<div class="judge"><strong>Judge:</strong> ${escapeHtml(cr.judgement.summary)}</div>` : ""}
${cr.judgement?.error ? `<div class="metrics">Judge failed: ${escapeHtml(cr.judgement.error)}</div>` : ""}
${checks}
<div class="metrics">${metrics.map(escapeHtml).join(" · ")}</div>
${report.meta.runs > 1 ? `<details class="allruns"><summary>All ${report.meta.runs} runs</summary><div class="grid"><div>${runsTable("base", cr.base)}</div><div>${runsTable("head", cr.head)}</div></div></details>` : ""}
</div>
</details>`;
}

/** A single self-contained HTML file (inline CSS, no external requests). */
export function renderHtml(report: DiffReport): string {
  const { meta, summary: s } = report;
  const promptSegs = wordDiff(report.prompts.base, report.prompts.head);
  const row = (label: string, b: string, h: string, d: string) =>
    `<tr><th>${label}</th><td>${b}</td><td>${h}</td><td>${d}</td></tr>`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>promptdiff: ${escapeHtml(meta.file)}</title>
<style>
:root { --bg:#fff; --fg:#1f2328; --muted:#656d76; --border:#d0d7de; --panel:#f6f8fa; --add:#dafbe1; --addfg:#116329; --del:#ffebe9; --delfg:#82071e; --changed:#9a6700; --noise:#0969da; --same:#1a7f37; --err:#cf222e; }
@media (prefers-color-scheme: dark) { :root { --bg:#0d1117; --fg:#e6edf3; --muted:#8d96a0; --border:#30363d; --panel:#161b22; --add:#033a16; --addfg:#7ee787; --del:#4c0519; --delfg:#ffa198; --changed:#d29922; --noise:#4493f8; --same:#3fb950; --err:#f85149; } }
* { box-sizing: border-box; }
body { margin:0; padding:24px; font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif; background:var(--bg); color:var(--fg); }
main { max-width:1280px; margin:0 auto; }
h1 { font-size:20px; margin:0 0 4px; } h2 { font-size:16px; margin:24px 0 8px; }
.sub { color:var(--muted); margin-bottom:16px; }
.counts { display:flex; gap:12px; flex-wrap:wrap; margin:16px 0; }
.count { border:1px solid var(--border); border-radius:8px; padding:8px 14px; background:var(--panel); }
.count b { font-size:20px; display:block; }
table { border-collapse:collapse; margin:8px 0 16px; }
th, td { border:1px solid var(--border); padding:4px 10px; text-align:right; font-variant-numeric:tabular-nums; }
th:first-child { text-align:left; }
pre { white-space:pre-wrap; word-break:break-word; margin:0; padding:10px; background:var(--panel); border:1px solid var(--border); border-radius:6px; font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
ins { background:var(--add); color:var(--addfg); text-decoration:none; }
del { background:var(--del); color:var(--delfg); }
.case { border:1px solid var(--border); border-radius:8px; margin:10px 0; }
.case > summary { padding:10px 14px; cursor:pointer; list-style:none; display:flex; gap:10px; align-items:baseline; }
.case > summary::-webkit-details-marker { display:none; }
.case .input { color:var(--muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.body { padding:0 14px 14px; }
.badge { font-size:11px; font-weight:600; text-transform:uppercase; padding:2px 8px; border-radius:999px; border:1px solid currentColor; }
.badge.changed { color:var(--changed); } .badge.noise { color:var(--noise); } .badge.identical { color:var(--same); } .badge.error { color:var(--err); }
.grid { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
@media (max-width: 800px) { .grid { grid-template-columns:1fr; } }
.label { font-size:12px; color:var(--muted); margin:10px 0 4px; }
.metrics { color:var(--muted); font-size:12.5px; margin-top:10px; }
.run { margin-bottom:8px; } .runhead { font-size:12px; color:var(--muted); margin-bottom:2px; }
.allruns { margin-top:10px; } .allruns > summary { cursor:pointer; color:var(--muted); }
.judge { margin-top:10px; padding:8px 10px; border-left:3px solid var(--noise); background:var(--panel); }
.convo { border:1px solid var(--border); border-radius:6px; background:var(--panel); padding:6px 10px; white-space:pre-wrap; font-size:13px; }
.turn { padding:4px 0; } .turn + .turn { border-top:1px dashed var(--border); } .role { font-size:11px; font-weight:600; text-transform:uppercase; color:var(--muted); margin-right:8px; }
.checks { margin:4px 0; padding-left:18px; } .fail { color:var(--err); } .why { color:var(--muted); }
.filters { margin:8px 0; } .filters label { margin-right:12px; }
</style>
</head>
<body>
<main>
<h1>promptdiff: ${escapeHtml(meta.file)}</h1>
<div class="sub">${escapeHtml(meta.baseRef)} → ${escapeHtml(meta.headRef)} · ${escapeHtml(meta.model)}${meta.temperature !== undefined ? ` · temperature ${meta.temperature}` : ""} · ${meta.runs} run${meta.runs === 1 ? "" : "s"} per case · ${escapeHtml(meta.startedAt)}</div>
<div class="counts">
<div class="count"><b style="color:var(--changed)">${s.changed}</b>changed</div>
<div class="count"><b style="color:var(--noise)">${s.noise}</b>noise</div>
<div class="count"><b style="color:var(--same)">${s.identical}</b>identical</div>
${s.errors ? `<div class="count"><b style="color:var(--err)">${s.errors}</b>errors</div>` : ""}
</div>
<table>
<tr><th></th><th>base (${escapeHtml(meta.baseRef)})</th><th>head (${escapeHtml(meta.headRef)})</th><th>change</th></tr>
${row("input tokens", formatInt(s.base.inputTokens), formatInt(s.head.inputTokens), formatPercentChange(s.base.inputTokens, s.head.inputTokens))}
${row("output tokens", formatInt(s.base.outputTokens), formatInt(s.head.outputTokens), formatPercentChange(s.base.outputTokens, s.head.outputTokens))}
${row("avg latency", formatMs(s.base.avgLatencyMs), formatMs(s.head.avgLatencyMs), formatPercentChange(s.base.avgLatencyMs, s.head.avgLatencyMs))}
${row("est. cost", formatCost(s.base.cost), formatCost(s.head.cost), formatPercentChange(s.base.cost, s.head.cost))}
</table>
${s.judge ? `<p class="sub">Judge (${escapeHtml(meta.judgeModel ?? "")}): ${s.judge.calls} calls, cost ${formatCost(s.judge.cost)}${meta.compare === "semantic" ? " · outputs compared by meaning" : ""}</p>` : ""}
${s.totalCost !== undefined && s.totalCost > 0 ? `<p>Total cost of this run: <strong>${formatCost(s.totalCost)}</strong></p>` : ""}
${s.checks ? `<p>Checks passed: base ${s.checks.base.passed}/${s.checks.base.total} · head ${s.checks.head.passed}/${s.checks.head.total}${s.checks.regressions ? ` · <strong style="color:var(--err)">${s.checks.regressions} regressed</strong>` : ""}${s.checks.fixed ? ` · <strong style="color:var(--same)">${s.checks.fixed} fixed</strong>` : ""}</p>` : ""}
${meta.pricingKnown ? "" : `<p class="sub">Cost unknown: ${escapeHtml(meta.model)} is not in the pricing table.</p>`}
<details><summary><strong>Prompt diff</strong></summary><pre>${segmentsHtml(promptSegs)}</pre></details>
<h2>Cases</h2>
<div class="filters">
${(["changed", "noise", "identical", "error"] as const).map((st) => `<label><input type="checkbox" data-status="${st}" checked> ${st}</label>`).join("\n")}
</div>
${report.cases.map((cr) => caseHtml(cr, report)).join("\n")}
</main>
<script>
document.querySelectorAll(".filters input").forEach(function (box) {
  box.addEventListener("change", function () {
    document.querySelectorAll(".case." + box.dataset.status).forEach(function (el) { el.style.display = box.checked ? "" : "none"; });
  });
});
</script>
</body>
</html>
`;
}
