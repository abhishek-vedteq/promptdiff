import { diffWordsWithSpace } from "diff";

export type SegmentKind = "same" | "added" | "removed";

export interface Segment {
  text: string;
  kind: SegmentKind;
}

/** Word-level diff of two outputs as a flat list of segments. */
export function wordDiff(base: string, head: string): Segment[] {
  return diffWordsWithSpace(base, head).map((part) => ({
    text: part.value,
    kind: part.added ? "added" : part.removed ? "removed" : "same",
  }));
}

/** Segments for the left (base) column: unchanged + removed text. */
export const leftSide = (segments: Segment[]) => segments.filter((s) => s.kind !== "added");
/** Segments for the right (head) column: unchanged + added text. */
export const rightSide = (segments: Segment[]) => segments.filter((s) => s.kind !== "removed");

/**
 * Greedy word-wrap that keeps each segment's kind. Breaks on newlines and
 * whitespace; hard-splits words longer than the width.
 */
export function wrapSegments(segments: Segment[], width: number): Segment[][] {
  const lines: Segment[][] = [];
  let line: Segment[] = [];
  let len = 0;
  const push = (text: string, kind: SegmentKind) => {
    const last = line[line.length - 1];
    if (last && last.kind === kind) last.text += text;
    else line.push({ text, kind });
    len += text.length;
  };
  const newline = () => {
    lines.push(line);
    line = [];
    len = 0;
  };

  for (const seg of segments) {
    for (const token of seg.text.replace(/\r\n/g, "\n").replace(/\t/g, "  ").split(/(\n|\s+)/)) {
      if (token === "") continue;
      if (token === "\n") {
        newline();
        continue;
      }
      const isSpace = /^\s+$/.test(token);
      if (isSpace) {
        if (len === 0 && lines.length > 0 && seg.kind === "same") continue; // drop leading space after a wrap
        const room = width - len;
        if (token.length > room) {
          newline();
          continue;
        }
        push(token, seg.kind);
        continue;
      }
      let rest = token;
      while (rest.length > 0) {
        if (len + rest.length <= width) {
          push(rest, seg.kind);
          rest = "";
        } else if (len > 0 && rest.length <= width) {
          newline();
        } else {
          const take = width - len;
          push(rest.slice(0, take), seg.kind);
          rest = rest.slice(take);
          newline();
        }
      }
    }
  }
  if (line.length > 0 || lines.length === 0) lines.push(line);
  return lines;
}
