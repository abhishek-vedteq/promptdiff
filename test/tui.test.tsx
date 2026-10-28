import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import type { RunDeps } from "../src/commands/run.js";
import type { CliRunOptions } from "../src/config/resolve.js";
import type { RunPlan } from "../src/estimate.js";
import { App } from "../src/tui/App.js";
import { Controller, type ControllerDeps } from "../src/tui/controller.js";
import type { DiffReport } from "../src/types.js";
import { tempDir } from "./helpers.js";

const plan: RunPlan = {
  totalCalls: 2, cachedCalls: 0, assumedOutputTokens: 500,
  generation: { calls: 2, inputTokens: 10, outputTokens: 1000, cost: 0.5 },
  judge: { calls: 0, inputTokens: 0, outputTokens: 0, cost: 0 },
  cost: 0.5,
};

const totals = { inputTokens: 10, outputTokens: 20, avgLatencyMs: 100, calls: 1 };
const report: DiffReport = {
  meta: { tool: "promptdiff", version: "0", file: "prompts/support.md", baseRef: "HEAD", headRef: "working copy", model: "claude-code:default", runs: 1, compare: "words", promptChanged: true, pricingKnown: false, startedAt: "", durationMs: 1 },
  prompts: { base: "a", head: "b" },
  cases: [
    { id: "same-case", input: "hi", status: "identical", base: [{ runIndex: 0, text: "hello", latencyMs: 1, cached: false }], head: [{ runIndex: 0, text: "hello", latencyMs: 1, cached: false }], baseTotals: totals, headTotals: totals },
    { id: "refund", input: "refund?", status: "changed", base: [{ runIndex: 0, text: "Refunds take 5 days.", latencyMs: 1, cached: false }], head: [{ runIndex: 0, text: "What is your order number?", latencyMs: 1, cached: false }], baseTotals: totals, headTotals: totals },
  ],
  summary: { total: 2, identical: 1, noise: 0, changed: 1, errors: 0, base: totals, head: totals },
};

function fakeDeps(over: Partial<ControllerDeps> = {}): ControllerDeps & { calls: { file: string; cli: CliRunOptions }[] } {
  const calls: { file: string; cli: CliRunOptions }[] = [];
  return {
    calls,
    cwd: tempDir(),
    env: {},
    colorLevel: 0,
    runDiff: async (file: string, cli: CliRunOptions, deps: Partial<RunDeps>) => {
      calls.push({ file, cli });
      deps.onPlan?.(plan);
      if (cli.dryRun) return 0;
      deps.onProgress?.("Running prompts… 1/2");
      deps.onReport?.(report);
      return 0;
    },
    status: async () => [],
    detectModel: async () => ({ model: "claude-code:default", reason: "your Claude Code login" }),
    modelProblem: async (model: string) => (model.startsWith("anthropic:") ? "no Anthropic API key" : undefined),
    isRepo: async () => true,
    branch: async () => "main",
    promptFiles: async () => [
      { path: "prompts/support.md", changed: true, added: 1, removed: 1 },
      { path: "prompts/sales.md", changed: false },
    ],
    cases: async (file: string) => ({ file, count: 6, conversations: 1 }),
    init: async (out: { write(s: string): unknown }) => void out.write("  created  cases.jsonl\n"),
    openFile: vi.fn(),
    ...over,
  };
}

describe("Controller", () => {
  it("loads settings, detects a model, and lists prompt files", async () => {
    const c = new Controller(fakeDeps());
    await c.init();
    expect(c.settings).toMatchObject({ model: "claude-code:default", base: "HEAD", runs: 1, compare: "words" });
    expect(c.modelProblem).toBeUndefined();
    expect(c.changedCount).toBe(1);
    expect(c.branch).toBe("main");
    expect(c.cases).toMatchObject({ count: 6 });
  });

  it("flags a model that isn't set up and finds one that is", async () => {
    const c = new Controller(fakeDeps());
    await c.init({ model: "anthropic:claude-opus-5-5" });
    expect(c.modelProblem).toBe("no Anthropic API key");
    expect(c.alternative?.model).toBe("claude-code:default");
  });

  it("compares with the session settings and keeps the report", async () => {
    const deps = fakeDeps();
    const c = new Controller(deps);
    await c.init();
    c.settings.runs = 3;
    c.settings.compare = "semantic";
    const progress: number[][] = [];
    const { report: r } = await c.compare("prompts/support.md", { progress: (d, t) => progress.push([d, t]), log: () => {}, confirm: async () => true, signal: new AbortController().signal });
    expect(deps.calls[0]).toMatchObject({ file: "prompts/support.md", cli: { model: "claude-code:default", runs: "3", compare: "semantic", base: "HEAD" } });
    expect(deps.calls[0]!.cli.html).toMatch(/[\\/]\.promptdiff[\\/]reports[\\/]last\.html$/);
    expect(progress).toEqual([[1, 2]]);
    expect(r?.summary.changed).toBe(1);
    expect(c.lastReport).toBeDefined();
  });
});

