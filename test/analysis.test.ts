import { describe, expect, it } from "vitest";
import { classify, wordDistance } from "../src/analysis.js";

describe("wordDistance", () => {
  it("is 0 for identical text (ignoring outer whitespace) and 1 for disjoint", () => {
    expect(wordDistance("a b c", "  a b c\n")).toBe(0);
    expect(wordDistance("a b c", "x y z")).toBe(1);
  });

  it("is proportional to the share of changed words", () => {
    const d = wordDistance("one two three four", "one two three five");
    expect(d).toBeGreaterThan(0.2);
    expect(d).toBeLessThan(0.3);
  });
});

describe("classify", () => {
  it("identical when every output matches", () => {
    expect(classify(["Hello"], ["Hello "]).status).toBe("identical");
    expect(classify(["a", "a", "a"], ["a", "a", "a"]).status).toBe("identical");
  });

  it("changed when there's any difference and only one run (no noise estimate)", () => {
    expect(classify(["Hello there"], ["Hello friend"]).status).toBe("changed");
  });

  it("changed when runs are deterministic within a version but differ across versions", () => {
    const r = classify(["refund approved", "refund approved"], ["refund denied", "refund denied"]);
    expect(r.status).toBe("changed");
    expect(r.stats.withinBase).toBe(0);
  });

  it("noise when versions differ no more than runs of the same version do", () => {
    const base = [
      "Sure, I can help you with your refund today.",
      "Of course, I can help with your refund right away.",
      "Happy to help you with the refund today.",
    ];
    const head = [
      "Sure, I can help with your refund right away.",
      "Of course, I can help you with the refund today.",
      "Happy to help with your refund today.",
    ];
    const r = classify(base, head);
    expect(r.status).toBe("noise");
    expect(r.stats.between).toBeLessThanOrEqual(Math.max(r.stats.withinBase!, r.stats.withinHead!) * 1.5 + 0.05);
  });

  it("changed when the difference clearly exceeds natural variation", () => {
    const base = [
      "Sure, I can help you with your refund today.",
      "Of course, I can help with your refund today.",
      "Sure, I can help with your refund today.",
    ];
    const head = [
      "I'm sorry, but refunds are not available for this order type. Please contact billing.",
      "Unfortunately refunds are not available for this order type. Please contact the billing team.",
      "I'm sorry, refunds are not possible for this order type. Contact billing for options.",
    ];
    expect(classify(base, head).status).toBe("changed");
  });
});
