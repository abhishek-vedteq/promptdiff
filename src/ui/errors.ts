import type { ChalkInstance } from "chalk";
import { PromptdiffError } from "../errors.js";
import { glyph, nest } from "./theme.js";

/** Formats an error the way the CLI shows it: a red ✗ line, then hints behind a │ gutter. */
export function formatError(err: unknown, c: ChalkInstance, debug = false): string {
  if (err instanceof PromptdiffError) {
    const lines = [`${c.red(glyph.fail)} ${c.bold(err.message)}`];
    if (err.hint) lines.push(...nest(err.hint.split("\n").map((l) => c.dim(l)), c));
    return lines.join("\n");
  }
  const message = err instanceof Error ? err.message : String(err);
  const lines = [`${c.red(glyph.fail)} ${c.bold("Unexpected error:")} ${message}`];
  if (debug && err instanceof Error && err.stack) lines.push(c.dim(err.stack));
  else lines.push(...nest([c.dim("Set PROMPTDIFF_DEBUG=1 for a stack trace. Please report bugs at https://github.com/abhishek-vedteq/promptdiff/issues")], c));
  return lines.join("\n");
}
