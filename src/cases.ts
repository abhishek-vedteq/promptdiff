import { readFile } from "node:fs/promises";
import { z } from "zod";
import { assertionSchema, compileSchema, type Assertion } from "./assertions.js";
import { PromptdiffError } from "./errors.js";

export const chatMessageSchema = z
  .object({ role: z.enum(["user", "assistant"]), content: z.string() })
  .strict();

export type ChatMessage = z.infer<typeof chatMessageSchema>;

export const varsSchema = z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "variable names may only contain letters, digits, and underscores"), z.union([z.string(), z.number(), z.boolean()]));

export const testCaseSchema = z
  .object({
    id: z.union([z.string().min(1), z.number()]).optional(),
    input: z.string({ error: '"input" must be a string' }).optional(),
    messages: z.array(chatMessageSchema).min(1).optional(),
    /** Build the message by calling a project function (needs --run-code). */
    from: z.object({ call: z.string().regex(/.+#[A-Za-z_$][\w$]*$/, 'use "path/to/file.ts#functionName"'), args: z.array(z.unknown()).default([]) }).strict().optional(),
    vars: varsSchema.optional(),
    assert: z.array(assertionSchema).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .superRefine((c, ctx) => {
    const given = [c.input, c.messages, c.from].filter((v) => v !== undefined).length;
    if (given !== 1) {
      ctx.addIssue({ code: "custom", message: 'each case needs exactly one of "input", "messages", or "from"' });
      return;
    }
    if (c.messages) {
      if (c.messages[0]!.role !== "user") ctx.addIssue({ code: "custom", path: ["messages", 0, "role"], message: 'the first message must have role "user"' });
      if (c.messages[c.messages.length - 1]!.role !== "user") {
        ctx.addIssue({ code: "custom", path: ["messages", c.messages.length - 1, "role"], message: 'the last message must have role "user" (it\'s the turn the model answers)' });
      }
    }
  });

export interface TestCase {
  id: string;
  /** Single-turn input. Exactly one of input/messages is set. */
  input?: string;
  /** Multi-turn conversation ending with a user message. */
  messages?: ChatMessage[];
  /** Built by calling project code before the run (replaced by input/messages). */
  from?: { call: string; args: unknown[] };
  /** Template variables for the prompt. */
  vars: Record<string, string | number | boolean>;
  assert: Assertion[];
  metadata?: Record<string, unknown>;
  line: number;
}

/** The conversation sent to the model for a case. */
export function caseMessages(tc: TestCase): ChatMessage[] {
  return tc.messages ?? [{ role: "user", content: tc.input ?? "" }];
}

/** The case's input as used in cache keys: the raw string for single-turn cases (keeps old cache entries valid). */
export function caseInputKey(tc: TestCase): string {
  return tc.messages ? JSON.stringify(tc.messages) : (tc.input ?? "");
}

/** What to show as "the input": the final user message. */
export function caseLabel(tc: TestCase): string {
  const msgs = caseMessages(tc);
  return msgs[msgs.length - 1]!.content;
}

/** Throws a readable error if an is-json schema can't be compiled. */
export function validateAssertionSchemas(assertions: Assertion[], where: string): void {
  for (const a of assertions) {
    if (a.type !== "is-json" || !a.schema) continue;
    try {
      compileSchema(a.schema);
    } catch (err) {
      throw new PromptdiffError(`${where}: invalid JSON schema in is-json assertion (${(err as Error).message})`);
    }
  }
}

/**
 * Parses JSONL test cases. Each non-blank line must be a JSON object with an
 * "input" string and an optional "id". Errors include the file and line number.
 */
export function parseCases(text: string, fileLabel = "cases.jsonl"): TestCase[] {
  const cases: TestCase[] = [];
  const seen = new Map<string, number>();
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);

  lines.forEach((raw, index) => {
    const lineNo = index + 1;
    const line = raw.trim();
    if (line === "") return;

    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch (err) {
      throw new PromptdiffError(`${fileLabel}:${lineNo}: invalid JSON (${(err as Error).message})`, {
        hint: 'Each line must be one JSON object, e.g. {"id": "refund", "input": "I want a refund"}',
      });
    }

    const parsed = testCaseSchema.safeParse(json);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const where = issue?.path.length ? ` at "${issue.path.join(".")}"` : "";
      const msg = json === null || typeof json !== "object" || Array.isArray(json)
        ? "expected a JSON object"
        : `${issue?.message ?? "invalid test case"}${where}`;
      const isAssert = issue?.path[0] === "assert";
      throw new PromptdiffError(`${fileLabel}:${lineNo}: ${msg}`, {
        hint: isAssert
          ? 'Assertions look like {"type": "contains", "value": "refund"}. See docs/assertions.md for every type.'
          : 'Each line needs an "input" string or a "messages" array, e.g. {"id": "refund", "input": "I want a refund"}',
      });
    }

    const id = parsed.data.id !== undefined ? String(parsed.data.id) : `line-${lineNo}`;
    const prev = seen.get(id);
    if (prev !== undefined) {
      throw new PromptdiffError(`${fileLabel}:${lineNo}: duplicate id "${id}" (first used on line ${prev})`);
    }
    seen.set(id, lineNo);
    const assert = parsed.data.assert ?? [];
    validateAssertionSchemas(assert, `${fileLabel}:${lineNo}`);
    const { input, messages, from, vars, metadata } = parsed.data;
    cases.push({ id, input, messages, ...(from ? { from: { call: from.call, args: from.args } } : {}), vars: vars ?? {}, assert, metadata, line: lineNo });
  });

  if (cases.length === 0) {
    throw new PromptdiffError(`${fileLabel} has no test cases.`, {
      hint: 'Add one JSON object per line, e.g. {"id": "refund", "input": "I want a refund"}',
    });
  }
  return cases;
}

export async function loadCases(filePath: string, label = filePath): Promise<TestCase[]> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new PromptdiffError(`Cases file not found: ${label}`, {
        hint: "Pass --cases <file>, set `cases:` in promptdiff.config.yaml, or run `promptdiff init` to create a sample.",
      });
    }
    throw err;
  }
  return parseCases(text, label);
}
