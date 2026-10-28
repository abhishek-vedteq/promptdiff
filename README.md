<div align="center">

# promptdiff

**`git diff` for prompts.**

See what your prompt change *actually* did before you ship it.

[![npm](https://img.shields.io/npm/v/promptdiff.svg)](https://www.npmjs.com/package/promptdiff)
[![CI](https://github.com/abhishek-vedteq/promptdiff/actions/workflows/ci.yml/badge.svg)](https://github.com/abhishek-vedteq/promptdiff/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

</div>

---

You changed one sentence in your system prompt. Did the bot get better? Did it break the refund flow? Did responses get 40% longer and more expensive?

You usually find out in production.

**promptdiff** runs your test cases through the old and new versions of a prompt and shows you, case by case, how the outputs changed, along with the change in tokens, latency, and cost.

```
$ promptdiff prompts/support.md --base main --runs 3

CHANGED refund-no-order  You billed me twice this month. Fix it.
  base (main) · run 1                         │ head (working copy) · run 1
  I'm sorry about the double charge. Refunds  │ I'm sorry about the double charge. Could you
  take 5 business days.                       │ share your order number so I can start the refund?
  output tokens 18 → 24 (+33.3%) · latency 1.10s → 1.31s (+19.1%) · cost $0.00052 → $0.00064 (+23.1%)

NOISE   angry  This is the third time I'm writing. Your product deleted my data!!

SAME    off-topic  What's a good recipe for banana bread?

Summary
  1 changed · 1 noise · 4 identical   (6 cases × 3 runs × 2 versions, anthropic:claude-opus-5-5)
```

## Why promptdiff

**Prompts are code. Treat them that way.** Your prompts already live in git, so promptdiff compares them the way you compare code: against a branch, a tag, or a commit. They can be text files, or constants in your TypeScript, JavaScript, or Python code (`email.prompt.ts#SYSTEM_PROMPT`, `prompts.py#SYSTEM_PROMPT`): promptdiff follows the imports and builds the exact text, without running your code.

**Real changes, not randomness.** LLMs rarely give the same answer twice. Run each case a few times, or let an LLM judge compare outputs by meaning, and promptdiff tells you whether a difference is a real change or just rewording. Every case is labeled **changed**, **noise**, or **identical**.

**Catch regressions, not just differences.** Add checks to your test cases, like "contains the refund window", "valid JSON matching this schema", "under 80 words", or a plain-English rubric graded by a judge model. promptdiff flags every case where the new prompt fails a check the old one passed.

**Know the cost before you ship, and before you run.** Every diff shows how output tokens, latency, and cost moved, so a "small wording tweak" that doubles your bill doesn't go unnoticed. promptdiff also estimates each run's cost up front, and enforces a budget if you set one.

**Cheap to run again.** Results are cached locally. Run the comparison as often as you like, and only pay for outputs you haven't generated before.

**Works with the account you already have.** Already logged in to Claude Code or the Codex CLI? promptdiff finds it and runs your prompts through it, with no setup. Or use an Anthropic, OpenAI, or Google Gemini API key, or sign in to Anthropic with your browser. Any model id your provider offers works.

**Built for pull requests.** Add one step to your pipeline and every pull request that touches a prompt gets a comment with the results, updated on every push. Use `--fail-on-regression` to block changes that break your checks.

## Get started in a minute

```bash
npm install -g promptdiff

cd your-repo
promptdiff init     # sample config + test cases
promptdiff login    # API key, browser sign-in, or your Claude Code / Codex login

# edit a prompt, then just:
promptdiff
```

`promptdiff` on its own opens an interactive app: your prompt files (changed ones first), a single key to compare, and a results screen showing each test case's before and after. For scripts and CI, `promptdiff prompts/support.md --base main` runs once and exits.

Already using Claude Code or Codex? Skip `login`: promptdiff picks up your login automatically. Want to look around first? `--model mock:echo` runs fully offline.

Requires Node.js 22+ and git. Works on macOS, Linux, and Windows.

## Features

- A keyboard-driven app (`promptdiff`) for browsing prompts and results, plus one-shot commands for scripts and CI
- Colored, word-level diffs, side by side in your terminal
- Noise detection across multiple runs (`--runs 3`), or by meaning with an LLM judge (`--compare semantic`)
- Checks: `contains`, regex, JSON Schema, length limits, and plain-English rubrics
- Prompts in text files or in code: reads constants from TypeScript, JavaScript, and Python, following imports, packages, and path aliases
- Prompt templates with `{{variables}}`, and multi-turn conversation test cases
- Cost estimate before every run, `--dry-run`, and `--max-cost` budgets
- Changes in tokens, latency, and cost per case and overall
- Anthropic, OpenAI, and Google Gemini through the Vercel AI SDK, or your installed Claude Code / Codex CLI
- Guided `promptdiff login`: paste a key (checked before saving), sign in with your browser, or use an existing CLI login
- Local result cache, so re-runs are free
- Terminal, JSON, Markdown, and self-contained HTML reports
- PR comments that update in place (`--github-comment`)
- Parallel calls with automatic retries on rate limits and network errors, a live progress spinner, and graceful Ctrl+C
- API keys stored privately (or read from environment variables in CI), and never printed
- CI exit codes with `--fail-on-change`, `--fail-on-regression`, and `--fail-on-check`

## Documentation

| | |
| --- | --- |
| [Getting started](./docs/getting-started.md) | Install, set up, and run your first diff |
| [Logging in](./docs/api-keys.md) | API keys, browser login, your Claude Code / Codex login, CI variables |
| [Prompts in code](./docs/prompts-in-code.md) | Comparing prompts stored in TypeScript, JavaScript, or Python |
| [Test cases](./docs/test-cases.md) | The `cases.jsonl` format, templates, and conversations |
| [Assertions](./docs/assertions.md) | Checks that every output must pass |
| [LLM judge](./docs/llm-judge.md) | Rubric grading and comparing outputs by meaning |
| [Cost controls](./docs/cost-controls.md) | Estimates, confirmation, and budgets |
| [Interactive app](./docs/interactive.md) | The three screens and their keys |
| [Commands and flags](./docs/commands.md) | Full CLI reference and exit codes |
| [Configuration](./docs/configuration.md) | `promptdiff.config.yaml` reference |
| [How it works](./docs/how-it-works.md) | Noise detection, caching, retries, and cost estimates |
| [CI usage](./docs/ci.md) | GitHub Actions, PR comments, and CI tips |
| [Using as a library](./docs/library.md) | Calling promptdiff from TypeScript, and custom providers |

## Contributing

Issues and pull requests are welcome, especially new providers. See [CONTRIBUTING.md](./CONTRIBUTING.md) to get set up. The test suite runs offline with no API keys.

## License

[MIT](./LICENSE)
