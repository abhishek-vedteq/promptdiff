import { mkdirSync } from "node:fs";
import path from "node:path";
import type { RunDeps } from "../commands/run.js";
import type { ProviderStatus } from "../commands/status.js";
import { loadProjectConfig } from "../config/project.js";
import type { CliRunOptions } from "../config/resolve.js";
import type { DetectedModel } from "../detect.js";
import type { RunPlan } from "../estimate.js";
import type { DiffReport } from "../types.js";

export interface PromptFile {
  /** Relative to the working directory. */
  path: string;
  changed: boolean;
  added?: number;
  removed?: number;
}

export interface CasesInfo {
  file: string;
  count?: number;
  /** Cases with "messages" (skipped by CLI providers). */
  conversations?: number;
  error?: string;
}

export interface Settings {
  model?: string;
  /** Where the model came from: a config file, a flag, a detected login, or the picker. */
  modelSource?: string;
  base: string;
  runs: number;
  compare: "words" | "semantic";
  judge?: string;
}

export interface ModelOption {
  model: string;
  label: string;
  detail: string;
  ready: boolean;
  /** Needs a model id typed in (e.g. openai:<model-id>). */
  needsId?: boolean;
}

/** Everything the app needs from the outside world, injected so tests can fake it. */
export interface ControllerDeps {
  cwd: string;
  env: NodeJS.ProcessEnv;
  colorLevel: 0 | 1 | 2 | 3;
  runDiff: (file: string, cli: CliRunOptions, deps: Partial<RunDeps>) => Promise<number>;
  status: () => Promise<ProviderStatus[]>;
  detectModel: () => Promise<DetectedModel | undefined>;
  /** Why a model can't run right now, or undefined if it's ready. */
  modelProblem: (model: string) => Promise<string | undefined>;
  isRepo: () => Promise<boolean>;
  branch: () => Promise<string | undefined>;
  promptFiles: (base: string) => Promise<PromptFile[]>;
  cases: (file: string) => Promise<CasesInfo>;
  init: (out: { write(s: string): unknown }) => Promise<void>;
  openFile: (file: string) => void;
}

export interface CompareHooks {
  progress: (done: number, total: number) => void;
  log: (line: string) => void;
  confirm: (question: string) => Promise<boolean>;
  signal: AbortSignal;
}

const DEFAULT_MODEL_FOR: Record<string, string> = {
  anthropic: "anthropic:claude-opus-5-5",
  "claude-code": "claude-code:default",
  codex: "codex:default",
};

/** The interactive app's state and actions, free of any UI code. */
export class Controller {
  settings: Settings = { base: "HEAD", runs: 1, compare: "words" };
  inRepo = false;
  branch?: string;
  prompts: PromptFile[] = [];
  cases?: CasesInfo;
  modelProblem?: string;
  /** A ready model to suggest when the current one isn't usable. */
  alternative?: DetectedModel;
  report?: DiffReport;
  plan?: RunPlan;
  /** HTML report of the last comparison. */
  lastReport?: string;
  private casesSetting?: string;

  constructor(readonly deps: ControllerDeps) {}

  async init(cli: CliRunOptions = {}): Promise<void> {
    const project = await loadProjectConfig(this.deps.cwd, cli.config).catch(() => ({ config: {}, file: undefined }));
    const cfg = project.config as { model?: string; base?: string; runs?: number; compare?: "words" | "semantic"; judge?: string; cases?: string };
    this.settings = {
      model: cli.model ?? cfg.model,
      modelSource: cli.model ? "--model flag" : cfg.model ? "from promptdiff.config.yaml" : undefined,
      base: cli.base ?? cfg.base ?? "HEAD",
      runs: cli.runs ? Number(cli.runs) : (cfg.runs ?? 1),
      compare: (cli.compare as Settings["compare"] | undefined) ?? cfg.compare ?? "words",
      judge: cli.judge ?? cfg.judge,
    };
    this.casesSetting = cli.cases ?? cfg.cases;
    if (!this.settings.model) {
      const found = await this.deps.detectModel();
      if (found) this.setModel(found.model, found.reason);
    }
    await this.checkModel();
    this.inRepo = await this.deps.isRepo();
    if (this.inRepo) this.branch = await this.deps.branch();
    await this.refresh();
  }

  setModel(model: string, source: string): void {
    this.settings.model = model;
    this.settings.modelSource = source;
  }

  async checkModel(): Promise<void> {
    this.modelProblem = this.settings.model ? await this.deps.modelProblem(this.settings.model) : "no model chosen";
    this.alternative = undefined;
    if (this.modelProblem) {
      const found = await this.deps.detectModel();
      if (found && found.model !== this.settings.model) this.alternative = found;
    }
  }

  /** Re-reads prompt files and test cases (called on a timer, so edits show up live). */
  async refresh(): Promise<void> {
    this.cases = await this.deps.cases(this.casesSetting ?? "cases.jsonl");
    if (this.inRepo) this.prompts = await this.deps.promptFiles(this.settings.base);
  }

  get changedCount(): number {
    return this.prompts.filter((p) => p.changed).length;
  }

  /** Every model the user could pick, ready ones first. */
  async modelOptions(): Promise<ModelOption[]> {
    const statuses = await this.deps.status();
    const options = statuses.map((st): ModelOption => {
      const known = DEFAULT_MODEL_FOR[st.def.id];
      return {
        model: known ?? `${st.def.id}:`,
        label: known ?? `${st.def.id}:<model-id>`,
        detail: st.detail,
        ready: st.ready,
        needsId: !known,
      };
    });
    return [...options.filter((o) => o.ready), ...options.filter((o) => !o.ready)];
  }

  /** Compares one prompt file. Returns the report (or, for a dry run, just the plan). */
  async compare(file: string, hooks: CompareHooks, dryRun = false): Promise<{ report?: DiffReport; plan?: RunPlan }> {
    const s = this.settings;
    const cli: CliRunOptions = {
      ...(s.model ? { model: s.model } : {}),
      ...(this.casesSetting ? { cases: this.casesSetting } : {}),
      base: s.base,
      runs: String(s.runs),
      compare: s.compare,
      ...(s.judge ? { judge: s.judge } : {}),
      ...(dryRun ? { dryRun: true } : {}),
    };
    if (!dryRun) {
      const dir = path.join(this.deps.cwd, ".promptdiff", "reports");
      mkdirSync(dir, { recursive: true });
      cli.html = path.join(dir, "last.html");
    }
    let report: DiffReport | undefined;
    let plan: RunPlan | undefined;
    const discard = { isTTY: true, columns: 120, write: () => true };
    const stderr = {
      isTTY: false,
      write: (text: string) => {
        for (const line of text.split("\n")) {
          if (line.trim() && !line.startsWith("HTML report written")) hooks.log(line);
        }
        return true;
      },
    };
    await this.deps.runDiff(file, cli, {
      cwd: this.deps.cwd,
      env: this.deps.env,
      stdout: discard,
      stderr,
      colorLevel: this.deps.colorLevel,
      interactive: true,
      confirm: hooks.confirm,
      signal: hooks.signal,
      onPlan: (p) => {
        plan = p;
        this.plan = p; // available to the confirmation question while the run waits
      },
      onReport: (r) => (report = r),
      onProgress: (text) => {
        const m = text?.match(/(\d+)\/(\d+)/);
        if (m) hooks.progress(Number(m[1]), Number(m[2]));
      },
    });
    if (report) {
      this.report = report;
      this.lastReport = cli.html;
    }
    if (plan) this.plan = plan;
    return { report, plan };
  }
}
