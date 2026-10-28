import { describe, expect, it } from "vitest";
import { assertionSchema, evaluateAssertions, tally, type Assertion } from "../src/assertions.js";
import { parseCases } from "../src/cases.js";

const run = async (a: Assertion, output: string) => (await evaluateAssertions([a], output))[0]!;

describe("assertions", () => {
  it("text checks", async () => {
    expect((await run({ type: "contains", value: "refund" }, "Your refund is on its way")).pass).toBe(true);
    expect((await run({ type: "contains", value: "REFUND" }, "your refund")).pass).toBe(false);
    expect((await run({ type: "contains", value: "REFUND", ignoreCase: true }, "your refund")).pass).toBe(true);
    expect((await run({ type: "not-contains", value: "sorry" }, "I'm sorry")).pass).toBe(false);
    expect((await run({ type: "equals", value: "yes" }, " yes\n")).pass).toBe(true);
    expect((await run({ type: "starts-with", value: "Hi" }, "  Hi there")).pass).toBe(true);
  });

  it("regex checks", async () => {
    expect((await run({ type: "regex", value: "#\\d{4}" }, "order #4821")).pass).toBe(true);
    expect((await run({ type: "regex", value: "^yes$", flags: "i" }, "YES")).pass).toBe(true);
    expect((await run({ type: "not-regex", value: "\\bAI\\b" }, "As an AI model")).pass).toBe(false);
  });

  it("length checks", async () => {
    expect(await run({ type: "max-words", value: 3 }, "one two three four")).toMatchObject({ pass: false, reason: "4 words" });
    expect((await run({ type: "min-words", value: 3 }, "one two three")).pass).toBe(true);
    expect((await run({ type: "max-chars", value: 5 }, "123456")).pass).toBe(false);
    expect((await run({ type: "min-chars", value: 5 }, "12345")).pass).toBe(true);
  });

  it("JSON and JSON schema checks", async () => {
    expect((await run({ type: "is-json" }, '{"a": 1}')).pass).toBe(true);
    expect((await run({ type: "is-json" }, "```json\n{}\n```")).reason).toMatch(/not valid JSON/);
    const schema = { type: "object", required: ["intent"], properties: { intent: { enum: ["refund", "other"] } } };
    expect((await run({ type: "is-json", schema }, '{"intent": "refund"}')).pass).toBe(true);
    const bad = await run({ type: "is-json", schema }, '{"intent": "cancel"}');
    expect(bad.pass).toBe(false);
    expect(bad.reason).toMatch(/does not match schema.*intent/);
  });

  it("llm-rubric uses the grader, and fails cleanly without one", async () => {
    const rubric: Assertion = { type: "llm-rubric", value: "Is polite" };
    expect(await run(rubric, "hi")).toMatchObject({ pass: false, reason: "no judge model configured" });
    const [r] = await evaluateAssertions([rubric], "hi", async () => ({ pass: true, reason: "polite" }));
    expect(r).toMatchObject({ pass: true, reason: "polite", label: 'llm-rubric "Is polite"' });
    const [e] = await evaluateAssertions([rubric], "hi", async () => {
      throw new Error("timeout");
    });
    expect(e).toMatchObject({ pass: false, reason: "judge error: timeout" });
  });

  it("validates assertion definitions", () => {
    expect(assertionSchema.safeParse({ type: "contains" }).success).toBe(false);
    expect(assertionSchema.safeParse({ type: "regex", value: "(" }).success).toBe(false);
    expect(assertionSchema.safeParse({ type: "nope", value: "x" }).success).toBe(false);
    expect(assertionSchema.safeParse({ type: "max-words", value: -1 }).success).toBe(false);
  });

  it("tallies results across runs", () => {
    expect(tally([[{ label: "a", pass: true }, { label: "b", pass: false }], [{ label: "a", pass: true }]])).toEqual({ passed: 2, total: 3 });
  });
});

describe("assertions in cases.jsonl", () => {
  it("parses assert arrays", () => {
    const [c] = parseCases('{"input": "x", "assert": [{"type": "contains", "value": "y"}]}');
    expect(c!.assert).toEqual([{ type: "contains", value: "y" }]);
  });

  it("reports bad assertions with the line number", () => {
    expect(() => parseCases('{"input": "x"}\n{"input": "x", "assert": [{"type": "contain", "value": "y"}]}', "c.jsonl")).toThrow(/^c\.jsonl:2:/);
    expect(() => parseCases('{"input": "x", "assert": [{"type": "is-json", "schema": {"type": "nope"}}]}', "c.jsonl")).toThrow(/c\.jsonl:1: invalid JSON schema/);
  });

  it("rejects unknown fields so typos are caught", () => {
    expect(() => parseCases('{"input": "x", "asserts": []}', "c.jsonl")).toThrow(/c\.jsonl:1:.*asserts/);
  });
});
