# promptdiff for VS Code

See how editing a prompt changes your model's answers, right from the editor.

- **promptdiff: Open** opens the promptdiff app in a terminal.
- **promptdiff: Compare this prompt…** (editor right-click menu, or the title bar on files with "prompt" in the name) compares the current prompt with the last commit, a branch, or your approved answers, and shows the report beside your code. In code files, put the cursor on the constant that holds the prompt (e.g. `SYSTEM_PROMPT`).

Requires [promptdiff](https://github.com/abhishek-vedteq/promptdiff) (run through `npx` by default; set `promptdiff.command` to `promptdiff` if it's installed globally), Node.js 22+, and a git repository.
