#!/usr/bin/env node
import { chalkStderr } from "chalk";
import { Command } from "commander";
import { configList, configRemove, configSet } from "./commands/config.js";
import { initCommand } from "./commands/init.js";
import { loginCommand } from "./commands/login.js";
import { addRunOptions } from "./commands/run-options.js";
import { EXIT_ERROR, runCommand } from "./commands/run.js";
import type { CliRunOptions } from "./config/resolve.js";
import { formatError } from "./ui/errors.js";
import { getVersion } from "./version.js";

const program = new Command();

program
  .name("promptdiff")
  .description("git diff for prompts: run test cases through two versions of a prompt and diff the outputs")
  .version(getVersion(), "-v, --version")
  .showHelpAfterError();

addRunOptions(
  program
    .command("run [file]", { isDefault: true })
    .description("compare a prompt file at a git ref with the working copy (default command). With no file, opens the interactive app."),
)
  .addHelpText(
    "after",
    `
Examples:
  promptdiff                                   open the interactive app
  promptdiff prompts/support.md --base main
  promptdiff prompts/support.md --base main --model claude-code:default
  promptdiff prompts/support.md --base main --model openai:<model-id> --runs 3
  promptdiff prompts/support.md --base v1.2 --head v1.3 --json > diff.json
  promptdiff prompts/support.md --base origin/main --github-comment --fail-on-regression

Exit codes: 0 success, 1 error, 2 changes or failed checks (with --fail-on-* flags)`,
  )
  .action(async (file: string | undefined, opts: CliRunOptions, cmd: Command) => {
    if (!file) {
      if (process.stdin.isTTY && process.stdout.isTTY) {
        const { startInteractive } = await import("./tui/index.js");
        await startInteractive(opts);
        return;
      }
      cmd.error("error: missing prompt file. Usage: promptdiff <file> [options]  (run `promptdiff` in a terminal for the interactive app)");
    }
    // First Ctrl+C stops gracefully (keeping finished results); a second one exits immediately.
    const controller = new AbortController();
    const onSigint = () => {
      if (controller.signal.aborted) process.exit(130);
      controller.abort();
    };
    process.on("SIGINT", onSigint);
    try {
      process.exitCode = await runCommand(file, opts, { signal: controller.signal });
    } finally {
      process.off("SIGINT", onSigint);
    }
  });

program
  .command("login [provider]")
  .description("set up a provider: paste an API key, sign in with your browser, or use your Claude Code / Codex login")
  .action(async (provider: string | undefined) => {
    if (!(await loginCommand(provider))) process.exitCode = 1;
  });

program
  .command("logout <provider>")
  .description("remove a saved API key (CLI and browser logins are managed by those tools)")
  .action(async (provider: string) => configRemove(provider));

program
  .command("status")
  .description("show which providers are ready to use")
  .action(async () => configList());

const config = program.command("config").description("manage API keys (stored in your user config directory)");
config
  .command("set <provider> [key]")
  .description("save an API key; omit [key] to paste it without it landing in shell history")
  .action(async (provider: string, key: string | undefined) => configSet(provider, key));
config
  .command("list")
  .description("show which providers are ready to use (same as `promptdiff status`)")
  .action(async () => configList());
config
  .command("remove <provider>")
  .alias("rm")
  .description("delete a saved API key")
  .action(async (provider: string) => configRemove(provider));

program
  .command("init")
  .description("create a sample promptdiff.config.yaml and cases.jsonl in the current directory")
  .option("-f, --force", "overwrite existing files")
  .action(async (opts: { force?: boolean }) => initCommand(opts));

try {
  await program.parseAsync(process.argv);
} catch (err) {
  process.stderr.write(formatError(err, chalkStderr, !!process.env.PROMPTDIFF_DEBUG) + "\n");
  process.exitCode = EXIT_ERROR;
}
