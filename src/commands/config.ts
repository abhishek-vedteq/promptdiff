import chalk, { Chalk } from "chalk";
import { maskKey, removeKey, setKey } from "../config/keys.js";
import { userConfigPath } from "../config/paths.js";
import { PromptdiffError } from "../errors.js";
import { getProviderDefinition } from "../providers/registry.js";
import { glyph, nest } from "../ui/theme.js";
import { gatherStatus } from "./status.js";

type Out = { write(s: string): unknown };

function keyedProvider(id: string) {
  const def = getProviderDefinition(id);
  if (def.requiresKey === false) {
    throw new PromptdiffError(`The "${def.id}" provider doesn't use an API key.`, {
      hint: def.kind === "cli" ? `It uses the CLI's own login. Run \`promptdiff login ${def.id}\` to check or set it up.` : undefined,
    });
  }
  return def;
}

/** Reads a line from the terminal without echoing it. */
function readHidden(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stderr.write(prompt);
    let value = "";
    const cleanup = () => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          cleanup();
          process.stderr.write("\n");
          resolve(value);
          return;
        }
        if (ch === "\u0003") {
          cleanup();
          process.stderr.write("\n");
          reject(new PromptdiffError("Cancelled."));
          return;
        }
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    stdin.resume();
    stdin.on("data", onData);
  });
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export async function configSet(providerId: string, key: string | undefined, out: Out = process.stdout): Promise<void> {
  const def = keyedProvider(providerId);
  let value = key;
  if (value === undefined) {
    value = process.stdin.isTTY ? await readHidden(`Paste your ${def.displayName} API key (input hidden): `) : await readStdin();
  }
  value = value.trim();
  if (!value) throw new PromptdiffError("No key provided.");
  const file = userConfigPath();
  await setKey(def.id, value, file);
  out.write(`Saved ${def.displayName} key ${maskKey(value)} to ${file}\n`);
  if (process.env[def.envVar]) {
    out.write(`Note: ${def.envVar} is set in your environment and takes precedence over the saved key.\n`);
  }
}

export async function configList(out: Out = process.stdout): Promise<void> {
  const file = userConfigPath();
  const c = new Chalk({ level: out === process.stdout ? chalk.level : 0 });
  const statuses = await gatherStatus(process.env, file);
  out.write(`${c.bold("Providers")} ${c.dim(`(keys saved in ${file})`)}\n`);
  const w = Math.max(...statuses.map((st) => st.def.id.length));
  const rows = statuses.map((st) => {
    const mark = st.ready ? c.green(glyph.ok) : c.dim("–");
    return `${mark} ${st.def.id.padEnd(w)}  ${st.ready ? st.detail : c.dim(st.detail)}`;
  });
  out.write(nest(rows, c).join("\n") + "\n");
  if (!statuses.some((st) => st.ready)) out.write(c.dim("\n  Nothing is set up yet. Run `promptdiff login` to get started.\n"));
}

export async function configRemove(providerId: string, out: Out = process.stdout): Promise<void> {
  const def = keyedProvider(providerId);
  const removed = await removeKey(def.id, userConfigPath());
  out.write(removed ? `Removed ${def.displayName} key.\n` : `No ${def.displayName} key was saved by promptdiff.\n`);
  if (process.env[def.envVar]) out.write(`Note: ${def.envVar} is still set in your environment.\n`);
  if (def.id === "anthropic") out.write("To sign out of a browser login, run `ant auth logout`.\n");
}
