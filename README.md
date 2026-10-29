<div align="center">

# ± promptdiff

**`git diff` for prompts.**

See how editing a prompt changes your model's answers, before you ship it.

[![npm](https://img.shields.io/npm/v/promptdiff.svg)](https://www.npmjs.com/package/promptdiff)
[![CI](https://github.com/abhishek-vedteq/promptdiff/actions/workflows/ci.yml/badge.svg)](https://github.com/abhishek-vedteq/promptdiff/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
![Node 22+](https://img.shields.io/badge/node-22%2B-339933)

<img src="https://raw.githubusercontent.com/abhishek-vedteq/promptdiff/main/docs/demo.gif" alt="promptdiff: the changed prompt is selected, Enter runs the test cases through the old and new versions, and the results show each answer before and after" width="820">

</div>

---

You changed one sentence in your system prompt. Did the bot get better? Did it stop asking for the order number? Did its answers get 40% longer, and your bill with them?

Usually you find out in production. **promptdiff tells you before you merge.** It runs your test cases through the old version of the prompt (from git) and your new one, then shows you, case by case, exactly how the answers changed.

```bash
npm install -g promptdiff
cd your-project
promptdiff
```

## Why promptdiff

**It works with the prompts you already have.** Your prompts can be text files, or constants in TypeScript, JavaScript, Python, or YAML/JSON. promptdiff follows imports and builds the exact text the model sees, without running your code. On real production codebases, every prompt it read matched what the code produces at runtime, byte for byte.

**It tells real changes from randomness.** Models rarely give the same answer twice. promptdiff runs cases more than once, or asks an LLM judge to compare meaning, and labels each case **changed**, **noise**, or **same**. You review what actually changed.

**It catches regressions, not just differences.** Write down what a good answer must do, like "asks for the order number", "valid JSON matching this schema", or "under 80 words". promptdiff flags every case where the new prompt fails something the old one passed.

**You know the cost before you spend it.** Each run shows its estimated cost first, enforces a budget if you set one, and caches every answer, so running it again is free. Every diff shows the change in tokens, latency, and cost.

**It fits how you work.** It has a keyboard-driven terminal app for exploring, one-line commands for scripts, and a GitHub Action that comments on every pull request that touches a prompt.

## Quick start

```bash
npm install -g promptdiff        # or run it without installing: npx promptdiff
cd your-project
promptdiff
```

On first launch, promptdiff checks what it needs and offers to fix each missing piece with Enter:

1. **A git repository**, because the old version of a prompt comes from git history.
2. **A model.** It finds your Claude Code or Codex login automatically, or you can log in with an API key or your browser.
3. **Test cases**: example messages your users send. promptdiff can write a first set from your prompt for you to review.
4. **A prompt**, found automatically in your project.

Then edit a prompt, save, and press **Enter**.

> Requires Node.js 22+ and git. Works on macOS, Linux, and Windows.

## What it looks like

**In the terminal app**, changed prompts are listed first. Enter compares one, and the results show each test case's answer before and after, with the changed words highlighted. JSON answers are compared field by field:

```
JSON: 2 fields changed
~ confidence: 0.9 → 0.6
+ escalate: true
```

**In a pull request**, the GitHub Action posts one comment per prompt and updates it on every push:

> 🔴 **1 regression**: the new prompt fails checks the old one passed.
>
> | Changed | Noise | Identical | Checks (base → head) |
> | ---: | ---: | ---: | :---: |
> | 2 | 1 | 9 | 24/24 → 23/24 |

**In CI logs, scripts, and reports**, you get plain text, JSON (`--json`), Markdown (`--markdown`), or a self-contained HTML report (`--html`).

## Works with your stack

| | Supported |
| --- | --- |
| **Prompts in** | Text files (`.md`, `.txt`, `.prompt`, `.jinja`…), TypeScript and JavaScript constants (`file.ts#SYSTEM_PROMPT`), Python (`prompts.py#SYSTEM_PROMPT`, `#Class.ATTR`), YAML/JSON (`prompts.yaml#support.system`) |
| **Models** | Anthropic, OpenAI, Google Gemini, Azure OpenAI, AWS Bedrock, Ollama (local and free), or your existing **Claude Code** / **Codex** login. Any model id your provider offers works. |
| **Test cases** | One message per line, multi-turn conversations, `{{template}}` variables, or messages built by calling your own code (opt-in) |
| **CI** | GitHub Action with PR comments, exit codes for any CI, JSON output |

## Everyday commands

```bash
promptdiff                                        # the interactive app
promptdiff prompts/support.md --base main         # compare once, print a report
promptdiff src/email.prompt.ts#SYSTEM_PROMPT      # a prompt that lives in code

promptdiff cases generate prompts/support.md      # draft test cases from a prompt
promptdiff prompts/support.md --runs 3            # tell real changes from randomness
promptdiff prompts/support.md --compare semantic  # let an LLM judge compare meaning
promptdiff prompts/support.md --vs openai:gpt-4o  # same prompt, two models
promptdiff prompts/support.md --approve           # save today's answers as approved…
promptdiff prompts/support.md --snapshot          # …and later check against them (model drift)
promptdiff bisect prompts/support.md --good v1.2  # find the commit that broke a check
promptdiff prompts/support.md --batch             # half price via provider batch APIs
promptdiff prompts/support.md --dry-run           # see the calls and cost, run nothing
```

[All commands and flags →](./docs/commands.md)

## In CI

```yaml
# .github/workflows/prompts.yml
on:
  pull_request:
    paths: ["prompts/**", "src/**/*.prompt.ts"]
permissions:
  contents: read
  pull-requests: write
jobs:
  promptdiff:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: abhishek-vedteq/promptdiff@v1
        with:
          prompt: prompts/support.md
          fail-on: regression
          max-cost: "2"
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

[GitHub Action and CI guide →](./docs/ci.md)

## Common questions

**Does promptdiff run my code?**
No. It reads prompts from your source by parsing the files, without executing anything. You don't need your project's dependencies or `.env`. The one exception is opt-in: test cases that build their message by calling your own function only run with `--run-code`.

**What does it cost?**
Each comparison costs about two model calls per test case: one for the old prompt and one for the new. Before anything runs, you see an estimate, and promptdiff asks first if it's above $1. `--max-cost` sets a hard budget. Answers are cached, so comparing the same thing again is free, and `--batch` halves the price on supported providers. With Ollama it's free.

**Where do my API keys go?**
They stay in your user config file, readable only by you, or in environment variables for CI. They're never printed or logged. With `claude-code:` or `codex:`, promptdiff uses those tools' own login and never reads their credentials.

**How is this different from an eval platform?**
promptdiff is a diff tool, not a platform: no account, no dashboard, no data leaving your machine except the model calls themselves. It answers one question well: what did *this* prompt change do? It's built around git, so it fits code review.

## Documentation

| Getting started | Your prompts and tests | Running comparisons | Automation |
| --- | --- | --- | --- |
| [Getting started](./docs/getting-started.md) | [Prompts in code](./docs/prompts-in-code.md) | [How it works](./docs/how-it-works.md) | [CI & GitHub Action](./docs/ci.md) |
| [Logging in](./docs/api-keys.md) | [Test cases](./docs/test-cases.md) | [Models & providers](./docs/models.md) | [Commands & flags](./docs/commands.md) |
| [Interactive app](./docs/interactive.md) | [Checks (assertions)](./docs/assertions.md) | [LLM judge](./docs/llm-judge.md) | [Configuration](./docs/configuration.md) |
| | [Snapshots & bisect](./docs/snapshots-and-bisect.md) | [Cost controls](./docs/cost-controls.md) | [Library API](./docs/library.md) |

## Contributing

Issues and pull requests are welcome, especially new providers and prompt formats. The test suite runs offline with no API keys. See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

[MIT](./LICENSE)
