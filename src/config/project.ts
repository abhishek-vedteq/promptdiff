import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { assertionSchema } from "../assertions.js";
import { varsSchema } from "../cases.js";
import { PromptdiffError } from "../errors.js";

export const PROJECT_CONFIG_FILE = "promptdiff.config.yaml";

export const projectConfigSchema = z
  .object({
    model: z.string().min(1).optional(),
    temperature: z.number().min(0).max(2).optional(),
    maxOutputTokens: z.number().int().positive().optional(),
    cases: z.string().min(1).optional(),
    concurrency: z.number().int().min(1).max(64).optional(),
    runs: z.number().int().min(1).max(50).optional(),
    base: z.string().min(1).optional(),
    pricing: z.string().min(1).optional(),
    /** Stop the run (and refuse to start it) above this estimated/actual cost in USD. */
    maxCost: z.number().positive().optional(),
    /** Ask for confirmation in interactive terminals when the estimate exceeds this many USD. */
    confirmAbove: z.number().min(0).optional(),
    /** How to decide whether outputs changed: word overlap (free) or an LLM judge (semantic). */
    compare: z.enum(["words", "semantic"]).optional(),
    /** Model for llm-rubric checks and semantic comparison. Defaults to `model`. */
    judge: z.string().min(1).optional(),
    /**
     * Where prompts live (globs, relative to this file). Code files list their exported
     * prompt constants; "file.ts#NAME" picks one. An entry can name its own test cases.
     */
    prompts: z
      .array(z.union([z.string().min(1), z.object({ path: z.string().min(1), cases: z.string().min(1).optional() }).strict()]))
      .optional(),
    /** Default template variables; a case's own vars override these. */
    vars: varsSchema.optional(),
    /** Assertions applied to every test case, before the case's own. */
    assert: z.array(assertionSchema).optional(),
  })
  .strict();

export type ProjectConfig = z.infer<typeof projectConfigSchema>;

export interface LoadedProjectConfig {
  config: ProjectConfig;
  /** Absolute path of the file, or undefined if none was found. */
  file?: string;
}

/**
 * Loads promptdiff.config.yaml. With an explicit path, a missing file is an error;
 * otherwise a missing file just means "no project defaults".
 */
export async function loadProjectConfig(cwd: string, explicitPath?: string): Promise<LoadedProjectConfig> {
  const file = path.resolve(cwd, explicitPath ?? PROJECT_CONFIG_FILE);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT" && !explicitPath) return { config: {} };
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new PromptdiffError(`Config file not found: ${file}`);
    }
    throw err;
  }
  return { config: parseProjectConfig(text, file), file };
}

export function parseProjectConfig(text: string, file = PROJECT_CONFIG_FILE): ProjectConfig {
  let raw: unknown;
  try {
    raw = parseYaml(text) ?? {};
  } catch (err) {
    throw new PromptdiffError(`${file}: invalid YAML (${(err as Error).message})`);
  }
  const parsed = projectConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `  - ${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`)
      .join("\n");
    throw new PromptdiffError(`${file} is invalid:\n${details}`, {
      hint: "Valid keys: model, temperature, maxOutputTokens, cases, concurrency, runs, base, pricing, maxCost, confirmAbove, compare, judge, prompts, vars, assert. See docs/configuration.md.",
    });
  }
  return parsed.data;
}
