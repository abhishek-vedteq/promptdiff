# Snapshots and bisect

## Approved answers (snapshots)

Normally promptdiff compares the old prompt's answers with the new prompt's. With snapshots, you compare the new answers with answers you've **approved**: once, then any time later.

```bash
promptdiff prompts/support.md --approve     # run, then save the new prompt's answers as approved
git add promptdiff-snapshots/ && git commit -m "Approve support answers"

promptdiff prompts/support.md --snapshot    # later: compare today's answers with the approved ones
```

In the app, press **a** on the results screen to approve. To compare against the approved answers, press **b** and type `approved`.

Why use them:

- **Half the calls.** The old prompt doesn't need to run again.
- **Model drift.** With an unchanged prompt, `--snapshot` shows whether the provider's model has started answering differently. Run it on a schedule in CI to find out early.
- **Reviewed answers.** Snapshots are plain JSON in `promptdiff-snapshots/`, committed with your code, so changes to approved answers show up in code review.

If the approved answers came from a different model than the current run, promptdiff says so.

## Finding the change that broke something (bisect)

Answers got worse at some point, and you're not sure which prompt change did it:

```bash
promptdiff bisect prompts/support.md --good v1.2
```

promptdiff binary-searches the commits that changed the prompt (or any file it's built from) between `--good` and your working copy (or `--bad <ref>`). At each step it runs your test cases and checks whether their [checks](./assertions.md) pass:

```
Checking 2 cases (refund, other) with anthropic:claude-opus-5-5.
6 versions changed the prompt between v1.2 and working copy; about 5 checks to go.
  ✓ v1.2 (good)
  ✗ working copy (bad)
  ✓ 3f2a9c1e Polite wording
  ✗ 8b04d2aa Make it brief

First bad version: 8b04d2aa  Make it brief
  ✗ refund: contains "order number" (text not found)
See the change: git show 8b04d2aa
```

- **It needs checks.** Checks are how promptdiff tells good from bad, so add one that describes what went wrong (an `llm-rubric` check works for anything you can describe).
- **Narrow it down** with `--case <id>` to only run the cases that matter.
- **It's cheap:** with 30 commits, it runs your cases about 7 times instead of 30, and every result is cached.
