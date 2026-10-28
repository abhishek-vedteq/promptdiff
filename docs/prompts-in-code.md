# Prompts in code

Most apps don't keep prompts in text files. They keep them in code. promptdiff reads prompts from **TypeScript/JavaScript** and **Python**.

## TypeScript and JavaScript



```ts
// src/email/prompts/recruiter.prompt.ts
import { OUTPUT_FORMAT } from "./shared";

export const RECRUITER_SYSTEM_PROMPT = `You are an expert career coach...

${OUTPUT_FORMAT}`;
```

promptdiff can compare those directly. Point it at the file and the name of the exported constant, joined with `#`:

```bash
promptdiff src/email/prompts/recruiter.prompt.ts#RECRUITER_SYSTEM_PROMPT --base main
```

promptdiff builds the full text of the prompt for both versions (the one in `main`, and your working copy), then compares the model's answers as usual. If you only changed `OUTPUT_FORMAT` in `shared.ts`, that still counts as a change to `RECRUITER_SYSTEM_PROMPT`.

## How it reads your code

promptdiff **never runs your code**. It parses the files and works out the text from what's written there. It can follow:

| What | Example |
| --- | --- |
| Strings and template literals | `` `You are ${ROLE}.` ``, `"a" + "b"` |
| Constants in the same file | `const TONE = "warm";` |
| Relative imports, including index files and re-exports | `import { FORMAT } from "./shared"`, `export * from "./x"` |
| Packages in the same repo (workspaces) | `import { CATALOG } from "@acme/types"` |
| tsconfig path aliases | `import { RULES } from "@/lib/rules"` |
| Arrays and objects of constants | `RULES.map((r, i) => \`${i + 1}. ${r}\`).join("\n")`, `CONFIG.tone` |
| Common methods | `.join`, `.map`, `.filter`, `.trim`, `.toUpperCase`, `.replace`, `.length`, `JSON.stringify`, `Object.keys` |
| Simple callbacks | `(entry) => { const x = …; return \`…\`; }` |
| `dedent` / `outdent` template tags, `as const`, `satisfies` | |

It can't follow values that only exist when the code runs, such as function calls (`buildPrompt()`), dates, environment variables, or data from a database. When that happens, the error shows the exact file, line, and code, for example:

```
✗ src/prompts/chat.ts:12: can't read the prompt here (`new Date().toDateString()`): this kind of expression can't be read without running the code.
```

Usually the fix is to keep runtime values out of the system prompt and put them in the test case input instead, which is closer to how they reach the model anyway.

> **Tested on real projects:** in two production TypeScript monorepos, every exported system prompt (19, some assembled from more than 20 files across packages) came out byte-for-byte identical to the value the code produces at runtime.

## Python

```python
# app/prompts/support.py
from textwrap import dedent
from .shared import OUTPUT_FORMAT

COMPANY = "Acme"

SYSTEM_PROMPT = dedent(f"""
    You are the support assistant for {COMPANY}.
    {OUTPUT_FORMAT}
""").strip()

class Prompts:
    REFUND = "Refunds take 5 business days."
```

```bash
promptdiff app/prompts/support.py#SYSTEM_PROMPT --base main
promptdiff app/prompts/support.py#Prompts.REFUND --base main      # class attributes too
```

promptdiff reads Python with **Python's own parser**, so it needs Python 3 installed (`python3` or `python` on your PATH; set `PROMPTDIFF_PYTHON` to use a specific one). Like with TypeScript, **your code is never run**: you don't need the project's dependencies, a virtualenv, or its `.env`.

It can follow:

| What | Example |
| --- | --- |
| Strings, triple quotes, f-strings (with `!r` and format specs), implicit joining | `f"""Use {MAX:.0f} words"""`, `("a" "b")` |
| `%` and `.format()` | `"Hi %s" % NAME`, `"{x}".format(x=TONE)` |
| `textwrap.dedent`, `inspect.cleandoc`, `json.dumps` | `dedent("""...""").strip()` |
| Joins and comprehensions | `"
".join(f"{i}. {r}" for i, r in enumerate(RULES, 1) if r)` |
| Lists, tuples, dicts, indexing, slicing | `TONES["warm"]`, `RULES[:3]` |
| Imports inside the repo: relative, absolute, `src/` layouts, `__init__.py` re-exports, `import *` | `from .shared import FORMAT`, `from app.prompts import shared` |
| Class attributes | `class Prompts: SUPPORT = BASE + "..."` |

Prompts built inside functions (`def build_prompt(user): return f"..."`) need runtime values, so they can't be read, as with TypeScript.

> **Tested on real projects:** on two well-known open-source Python AI projects (one with 104 prompts stored as class attributes), every listed prompt could be read. In promptdiff's own tests, every supported pattern produces exactly the same text as Python does when it imports the module.

## What appears in the app

Without any configuration, the app lists prompts from files whose path mentions "prompt" (for example `*.prompt.ts`, or anything in a `prompts/` folder). From code files, it lists constants whose name contains **prompt** or **instruction** (`SYSTEM_PROMPT`, `systemInstruction`…), and, in Python, attributes of classes whose name contains them (`class SupportPrompts: main_system = ...`). It skips functions, objects, type hints, `None`, and things made by calling a function. Hidden folders like `.claude/` and `.github/` are skipped.

If your prompts live elsewhere, or the list includes things that aren't prompts, list them yourself with `prompts:` in `promptdiff.config.yaml`:

```yaml
prompts:
  - packages/core/src/**/*.prompt.ts                          # every prompt constant in these files
  - apps/web/src/app/api/chat/sys-ins.ts#systemInstruction    # one specific constant
  - prompts/*.md                                              # plain prompt files
```

Patterns are relative to the config file. When `prompts:` is set, the app lists exactly what it matches.

## Different test cases for different prompts

An email prompt and a job-extraction prompt need different test cases. Give a `prompts:` entry its own file with `cases:`:

```yaml
prompts:
  - path: packages/core/src/email/**/*.prompt.ts
    cases: tests/prompt-cases/email.jsonl
  - path: packages/core/src/job-ingest/**/*.prompt.ts
    cases: tests/prompt-cases/job-ingest.jsonl
cases: cases.jsonl   # for everything else
```

The test cases are the **user messages** your app sends along with the system prompt. If your code builds the user message with a function (e.g. `createRecruiterUserPrompt(input)`), write a few realistic examples of its output into the test-case file.

## Limits

- Only constants (exported ones, in TypeScript/JavaScript) that evaluate to text can be compared.
- Python prompts need Python 3 installed. Prompts built inside functions from runtime data need moving into a constant first.
- What promptdiff sends is the system prompt and your test-case message. If your app also gives the model tools, extra context (like the current date or a user profile), or earlier messages, those aren't included, so answers may differ somewhat from production.
