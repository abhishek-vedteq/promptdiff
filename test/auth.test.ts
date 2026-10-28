import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { antTokenSource } from "../src/ant.js";
import { resolveCredential } from "../src/auth.js";
import { detectDefaultModel } from "../src/detect.js";
import { findExecutable } from "../src/exec.js";
import { getProviderDefinition } from "../src/providers/registry.js";
import { fakeBin, tempDir } from "./helpers.js";

const posixOnly = process.platform === "win32" ? it.skip : it;
const anthropic = getProviderDefinition("anthropic");

function antHome(): string {
  const home = tempDir("promptdiff-ant-");
  mkdirSync(path.join(home, "credentials"));
  writeFileSync(path.join(home, "credentials", "default.json"), "{}");
  return home;
}

describe("resolveCredential", () => {
  posixOnly("prefers env key > env token > saved key > ant browser login", () => {
    const antDir = fakeBin("ant", 'console.log("tok-from-ant-1234567890")');
    const base = { PATH: antDir, ANTHROPIC_CONFIG_DIR: antHome() };
    const saved = { keys: { anthropic: "sk-saved-key-000000" } };

    expect(resolveCredential(anthropic, saved, { ...base, ANTHROPIC_API_KEY: "sk-env-key-11111111", ANTHROPIC_AUTH_TOKEN: "tok-env" })?.source).toBe("env");
    expect(resolveCredential(anthropic, saved, { ...base, ANTHROPIC_AUTH_TOKEN: "tok-env-2222222222" })).toMatchObject({ source: "env-token", credential: { kind: "auth-token" } });
    expect(resolveCredential(anthropic, saved, base)?.source).toBe("config");
    expect(resolveCredential(anthropic, { keys: {} }, base)).toMatchObject({ source: "ant", label: "browser login via `ant` CLI" });
    expect(resolveCredential(anthropic, { keys: {} }, { PATH: antDir, ANTHROPIC_CONFIG_DIR: tempDir() })).toBeUndefined();
  });

  it("CLI providers need no key", () => {
    expect(resolveCredential(getProviderDefinition("claude-code"), { keys: {} }, {})).toMatchObject({ credential: { kind: "none" }, source: "cli" });
  });

  it("ANTHROPIC_AUTH_TOKEN is an OAuth token, not an API key", async () => {
    const r = resolveCredential(anthropic, { keys: {} }, { ANTHROPIC_AUTH_TOKEN: "tok-abcdef-123456" })!;
    expect(r.credential.kind).toBe("auth-token");
    if (r.credential.kind === "auth-token") expect(await r.credential.token()).toBe("tok-abcdef-123456");
    expect(r.label).not.toContain("abcdef");
  });
});

describe("ant token source", () => {
  posixOnly("asks ant for a token, caches it, and records it for redaction", async () => {
    const counter = path.join(tempDir(), "count");
    const dir = fakeBin(
      "ant",
      `const fs = require("fs"); const f = ${JSON.stringify(counter)};
       const n = fs.existsSync(f) ? Number(fs.readFileSync(f, "utf8")) + 1 : 1; fs.writeFileSync(f, String(n));
       if (process.env.ANTHROPIC_API_KEY) { console.log("api key leaked into ant"); process.exit(1); }
       if (process.argv.slice(2).join(" ") !== "auth print-credentials --access-token") process.exit(2);
       console.log("sk-ant-oat-token-" + n);`,
    );
    const seen: string[] = [];
    const token = antTokenSource({ PATH: dir, ANTHROPIC_API_KEY: "should-be-removed" }, (t) => seen.push(t));
    expect(await token()).toBe("sk-ant-oat-token-1");
    expect(await token()).toBe("sk-ant-oat-token-1"); // cached
    expect(seen).toEqual(["sk-ant-oat-token-1"]);
  });

  posixOnly("explains how to log in again when ant fails", async () => {
    const dir = fakeBin("ant", "process.exit(1)");
    await expect(antTokenSource({ PATH: dir })()).rejects.toMatchObject({ hint: expect.stringContaining("ant auth login") });
  });
});

describe("detectDefaultModel", () => {
  const none = async () => ({ installed: false, loggedIn: false });
  const loggedIn = async () => ({ installed: true, loggedIn: true, method: "claude.ai (max)" });

  it("prefers Anthropic credentials, then Claude Code, then Codex", async () => {
    expect((await detectDefaultModel({ keys: { anthropic: "sk-xxxxxxxxxxxx" } }, {}, { "claude-code": loggedIn, codex: loggedIn }))?.model).toBe("anthropic:claude-opus-5-5");
    const cc = await detectDefaultModel({ keys: {} }, {}, { "claude-code": loggedIn, codex: loggedIn });
    expect(cc).toEqual({ model: "claude-code:default", reason: "found your Claude Code login (claude.ai (max))" });
    expect((await detectDefaultModel({ keys: {} }, {}, { "claude-code": none, codex: loggedIn }))?.model).toBe("codex:default");
    expect(await detectDefaultModel({ keys: { openai: "sk-openai-xxxxx" } }, {}, { "claude-code": none, codex: none })).toBeUndefined();
  });
});

describe("findExecutable", () => {
  posixOnly("finds executables on PATH only", () => {
    const dir = fakeBin("thing", "");
    expect(findExecutable("thing", { PATH: dir })).toBe(path.join(dir, "thing"));
    expect(findExecutable("thing", { PATH: tempDir() })).toBeUndefined();
  });

  it("uses PATHEXT on Windows", () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, "tool.cmd"), "");
    expect(findExecutable("tool", { PATH: dir, PATHEXT: ".EXE;.CMD" }, "win32")).toBe(path.join(dir, "tool.cmd"));
  });
});

