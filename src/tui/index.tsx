import path from "node:path";
import chalk from "chalk";
import { render } from "ink";
import { cliLoginCheckers, resolveCredential } from "../auth.js";
import { loadCases } from "../cases.js";
import { initCommand } from "../commands/init.js";
import { loginCommand } from "../commands/login.js";
import { runCommand } from "../commands/run.js";
import { gatherStatus } from "../commands/status.js";
import { readUserConfig } from "../config/keys.js";
import type { CliRunOptions } from "../config/resolve.js";
import { detectDefaultModel } from "../detect.js";
import { PromptdiffError } from "../errors.js";
import { getRepoRoot, git } from "../git.js";
import { promptFilesWithStatus } from "../prompts.js";
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
    promptFiles: (base) => promptFilesWithStatus(cwd, base),
    cases: (file) => casesInfo(cwd, file),
    init: (out) => initCommand({}, cwd, out),
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
