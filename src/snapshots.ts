/**
 * Approved outputs ("snapshots"): saved answers you were happy with, committed to git.
 * Comparing against them skips re-running the old prompt, and catches model drift.
 */
import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { PromptdiffError } from "./errors.js";
import type { DiffReport } from "./types.js";

export const SNAPSHOT_DIR = "promptdiff-snapshots";

const outputSchema = z.object({ text: z.string(), inputTokens: z.number().optional(), outputTokens: z.number().optional(), latencyMs: z.number().optional() });
const snapshotSchema = z.object({
  prompt: z.string(),
  model: z.string(),
  approvedAt: z.string(),
  cases: z.record(z.string(), z.object({ input: z.string(), outputs: z.array(outputSchema) })),
});

export type Snapshot = z.infer<typeof snapshotSchema>;
export type SnapshotOutput = z.infer<typeof outputSchema>;

/** File for a prompt's snapshot: readable name, plus a short hash when the name gets long. */
export function snapshotPath(dir: string, prompt: string): string {
  let slug = prompt.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  if (slug.length > 120) slug = `${slug.slice(0, 100)}_${createHash("sha256").update(prompt).digest("hex").slice(0, 10)}`;
  return path.join(dir, SNAPSHOT_DIR, `${slug}.json`);
}

export async function readSnapshot(file: string, prompt: string): Promise<Snapshot> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    throw new PromptdiffError(`No approved outputs for ${prompt} yet.`, {
      hint: `Approve the current outputs first: promptdiff ${prompt} --approve  (or press a on the results screen)`,
    });
  }
  const parsed = snapshotSchema.safeParse(JSON.parse(text));
  if (!parsed.success) throw new PromptdiffError(`${file} isn't a valid promptdiff snapshot.`);
  return parsed.data;
}

/** Saves the new prompt's ("head") outputs from a report as the approved ones. */
export async function writeSnapshot(file: string, report: DiffReport): Promise<number> {
  const cases: Snapshot["cases"] = {};
  for (const cr of report.cases) {
    if (cr.head.some((o) => o.error)) continue;
    cases[cr.id] = {
      input: cr.input,
      outputs: cr.head.map((o) => ({ text: o.text, inputTokens: o.inputTokens, outputTokens: o.outputTokens, latencyMs: Math.round(o.latencyMs) })),
    };
  }
  const snapshot: Snapshot = { prompt: report.meta.file, model: report.meta.vsModel ?? report.meta.model, approvedAt: new Date().toISOString(), cases };
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(snapshot, null, 2) + "\n");
  return Object.keys(cases).length;
}
