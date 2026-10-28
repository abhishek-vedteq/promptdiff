# LLM judge

Some things can't be checked with string matching: "Is the reply polite?", "Did it ask for the order number?", "Do these two answers say the same thing?" For those, promptdiff can ask a model to judge.

The judge is used for two things:

1. **`llm-rubric` checks**: grade each output against a plain-English rubric.
2. **`--compare semantic`**: decide whether the old and new outputs differ in meaning, rather than just in wording.

## Choosing the judge model

By default, the judge is the same model you're testing. To use a different one, set `judge` in the config file or pass `--judge`:

```yaml
model: anthropic:claude-opus-5-5
judge: anthropic:claude-haiku-5-5   # cheaper, and usually enough for grading
```

The judge model can come from a different provider. promptdiff looks up that provider's key the same way it does for the main model.

## `llm-rubric` checks

```jsonl
{"id": "refund-no-order", "input": "You billed me twice. Fix it.", "assert": [{"type": "llm-rubric", "value": "Asks the customer for their order number"}]}
```

The judge sees the conversation, the response, and the rubric, and returns pass or fail with a one-sentence reason. The reason appears next to failed checks in every report. Write rubrics as one specific, checkable statement. "Asks for the order number" works better than "Handles the request well".

## Semantic comparison

```bash
promptdiff prompts/support.md --base main --compare semantic
```

By default, promptdiff decides whether a case changed by measuring word overlap. That's free, but it flags rewording as a change, especially with `--runs 1`.

With `--compare semantic`, every case whose outputs aren't identical is sent to the judge with every sample from both versions. The judge decides whether the new version differs in a way that matters: different facts, actions, or requested information, refusing instead of helping, a different format or language, or a clear change in tone or length. Then:

- **changed** means the judge found a meaningful difference. Its one-sentence summary (for example, "B now asks for the order number before promising a refund") appears in every report.
- **noise** means the outputs differ only in wording.

That's one extra call per non-identical case. Set `compare: semantic` in the config file to make it the default.

If a judge call fails, the case keeps its word-based status, and the report says so.

## Cost and caching

Judge calls are included in the cost estimate, the `--max-cost` budget, and the run summary. They're cached like everything else: the same rubric and response, or the same set of outputs to compare, is never judged twice.

## Trusting the judge

An LLM judge is a model, so it can be wrong. Some ways to keep it honest:

- Prefer deterministic checks (`contains`, `is-json`, …) wherever they can express what you mean.
- Read the judge's reasons on a few cases when you add a new rubric.
- Use a capable judge model for subtle rubrics.
