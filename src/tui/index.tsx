import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import chalk from "chalk";
import { render } from "ink";
import { cliLoginCheckers, resolveCredential } from "../auth.js";
import { loadCases } from "../cases.js";
import { casesGenerateCommand } from "../commands/cases.js";
import { SAMPLE_PROMPT, initCommand } from "../commands/init.js";
import { loginCommand } from "../commands/login.js";
import { runCommand } from "../commands/run.js";
import { gatherStatus } from "../commands/status.js";
import { readUserConfig } from "../config/keys.js";
import type { CliRunOptions } from "../config/resolve.js";
import { detectDefaultModel } from "../detect.js";
import { PromptdiffError } from "../errors.js";
import { getRepoRoot, git } from "../git.js";
import { discoverPrompts } from "../prompts.js";
import { getProviderDefinition, parseModelSpec } from "../providers/registry.js";
import { App } from "./App.js";
import { Controller, type CasesInfo } from "./controller.js";
import { openWithDefaultApp } from "./open.js";

async function modelProblem(model: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  let def;
  try {
    def = getProviderDefinition(parseModelSpec(model).provider);
  } catch (err) {
    return (err as Error).message;
  }
  if (def.kind === "cli") {
    const login = await cliLoginCheckers[def.id]?.(env);
    if (!login?.installed) return `the \`${def.id === "claude-code" ? "claude" : def.id}\` command isn't installed`;
    if (!login.loggedIn) return `${def.id === "codex" ? "Codex" : "Claude Code"} isn't logged in`;
    return undefined;
  }
  if (def.requiresKey === false) return undefined;
  return resolveCredential(def, await readUserConfig(), env) ? undefined : `no ${def.displayName} API key`;
}

async function casesInfo(cwd: string, file: string): Promise<CasesInfo> {
  const full = path.resolve(cwd, file);
  const label = path.relative(cwd, full) || file;
  try {
    const cases = await loadCases(full, label);
    return { file: label, count: cases.length, conversations: cases.filter((tc) => tc.messages && tc.messages.length > 1).length };
  } catch (err) {
    if (err instanceof PromptdiffError && err.message.startsWith("Cases file not found")) {
      return { file: label, error: `none yet (${label} not found). Press i to create sample files.` };
    }
    return { file: label, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Writes prompts/support.md (unless it exists) and commits only that file. */
async function createSamplePrompt(cwd: string): Promise<string> {
  const rel = path.join("prompts", "support.md");
  const file = path.join(cwd, rel);
  if (!existsSync(file)) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, SAMPLE_PROMPT);
  }
  await git(["add", "--", rel], cwd);
  try {
    await git(["commit", "-q", "-m", "Add sample prompt for promptdiff", "--", rel], cwd);
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr ?? "";
    if (/user\.(name|email)|identity/i.test(stderr)) {
      throw new PromptdiffError(`Created ${rel}, but git couldn't commit it: your git name and email aren't set.`, {
        hint: 'Run: git config --global user.name "Your Name" && git config --global user.email you@example.com, then press enter again.',
      });
    }
    throw new PromptdiffError(`Created ${rel}, but committing it failed: ${stderr.trim() || (err as Error).message}`);
  }
  return rel.split(path.sep).join("/");
}

/** Opens the interactive app (what `promptdiff` with no arguments does in a terminal). */
export async function startInteractive(cli: CliRunOptions = {}): Promise<void> {
  const cwd = process.cwd();
  const env = process.env;
  const colorLevel = env.NO_COLOR ? 0 : (Math.max(chalk.level, 1) as 1 | 2 | 3);

  const controller = new Controller({
    cwd,
    env,
    colorLevel,
    runDiff: runCommand,
    status: () => gatherStatus(env),
    detectModel: async () => detectDefaultModel(await readUserConfig(), env),
    modelProblem: (model) => modelProblem(model, env),
    isRepo: () => getRepoRoot(cwd).then(() => true, () => false),
    branch: () => git(["rev-parse", "--abbrev-ref", "HEAD"], cwd).then((r) => r.stdout.trim() || undefined, () => undefined),
    promptFiles: (base, patterns, configDir) => discoverPrompts(cwd, base, patterns, configDir),
    cases: (file) => casesInfo(cwd, file),
    init: (out, model) => initCommand({ model }, cwd, out),
    generateCases: (prompt, model, out) => casesGenerateCommand(prompt, { model }, { cwd, env, out }),
    gitInit: async () => {
      await git(["init", "-q"], cwd);
    },
    createSamplePrompt: () => createSamplePrompt(cwd),
    openFile: openWithDefaultApp,
  });

  process.stdout.write(chalk.dim("promptdiff: loading…"));
  await controller.init(cli);
  process.stdout.write("\r\x1b[2K");

  const app = render(
    <App
      controller={controller}
      login={async (provider) => {
        await loginCommand(provider);
      }}
    />,
    { exitOnCtrlC: false, alternateScreen: true },
  );
  await app.waitUntilExit();

  if (controller.lastReport) {
    process.stdout.write(chalk.dim(`Last report: ${path.relative(cwd, controller.lastReport)}\n`));
  }
}
