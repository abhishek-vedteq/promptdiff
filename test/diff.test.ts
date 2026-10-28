import { describe, expect, it } from "vitest";
import { escapeHtml, renderHtml } from "../src/report/html.js";
import { leftSide, rightSide, wordDiff, wrapSegments } from "../src/report/diff.js";
import { renderTerminal } from "../src/report/terminal.js";
import { MockProvider } from "../src/providers/mock.js";
import { runDiff, sumTotals } from "../src/runner.js";
import type { DiffReport } from "../src/types.js";
import { makeCase } from "./helpers.js";

describe("wordDiff", () => {
  it("marks removed and added words", () => {
    const segs = wordDiff("the quick brown fox", "the slow brown fox");
    expect(segs.filter((s) => s.kind === "removed").map((s) => s.text.trim())).toEqual(["quick"]);
    expect(segs.filter((s) => s.kind === "added").map((s) => s.text.trim())).toEqual(["slow"]);
    expect(leftSide(segs).map((s) => s.text).join("")).toBe("the quick brown fox");
    expect(rightSide(segs).map((s) => s.text).join("")).toBe("the slow brown fox");
  });
});

describe("wrapSegments", () => {
  it("wraps at the width and keeps segment kinds", () => {
    const lines = wrapSegments([{ text: "aaa bbb ", kind: "same" }, { text: "ccc ddd", kind: "added" }], 8);
    for (const l of lines) expect(l.reduce((n, s) => n + s.text.length, 0)).toBeLessThanOrEqual(8);
    expect(lines.flat().filter((s) => s.kind === "added").map((s) => s.text).join("")).toContain("ccc");
  });

  it("honors newlines and hard-splits long words", () => {
    const lines = wrapSegments([{ text: "ab\n" + "x".repeat(25), kind: "same" }], 10);
    expect(lines[0]!.map((s) => s.text).join("")).toBe("ab");
    expect(lines.slice(1).map((l) => l.map((s) => s.text).join(""))).toEqual(["xxxxxxxxxx", "xxxxxxxxxx", "xxxxx"]);
  });
});

async function sampleReport(): Promise<DiffReport> {
  const provider = new MockProvider((req) => ({
    text: req.system.includes("v2") ? "Hello <b>friend</b>, how can I help?" : "Hello there, how can I help?",
    inputTokens: 10,
    outputTokens: req.system.includes("v2") ? 12 : 10,
  }));
  const cases = await runDiff({
    provider,
    modelSpec: "mock:m",
    modelId: "m",
    basePrompt: "v1",
    headPrompt: "v2",
    cases: [makeCase("greet", "hi", { line: 1 })],
    runs: 1,
    concurrency: 1,
    pricing: { "mock:m": { input: 1, output: 2 } },
  });
  return {
    meta: { tool: "promptdiff", version: "0", file: "p.md", baseRef: "main", headRef: "working copy", model: "mock:m", runs: 1, compare: "words", promptChanged: true, pricingKnown: true, startedAt: "t", durationMs: 1 },
    prompts: { base: "v1", head: "v2" },
    cases,
    summary: { total: 1, identical: 0, noise: 0, changed: 1, errors: 0, base: sumTotals(cases.map((c) => c.baseTotals)), head: sumTotals(cases.map((c) => c.headTotals)) },
  };
}

describe("terminal report", () => {
  it("shows inline markers without color", async () => {
    const out = renderTerminal(await sampleReport(), { colorLevel: 0, width: 100, sideBySide: false, verbose: false });
    expect(out).toContain("CHANGED");
    expect(out).toContain("[-there-]");
    expect(out).toContain("{+<b>friend</b>+}");
    expect(out).toContain("output tokens 10 → 12 (+20.0%)");
    expect(out).toMatch(/1 changed · 0 noise · 0 identical/);
  });

  it("renders side by side with color in wide terminals", async () => {
    const out = renderTerminal(await sampleReport(), { colorLevel: 1, width: 120, sideBySide: true, verbose: false });
    expect(out).toContain("base (main)");
    expect(out).toContain("head (working copy)");
    expect(out).toContain("│");
    expect(out).toContain("\u001b["); // ANSI colors
  });
});

describe("html report", () => {
  it("is self-contained and escapes model output", async () => {
    const html = renderHtml(await sampleReport());
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain("<ins>&lt;b&gt;friend&lt;/b&gt;</ins>");
    expect(html).toContain("<del>there</del>");
    expect(html).not.toContain("<b>friend</b>");
    expect(html).not.toMatch(/<(link|script)[^>]+(src|href)=/);
  });

  it("escapes all HTML special characters", () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
  });
});

describe("terminal look", () => {
  it("uses promptdiff's own look: wordmark header, status pills, │ gutters, and a Summary rule", async () => {
    const out = renderTerminal(await sampleReport(), { colorLevel: 0, width: 100, sideBySide: false, verbose: false });
    expect(out).toMatch(/^± promptdiff v0/);
    expect(out).toContain("p.md  main → working copy");
    expect(out).toContain("[CHANGED] greet");
    expect(out).toMatch(/\n {2}│ Hello/);
    expect(out).toMatch(/── Summary ─+/);
    expect(out).not.toMatch(/[⏺⎿✻╭]/);
  });
});
