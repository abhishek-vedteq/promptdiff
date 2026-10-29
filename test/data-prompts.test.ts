import { writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { extractDataPrompt, listDataPrompts } from "../src/data-prompts.js";
import { loadPrompt, parsePromptSpec } from "../src/prompt-source.js";
import { discoverPrompts } from "../src/prompts.js";
import { makeRepo } from "./helpers.js";

const YAML = `support:
  system: |
    You are the support assistant for Acme.
    Be brief.
  temperature: 0.2
agents:
  - name: router
    instructions: Route each message to billing, tech, or other. Reply with one word.
short_prompt: hi
`;

describe("prompts in YAML and JSON", () => {
  it("reads values by key path, from YAML and JSON", () => {
    expect(extractDataPrompt("p.yaml", YAML, "support.system")).toBe("You are the support assistant for Acme.\nBe brief.\n");
    expect(extractDataPrompt("p.yaml", YAML, "agents[0].instructions")).toMatch(/^Route each message/);
    expect(extractDataPrompt("p.json", JSON.stringify({ a: { "system-prompt": "x".repeat(30) } }), "a.system-prompt")).toBe("x".repeat(30));
  });

  it("explains missing keys and non-text values", () => {
    expect(() => extractDataPrompt("p.yaml", YAML, "support.nope")).toThrow(/nothing at "support.nope"/);
    expect(() => extractDataPrompt("p.yaml", YAML, "support.temperature")).toThrow(/isn't text \(it's number\)/);
  });

  it("lists prompt-like keys holding real text", () => {
    expect(listDataPrompts("p.yaml", YAML)).toEqual(["support.system", "agents[0].instructions"]);
  });

  it("parses key paths in specs only for data files", () => {
    expect(parsePromptSpec("p.yaml#agents[0].instructions")).toEqual({ file: "p.yaml", name: "agents[0].instructions" });
    expect(parsePromptSpec("p.ts#a.b")).toEqual({ file: "p.ts#a.b" });
  });

  it("compares git versions and discovers changed keys", async () => {
    const repo = makeRepo({ "config/prompts.yaml": YAML });
    writeFileSync(path.join(repo, "config/prompts.yaml"), YAML.replace("Be brief.", "Be brief and warm."));
    expect((await loadPrompt("config/prompts.yaml#support.system", { ref: "HEAD" }, repo)).text).toContain("Be brief.\n");
    expect((await loadPrompt("config/prompts.yaml#support.system", "working", repo)).text).toContain("Be brief and warm.");
    await expect(loadPrompt("config/prompts.yaml", "working", repo)).rejects.toMatchObject({ hint: expect.stringContaining("config/prompts.yaml#support.system") });
    const found = await discoverPrompts(repo, "HEAD");
    expect(found).toEqual([
      { path: "config/prompts.yaml#support.system", changed: true, added: 1, removed: 1 },
      { path: "config/prompts.yaml#agents[0].instructions", changed: false },
    ]);
  });
});
