# Test cases

Test cases live in a JSONL file (`cases.jsonl` by default), one JSON object per line:

```jsonl
{"id": "refund", "input": "I was charged twice for order #4821. Can I get a refund?"}
{"id": "password-reset", "input": "The password reset email never arrives."}
{"input": "Cases without an id are named after their line number."}
```

| Field      | Required | Description                                                        |
| ---------- | -------- | ------------------------------------------------------------------ |
| `input`    | one of `input` / `messages` / `from` | Sent as the user message. The prompt is the system prompt. |
| `messages` | one of `input` / `messages` / `from` | A multi-turn conversation. See below.     |
| `from`     | one of `input` / `messages` / `from` | Build the message by calling your code (opt-in). See below. |
| `id`       | no       | Name shown in reports. Defaults to `line-<n>`. Must be unique.      |
| `vars`     | no       | Values for `{{placeholders}}` in the prompt. See below.             |
| `assert`   | no       | Checks the output must pass. See [Assertions](./assertions.md).     |
| `metadata` | no       | Any object. Ignored by promptdiff and included in the JSON output.  |

Blank lines are skipped. Unknown fields are errors, so typos like `"asserts"` are caught. Invalid lines are reported with their line number, for example `cases.jsonl:7: invalid JSON (...)`.

## Writing test cases for you

Don't have test cases yet? Let a model draft them from your prompt:

```bash
promptdiff cases generate prompts/support.md            # 12 cases into the prompt's test-case file
promptdiff cases generate prompts/support.md -n 20 --with-checks
```

It writes realistic, varied user messages: everyday requests, edge cases, missing information, off-topic messages, and attempts to make the assistant ignore its instructions. If the prompt has `{{variables}}`, each case gets values for them. `--with-checks` adds a plain-English check to each case. In the app, press **g**.

**Review what it writes.** The best test cases are real messages from your users; generated ones are a starting point. Use `--append` to add more, `--force` to replace the file, or `-o <file>` to write elsewhere.

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

## Messages built by your code

If your app builds the user message with a function, a test case can call it, so you test the exact message your app sends:

```jsonl
{"id": "recruiter-email", "from": {"call": "src/email/prompts/recruiter.prompt.ts#createRecruiterUserPrompt", "args": [{"candidateName": "Ada Lopez", "jobTitle": "Product Manager"}]}}
```

`args` are passed to the function as-is, and it should return the message as a string (or a list of `{role, content}` messages).

**This runs your code**, so it only happens with `--run-code` (or `runCode: true` in `promptdiff.config.yaml`). TypeScript functions run with the project's `tsx` (install it with `npm i -D tsx`); JavaScript with Node; Python with `python3`. Everything else in promptdiff reads your code without running it.
