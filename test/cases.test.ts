import { describe, expect, it } from "vitest";
import { parseCases } from "../src/cases.js";

describe("parseCases", () => {
  it("parses JSONL, skipping blank lines and a BOM", () => {
    const text = '\uFEFF{"id":"a","input":"hello"}\n\n{"input":"no id"}\r\n{"id":7,"input":"num id","metadata":{"k":1}}\n';
    const cases = parseCases(text);
    expect(cases.map((c) => c.id)).toEqual(["a", "line-3", "7"]);
    expect(cases[2]!.metadata).toEqual({ k: 1 });
    expect(cases[1]!.line).toBe(3);
  });

  it("reports the line number of invalid JSON", () => {
    expect(() => parseCases('{"input":"ok"}\n{"input": oops}\n', "c.jsonl")).toThrow(/^c\.jsonl:2: invalid JSON/);
  });

  it("requires an input string", () => {
    expect(() => parseCases('{"id":"x"}', "c.jsonl")).toThrow(/c\.jsonl:1: .*input/);
    expect(() => parseCases('{"input": 5}', "c.jsonl")).toThrow(/c\.jsonl:1:/);
  });

  it("rejects non-object lines", () => {
    expect(() => parseCases('["input"]', "c.jsonl")).toThrow(/c\.jsonl:1: expected a JSON object/);
  });

  it("rejects duplicate ids", () => {
    expect(() => parseCases('{"id":"a","input":"1"}\n{"id":"a","input":"2"}', "c.jsonl")).toThrow(/line 1/);
  });

  it("rejects empty files", () => {
    expect(() => parseCases("\n\n", "c.jsonl")).toThrow(/no test cases/);
  });
});
