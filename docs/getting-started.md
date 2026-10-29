# Getting started

## Install

Requires Node.js 22 or newer and git. Works on macOS, Linux, and Windows.

Install straight from GitHub (npm builds it during install):

```bash
npm install -g github:abhishek-vedteq/promptdiff
promptdiff --help
```

Or clone it, if you want to read or change the code:

```bash
git clone https://github.com/abhishek-vedteq/promptdiff.git
cd promptdiff
npm install && npm run build && npm link
```

To update, run the install command again, or `git pull && npm run build` in your clone.

## Set up

```bash
cd your-repo
promptdiff init     # creates promptdiff.config.yaml and cases.jsonl, adds .promptdiff/ to .gitignore
promptdiff login    # paste an API key, sign in with your browser, or use your Claude Code / Codex login
```

Already logged in to Claude Code or the Codex CLI? You can skip `login`: promptdiff finds it automatically. See [Logging in](./api-keys.md).

Then edit `cases.jsonl` so it holds inputs that matter for your prompt. See [Test cases](./test-cases.md).

## Run your first diff

Edit a prompt file that's already committed to git, then run:

```bash
promptdiff
```

This opens the [interactive app](./interactive.md). Your changed prompt is listed first and already selected, so press Enter to compare it with the committed version. Or run a single comparison directly:

```bash
promptdiff prompts/support.md --base main
```

Each case is labeled **changed**, **noise**, or **identical**. Changed cases show a word-level diff of the two outputs, along with the change in output tokens, latency, and cost.

If your model isn't deterministic, run each case several times so promptdiff can tell real changes from randomness:

```bash
promptdiff prompts/support.md --base main --runs 3
```

## Try it without an API key

The offline mock provider echoes the first line of the prompt, so you can see how the tool works before you spend anything:

```bash
promptdiff prompts/support.md --base HEAD --model mock:echo
```

## Next steps

- [Commands and flags](./commands.md)
- [Configuration](./configuration.md)
- [CI usage](./ci.md)
