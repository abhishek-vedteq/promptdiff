import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { assertionSchema } from "../assertions.js";
import { parseCases } from "../cases.js";
import { loadProjectConfig } from "../config/project.js";
import { casesForPrompt } from "../config/resolve.js";
import { PromptdiffError } from "../errors.js";
import { setupModel } from "../model-setup.js";
import { loadPrompt } from "../prompt-source.js";
import type { Credential, Provider } from "../providers/types.js";
import { DEFAULT_RETRY, withRetry, type RetryOptions } from "../retry.js";
import { templateVariables } from "../templates.js";

/** Every case-generation request starts with this, so the offline mock provider can recognize it. */
export const GENERATE_MARKER = "You write test cases for an AI assistant.";

export function generatorSystem(withChecks: boolean): string {
  return `${GENERATE_MARKER} You'll get the assistant's system prompt. Write realistic messages that real users of this assistant would send, to test how the prompt behaves.

Cover a spread of situations:
- the common, everyday requests the prompt is clearly built for
- edge cases: missing or ambiguous information, unusual but valid requests, very short or very long messages
- requests the prompt says to refuse, redirect, or escalate (if any)
- an off-topic message, and an attempt to make the assistant ignore its instructions
- different tones (polite, frustrated, terse) and, where it fits, different languages

Write each message exactly as a user would type it. Don't describe the test; write the message itself.
${withChecks ? `For each case, add 1-2 checks of what a good answer must do, as plain-English rubrics the answer can be graded against, based only on what the system prompt asks for.\n` : ""}
Reply with only a JSON array and no other text:
[{"id": "<short-kebab-case-id>", "input": "<the user's message>"${withChecks ? ', "checks": ["<what a good answer does>"]' : ""}${"{VARS}"}}]`;
}

const generatedSchema = z.array(
  z.object({
    id: z.string().min(1),
    input: z.string().min(1),
    checks: z.array(z.string().min(1)).optional(),
    vars: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  }),
);

export interface GeneratedCase {
  id: string;
  input: string;
  vars?: Record<string, string | number | boolean>;
  assert?: z.infer<typeof assertionSchema>[];
}

/** Asks a model to write test cases for a prompt. */
export async function generateCases(args: {
  provider: Provider;
  modelId: string;
  prompt: string;
  count: number;
  withChecks?: boolean;
  retry?: RetryOptions;
}): Promise<GeneratedCase[]> {
  const variables = templateVariables(args.prompt);
  const varsField = variables.length ? `, "vars": {${variables.map((v) => `"${v}": "<a realistic value>"`).join(", ")}}` : "";
  const system = generatorSystem(args.withChecks === true).replace("{VARS}", varsField);
  const user =
    `Write ${args.count} test cases for this system prompt.` +
    (variables.length ? ` It contains placeholders (${variables.map((v) => `{{${v}}}`).join(", ")}); give each case realistic values for them in "vars".` : "") +
    `\n\n<system_prompt>\n${args.prompt}\n</system_prompt>`;
  const res = await withRetry(() => args.provider.generate({ model: args.modelId, system, messages: [{ role: "user", content: user }] }), args.retry ?? DEFAULT_RETRY);

  const start = res.text.indexOf("[");
  const end = res.text.lastIndexOf("]");
  let parsed: z.infer<typeof generatedSchema> | undefined;
  if (start >= 0 && end > start) {
    try {
      const r = generatedSchema.safeParse(JSON.parse(res.text.slice(start, end + 1)));
      if (r.success) parsed = r.data;
    } catch {
      // handled below
    }
  }
  if (!parsed || parsed.length === 0) {
    throw new PromptdiffError("The model didn't return test cases in the expected format.", {
      hint: `It replied: ${JSON.stringify(res.text.replace(/\s+/g, " ").slice(0, 160))}. Try again, or use a different --model.`,
    });
  }

  const seen = new Set<string>();
  return parsed.map((c) => {
    let id = c.id.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "case";
    for (let n = 2; seen.has(id); n++) id = `${id.replace(/-\d+$/, "")}-${n}`;
    seen.add(id);
    return {
      id,
      input: c.input,
      ...(c.vars && Object.keys(c.vars).length ? { vars: c.vars } : {}),
      ...(c.checks?.length ? { assert: c.checks.map((value) => ({ type: "llm-rubric" as const, value })) } : {}),
    };
  });
}

