# Contributing to promptdiff

Thanks for helping out! Bug reports, docs fixes, and new providers are all welcome.

## Setup

Requires Node.js 22+ and git.

```bash
git clone https://github.com/abhishek-vedteq/promptdiff.git
cd promptdiff
npm install
npm test          # vitest, no network or API keys needed
npm run lint      # eslint + tsc --noEmit
npm run build     # tsup -> dist/
node dist/cli.js --help
```

Try the CLI without an API key using the offline mock provider: `--model mock:anything`.

## Project layout

```
src/
  cli.ts              commander setup and error printing
  auth.ts, ant.ts     credential resolution, browser login via Anthropic's ant CLI
  detect.ts           picking a default model from existing logins
  ui/                 theme (colors, boxes, glyphs), error formatting, and the progress spinner
  tui/                the interactive app (Ink): controller.ts (state and actions), App.tsx (screens)
  commands/           run, config, init
  providers/          Provider interface, registry, AI SDK adapter, mock
  config/             user key store, project YAML config, flag precedence
  git.ts              reading files at refs (execFile, never a shell)
  cases.ts            JSONL test-case parsing
  runner.ts           concurrency, retries, caching, per-case results
  analysis.ts         identical / noise / changed classification
  cache.ts            on-disk result cache
  pricing.ts          cost estimates from pricing.json
  report/             terminal, JSON, and HTML output
test/                 vitest tests (mock provider only)
docs/                 user documentation
```

## Adding a provider

1. `npm install @ai-sdk/<provider>`.
2. Add an entry to `definitions` in `src/providers/registry.ts` with an `id`, `envVar`, `keyUrl`, an optional `verifyKey` (a free request that checks the key), and a `create(credential)` that returns `new AiSdkProvider(id, (model) => provider(model))`.
3. Add any known prices to `pricing.json`, and document the env var in `docs/api-keys.md`.

Providers that aren't on the AI SDK just need to implement the `Provider` interface in `src/providers/types.ts`. See `src/providers/cli.ts` for providers that wrap an installed command-line tool (set `kind: "cli"` and `capabilities`).

Never read another tool's stored credentials. Providers that use an existing login must go through that tool's official CLI.

## Guidelines

- Tests must not call real APIs. Use `MockProvider`.
- Never print or log full API keys. Use `maskKey` / `redactSecrets`.
- Run git through `git()` in `src/git.ts` (argument arrays via `execFile`).
- Keep user-facing errors as `PromptdiffError` with a `hint` that says how to fix the problem.

## Releasing (maintainers)

```bash
npm version patch   # or minor / major; creates a vX.Y.Z commit and tag
git push --follow-tags
```

The Release workflow publishes to npm when a `v*` tag is pushed (needs the `NPM_TOKEN` repo secret).
