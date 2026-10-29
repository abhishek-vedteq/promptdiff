# Commands and flags

## `promptdiff`

With no file, in a terminal, opens the [interactive app](./interactive.md).

## `promptdiff [run] <file>`

Compares `<file>` at a git ref against the working copy. `run` is the default command, so `promptdiff <file>` and `promptdiff run <file>` do the same thing.

`<file>` is a prompt file (e.g. `prompts/support.md`), or a constant in a code file: `src/prompts/email.prompt.ts#EMAIL_SYSTEM_PROMPT`, `app/prompts.py#SYSTEM_PROMPT`, or `app/prompts.py#Prompts.SUPPORT`. See [Prompts in code](./prompts-in-code.md).

| Flag                           | Description                                                                 | Default                  |
| ------------------------------ | --------------------------------------------------------------------------- | ------------------------ |
| `-b, --base <ref>`             | Git ref (branch, tag, or commit) for the old prompt.                        | `HEAD`                   |
| `--head <ref>`                 | Git ref for the new prompt.                                                 | working copy             |
| `-m, --model <provider:model>` | Model to use, e.g. `anthropic:claude-opus-5-5`, `openai:<model-id>`, `claude-code:default`, or `codex:default`. The model id is passed through unchanged. | from config, or auto-detected |
| `-c, --cases <file>`           | JSONL test cases.                                                           | `cases.jsonl`            |
| `-t, --temperature <n>`        | Sampling temperature, 0–2.                                                  | provider default         |
| `--max-tokens <n>`             | Max output tokens per call.                                                 | provider default         |
| `-r, --runs <n>`               | Runs per case per version.                                                  | `1`                      |
| `--concurrency <n>`            | Max parallel API calls.                                                     | `4`                      |
| `--no-cache`                   | Skip the result cache (don't read from it or write to it).                  |                          |
| `--vs <provider:model>`       | Compare two models on the same prompt instead of two prompt versions. See [Models](./models.md#comparing-two-models). | |
| `--approve`                    | Save this run's new answers as the approved ones (`promptdiff-snapshots/`). | |
| `--snapshot`                   | Compare with the approved answers instead of the old prompt. See [Snapshots](./snapshots-and-bisect.md). | |
| `--batch`                      | Send calls as one provider batch job: about half price, results take longer. See [Models](./models.md#batch-mode). | |
| `--run-code`                   | Allow test cases to build their message by calling your code (`from`). | |
| `--compare <mode>`             | `words` (free, word overlap) or `semantic` (an LLM judge compares meaning). See [LLM judge](./llm-judge.md). | `words` |
| `--judge <provider:model>`     | Model for `llm-rubric` checks and semantic comparison.                     | `--model`                |
| `--max-cost <usd>`             | Refuse to start if the estimate is higher, and stop once actual spend reaches it. See [Cost controls](./cost-controls.md). | |
| `--dry-run`                    | Print the call count and cost estimate, then exit without calling any model. |                        |
| `-y, --yes`                    | Don't ask for confirmation before expensive runs.                           |                          |
| `--json`                       | Print machine-readable JSON to stdout instead of the terminal report.       |                          |
| `--html <file>`                | Also write a self-contained HTML report with side-by-side diffs.            |                          |
| `--markdown <file>`            | Also write a GitHub-flavored Markdown report. Use `-` to print it to stdout instead of the terminal report. | |
| `--github-comment`             | Post the Markdown report as a PR comment, updating the same comment on re-runs. See [CI usage](./ci.md). | |
| `--pr <number>`                | Pull request for `--github-comment`.                                        | from the Actions event   |
| `--fail-on-change`             | Exit with code 2 if any case is `changed`.                                  |                          |
| `--fail-on-regression`         | Exit with code 2 if the new prompt fails checks the old prompt passed.      |                          |
| `--fail-on-check`              | Exit with code 2 if any check fails on the new prompt.                      |                          |
| `--config <file>`              | Path to the project config file.                                            | `promptdiff.config.yaml` |
| `--verbose`                    | Also show diffs for `noise` cases.                                          |                          |
| `--no-color`                   | Disable colors. `NO_COLOR` and `FORCE_COLOR` are also respected.            |                          |

Examples:

```bash
promptdiff prompts/support.md --base main
promptdiff prompts/support.md --base main --model openai:<model-id> --runs 3
promptdiff prompts/support.md --base v1.2 --head v1.3 --json > diff.json
promptdiff prompts/support.md --base origin/main --fail-on-change --html report.html
promptdiff prompts/support.md --base main --compare semantic --max-cost 1
promptdiff prompts/support.md --base main --dry-run
promptdiff src/prompts/email.prompt.ts#EMAIL_SYSTEM_PROMPT --base main
```

## `promptdiff cases generate <prompt>`

Has a model draft test cases from a prompt. Options: `-n <count>` (default 12), `-o <file>`, `-m <provider:model>`, `--with-checks`, `--append`, `--force`. See [Test cases](./test-cases.md#writing-test-cases-for-you).

## `promptdiff bisect <prompt> --good <ref>`

Finds the first version of a prompt whose checks fail. Options: `--bad <ref>` (default: working copy), `--case <id...>`, `-m`, `-c <cases file>`. See [Bisect](./snapshots-and-bisect.md#finding-the-change-that-broke-something-bisect).

## `promptdiff login [provider]`

Interactive setup. Without a provider, it shows what's already set up and lets you choose. Providers: `anthropic`, `openai`, `google`, `claude-code`, `codex`. See [Logging in](./api-keys.md).

## `promptdiff status`

Shows which providers are ready to use, and where each one's credentials come from (keys masked).

## `promptdiff logout <provider>`

Removes a key saved by promptdiff. Browser and CLI logins are managed by `ant`, `claude`, and `codex`.

## `promptdiff config`

| Command                            | Description                                                                 |
| ---------------------------------- | --------------------------------------------------------------------------- |
| `config set <provider> [key]`      | Save a key. Without `[key]`, reads it from a hidden prompt or from stdin.   |
| `config list`                      | Same as `promptdiff status`.                                                |
| `config remove <provider>`         | Delete a saved key. Alias: `config rm`.                                     |

See [API keys](./api-keys.md).

## `promptdiff init [--force]`

Creates a sample `promptdiff.config.yaml` and `cases.jsonl` in the current directory, and adds `.promptdiff/` to `.gitignore`. Existing files are left alone unless you pass `--force`.

## Exit codes

| Code | Meaning                                                       |
| ---- | ------------------------------------------------------------- |
| `0`  | Ran successfully.                                             |
| `1`  | Error (bad config, missing key, git error, failed API calls). |
| `2`  | Changes or failed checks, with `--fail-on-change`, `--fail-on-regression`, or `--fail-on-check`. |

## Stopping a run

Press **Ctrl+C** once to stop gracefully: no new calls are started, and finished results stay cached, so running again picks up where you left off. Press it again to quit immediately.