export interface CasesGenerateOptions {
  count?: string;
  output?: string;
  model?: string;
  withChecks?: boolean;
  append?: boolean;
  force?: boolean;
  config?: string;
}

export interface CasesDeps {
  cwd: string;
  env: NodeJS.ProcessEnv;
  out: { write(s: string): unknown };
  createProvider?: (providerId: string, credential: Credential) => Provider;
  userConfigFile?: string;
  retry?: RetryOptions;
}

/** `promptdiff cases generate <prompt>`: writes generated cases to the prompt's test-case file. */
export async function casesGenerateCommand(prompt: string, opts: CasesGenerateOptions, partial: Partial<CasesDeps> = {}): Promise<string> {
  const deps: CasesDeps = { cwd: process.cwd(), env: process.env, out: process.stdout, ...partial };
  const count = opts.count === undefined ? 12 : Number(opts.count);
  if (!Number.isInteger(count) || count < 1 || count > 100) throw new PromptdiffError("-n must be a whole number from 1 to 100");

  const project = await loadProjectConfig(deps.cwd, opts.config);
  const { provider, modelId, modelSpec } = await setupModel({
    model: opts.model ?? project.config.model,
    env: deps.env,
    userConfigFile: deps.userConfigFile,
    createProvider: deps.createProvider,
  });

  const configDir = project.file ? path.dirname(project.file) : deps.cwd;
  const target = opts.output
    ? path.resolve(deps.cwd, opts.output)
    : (casesForPrompt(project.config, project.file, deps.cwd, prompt) ?? path.resolve(configDir, project.config.cases ?? "cases.jsonl"));
  const rel = path.relative(deps.cwd, target);
  const label = !rel || rel.startsWith("..") ? target : rel;
  if (existsSync(target) && !opts.append && !opts.force) {
    throw new PromptdiffError(`${label} already exists.`, { hint: "Use --append to add to it, --force to replace it, or -o <file> to write somewhere else." });
  }

  const text = (await loadPrompt(prompt, "working", deps.cwd)).text;
  deps.out.write(`Writing ${count} test cases for ${prompt} with ${modelSpec}…\n`);
  const cases = await generateCases({ provider, modelId, prompt: text, count, withChecks: opts.withChecks, retry: deps.retry });

  // Avoid id clashes with cases already in the file when appending.
  let existing = "";
  if (opts.append && existsSync(target)) {
    existing = await readFile(target, "utf8");
    const taken = new Set(parseCases(existing, label).map((c) => c.id));
    for (const c of cases) {
      for (let n = 2; taken.has(c.id); n++) c.id = `${c.id.replace(/-\d+$/, "")}-${n}`;
      taken.add(c.id);
    }
  }
  const lines = cases.map((c) => JSON.stringify(c)).join("\n") + "\n";
  parseCases(lines, label); // validate before writing
  await mkdir(path.dirname(target), { recursive: true });
  if (opts.append && existing) await appendFile(target, (existing.endsWith("\n") ? "" : "\n") + lines);
  else await writeFile(target, lines);

  deps.out.write(`${opts.append && existing ? "Added" : "Wrote"} ${cases.length} test cases to ${label}:\n`);
  for (const c of cases) deps.out.write(`  ${c.id.padEnd(28)} ${c.input.replace(/\s+/g, " ").slice(0, 70)}\n`);
  deps.out.write(`Review and edit them: they're your examples of real use. Then compare with: promptdiff ${prompt}\n`);
  return target;
}
