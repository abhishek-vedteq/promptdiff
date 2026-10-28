# Logging in

promptdiff can call models in three ways. Pick whichever fits; you can use several.

| Way | Providers | Billing | Best for |
| --- | --- | --- | --- |
| **API key** | `anthropic`, `openai`, `google` | Pay per token on your API account | Everyday use and CI |
| **Browser login** (Anthropic's `ant` CLI) | `anthropic` | Pay per token on your Console account | Not handling keys by hand |
| **Your installed Claude Code or Codex CLI** | `claude-code`, `codex` | Counts against that tool's subscription or plan limits | Trying promptdiff with an account you already have |

The quickest way to set any of them up:

```bash
promptdiff login
```

It shows what's already set up, then walks you through the rest: pasting a key (hidden input, checked against the provider before saving), signing in with your browser, or confirming your Claude Code or Codex login.

To see what's ready at any time:

```bash
promptdiff status
```

```
Providers (keys saved in ~/.config/promptdiff/config.json)
  │ ✓ anthropic    sk-...a1b2 from ANTHROPIC_API_KEY
  │ – openai       not set up
  │ – google       not set up
  │ ✓ claude-code  logged in (claude.ai (max))
  │ ✓ codex        logged in (ChatGPT)
```

## No model configured? promptdiff picks one

If neither `--model` nor `model:` in the config file is set, promptdiff uses the first of these it finds, and tells you which one it picked:

1. Anthropic credentials (key, token, or browser login): `anthropic:claude-opus-5-5`
2. A logged-in Claude Code: `claude-code:default`
3. A logged-in Codex CLI: `codex:default`

OpenAI and Google keys aren't used automatically, because there's no model id to assume. Pass `--model openai:<model-id>` or `--model google:<model-id>`.

## API keys

```bash
promptdiff login openai             # guided: paste, verify, save
promptdiff config set anthropic     # or save directly; prompts for the key with hidden input
cat key.txt | promptdiff config set google   # or pipe it in
promptdiff logout openai            # remove a saved key
```

`promptdiff login` checks a key by listing the provider's models, which costs nothing.

Keys are stored in your user config file, readable only by you (`0600`):

| OS            | Location                                                                          |
| ------------- | --------------------------------------------------------------------------------- |
| macOS / Linux | `~/.config/promptdiff/config.json` (or `$XDG_CONFIG_HOME/promptdiff/config.json`) |
| Windows       | `%APPDATA%\promptdiff\config.json`                                                |

Set `PROMPTDIFF_CONFIG_DIR` to use a different directory.

### Environment variables

Environment variables take precedence over saved keys, so CI only needs secrets:

| Provider  | Environment variable           | `--model` prefix            |
| --------- | ------------------------------ | --------------------------- |
| Anthropic | `ANTHROPIC_API_KEY`            | `anthropic:` (or `claude:`) |
| OpenAI    | `OPENAI_API_KEY`               | `openai:`                   |
| Google    | `GOOGLE_GENERATIVE_AI_API_KEY` | `google:` (or `gemini:`)    |

For Anthropic, an OAuth access token also works: set `ANTHROPIC_AUTH_TOKEN` instead of `ANTHROPIC_API_KEY`.

### Order of precedence (Anthropic)

1. `ANTHROPIC_API_KEY`
2. `ANTHROPIC_AUTH_TOKEN`
3. a key saved with `promptdiff login` / `config set`
4. a browser login made with `ant auth login`

## Browser login (Anthropic)

```bash
promptdiff login anthropic    # then choose "Sign in with your browser"
```

This uses Anthropic's official [`ant` CLI](https://github.com/anthropics/anthropic-cli), which opens your browser, signs you in to the Claude Console, and stores a short-lived token. Whenever promptdiff needs a token, it asks `ant` for a current one, so it never stores or reads `ant`'s files itself. Usage is billed to the Console workspace you picked, like an API key.

Install `ant` first:

```bash
brew install anthropics/tap/ant                                   # macOS
go install github.com/anthropics/anthropic-cli/v2/cmd/ant@latest  # anywhere with Go
```

Builds for other platforms are on the [releases page](https://github.com/anthropics/anthropic-cli/releases). To sign out, run `ant auth logout`.

## Using your Claude Code or Codex login

If you already use Claude Code or the Codex CLI, promptdiff can run prompts through them:

```bash
promptdiff prompts/support.md --base main --model claude-code:default
promptdiff prompts/support.md --base main --model codex:default
promptdiff prompts/support.md --base main --model claude-code:claude-sonnet-5-5   # pick a model
```

`default` means "whatever that CLI is set to use". Any other model id is passed to the CLI's `--model` / `-m` flag.

**How it works.** promptdiff runs the official command (`claude -p` or `codex exec`) for each call, with your prompt as the system prompt and the test case on stdin. It **never reads either tool's credentials**: the CLI uses its own login. To keep results about your prompt, each call runs in an empty temporary directory, with:

- **Claude Code:** tools, MCP servers, settings, hooks, slash commands, and session history turned off; your prompt replaces Claude Code's system prompt.
- **Codex:** a read-only sandbox, no saved session, and your prompt replacing Codex's built-in instructions.

**Limitations:**

- **Single-turn cases only.** Cases with `messages` are rejected before anything runs.
- **No temperature or max tokens.** These settings are ignored, with a warning.
- **Tokens include overhead.** The CLIs add their own context to each call (Codex adds a lot), so token counts are higher than a direct API call, and cost shows as unknown.
- **Slower.** Each call starts a CLI process. Keep `--concurrency` low (2–4) so you don't hit your plan's rate limits.
- **Usage limits.** Calls count against your Claude or ChatGPT plan's usage limits.
- **Personal use.** Use API keys in CI, not a personal subscription.
- **Windows:** install Claude Code with the native installer, since an npm-installed `claude.cmd` can't receive multi-line prompts. Prompts over 30,000 characters don't fit on the Windows command line.

> promptdiff doesn't offer "Sign in with Claude.ai / ChatGPT" itself, and it never reuses the subscription tokens those tools store. Anthropic doesn't allow third-party tools to use Claude.ai subscription logins, so running the official CLI you're already logged into is the supported way to use that account.

## Safety

promptdiff never prints a full API key or token. Keys are masked in `status` and `config list`, and keys and tokens are redacted from error messages. If credentials are missing, the error message lists every way to set them up.
