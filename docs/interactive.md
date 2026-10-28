# Interactive app

Run `promptdiff` with no arguments in a terminal to open the app. It takes over the terminal window (like `vim` or `htop`), and puts everything back when you quit.

Every key you can press is always listed in the bar at the bottom, and **?** explains how promptdiff works.

## First launch: setup

If anything is missing, the app opens on a checklist instead:

```
 Let's get you set up  1 of 4 done
 › ○ 1. A git repository
      this folder isn't one yet. promptdiff gets the old version of a prompt from git.
      enter to run `git init` here
   ✓ 2. A model to run prompts
      claude-code:default (found your Claude Code login)
   ○ 3. Test cases
      none yet. Test cases are example messages your users send, saved in cases.jsonl.
   ○ 4. A prompt file, committed to git
      none yet. A prompt file is your system prompt saved as .md or .txt, e.g. prompts/support.md.
```

Press **Enter** on a step to do it:

| Step | What Enter does |
| --- | --- |
| A git repository | Runs `git init` in this folder |
| A model | Switches to a model that's ready (e.g. your Claude Code login), or lets you choose or log in |
| Test cases | Creates `cases.jsonl` with example cases, and `promptdiff.config.yaml` set to your model |
| A prompt file | Creates `prompts/support.md` (a sample support-bot prompt) and commits just that file |

When all four are done, you land on the prompts screen.

## The screens

There are three screens.

## 1. Prompts

```
 ± promptdiff   ~/code/support-bot · main                          claude-code:default
 ─────────────────────────────────────────────────────────────────────────────────────

 Prompt files  1 changed since HEAD
 › ● prompts/support.md     +1 −1
   ○ prompts/sales.md       unchanged

 Compare with  HEAD (b to change)
 Test cases    6 in cases.jsonl
 Model         claude-code:default ✓ ready · found your Claude Code login
 Settings      1 run per case (r)   compared by words (s)

 ─────────────────────────────────────────────────────────────────────────────────────
 enter compare  ↑↓ select  m model  b base  r runs  s semantic  p cost  l log in  q quit
```

- Changed prompt files (●) are listed first, with lines added and removed. Edits you save in your editor show up within a couple of seconds, without restarting.
- A **Next step** box always says what to do now: edit a prompt and save it, or press Enter to compare (with how many calls that makes).

| Key | Action |
| --- | --- |
| ↑ ↓ | Select a prompt file |
| Enter | Compare the selected file with the version in **Compare with** |
| m | Choose a model from the ones that are set up |
| b | Compare with another branch, tag, or commit (e.g. `main`, `HEAD~3`) |
| r | Runs per test case: 1 → 3 → 5. More runs tell real changes from randomness. |
| s | Compare by words (free) or by meaning (an LLM judge decides) |
| p | Show the number of calls and estimated cost, without running |
| v / o | View the last results again, or open the full HTML report in your browser |
| l | Log in: paste an API key, sign in with your browser, or use Claude Code / Codex |
| ? | How promptdiff works, and what the results mean |
| q | Quit |

## 2. Running

A progress bar shows how many calls are done. If the run is expensive, you're asked to confirm first. Press **Esc** to stop: finished results are saved, so comparing again picks up where it stopped.

## 3. Results

```
 prompts/support.md  HEAD → working copy                1 changed · 0 noise · 5 same
 output tokens −34% · latency −40% · cost n/a

 › CHANGED refund          │ input: Can I get a refund for a double charge?
   SAME    password-reset  │
   SAME    off-topic       │ − before (HEAD)
                           │ Yes, double charges are usually refundable, so please
                           │ contact the merchant's billing support…
                           │
                           │ + after (working copy)
                           │ Yes, could you share your order number so I can look…
```

Test cases are on the left; the selected one's before and after are on the right, with the changed words highlighted. Wide terminals show before and after side by side.

| Key | Action |
| --- | --- |
| ↑ ↓ | Select a test case |
| j k (or PgUp/PgDn) | Scroll a long case |
| o | Open the full HTML report in your browser |
| c | Compare again |
| Esc | Back to the prompts screen |

## Settings

Changes made in the app (model, base, runs, compare mode) last until you quit. To keep them, set them in [`promptdiff.config.yaml`](./configuration.md). The app also accepts the usual flags as starting values, e.g. `promptdiff --base main --runs 3`.

## Scripts and CI

The app only opens when you run `promptdiff` with no file in a terminal. `promptdiff <file> [flags]` runs once and prints a report, exactly as before.

## Symbols look wrong?

promptdiff draws symbols like `±` and `│` when your terminal supports them, and falls back to plain text (`+-`, `|`) on old Windows consoles. If it guesses wrong, set `PROMPTDIFF_UNICODE=1` (or `0`).