const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));

async function start(over: Partial<ControllerDeps> = {}, cli: CliRunOptions = {}) {
  const deps = fakeDeps(over);
  const controller = new Controller(deps);
  await controller.init(cli);
  const ui = render(<App controller={controller} login={async () => {}} />);
  await tick();
  return { ...ui, deps, controller };
}

describe("App", () => {
  it("shows the prompts screen with its own look and the key bar", async () => {
    const { lastFrame, unmount } = await start();
    const frame = lastFrame()!;
    expect(frame).toContain("± promptdiff");
    expect(frame).toContain("main");
    expect(frame).toContain("Prompt files  1 changed since HEAD");
    expect(frame).toContain("› ● prompts/support.md");
    expect(frame).toContain("+1 −1");
    expect(frame).toContain("○ prompts/sales.md");
    expect(frame).toContain("claude-code:default ✓ ready");
    expect(frame).toContain("enter compare");
    expect(frame).not.toMatch(/[⏺⎿✻]/);
    unmount();
  });

  it("enter compares the selected prompt and shows the results screen", async () => {
    const { lastFrame, stdin, deps, unmount } = await start();
    stdin.write("\r");
    await tick(80);
    expect(deps.calls[0]!.file).toBe("prompts/support.md");
    const frame = lastFrame()!;
    expect(frame).toContain("1 changed");
    expect(frame).toContain("› CHANGED refund");
    expect(frame).toContain("SAME    same-case");
    expect(frame).toContain("input: refund?");
    expect(frame).toContain("− before (HEAD)");
    expect(frame).toContain("[-Refunds-]");
    expect(frame).toContain("+ after (working copy)");
    expect(frame).toContain("{+What+}");
    stdin.write("\u001b"); // esc back
    await tick();
    expect(lastFrame()).toContain("Prompt files");
    unmount();
  });

  it("explains a model that isn't ready instead of running", async () => {
    const { lastFrame, stdin, deps, unmount } = await start({}, { model: "anthropic:claude-opus-5-5" });
    expect(lastFrame()).toContain("✗ no Anthropic API key");
    expect(lastFrame()).toContain("claude-code:default is ready");
    stdin.write("\r");
    await tick();
    expect(deps.calls).toHaveLength(0);
    expect(lastFrame()).toContain("Press m to choose a model");
    unmount();
  });

  it("m opens the model picker and enter switches model", async () => {
    const { lastFrame, stdin, controller, unmount } = await start(
      {
        status: async () =>
          [
            { def: { id: "claude-code" }, ready: true, detail: "logged in" },
            { def: { id: "codex" }, ready: true, detail: "logged in (ChatGPT)" },
          ] as never,
      },
      { model: "anthropic:claude-opus-5-5" },
    );
    stdin.write("m");
    await tick();
    expect(lastFrame()).toContain("Choose a model");
    stdin.write("\u001b[B"); // down
    await tick();
    stdin.write("\r");
    await tick();
    expect(controller.settings.model).toBe("codex:default");
    expect(lastFrame()).toContain("Using codex:default for this session");
    unmount();
  });

  it("r cycles runs, s toggles semantic, p shows the cost plan", async () => {
    const { lastFrame, stdin, controller, deps, unmount } = await start();
    stdin.write("r");
    await tick();
    expect(controller.settings.runs).toBe(3);
    stdin.write("s");
    await tick();
    expect(controller.settings.compare).toBe("semantic");
    expect(lastFrame()).toContain("compared by meaning");
    stdin.write("p");
    await tick(80);
    expect(deps.calls.at(-1)!.cli.dryRun).toBe(true);
    expect(lastFrame()).toContain("Plan: 2 calls");
    unmount();
  });

  it("asks before expensive runs", async () => {
    let answer: boolean | undefined;
    const { lastFrame, stdin, unmount } = await start({
      runDiff: async (_f: string, _c: CliRunOptions, d: Partial<RunDeps>) => {
        d.onPlan?.(plan);
        answer = await d.confirm!("Continue? [y/N] ");
        return 0;
      },
    });
    stdin.write("\r");
    await tick();
    expect(lastFrame()).toContain("estimated at ~$0.5000");
    expect(lastFrame()).toContain("y yes, run it");
    stdin.write("n");
    await tick();
    expect(answer).toBe(false);
    unmount();
  });

  it("explains empty states", async () => {
    const notRepo = await start({ isRepo: async () => false });
    expect(notRepo.lastFrame()).toContain("This folder isn't a git repository.");
    notRepo.unmount();
    const noCases = await start({ cases: async (f: string) => ({ file: f, error: "none yet (cases.jsonl not found). Press i to create sample files." }) });
    expect(noCases.lastFrame()).toContain("Press i to create sample files");
    expect(noCases.lastFrame()).toContain("i create sample files");
    noCases.unmount();
  });
});
