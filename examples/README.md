# Example

A sample support-bot prompt and test cases.

```bash
# from the root of a git repo containing these files, after committing them:
cp examples/promptdiff.config.yaml examples/cases.jsonl .
# edit examples/prompts/support.md (e.g. change "at most 4 sentences" to "at most 2 sentences"), then:
promptdiff examples/prompts/support.md --base HEAD
```

No API key yet? Try the offline mock provider, which echoes the first line of the prompt:

```bash
promptdiff examples/prompts/support.md --base HEAD --model mock:echo
```
