import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { PromptdiffError } from "./errors.js";

const priceSchema = z.object({ input: z.number().min(0), output: z.number().min(0) });
const pricingFileSchema = z.object({ models: z.record(z.string(), priceSchema) }).passthrough();

export type ModelPrice = z.infer<typeof priceSchema>;
export type PricingTable = Record<string, ModelPrice>;

export const PROJECT_PRICING_FILE = "promptdiff.pricing.json";

/** The pricing.json shipped with the package (one level above src/ and dist/). */
export function loadBuiltinPricing(): PricingTable {
  const url = new URL("../pricing.json", import.meta.url);
  // A broken built-in table is a bug in promptdiff, so fail loudly rather than silently dropping prices.
  return pricingFileSchema.parse(JSON.parse(readFileSync(url, "utf8"))).models;
}

/** Loads a user pricing file. Missing optional files yield an empty table. */
export async function loadPricingFile(file: string, required: boolean): Promise<PricingTable> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT" && !required) return {};
    throw new PromptdiffError(`Pricing file not found: ${file}`);
  }
  const parsed = pricingFileSchema.safeParse(JSON.parse(text));
  if (!parsed.success) {
    throw new PromptdiffError(`Pricing file is invalid: ${file}`, {
      hint: 'Expected {"models": {"provider:model-id": {"input": <USD per 1M>, "output": <USD per 1M>}}}',
    });
  }
  return parsed.data.models;
}

/** Whether a model has a price (exactly, or through a "provider:*" entry). */
export const hasPrice = (table: PricingTable, model: string) => table[model] !== undefined || table[`${model.split(":")[0]}:*`] !== undefined;

/** Returns USD cost, or undefined if the model isn't priced or usage is unknown. */
export function estimateCost(
  table: PricingTable,
  model: string,
  inputTokens: number | undefined,
  outputTokens: number | undefined,
): number | undefined {
  // Exact model first, then a provider-wide entry like "ollama:*".
  const price = table[model] ?? table[`${model.split(":")[0]}:*`];
  if (!price || inputTokens === undefined || outputTokens === undefined) return undefined;
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
}
