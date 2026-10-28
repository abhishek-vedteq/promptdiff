import { mkdirSync } from "node:fs";
import type { RunDeps } from "../commands/run.js";
import type { ProviderStatus } from "../commands/status.js";
import path from "node:path";
import { loadProjectConfig, type ProjectConfig } from "../config/project.js";
import { casesForPrompt, promptPatterns, type CliRunOptions } from "../config/resolve.js";
import type { DetectedModel } from "../detect.js";
import type { RunPlan } from "../estimate.js";
import type { DiffReport } from "../types.js";

export interface PromptFile {
  /** Relative to the working directory; "file.ts#NAME" for prompts in code. */
  path: string;
  /** Why a prompt in code couldn't be read. */
  error?: string;
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
  /** Lists prompts; `patterns` come from the `prompts:` setting, relative to `configDir`. */
  promptFiles: (base: string, patterns?: { path: string }[], configDir?: string) => Promise<PromptFile[]>;
  cases: (file: string) => Promise<CasesInfo>;
  init: (out: { write(s: string): unknown }, model?: string) => Promise<void>;
  openFile: (file: string) => void;
  /** Runs `git init` in cwd. */
  gitInit: () => Promise<void>;
  /** Writes a sample prompt file and commits just that file. Returns its path. */
  createSamplePrompt: () => Promise<string>;
}

export type SetupStepId = "repo" | "model" | "cases" | "prompt";

export interface SetupStep {
  id: SetupStepId;
  title: string;
  done: boolean;
  /** What's there (when done) or what's missing (when not). */
  detail: string;
  /** What pressing Enter does on this step, when it isn't done. */
  action?: string;
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
  /** --cases flag, which overrides everything. */
  private casesFlag?: string;
  private configPath?: string;
  private project: ProjectConfig = {};
  private projectFile?: string;
  /** Test-case info by file (relative to cwd). */
  private casesByFile = new Map<string, CasesInfo>();

  constructor(readonly deps: ControllerDeps) {}

  async init(cli: CliRunOptions = {}): Promise<void> {
    this.configPath = cli.config;
    await this.loadConfig();
    const cfg = this.project;
    this.settings = {
      model: cli.model ?? cfg.model,
      modelSource: cli.model ? "--model flag" : cfg.model ? `from ${path.basename(this.projectFile ?? "promptdiff.config.yaml")}` : undefined,
      base: cli.base ?? cfg.base ?? "HEAD",
      runs: cli.runs ? Number(cli.runs) : (cfg.runs ?? 1),
      compare: (cli.compare as Settings["compare"] | undefined) ?? cfg.compare ?? "words",
      judge: cli.judge ?? cfg.judge,
    };
    this.casesFlag = cli.cases;
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
    await this.loadConfig();
    if (this.inRepo) {
      this.prompts = await this.deps.promptFiles(this.settings.base, promptPatterns(this.project), this.projectFile ? path.dirname(this.projectFile) : this.deps.cwd);
    }
    const files = new Set([this.defaultCasesFile, ...this.prompts.map((p) => this.casesFileFor(p.path))]);
    const infos = new Map<string, CasesInfo>();
    for (const f of files) {
      const info = await this.deps.cases(f);
      infos.set(f, { ...info, file: this.display(info.file) });
    }
    this.casesByFile = infos;
    this.cases = infos.get(this.defaultCasesFile);
  }

  /** Re-reads promptdiff.config.yaml (it may be created or edited while the app is open). */
  private async loadConfig(): Promise<void> {
    const loaded = await loadProjectConfig(this.deps.cwd, this.configPath).catch(() => ({ config: {} as ProjectConfig, file: undefined }));
    this.project = loaded.config;
    this.projectFile = loaded.file;
  }

  private get defaultCasesFile(): string {
    if (this.casesFlag) return this.casesFlag;
    const configDir = this.projectFile ? path.dirname(this.projectFile) : this.deps.cwd;
    return path.relative(this.deps.cwd, path.resolve(configDir, this.project.cases ?? "cases.jsonl")) || "cases.jsonl";
  }

