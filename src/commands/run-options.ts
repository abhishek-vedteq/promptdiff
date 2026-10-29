import { Command, Option } from "commander";

/** Adds the run flags to a command. Shared by the CLI and the interactive app's /run. */
export function addRunOptions(cmd: Command): Command {
  return cmd
    .option("-b, --base <ref>", "git ref for the old prompt (default: HEAD, or `base` in config)")
    .option("--head <ref>", "git ref for the new prompt (default: the working copy)")
    .option("-m, --model <provider:model>", "model to run, e.g. anthropic:claude-opus-5-5 or claude-code:default (default: auto-detected)")
    .option("--vs <provider:model>", "compare two models instead of two prompt versions: --model (A) vs this model (B), same prompt")
    .option("--snapshot", "compare with the approved outputs (from --approve) instead of the old prompt; catches model drift")
    .option("--approve", "save this run's new outputs as the approved ones (in promptdiff-snapshots/, commit them)")
    .option("-c, --cases <file>", "JSONL test cases (default: cases.jsonl)")
    .option("-t, --temperature <n>", "sampling temperature (default: provider default)")
    .option("--max-tokens <n>", "max output tokens per call")
    .option("-r, --runs <n>", "runs per case per version, to measure randomness (default: 1)")
    .option("--concurrency <n>", "parallel API calls (default: 4)")
    .option("--no-cache", "ignore and don't write the local result cache")
    .option("--json", "print machine-readable JSON instead of the terminal report")
    .option("--html <file>", "also write a self-contained HTML report")
    .option("--markdown <file>", "also write a Markdown report (use - for stdout)")
    .option("--github-comment", "post the Markdown report as a PR comment, updating it on re-runs")
    .option("--pr <number>", "pull request number for --github-comment (default: from the GitHub Actions event)")
    .option("--fail-on-change", "exit with code 2 if any case changed (for CI)")
    .option("--fail-on-regression", "exit with code 2 if the new prompt fails checks the old one passed")
    .option("--fail-on-check", "exit with code 2 if any check fails on the new prompt")
    .option("--compare <mode>", "how to detect changes: words (free) or semantic (LLM judge) (default: words)")
    .option("--judge <provider:model>", "model for llm-rubric checks and semantic comparison (default: --model)")
    .option("--run-code", 'allow test cases to build their message by calling your code ("from"); runs project code')
    .option("--batch", "send calls as one provider batch job: about half price, results can take minutes to hours")
    .option("--max-cost <usd>", "refuse to start, or stop, if the run would cost more than this")
    .option("--dry-run", "show how many calls and how much the run would cost, then exit")
    .option("-y, --yes", "don't ask for confirmation before expensive runs")
    .option("--config <file>", "path to config file (default: promptdiff.config.yaml)")
    .option("--verbose", "show diffs for 'noise' cases too")
    .addOption(new Option("--no-color", "disable colors"));
}
