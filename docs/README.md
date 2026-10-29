# promptdiff documentation

- [Getting started](./getting-started.md): install, set up a key, run your first diff
- [Logging in](./api-keys.md): API keys, browser login, using your Claude Code or Codex login, and environment variables
- [Prompts in code](./prompts-in-code.md): comparing prompts stored as constants in TypeScript, JavaScript, or Python
- [Test cases](./test-cases.md): the `cases.jsonl` format
- [Assertions](./assertions.md): checks like `contains`, `is-json`, `max-words`, and `llm-rubric`
- [LLM judge](./llm-judge.md): rubric grading and comparing outputs by meaning
- [Cost controls](./cost-controls.md): estimates, confirmation, and `--max-cost` budgets
- [Models & providers](./models.md): every provider, `--vs` model comparisons, and batch mode
- [Snapshots & bisect](./snapshots-and-bisect.md): approved answers, model drift, and finding the commit that broke a check
- [Interactive app](./interactive.md): what `promptdiff` on its own opens, and its keys
- [Commands and flags](./commands.md): every command, flag, and exit code
- [Configuration](./configuration.md): `promptdiff.config.yaml` reference
- [How it works](./how-it-works.md): noise detection, caching, retries, cost estimates
- [CI usage](./ci.md): running promptdiff in GitHub Actions and other CI systems
- [Using as a library](./library.md): calling promptdiff from TypeScript
