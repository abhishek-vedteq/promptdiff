/**
 * Field-by-field comparison for outputs that are JSON, so "confidence: 0.9 → 0.6" is shown
 * instead of a word diff of the raw text, and reordered keys or whitespace don't count as changes.
 */

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** Parses an output as JSON: plain JSON, or a single ```json fenced block. Objects and arrays only. */
export function parseJsonOutput(text: string): JsonValue | undefined {
  let body = text.trim();
  const fence = body.match(/^```(?:json|JSON)?\s*\n([\s\S]*?)\n?```$/);
  if (fence) body = fence[1]!.trim();
  if (!body.startsWith("{") && !body.startsWith("[")) return undefined;
  try {
    const value = JSON.parse(body) as JsonValue;
    return typeof value === "object" && value !== null ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Flattens to leaf paths: {a: {b: [1]}} → "a.b[0]" → 1. Empty objects/arrays are leaves too. */
export function flatten(value: JsonValue, prefix = "", out = new Map<string, JsonValue>()): Map<string, JsonValue> {
  if (Array.isArray(value)) {
    if (value.length === 0) out.set(prefix || "(root)", []);
    value.forEach((v, i) => flatten(v, `${prefix}[${i}]`, out));
  } else if (value !== null && typeof value === "object") {
    const keys = Object.keys(value);
    if (keys.length === 0) out.set(prefix || "(root)", {});
    for (const k of keys) flatten(value[k]!, prefix ? `${prefix}.${k}` : k, out);
  } else {
    out.set(prefix || "(root)", value);
  }
  return out;
}

export interface JsonChange {
  path: string;
  kind: "added" | "removed" | "changed";
  before?: JsonValue;
  after?: JsonValue;
}

const same = (a: JsonValue | undefined, b: JsonValue | undefined) => JSON.stringify(a) === JSON.stringify(b);

/** Every leaf that was added, removed, or changed, in the order of the new output. */
export function diffJson(before: JsonValue, after: JsonValue): JsonChange[] {
  const a = flatten(before);
  const b = flatten(after);
  const changes: JsonChange[] = [];
  for (const [path, value] of b) {
    if (!a.has(path)) changes.push({ path, kind: "added", after: value });
    else if (!same(a.get(path), value)) changes.push({ path, kind: "changed", before: a.get(path), after: value });
  }
  for (const [path, value] of a) if (!b.has(path)) changes.push({ path, kind: "removed", before: value });
  return changes;
}

/** Share of leaves that differ, in [0, 1]. */
export function jsonDistance(before: JsonValue, after: JsonValue): number {
  const a = flatten(before);
  const b = flatten(after);
  const all = new Set([...a.keys(), ...b.keys()]);
  if (all.size === 0) return 0;
  let differing = 0;
  for (const path of all) if (!same(a.get(path), b.get(path))) differing++;
  return differing / all.size;
}

/** Short display of a JSON value, e.g. "refund" → "\"refund\"", long strings clipped. */
export function showJson(value: JsonValue | undefined, max = 60): string {
  const text = JSON.stringify(value) ?? "undefined";
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
