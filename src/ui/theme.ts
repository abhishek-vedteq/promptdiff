import { stripVTControlCharacters } from "node:util";
import chalk, { type ChalkInstance } from "chalk";

/**
 * promptdiff's look: a teal accent, a ± mark, and diff-style │ gutters.
 * Red and green are reserved for removed and added text.
 */

/**
 * Whether the terminal can draw symbols like ± and │ (legacy Windows consoles can't).
 * Set PROMPTDIFF_UNICODE=1 or 0 to override the guess.
 */
export const unicode =
  process.env.PROMPTDIFF_UNICODE !== undefined
    ? process.env.PROMPTDIFF_UNICODE !== "0"
    : process.platform !== "win32" || !!process.env.WT_SESSION || process.env.TERM_PROGRAM === "vscode" || !!process.env.TERM?.includes("xterm");

export const glyph = unicode
  ? { mark: "±", bullet: "●", hollow: "○", pointer: "›", gutter: "│", rule: "─", ok: "✓", fail: "✗", warn: "!", sep: "·", arrow: "→" }
  : { mark: "+-", bullet: "*", hollow: "o", pointer: ">", gutter: "|", rule: "-", ok: "+", fail: "x", warn: "!", sep: "-", arrow: "->" };

/** Braille dots spinner. */
export const spinnerFrames = unicode ? ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] : ["-", "\\", "|", "/"];

export const ACCENT = "#2BB3A3";

export const accentWith = (c: ChalkInstance) => (text: string) => c.hex(ACCENT)(text);
export const accent = accentWith(chalk);

export const visibleWidth = (s: string) => stripVTControlCharacters(s).length;

/** The ± promptdiff wordmark: a red −, a green +, and the name. */
export function wordmark(c: ChalkInstance): string {
  return unicode ? `${c.green.bold("±")} ${c.bold("promptdiff")}` : c.bold("promptdiff");
}

/** A full-width horizontal rule, optionally with a label: "── Summary ─────". */
export function rule(c: ChalkInstance, width: number, label?: string): string {
  if (!label) return c.dim(glyph.rule.repeat(width));
  const text = ` ${label} `;
  return c.dim(glyph.rule.repeat(2)) + c.bold(text) + c.dim(glyph.rule.repeat(Math.max(0, width - 2 - visibleWidth(text))));
}

/** Indents detail lines under a heading behind a dim │ gutter, like a diff tool. */
export function nest(lines: string[], c: ChalkInstance): string[] {
  return lines.map((l) => `  ${c.dim(glyph.gutter)} ${l}`);
}

/** A colored status label, e.g. " CHANGED " on yellow. */
export function pill(c: ChalkInstance, text: string, color: "yellow" | "cyan" | "green" | "red" | "gray"): string {
  if (c.level === 0) return `[${text}]`;
  const bg = { yellow: c.bgYellow.black, cyan: c.bgCyan.black, green: c.bgGreen.black, red: c.bgRed.white, gray: c.bgGray.white }[color];
  return bg(` ${text} `);
}