  /** The test-case file a prompt uses: --cases, its `prompts:` entry, `cases:`, or cases.jsonl. */
  /** Shows paths outside the project as absolute (with ~), not as ../../.. */
  private display(file: string): string {
    return file.startsWith("..") ? path.resolve(this.deps.cwd, file) : file;
  }

  casesFileFor(prompt?: string): string {
    if (this.casesFlag || !prompt) return this.defaultCasesFile;
    const own = casesForPrompt(this.project, this.projectFile, this.deps.cwd, prompt);
    return own ? path.relative(this.deps.cwd, own) : this.defaultCasesFile;
  }

  casesFor(prompt?: string): CasesInfo | undefined {
    return this.casesByFile.get(this.casesFileFor(prompt)) ?? this.cases;
  }

  /** The four things promptdiff needs, in order. */
  setupSteps(): SetupStep[] {
    const model = this.settings.model;
    return [
      {
        id: "repo",
        title: "A git repository",
        done: this.inRepo,
        detail: this.inRepo ? `found${this.branch ? ` (branch ${this.branch})` : ""}` : "this folder isn't one yet. promptdiff gets the old version of a prompt from git.",
        action: "run `git init` here",
      },
      {
        id: "model",
        title: "A model to run prompts",
        done: !this.modelProblem,
        detail: !this.modelProblem
          ? `${model}${this.settings.modelSource ? ` (${this.settings.modelSource})` : ""}`
          : `${model ? `${model}: ${this.modelProblem}` : "none set up yet"}${this.alternative ? `. ${this.alternative.model} is ready to use.` : ""}`,
        action: this.alternative ? `use ${this.alternative.model}` : "choose a model or log in",
      },
      {
        id: "cases",
        title: "Test cases",
        done: !this.cases?.error && (this.cases?.count ?? 0) > 0,
        detail: this.cases?.error
          ? this.prompts.length
            ? `none yet. Test cases are the user messages your app sends along with the prompt, one per line in ${this.cases.file}.`
            : "none yet. Test cases are example messages your users send, saved in cases.jsonl."
          : `${this.cases?.count} in ${this.cases?.file}`,
        action: this.prompts.length
          ? "create cases.jsonl with placeholder examples, to replace with real messages from your app"
          : "create cases.jsonl with 5 examples (and promptdiff.config.yaml)",
      },
      {
        id: "prompt",
        title: "A prompt file, committed to git",
        done: this.prompts.length > 0,
        detail: this.prompts.length
          ? `${this.prompts.length} found: ${this.prompts.slice(0, 3).map((p) => (p.path.includes("#") ? p.path.slice(p.path.lastIndexOf("#") + 1) : p.path)).join(", ")}${this.prompts.length > 3 ? ", …" : ""}`
          : "none yet. A prompt file is your system prompt saved as .md or .txt, e.g. prompts/support.md.",
        action: "create prompts/support.md (a sample support-bot prompt) and commit it",
      },
    ];
  }

  get setupComplete(): boolean {
    return this.setupSteps().every((s) => s.done);
  }

  /** Performs the fix for one setup step. Returns a message for the user. */
  async fixStep(id: SetupStepId): Promise<string> {
    switch (id) {
      case "repo":
        await this.deps.gitInit();
        this.inRepo = await this.deps.isRepo();
        this.branch = await this.deps.branch();
        await this.refresh();
        return "Created a git repository here.";
      case "model":
        if (!this.alternative) return "";
        this.setModel(this.alternative.model, this.alternative.reason);
        await this.checkModel();
        return `Using ${this.settings.model}.`;
      case "cases": {
        let out = "";
        await this.deps.init({ write: (t: string) => (out += t) }, this.modelProblem ? undefined : this.settings.model);
        await this.refresh();
        return out.includes("created") ? "Created cases.jsonl with example test cases, and promptdiff.config.yaml." : out.trim();
      }
      case "prompt": {
        const file = await this.deps.createSamplePrompt();
        await this.refresh();
        return `Created and committed ${file}.`;
      }
    }
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
      // Only an explicit --cases is passed on; otherwise the run picks the prompt's own test cases.
      ...(this.casesFlag ? { cases: this.casesFlag } : {}),
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
