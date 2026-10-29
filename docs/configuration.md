# Configuration

promptdiff reads `promptdiff.config.yaml` from the current directory, or the file passed with `--config`. It's validated on load, and unknown keys are errors.

**Precedence:** CLI flags override config values, and config values override the defaults. Relative paths in the config file are resolved from the config file's directory.

```yaml
model: anthropic:claude-opus-5-5   # <provider>:<model-id>
cases: cases.jsonl                 # JSONL test cases
concurrency: 4                     # parallel API calls (1–64)
runs: 3                            # runs per case per version (1–50)
temperature: 0.7                   # optional, 0–2; omit to use the provider default
maxOutputTokens: 1024              # optional
base: main                         # default --base ref
pricing: promptdiff.pricing.json   # optional extra pricing table
compare: words                     # words (free) or semantic (LLM judge)
judge: anthropic:claude-haiku-5-5  # model for llm-rubric and semantic comparison (default: model)
maxCost: 2.50                      # USD budget per run
confirmAbove: 1.00                 # ask before runs estimated above this (interactive terminals only)
prompts:                           # where your prompts live (see docs/prompts-in-code.md)
  - src/**/*.prompt.ts
  - path: src/email/**/*.prompt.ts
    cases: tests/email.jsonl         # test cases for just these prompts
vars:                              # default template variables
  company: Acme
assert:                            # checks applied to every case
  - type: max-words
    value: 150
```

| Key               | Type    | Default        | Description                                          |
| ----------------- | ------- | -------------- | ---------------------------------------------------- |
| `model`           | string  | (none)         | `<provider>:<model-id>`. Required here or via `--model`. |
| `cases`           | string  | `cases.jsonl`  | Path to the test cases.                              |
| `concurrency`     | integer | `4`            | Max parallel API calls.                              |
| `runs`            | integer | `1`            | Runs per case per version.                           |
| `temperature`     | number  | provider default | Only sent when set.                                |
| `maxOutputTokens` | integer | provider default | Cap on output tokens per call.                     |
| `base`            | string  | `HEAD`         | Default git ref for the old prompt.                  |
| `pricing`         | string  | `promptdiff.pricing.json` if it exists | Extra pricing table.         |
| `compare`         | `words` \| `semantic` | `words` | How to decide whether outputs changed. See [LLM judge](./llm-judge.md). |
| `judge`           | string  | `model`        | `<provider>:<model-id>` for the judge.               |
| `maxCost`         | number  | (none)         | Budget in USD. See [Cost controls](./cost-controls.md). |
| `confirmAbove`    | number  | `1`            | Ask before runs estimated above this many USD.       |
| `prompts`         | array   | auto-detected  | Globs (or `file.ts#NAME`) for the prompts to list. An entry can be `{path, cases}` to give those prompts their own test cases. See [Prompts in code](./prompts-in-code.md). |
| `runCode`         | boolean | `false`        | Allow test cases to call your code (`from`). See [Test cases](./test-cases.md#messages-built-by-your-code). |
| `vars`            | object  | (none)         | Default template variables. See [Test cases](./test-cases.md#prompt-templates). |
| `assert`          | array   | (none)         | Checks applied to every case. See [Assertions](./assertions.md). |

> **Temperature:** some newer models (including recent Anthropic models) reject sampling parameters such as `temperature`. promptdiff only sends `temperature` when you set it.

## Models

The model id after the colon is passed to the provider as-is, so any model your provider offers works, including new releases and fine-tunes. promptdiff doesn't keep a list of model names.

## Pricing table

See [Cost estimates](./how-it-works.md#cost-estimates).
