/**
 * Prompts stored in YAML or JSON files, addressed by key path:
 * "prompts.yaml#support.system", "agents.json#agents[0].instructions".
 */
import { parse as parseYaml } from "yaml";
import { PromptdiffError } from "./errors.js";

const DATA_EXTENSIONS = [".yaml", ".yml", ".json"];
export const isDataFile = (file: string) => DATA_EXTENSIONS.some((ext) => file.toLowerCase().endsWith(ext));

/** Key paths: dotted keys (letters, digits, _ $ -) and [n] indexes. */
export const DATA_PATH = /^[\w$-]+(\[\d+\]|\.[\w$-]+)*$/;

/** Keys that usually hold prompt text. */
const PROMPT_KEY = /prompt|instruction|system|template|persona/i;

type Data = unknown;

function parse(file: string, source: string): Data {
  try {
    return parseYaml(source) as Data; // YAML is a superset of JSON
  } catch (err) {
    throw new PromptdiffError(`${file}: couldn't parse (${(err as Error).message.split("\n")[0]})`);
  }
}

const join = (prefix: string, key: string | number) => (typeof key === "number" ? `${prefix}[${key}]` : prefix ? `${prefix}.${key}` : key);

/** Key paths of text values whose key looks like a prompt (and that are long enough to be one). */
export function listDataPrompts(file: string, source: string): string[] {
  const out: string[] = [];
  const walk = (value: Data, path: string, key: string) => {
    if (typeof value === "string") {
      if (path && PROMPT_KEY.test(key) && value.trim().length >= 20 && DATA_PATH.test(path)) out.push(path);
    } else if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, join(path, i), key));
    } else if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) walk(v, join(path, k), k);
    }
  };
  walk(parse(file, source), "", "");
  return out;
}

/** Reads the text at a key path. */
export function extractDataPrompt(file: string, source: string, keyPath: string): string {
  let value: Data = parse(file, source);
  const parts = keyPath.match(/[^.[\]]+|\[\d+\]/g) ?? [];
  let walked = "";
  for (const part of parts) {
    const index = part.startsWith("[") ? Number(part.slice(1, -1)) : undefined;
    walked = index !== undefined ? `${walked}${part}` : walked ? `${walked}.${part}` : part;
    if (index !== undefined ? !Array.isArray(value) || index >= value.length : !value || typeof value !== "object" || Array.isArray(value) || !(part in value)) {
      const candidates = listDataPrompts(file, source);
      throw new PromptdiffError(`${file} has nothing at "${walked}".`, {
        hint: candidates.length ? `Prompt-like keys in this file: ${candidates.slice(0, 8).join(", ")}` : "Use a dotted key path, e.g. prompts.yaml#support.system",
      });
    }
    value = index !== undefined ? (value as Data[])[index] : (value as Record<string, Data>)[part];
  }
  if (typeof value !== "string") {
    throw new PromptdiffError(`${file}#${keyPath} isn't text (it's ${Array.isArray(value) ? "a list" : value === null ? "null" : typeof value}).`);
  }
  return value;
}
