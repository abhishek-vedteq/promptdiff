# Cost controls

promptdiff estimates what a run will cost *before* it sends anything, and can enforce a budget.

## See the estimate first

```bash
promptdiff prompts/support.md --base main --runs 5 --dry-run
```

```
Plan: 60 calls to anthropic:claude-opus-5-5 (12 cached, 48 new) + 48 judge calls
  ~31,200 input + ~31,200 output tokens (assuming ~500 output tokens per response)
  Estimated cost: ~$0.75 (at most ~$1.20 if every response hits max tokens)
```

The estimate:

- **counts cached results as free.** Only calls that will actually hit the API are counted.
- **estimates input tokens** from prompt and input length (about 4 characters per token).
- **estimates output tokens** from the average of your cached results for that model. With no cache history, it assumes 500 tokens per response, capped at `maxOutputTokens`.
- **includes judge calls**, for `llm-rubric` checks and `--compare semantic`.

It's an estimate, not a quote: tokenizers differ between models, and response lengths vary.

When the terminal is interactive, the plan is printed before every run.

## Confirmation

In an interactive terminal, promptdiff asks before starting a run estimated to cost more than **$1.00**:

```
Continue? [y/N]
```

Change the threshold with `confirmAbove` in the config file. Pass `--yes` to skip the question. In CI (no terminal), it never asks. If the model isn't in the pricing table, it asks before runs of 100 or more API calls.

## Budgets

```bash
promptdiff prompts/support.md --base main --max-cost 2
```

`--max-cost <usd>` (or `maxCost` in the config file) protects you twice:

1. **Before the run:** if the estimate is over the budget, promptdiff refuses to start and sends nothing.
2. **During the run:** promptdiff tracks actual spend from real token usage. Once spend reaches the budget, it stops starting new calls and exits with an error. Calls that were already in flight still finish, so actual spend can go slightly over.

Completed results are cached, so after raising the budget, a re-run only pays for the calls that didn't finish.

A budget can only be enforced for models with prices, so `--max-cost` is an error for a model that isn't in the [pricing table](./how-it-works.md#cost-estimates).

## Other ways to spend less

- Set `maxOutputTokens` to cap response length.
- Use `--runs 1` while iterating, then `--runs 3` before merging.
- Use `--compare words` (the default, free) day to day, and `--compare semantic` when you need it.
- Use a cheaper `judge` model than the model under test.
