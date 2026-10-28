import { access, appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { PROJECT_CONFIG_FILE } from "../config/project.js";

type Out = { write(s: string): unknown };

export const DEFAULT_INIT_MODEL = "anthropic:claude-opus-5-5";

/** The sample config, with the model the user actually has set up. */
export const sampleConfig = (model = DEFAULT_INIT_MODEL) => `# promptdiff project config. CLI flags override these values.
# Docs: https://github.com/abhishek-vedteq/promptdiff/blob/main/docs/configuration.md

# Model as <provider>:<model-id>. Providers: anthropic, openai, google,
# claude-code and codex (your logged-in CLI). Any model id your provider offers works.
model: ${model}

# Test cases, one JSON object per line: {"id": "...", "input": "..."}
cases: cases.jsonl

# Parallel API calls.
concurrency: 4

# Runs per case per version. Use 3+ to separate real changes from randomness.
runs: 1

# Optional. Leave unset to use the provider's default (some newer models reject it).
# temperature: 0.7

# Optional cap on output tokens per call.
# maxOutputTokens: 1024

# Default git ref to compare against (default: HEAD).
# base: main

# Optional extra pricing table (USD per 1M tokens), merged over the built-in one.
# Defaults to ./promptdiff.pricing.json if that file exists.
# pricing: promptdiff.pricing.json

# How to decide whether outputs changed: words (free) or semantic (an LLM judge compares meaning).
# compare: words

# Model for llm-rubric checks and semantic comparison (default: model).
# judge: anthropic:claude-haiku-5-5

# Budget in USD: refuse to start above the estimate, stop once spend reaches it.
# maxCost: 2.00

# Default values for {{placeholders}} in your prompt. Cases can override them with "vars".
# vars:
#   company: Acme

# Checks applied to every case. See docs/assertions.md.
# assert:
#   - type: max-words
#     value: 150
`;

export const SAMPLE_CASES = [
  { id: "refund", input: "I was charged twice for my order #4821. Can I get a refund?", assert: [{ type: "max-words", value: 120 }] },
  { id: "password-reset", input: "I can't log in. The password reset email never arrives." },
  { id: "angry", input: "This is the third time I'm writing. Your product deleted my data!!" },
  { id: "off-topic", input: "What's a good recipe for banana bread?" },
  {
    id: "follow-up",
    messages: [
      { role: "user", content: "I was charged twice." },
      { role: "assistant", content: "I'm sorry about that! Could you share your order number?" },
      { role: "user", content: "It's #4821." },
    ],
  },
]
  .map((c) => JSON.stringify(c))
  .join("\n") + "\n";

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

export const SAMPLE_CONFIG = sampleConfig();

/** A sample support-bot prompt, for people who don't have a prompt file yet. */
export const SAMPLE_PROMPT = `You are the customer support assistant for Acme Cloud Storage.

Guidelines:
- Be concise: answer in at most 4 sentences.
- Be warm, and acknowledge frustration when the customer is upset.
- For billing problems (double charges, refunds), explain that refunds are processed within 5 business days and ask for the order number if it wasn't given.
- For login problems, suggest checking the spam folder and offer a manual reset link.
- If the question is unrelated to Acme, politely say you can only help with Acme Cloud Storage.
`;

export async function initCommand(
  opts: { force?: boolean; model?: string },
  cwd = process.cwd(),
  out: Out = process.stdout,
): Promise<void> {
  let model = opts.model;
  if (!model) {
    // Write the model the user can actually run, if one is set up.
    const { detectDefaultModel } = await import("../detect.js");
    const { readUserConfig } = await import("../config/keys.js");
    model = (await detectDefaultModel(await readUserConfig()).catch(() => undefined))?.model;
  }
  const files: [string, string][] = [
    [PROJECT_CONFIG_FILE, sampleConfig(model)],
    ["cases.jsonl", SAMPLE_CASES],
  ];
  for (const [name, content] of files) {
    const file = path.join(cwd, name);
    if ((await exists(file)) && !opts.force) {
      out.write(`  skipped  ${name} (already exists; use --force to overwrite)\n`);
      continue;
    }
    await writeFile(file, content);
    out.write(`  created  ${name}\n`);
  }

  const gitignore = path.join(cwd, ".gitignore");
  const entry = ".promptdiff/";
  if (await exists(gitignore)) {
    const text = await readFile(gitignore, "utf8");
    if (!text.split(/\r?\n/).some((l) => l.trim() === entry || l.trim() === ".promptdiff")) {
      await appendFile(gitignore, `${text.endsWith("\n") || text === "" ? "" : "\n"}# promptdiff result cache\n${entry}\n`);
      out.write(`  updated  .gitignore (added ${entry})\n`);
    }
  } else {
    await writeFile(gitignore, `# promptdiff result cache\n${entry}\n`);
    out.write(`  created  .gitignore\n`);
  }

  out.write(`
Next steps:
  1. Set an API key:      promptdiff config set anthropic
  2. Edit a prompt file that's committed to git, e.g. prompts/support.md
  3. Compare it:          promptdiff prompts/support.md --base HEAD
`);
}
