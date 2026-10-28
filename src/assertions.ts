import { Ajv, type ValidateFunction } from "ajv";
import { z } from "zod";

const text = z.string();
const count = z.number().int().min(0);

function compiles(source: string, flags = ""): boolean {
  try {
    new RegExp(source, flags);
    return true;
  } catch {
    return false;
  }
}

const regexAssertion = <T extends string>(type: T) =>
  z
    .object({ type: z.literal(type), value: text, flags: z.string().regex(/^[dgimsuvy]*$/).optional() })
    .refine((a) => compiles(a.value, a.flags), { message: "invalid regular expression", path: ["value"] });

/** Checks that can be attached to a test case (`"assert": [...]`) or to every case via the config file. */
export const assertionSchema = z.union([
  z.object({ type: z.literal("contains"), value: text, ignoreCase: z.boolean().optional() }),
  z.object({ type: z.literal("not-contains"), value: text, ignoreCase: z.boolean().optional() }),
  z.object({ type: z.literal("equals"), value: text, ignoreCase: z.boolean().optional() }),
  z.object({ type: z.literal("starts-with"), value: text, ignoreCase: z.boolean().optional() }),
  regexAssertion("regex"),
  regexAssertion("not-regex"),
  z.object({ type: z.literal("is-json"), schema: z.record(z.string(), z.unknown()).optional() }),
  z.object({ type: z.literal("max-chars"), value: count }),
  z.object({ type: z.literal("min-chars"), value: count }),
  z.object({ type: z.literal("max-words"), value: count }),
  z.object({ type: z.literal("min-words"), value: count }),
  z.object({ type: z.literal("llm-rubric"), value: z.string().min(1) }),
]);

export type Assertion = z.infer<typeof assertionSchema>;
export const ASSERTION_TYPES = [
  "contains", "not-contains", "equals", "starts-with", "regex", "not-regex",
  "is-json", "max-chars", "min-chars", "max-words", "min-words", "llm-rubric",
] as const;

export interface AssertionResult {
  /** Human-readable description, e.g. `contains "order number"`. */
  label: string;
  pass: boolean;
  /** Why it failed (or, for llm-rubric, the judge's reasoning). */
  reason?: string;
}

/** Grades an output against a natural-language rubric (implemented by the LLM judge). */
export type RubricGrader = (rubric: string, output: string) => Promise<{ pass: boolean; reason: string }>;

const short = (s: string, n = 60) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const words = (s: string) => (s.match(/\S+/g) ?? []).length;

export function assertionLabel(a: Assertion): string {
  switch (a.type) {
    case "contains":
    case "not-contains":
    case "equals":
    case "starts-with":
      return `${a.type} ${JSON.stringify(short(a.value))}${a.ignoreCase ? " (ignore case)" : ""}`;
    case "regex":
    case "not-regex":
      return `${a.type} /${short(a.value)}/${a.flags ?? ""}`;
    case "is-json":
      return a.schema ? "is-json (with schema)" : "is-json";
    case "max-chars":
    case "min-chars":
    case "max-words":
    case "min-words":
      return `${a.type} ${a.value}`;
    case "llm-rubric":
      return `llm-rubric ${JSON.stringify(short(a.value))}`;
  }
}

const schemaCache = new WeakMap<object, ValidateFunction>();
const ajv = new Ajv({ allErrors: true, strict: false });

/** Throws if a JSON schema in an is-json assertion can't be compiled. */
export function compileSchema(schema: Record<string, unknown>): ValidateFunction {
  let fn = schemaCache.get(schema);
  if (!fn) {
    fn = ajv.compile(schema);
    schemaCache.set(schema, fn);
  }
  return fn;
}

function checkJson(output: string, schema: Record<string, unknown> | undefined): string | undefined {
  let value: unknown;
  try {
    value = JSON.parse(output.trim());
  } catch (err) {
    return `not valid JSON (${(err as Error).message})`;
  }
  if (!schema) return undefined;
  const validate = compileSchema(schema);
  if (validate(value)) return undefined;
  return `does not match schema: ${ajv.errorsText(validate.errors, { dataVar: "output" })}`;
}

/** Evaluates one deterministic assertion. Returns a failure reason, or undefined when it passes. */
function check(a: Exclude<Assertion, { type: "llm-rubric" }>, output: string): string | undefined {
  const fold = (s: string) => ("ignoreCase" in a && a.ignoreCase ? s.toLowerCase() : s);
  switch (a.type) {
    case "contains":
      return fold(output).includes(fold(a.value)) ? undefined : "text not found";
    case "not-contains":
      return fold(output).includes(fold(a.value)) ? "text was found" : undefined;
    case "equals":
      return fold(output.trim()) === fold(a.value.trim()) ? undefined : "output differs";
    case "starts-with":
      return fold(output.trimStart()).startsWith(fold(a.value)) ? undefined : "output starts differently";
    case "regex":
      return new RegExp(a.value, a.flags).test(output) ? undefined : "no match";
    case "not-regex":
      return new RegExp(a.value, a.flags).test(output) ? "pattern matched" : undefined;
    case "is-json":
      return checkJson(output, a.schema);
    case "max-chars":
      return output.length <= a.value ? undefined : `${output.length} characters`;
    case "min-chars":
      return output.length >= a.value ? undefined : `${output.length} characters`;
    case "max-words":
      return words(output) <= a.value ? undefined : `${words(output)} words`;
    case "min-words":
      return words(output) >= a.value ? undefined : `${words(output)} words`;
  }
}

/** Evaluates every assertion against one output. `grade` is required only for llm-rubric assertions. */
export async function evaluateAssertions(
  assertions: Assertion[],
  output: string,
  grade?: RubricGrader,
): Promise<AssertionResult[]> {
  const results: AssertionResult[] = [];
  for (const a of assertions) {
    const label = assertionLabel(a);
    if (a.type === "llm-rubric") {
      if (!grade) {
        results.push({ label, pass: false, reason: "no judge model configured" });
        continue;
      }
      try {
        const verdict = await grade(a.value, output);
        results.push({ label, pass: verdict.pass, reason: verdict.reason });
      } catch (err) {
        results.push({ label, pass: false, reason: `judge error: ${(err as Error).message}` });
      }
      continue;
    }
    const reason = check(a, output);
    results.push(reason === undefined ? { label, pass: true } : { label, pass: false, reason });
  }
  return results;
}

export interface CheckTally {
  passed: number;
  total: number;
}

export function tally(results: AssertionResult[][]): CheckTally {
  let passed = 0;
  let total = 0;
  for (const run of results) {
    for (const r of run) {
      total++;
      if (r.pass) passed++;
    }
  }
  return { passed, total };
}

export const passRate = (t: CheckTally) => (t.total === 0 ? 1 : t.passed / t.total);
