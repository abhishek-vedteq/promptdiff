import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveCredential } from "../src/auth.js";
import { maskKey, readUserConfig, redactSecrets, removeKey, setKey } from "../src/config/keys.js";
import { userConfigDir } from "../src/config/paths.js";
import { parseProjectConfig } from "../src/config/project.js";
import { resolveRunOptions } from "../src/config/resolve.js";
import { getProviderDefinition, parseModelSpec } from "../src/providers/registry.js";
import { tempDir } from "./helpers.js";

const anthropic = getProviderDefinition("anthropic");

describe("user config / keys", () => {
  it("stores keys with 0600 permissions and can remove them", async () => {
    const file = path.join(tempDir(), "nested", "config.json");
    await setKey("anthropic", "sk-ant-secret-123456", file);
    expect((await readUserConfig(file)).keys.anthropic).toBe("sk-ant-secret-123456");
    if (process.platform !== "win32") {
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(statSync(path.dirname(file)).mode & 0o077).toBe(0);
    }
    await setKey("openai", "sk-openai-abcdef", file);
    expect(await removeKey("anthropic", file)).toBe(true);
    expect(await removeKey("anthropic", file)).toBe(false);
    expect(JSON.parse(readFileSync(file, "utf8")).keys).toEqual({ openai: "sk-openai-abcdef" });
  });

  it("environment variables take precedence over the config file", () => {
    const config = { keys: { anthropic: "from-file-key-0000" } };
    expect(resolveCredential(anthropic, config, {})).toMatchObject({ credential: { kind: "api-key", key: "from-file-key-0000" }, source: "config" });
    expect(resolveCredential(anthropic, config, { ANTHROPIC_API_KEY: "from-env-key-1111" })).toMatchObject({ credential: { key: "from-env-key-1111" }, source: "env" });
    expect(resolveCredential(anthropic, { keys: {} }, { ANTHROPIC_API_KEY: "  " })).toBeUndefined();
  });

  it("masks keys", () => {
    expect(maskKey("sk-ant-api03-abcdefghijklmnopa1b2")).toBe("sk-...a1b2");
    expect(maskKey("short")).toBe("****");
    expect(redactSecrets("bad key sk-ant-api03-abcdefghijklmnopa1b2!", ["sk-ant-api03-abcdefghijklmnopa1b2"])).toBe("bad key sk-...a1b2!");
  });

  it("uses OS-appropriate config locations", () => {
    expect(userConfigDir({ PROMPTDIFF_CONFIG_DIR: "/x" }, "linux")).toBe("/x");
    expect(userConfigDir({ XDG_CONFIG_HOME: "/xdg" }, "linux")).toBe(path.join("/xdg", "promptdiff"));
    expect(userConfigDir({ APPDATA: "C:\\Users\\me\\AppData\\Roaming" }, "win32")).toContain("promptdiff");
  });
});

describe("project config", () => {
  it("validates with helpful errors", () => {
    expect(parseProjectConfig("model: anthropic:x\nruns: 3\n")).toEqual({ model: "anthropic:x", runs: 3 });
    expect(() => parseProjectConfig("runs: 0")).toThrow(/runs/);
    expect(() => parseProjectConfig("modle: x")).toThrow(/invalid/);
    expect(() => parseProjectConfig("temperature: hot")).toThrow(/temperature/);
    expect(parseProjectConfig("")).toEqual({});
  });

  it("CLI flags override the config file, which overrides defaults", () => {
    const cwd = tempDir();
    const configFile = path.join(cwd, "sub", "promptdiff.config.yaml");
    const project = { model: "anthropic:a", runs: 3, concurrency: 8, cases: "my-cases.jsonl", temperature: 0.2 };

    const fromConfig = resolveRunOptions({}, project, configFile, cwd);
    expect(fromConfig).toMatchObject({ model: "anthropic:a", runs: 3, concurrency: 8, temperature: 0.2, base: "HEAD", cache: true });
    expect(fromConfig.casesFile).toBe(path.join(cwd, "sub", "my-cases.jsonl"));

    const fromFlags = resolveRunOptions(
      { model: "openai:b", runs: "5", concurrency: "2", cases: "c.jsonl", temperature: "0", cache: false, base: "main" },
      project, configFile, cwd,
    );
    expect(fromFlags).toMatchObject({ model: "openai:b", runs: 5, concurrency: 2, temperature: 0, cache: false, base: "main" });
    expect(fromFlags.casesFile).toBe(path.join(cwd, "c.jsonl"));

    const defaults = resolveRunOptions({ model: "anthropic:a" }, {}, undefined, cwd);
    expect(defaults).toMatchObject({ runs: 1, concurrency: 4, temperature: undefined });
    expect(defaults.casesFile).toBe(path.join(cwd, "cases.jsonl"));
  });

  it("requires a model and validates numeric flags", () => {
    expect(() => resolveRunOptions({}, {}, undefined, "/")).toThrow(/No model/);
    expect(() => resolveRunOptions({ model: "a:b", runs: "two" }, {}, undefined, "/")).toThrow(/--runs/);
    expect(() => resolveRunOptions({ model: "a:b", temperature: "5" }, {}, undefined, "/")).toThrow(/--temperature/);
  });
});

describe("parseModelSpec", () => {
  it("splits on the first colon and passes model ids through", () => {
    expect(parseModelSpec("anthropic:claude-x")).toEqual({ provider: "anthropic", model: "claude-x" });
    expect(parseModelSpec("openai:ft:gpt:org::id")).toEqual({ provider: "openai", model: "ft:gpt:org::id" });
    expect(parseModelSpec("gemini:some-model")).toEqual({ provider: "google", model: "some-model" });
  });

  it("rejects bad specs", () => {
    expect(() => parseModelSpec("claude-x")).toThrow(/<provider>:<model-id>/);
    expect(() => parseModelSpec("nope:model")).toThrow(/Unknown provider/);
  });
});
