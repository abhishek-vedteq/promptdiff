import { readFileSync } from "node:fs";

/** Reads the version from package.json (one level above src/ and dist/). */
export function getVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}
