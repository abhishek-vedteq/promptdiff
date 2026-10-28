import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export interface CacheKeyParts {
  prompt: string;
  /** "provider:model-id" */
  model: string;
  temperature?: number;
  maxOutputTokens?: number;
  input: string;
  runIndex: number;
}

export interface CachedResult {
  text: string;
  inputTokens?: number;
  outputTokens?: number;
  latencyMs: number;
  createdAt: string;
}

const CACHE_VERSION = 1;

export function cacheKey(parts: CacheKeyParts): string {
  // Fixed field order so the hash is stable.
  const material = JSON.stringify([
    CACHE_VERSION,
    parts.prompt,
    parts.model,
    parts.temperature ?? null,
    parts.maxOutputTokens ?? null,
    parts.input,
    parts.runIndex,
  ]);
  return createHash("sha256").update(material).digest("hex");
}

/** File-based cache in `<dir>/<first two hex chars>/<hash>.json`. */
export class ResultCache {
  constructor(readonly dir: string) {}

  private file(key: string): string {
    return path.join(this.dir, key.slice(0, 2), `${key}.json`);
  }

  async get(key: string): Promise<CachedResult | undefined> {
    try {
      const value = JSON.parse(await readFile(this.file(key), "utf8")) as CachedResult;
      return typeof value.text === "string" ? value : undefined;
    } catch {
      return undefined; // missing or corrupt entries are treated as misses
    }
  }

  async set(key: string, value: CachedResult): Promise<void> {
    const file = this.file(key);
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    await writeFile(tmp, JSON.stringify(value));
    await rename(tmp, file);
  }
}

export function defaultCacheDir(repoRoot: string): string {
  return path.join(repoRoot, ".promptdiff", "cache");
}
