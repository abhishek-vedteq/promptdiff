# Models and providers

Choose a model with `--model <provider>:<model-id>`, or `model:` in `promptdiff.config.yaml`. The model id is passed to the provider as-is, so new models work the day they're released.

| Provider | `--model` | Credentials |
| --- | --- | --- |
| Anthropic | `anthropic:claude-opus-5-5` | `ANTHROPIC_API_KEY`, a saved key, or a browser login via Anthropic's `ant` CLI |
| OpenAI | `openai:<model-id>` | `OPENAI_API_KEY` or a saved key |
| Google Gemini | `google:<model-id>` | `GOOGLE_GENERATIVE_AI_API_KEY` or a saved key |
| Azure OpenAI | `azure:<deployment-name>` | `AZURE_API_KEY`, plus `AZURE_RESOURCE_NAME` (or `AZURE_OPENAI_BASE_URL`) |
| AWS Bedrock | `bedrock:<model-id>` | `AWS_REGION`, plus AWS credentials in the environment (`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`) or a Bedrock API key (`AWS_BEARER_TOKEN_BEDROCK`) |
| Ollama (local) | `ollama:<model>` | None. Needs `ollama serve` running; set `OLLAMA_BASE_URL` for another host. Free. |
| Claude Code | `claude-code:default` | Your Claude Code login (see [Logging in](./api-keys.md#using-your-claude-code-or-codex-login)) |
| Codex CLI | `codex:default` | Your Codex login |

`promptdiff status` shows what's ready, including whether Ollama is running and which models it has.

## Comparing two models

To see how a prompt behaves on another model (say, before switching to a cheaper one), use `--vs`:

```bash
promptdiff prompts/support.md --model openai:gpt-4o --vs google:gemini-2.5-flash
```

Both models get the same prompt (your working copy, or `--head <ref>`). Everything else works as usual: the report labels the sides **A** (`--model`) and **B** (`--vs`), and shows how answers, tokens, latency, and cost differ.

## Batch mode

Providers with batch APIs (Anthropic, OpenAI, Google) charge about half for requests that can wait:

```bash
promptdiff prompts/support.md --batch
```

All uncached calls are sent as one batch. Results can take from minutes to a few hours; promptdiff shows the batch's progress while it waits. Each result goes into the cache, so:

- **Stopping is safe:** press Ctrl+C and run the same command later. promptdiff picks up the same batch instead of starting (and paying for) a new one.
- **Failed items** run one by one afterwards.

Batch mode needs the cache, so it can't be combined with `--no-cache`, and it doesn't support `--vs` yet. Judge calls (rubric checks, `--compare semantic`) still run normally.

## Pricing

Cost estimates come from a small built-in table ([`pricing.json`](../pricing.json)), plus your own `promptdiff.pricing.json`. A `provider:*` entry covers every model of a provider (Ollama is `ollama:*` at $0). Models not in either table show token counts with the cost as unknown. See [Cost controls](./cost-controls.md).
