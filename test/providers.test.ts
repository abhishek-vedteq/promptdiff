import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { resolveCredential } from "../src/auth.js";
import { estimateCost, hasPrice, loadBuiltinPricing } from "../src/pricing.js";
import { getProviderDefinition, listProviders, parseModelSpec } from "../src/providers/registry.js";

describe("more providers", () => {
  it("registers ollama, azure, and bedrock", () => {
    expect(listProviders().map((d) => d.id)).toEqual(expect.arrayContaining(["ollama", "azure", "bedrock"]));
    expect(parseModelSpec("ollama:llama3.2:3b")).toEqual({ provider: "ollama", model: "llama3.2:3b" });
  });

  it("checks whether a local Ollama server is running", async () => {
    const server = createServer((_req, res) => res.end(JSON.stringify({ data: [{ id: "llama3.2" }, { id: "qwen3" }] })));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    const ollama = getProviderDefinition("ollama");
    expect(await ollama.checkReady!({ OLLAMA_BASE_URL: `http://127.0.0.1:${port}/v1` })).toEqual({ ready: true, detail: "running, 2 models: llama3.2, qwen3" });
    server.close();
    expect((await ollama.checkReady!({ OLLAMA_BASE_URL: `http://127.0.0.1:${port}/v1` })).ready).toBe(false);
  });

  it("uses AWS credentials from the environment for Bedrock", () => {
    const bedrock = getProviderDefinition("bedrock");
    expect(resolveCredential(bedrock, { keys: {} }, { AWS_ACCESS_KEY_ID: "AKIA", AWS_SECRET_ACCESS_KEY: "s", AWS_REGION: "us-east-1" })).toMatchObject({
      credential: { kind: "none" },
      label: "AWS credentials from AWS_ACCESS_KEY_ID (us-east-1)",
    });
    expect(resolveCredential(bedrock, { keys: {} }, { AWS_BEARER_TOKEN_BEDROCK: "bedrock-api-key-123" })).toMatchObject({ credential: { kind: "api-key" } });
    expect(resolveCredential(bedrock, { keys: {} }, {})).toBeUndefined();
  });

  it("explains missing Azure settings", () => {
    const saved = { ...process.env };
    delete process.env.AZURE_RESOURCE_NAME;
    delete process.env.AZURE_OPENAI_BASE_URL;
    expect(() => getProviderDefinition("azure").create({ kind: "api-key", key: "k" })).toThrow(/needs your resource name/);
    process.env = saved;
  });

  it("prices local models at zero through a provider-wide entry", () => {
    const table = loadBuiltinPricing();
    expect(hasPrice(table, "ollama:anything")).toBe(true);
    expect(estimateCost(table, "ollama:llama3.2", 1000, 1000)).toBe(0);
    expect(hasPrice(table, "openai:some-model")).toBe(false);
  });
});

describe("built-in pricing file", () => {
  it("is valid and loads", () => {
    expect(Object.keys(loadBuiltinPricing()).length).toBeGreaterThan(5);
  });
});
