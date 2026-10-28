import { diffWords } from "diff";

export type CaseStatus = "identical" | "noise" | "changed" | "error";

export interface VariationStats {
  /** Mean pairwise distance between runs of the base version (undefined with 1 run). */
  withinBase?: number;
  /** Mean pairwise distance between runs of the head version (undefined with 1 run). */
  withinHead?: number;
  /** Mean distance between every base run and every head run. */
  between: number;
}

/**
 * How much bigger the between-version distance must be than the within-version
 * distance before a case counts as "changed" rather than "noise".
 */
export const NOISE_RATIO = 1.5;
/** Absolute slack, so tiny within-version variation doesn't make tiny differences look real. */
export const NOISE_MARGIN = 0.05;

const normalize = (s: string) => s.replace(/\r\n/g, "\n").trim();
const countWords = (s: string) => (s.match(/\S+/g) ?? []).length;

/**
 * Word-level distance in [0, 1]: 0 = same words, 1 = nothing in common.
 * Computed as 1 - (2 * shared words) / (words in a + words in b).
 */
export function wordDistance(a: string, b: string): number {
  const na = normalize(a);
  const nb = normalize(b);
  if (na === nb) return 0;
  const total = countWords(na) + countWords(nb);
  if (total === 0) return 0;
  let shared = 0;
  for (const part of diffWords(na, nb)) {
    if (!part.added && !part.removed) shared += countWords(part.value);
  }
  return 1 - (2 * shared) / total;
}

function meanPairwise(outputs: string[]): number | undefined {
  if (outputs.length < 2) return undefined;
  let sum = 0;
  let n = 0;
  for (let i = 0; i < outputs.length; i++) {
    for (let j = i + 1; j < outputs.length; j++) {
      sum += wordDistance(outputs[i]!, outputs[j]!);
      n++;
    }
  }
  return sum / n;
}

export function variationStats(base: string[], head: string[]): VariationStats {
  let sum = 0;
  for (const b of base) for (const h of head) sum += wordDistance(b, h);
  return {
    withinBase: meanPairwise(base),
    withinHead: meanPairwise(head),
    between: base.length && head.length ? sum / (base.length * head.length) : 0,
  };
}

/**
 * Classifies a case:
 * - identical: every output from both versions is the same text (ignoring surrounding whitespace)
 * - noise:     outputs differ, but versions differ no more than runs of the same version differ
 * - changed:   versions differ more than natural variation (or, with 1 run, at all)
 */
export function classify(base: string[], head: string[]): { status: Exclude<CaseStatus, "error">; stats: VariationStats } {
  const stats = variationStats(base, head);
  const all = [...base, ...head].map(normalize);
  if (all.every((o) => o === all[0])) return { status: "identical", stats };

  const within = [stats.withinBase, stats.withinHead].filter((v): v is number => v !== undefined);
  if (within.length === 0) return { status: "changed", stats };

  const noiseLevel = Math.max(...within);
  const isNoise = stats.between <= noiseLevel * NOISE_RATIO + NOISE_MARGIN && noiseLevel > 0;
  return { status: isNoise ? "noise" : "changed", stats };
}
