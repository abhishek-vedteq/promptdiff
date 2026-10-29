# How it works

For each test case, promptdiff:

1. Reads the old prompt with `git show <base>:<file>`, and the new prompt from the working copy (or `git show <head>:<file>`).
2. Sends each prompt as the **system prompt**, with the case's `input` as the **user message**, `--runs` times per version.
3. Compares the outputs, labels the case, and reports the change in tokens, latency, and cost.

## Identical, noise, or changed?

LLM outputs vary from run to run, so a different output doesn't necessarily mean your prompt change caused it. Each case gets one of these labels:

- **identical**: every output from both versions is the same text (ignoring leading and trailing whitespace).
- **noise**: the outputs differ, but the two versions differ no more than runs of the *same* version differ from each other.
- **changed**: the versions differ by more than the natural variation.

promptdiff measures a word-level distance between two outputs: 0 means the same words, 1 means nothing in common. It then compares:

- **within**: the average distance between runs of the same version
- **between**: the average distance between base runs and head runs

A case is **changed** when `between > 1.5 × within + 0.05`. Otherwise it's **noise**.

With `--runs 1` there's no way to measure variation, so any difference counts as **changed**. Use `--runs 3` or more when your model isn't deterministic. The terminal and HTML reports show the within and between distances for each case.

## JSON answers

When both answers are JSON (plain, or in a single ```` ```json ```` block), promptdiff compares them **field by field** instead of word by word:

```
JSON: 2 fields changed
~ confidence: 0.9 → 0.6
+ escalate: true
```

Distance is the share of fields that differ, so reordered keys or different whitespace count as identical, and the noise detection above works on fields.

## Caching

Results are cached in `.promptdiff/cache/` at the repo root. The cache key is a SHA-256 hash of the prompt, model, temperature, max tokens, input, and run index. That means:

- Re-running the same comparison costs nothing.
- After you edit a prompt, only the new version is called again. The base version comes from the cache.
- Changing `--runs` from 3 to 5 only makes the calls for runs 4 and 5.

Use `--no-cache` to force fresh calls, or delete `.promptdiff/` to clear the cache. `promptdiff init` adds `.promptdiff/` to `.gitignore`.

## Concurrency and retries

Calls run in parallel, up to `--concurrency` (default 4) at a time. These failures are retried up to 5 times with exponential backoff and jitter:

- rate limits (429)
- overloaded or server errors (5xx)
- timeouts (408) and conflicts (409)
- network errors

If the provider sends a `retry-after` header, promptdiff waits that long before retrying. An invalid key (401/403) or unknown model (404) would fail every call, so promptdiff stops the run right away and tells you how to fix it. Other calls that still fail after retrying are shown as **error** cases, and the command exits with code 1.

## Cost estimates

promptdiff ships a small pricing table, [`pricing.json`](../pricing.json), in USD per million input and output tokens. To add models or override prices, create `promptdiff.pricing.json` in your project (or point `pricing:` in the config at another file):

```json
{
  "models": {
    "openai:your-model-id": { "input": 1.25, "output": 10 }
  }
}
```

Keys are `provider:model-id`, exactly as you pass them to `--model`. Your file is merged over the built-in table.

If a model isn't in either table, promptdiff still shows token counts but reports the cost as **unknown** instead of guessing. Prices change, so check your provider's pricing page.

## Output formats

- **Terminal** (default): colored word-level diffs, side by side in wide terminals (100+ columns) and inline otherwise. Without color, removed text appears as `[-like this-]` and added text as `{+like this+}`.
- **`--json`**: the full report on stdout, including every output from every run, token counts, latency, cost, and the noise statistics. Progress and warnings go to stderr, so the JSON stays clean.
- **`--html <file>`**: a single self-contained file (no external requests) with side-by-side diffs, filters for each status, every run, and the prompt diff itself.
