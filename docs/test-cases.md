# Test cases

Test cases live in a JSONL file (`cases.jsonl` by default), one JSON object per line:

```jsonl
{"id": "refund", "input": "I was charged twice for order #4821. Can I get a refund?"}
{"id": "password-reset", "input": "The password reset email never arrives."}
{"input": "Cases without an id are named after their line number."}
```

| Field      | Required | Description                                                        |
| ---------- | -------- | ------------------------------------------------------------------ |
| `input`    | one of `input` / `messages` | Sent as the user message. The prompt file is the system prompt. |
| `messages` | one of `input` / `messages` | A multi-turn conversation. See below.            |
| `id`       | no       | Name shown in reports. Defaults to `line-<n>`. Must be unique.      |
| `vars`     | no       | Values for `{{placeholders}}` in the prompt. See below.             |
| `assert`   | no       | Checks the output must pass. See [Assertions](./assertions.md).     |
| `metadata` | no       | Any object. Ignored by promptdiff and included in the JSON output.  |

Blank lines are skipped. Unknown fields are errors, so typos like `"asserts"` are caught. Invalid lines are reported with their line number, for example `cases.jsonl:7: invalid JSON (...)`.

## Multi-turn conversations

To test how the prompt handles a conversation, use `messages` instead of `input`:

```jsonl
{"id": "follow-up", "messages": [{"role": "user", "content": "I was charged twice."}, {"role": "assistant", "content": "Sorry about that! What's your order number?"}, {"role": "user", "content": "It's #4821."}]}
```

Roles are `user` and `assistant`. The conversation must start and end with a `user` message; the model's reply to the last message is what gets compared. The earlier assistant turns are fixed, so every version of the prompt sees the same history.

## Prompt templates

If your prompt has placeholders, give each case values with `vars`:

```markdown
<!-- prompts/support.md -->
You are the support assistant for {{company}}. The customer's name is {{name}} and they're on the {{plan}} plan.
```

```jsonl
{"id": "pro-refund", "input": "Refund please", "vars": {"name": "Ada", "plan": "Pro"}}
{"id": "free-refund", "input": "Refund please", "vars": {"name": "Bo", "plan": "Free"}}
```

Shared values can go in the config file, and a case's own `vars` override them:

```yaml
vars:
  company: Acme Cloud Storage
```

- Placeholders look like `{{name}}` or `{{ name }}`. Names use letters, digits, and underscores.
- Values can be strings, numbers, or booleans.
- Templating is on when the config file or any case defines `vars`. Then every placeholder in both versions of the prompt must have a value, and promptdiff checks this before making any API call.
- If nothing defines `vars`, the prompt is sent exactly as written, braces included.

## Tips for good cases

- Cover the situations your prompt is meant to handle, plus a few edge cases (angry users, off-topic questions, missing information).
- Keep each case small and focused, so a changed output points to one behavior.
- Add a case whenever you fix a bug in the prompt, so the fix can't silently regress.
