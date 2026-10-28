# Assertions (checks)

A diff shows you *what* changed. Assertions tell you whether an output is still *correct*. Add them to a test case with `assert`:

```jsonl
{"id": "refund", "input": "I was charged twice for order #4821.", "assert": [{"type": "contains", "value": "5 business days"}, {"type": "max-words", "value": 80}]}
{"id": "classify", "input": "Cancel my plan", "assert": [{"type": "is-json", "schema": {"type": "object", "required": ["intent"], "properties": {"intent": {"enum": ["cancel", "refund", "other"]}}}}]}
```

Every assertion runs against every output, for both the old and the new prompt. The report shows how many checks each version passed, and labels each case:

- **REGRESSION**: the new prompt passes fewer checks than the old one.
- **FIXED**: the new prompt passes more checks than the old one.

## Assertion types

| Type           | Fields                      | Passes when the output…                                     |
| -------------- | --------------------------- | ----------------------------------------------------------- |
| `contains`     | `value`, `ignoreCase?`      | contains `value`                                            |
| `not-contains` | `value`, `ignoreCase?`      | doesn't contain `value`                                     |
| `equals`       | `value`, `ignoreCase?`      | equals `value`, ignoring leading and trailing whitespace     |
| `starts-with`  | `value`, `ignoreCase?`      | starts with `value`, ignoring leading whitespace             |
| `regex`        | `value`, `flags?`           | matches the regular expression (JavaScript syntax)           |
| `not-regex`    | `value`, `flags?`           | doesn't match the regular expression                         |
| `is-json`      | `schema?`                   | is valid JSON, and matches the [JSON Schema](https://json-schema.org) if given |
| `max-chars`    | `value`                     | has at most `value` characters                               |
| `min-chars`    | `value`                     | has at least `value` characters                              |
| `max-words`    | `value`                     | has at most `value` words                                    |
| `min-words`    | `value`                     | has at least `value` words                                   |
| `llm-rubric`   | `value`                     | satisfies a plain-English rubric, as graded by a judge model. See [LLM judge](./llm-judge.md). |

`is-json` is strict: output wrapped in a Markdown code fence fails. If your prompt asks for JSON, that's usually what you want to catch.

## Checks for every case

Assertions in the config file apply to every test case, before the case's own:

```yaml
# promptdiff.config.yaml
assert:
  - type: max-words
    value: 150
  - type: not-contains
    value: "As an AI"
```

## Failing CI on checks

| Flag                   | Exits with code 2 when…                                         |
| ---------------------- | --------------------------------------------------------------- |
| `--fail-on-regression` | the new prompt fails a check that the old prompt passed          |
| `--fail-on-check`      | any check fails on the new prompt                                |

`--fail-on-regression` is usually the right choice for pull requests: it only blocks changes that make things worse, even if some checks were already failing.

## Validation

Assertions are validated before any API call is made. A typo in a type, an invalid regular expression, or an invalid JSON Schema is reported with the line number, so a mistake never costs you a run.
