import { describe, expect, it } from "vitest";
import { classify, outputDistance } from "../src/analysis.js";
import { diffJson, flatten, jsonDistance, parseJsonOutput } from "../src/json-diff.js";
import { jsonLines } from "../src/report/terminal.js";
import { Chalk } from "chalk";

describe("JSON outputs", () => {
  it("parses plain and fenced JSON, and rejects non-JSON", () => {
    expect(parseJsonOutput('{"a": 1}')).toEqual({ a: 1 });
    expect(parseJsonOutput('```json\n[1, 2]\n```')).toEqual([1, 2]);
    expect(parseJsonOutput("Sure! {\"a\": 1}")).toBeUndefined();
    expect(parseJsonOutput('"just a string"')).toBeUndefined();
  });

  it("flattens to leaf paths and diffs field by field", () => {
    expect([...flatten({ a: { b: [1, { c: true }] }, d: [] }).keys()]).toEqual(["a.b[0]", "a.b[1].c", "d"]);
    const changes = diffJson({ intent: "refund", confidence: 0.9, tags: ["billing"], notes: "x" }, { intent: "refund", confidence: 0.6, tags: ["billing", "urgent"] });
    expect(changes).toEqual([
      { path: "confidence", kind: "changed", before: 0.9, after: 0.6 },
      { path: "tags[1]", kind: "added", after: "urgent" },
      { path: "notes", kind: "removed", before: "x" },
    ]);
  });

  it("measures distance by fields, ignoring key order and whitespace", () => {
    expect(outputDistance('{"a": 1, "b": 2}', '{\n  "b": 2,\n  "a": 1\n}')).toBe(0);
    expect(jsonDistance({ a: 1, b: 2 }, { a: 1, b: 3 })).toBe(0.5);
    expect(classify(['{"a": 1, "b": 2}'], ['{"b":2,"a":1}']).status).toBe("identical");
    expect(classify(['{"intent": "refund"}'], ['{"intent": "cancel"}']).status).toBe("changed");
  });

  it("renders changed fields in the terminal", () => {
    const lines = jsonLines(new Chalk({ level: 0 }), '{"intent": "refund", "confidence": 0.9}', '{"intent": "refund", "confidence": 0.6, "escalate": true}')!;
    expect(lines.join("\n")).toBe(['  JSON: 2 fields changed', '  ~ confidence: 0.9 → 0.6', '  + escalate: true'].join("\n"));
    expect(jsonLines(new Chalk({ level: 0 }), "hello", '{"a": 1}')).toBeUndefined();
  });
});
