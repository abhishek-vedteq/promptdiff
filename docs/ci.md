# CI usage

promptdiff reads keys from environment variables, so CI only needs your provider's key stored as a secret. Use `--fail-on-change` to make the job fail (exit code 2) when outputs change, and `--html` to keep a report you can open later.

## GitHub Actions

```yaml
# .github/workflows/prompts.yml
name: Prompt diff
on:
  pull_request:
    paths: ["prompts/**", "cases.jsonl"]

permissions:
  contents: read
  pull-requests: write   # for --github-comment

jobs:
  promptdiff:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0   # promptdiff needs the base branch's history
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: >
          npx promptdiff prompts/support.md
          --base origin/${{ github.base_ref }}
          --runs 3 --max-cost 2
          --github-comment --fail-on-regression
          --html promptdiff-report.html
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: promptdiff-report
          path: promptdiff-report.html
```

`fetch-depth: 0` matters: by default, `actions/checkout` fetches only one commit, so the base ref wouldn't exist.

## PR comments

`--github-comment` posts a Markdown summary on the pull request: a verdict line, counts, token/latency/cost changes, and a collapsible section for each case worth reviewing (regressions first), with a diff, failed checks, and the judge's summary.

- **One comment per prompt file, updated in place.** Pushing new commits edits the existing comment instead of adding another one.
- **It fits GitHub's limits.** If the report would exceed GitHub's comment size limit, the least important cases are left out and the comment says how many. The full results are in the `--html` or `--json` report.
- **It fails fast.** A missing token or PR number is an error before any model is called.
- It needs `GITHUB_TOKEN` (or `GH_TOKEN`), `GITHUB_REPOSITORY`, and a PR number. In a `pull_request` workflow, the PR number is read from the event; elsewhere, pass `--pr <number>`.
- Pull requests from forks get a read-only `GITHUB_TOKEN`, so comments fail there. Use `--markdown` and upload the file instead.

To post comments with another tool, write the Markdown yourself:

```bash
promptdiff prompts/support.md --base main --markdown - > comment.md
gh pr comment 123 --body-file comment.md
```

## Should changes fail the build?

A changed output is often exactly what you wanted. Two common setups:

- **Report only:** leave out `--fail-on-change` and upload the HTML report for reviewers to read.
- **Gate on checks:** use `--fail-on-regression` so the build fails only when the new prompt breaks a check the old one passed. This is the best default for most teams.
- **Gate on any change:** use `--fail-on-change` on prompts that should be stable, such as a classifier whose outputs feed other code.

Add `--max-cost` in CI so a large test set or a long-winded model can't run up an unexpected bill.

## Processing results

Use `--json` to post-process results:

```bash
promptdiff prompts/support.md --base main --json | jq '.cases[] | select(.status == "changed") | .id'
```

## Caching in CI

The cache lives in `.promptdiff/cache/`. To reuse results between CI runs, cache that directory, for example with `actions/cache` keyed on a hash of your prompts and cases.
