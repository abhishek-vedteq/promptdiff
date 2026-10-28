import * as p from "@clack/prompts";
import { ANT_INSTALL_HINT, antLogin, antTokenSource, findAnt, runInteractive } from "../ant.js";
import { cliLoginCheckers } from "../auth.js";
import { maskKey, setKey } from "../config/keys.js";
import { userConfigPath } from "../config/paths.js";
import { PromptdiffError } from "../errors.js";
import { findExecutable } from "../exec.js";
import { getProviderDefinition } from "../providers/registry.js";
import type { ProviderDefinition } from "../providers/types.js";
import { accent } from "../ui/theme.js";
import { gatherStatus } from "./status.js";

class LoginCancelled extends Error {}

/** Stops the wizard if the user pressed Ctrl+C / Esc. */
function orExit<T>(value: T): Exclude<T, symbol> {
  if (p.isCancel(value)) throw new LoginCancelled();
  return value as Exclude<T, symbol>;
}

const MODEL_HINT: Record<string, string> = {
  anthropic: "--model anthropic:claude-opus-5-5",
  openai: "--model openai:<model-id>",
  google: "--model google:<model-id>",
  "claude-code": "--model claude-code:default",
  codex: "--model codex:default",
};

async function loginWithKey(def: ProviderDefinition): Promise<boolean> {
  if (def.keyUrl) p.log.info(`Create a key at ${def.keyUrl}`);
  for (;;) {
    const key = orExit(await p.password({ message: `Paste your ${def.displayName} API key`, validate: (v) => (v?.trim() ? undefined : "Paste a key, or press Esc to cancel") })).trim();
    if (def.verifyKey) {
      const s = p.spinner();
      s.start("Checking the key");
      try {
        await def.verifyKey(key);
        s.stop("Key works");
      } catch (err) {
        if (err instanceof PromptdiffError) {
          s.error(err.message);
          if (orExit(await p.confirm({ message: "Try a different key?" }))) continue;
          return false;
        }
        s.error(`Couldn't reach ${def.displayName} to check the key`);
        if (!orExit(await p.confirm({ message: "Save it anyway?", initialValue: false }))) return false;
      }
    }
    await setKey(def.id, key);
    p.log.success(`Saved ${maskKey(key)} to ${userConfigPath()} (readable only by you)`);
    if (def.envVar && process.env[def.envVar]) {
      p.log.warn(`${def.envVar} is set in your environment, and it takes precedence over the saved key.`);
    }
    return true;
  }
}

async function loginWithAnt(): Promise<boolean> {
  if (!findAnt()) {
    p.note(ANT_INSTALL_HINT, "Install Anthropic's ant CLI first");
    p.log.info("Then run `promptdiff login anthropic` again.");
    return false;
  }
  p.log.step("Opening your browser to sign in to the Claude Console…");
  if (!(await antLogin())) {
    p.log.error("`ant auth login` didn't complete.");
    return false;
  }
  const s = p.spinner();
  s.start("Checking the login");
  try {
    await antTokenSource()();
    s.stop("Signed in. promptdiff will get fresh tokens from `ant` automatically.");
    if (process.env.ANTHROPIC_API_KEY) p.log.warn("ANTHROPIC_API_KEY is set in your environment, and it takes precedence over the browser login.");
    return true;
  } catch (err) {
    s.error((err as Error).message);
    return false;
  }
}

async function loginWithCli(def: ProviderDefinition): Promise<boolean> {
  const bin = def.id === "claude-code" ? "claude" : "codex";
  const name = def.id === "claude-code" ? "Claude Code" : "Codex CLI";
  const check = cliLoginCheckers[def.id]!;
  let status = await check();
  if (!status.installed) {
    p.note(
      def.id === "claude-code"
        ? "Install Claude Code: https://claude.com/claude-code"
        : "Install the Codex CLI:  npm install -g @openai/codex",
      `${name} isn't installed`,
    );
    return false;
  }
  if (!status.loggedIn) {
    p.log.step(`Starting \`${bin} ${def.id === "claude-code" ? "auth login" : "login"}\`…`);
    await runInteractive(findExecutable(bin)!, def.id === "claude-code" ? ["auth", "login"] : ["login"]);
    status = await check();
    if (!status.loggedIn) {
      p.log.error(`${name} still isn't logged in.`);
      return false;
    }
  }
  p.log.success(`${name} is logged in${status.method ? ` (${status.method})` : ""}.`);
  p.note(
    [
      `promptdiff runs your prompts through \`${bin}\` and never reads its credentials.`,
      "Calls count against that account's usage limits.",
      "Single-turn cases only; temperature and max tokens are ignored.",
      "Token counts include the CLI's own overhead, so costs show as unknown.",
    ].join("\n"),
    "How this works",
  );
  return true;
}

/** Runs the login wizard. Returns whether a provider ended up set up. */
export async function loginCommand(providerArg?: string): Promise<boolean> {
  try {
    return await loginWizard(providerArg);
  } catch (err) {
    if (err instanceof LoginCancelled) {
      p.cancel("Login cancelled. Nothing was changed.");
      return false;
    }
    throw err;
  }
}

async function loginWizard(providerArg?: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    throw new PromptdiffError("`promptdiff login` is interactive and needs a terminal.", {
      hint: "In scripts and CI, set an environment variable (e.g. ANTHROPIC_API_KEY) or pipe a key into `promptdiff config set <provider>`.",
    });
  }
  p.intro(accent(" promptdiff login "));

  let def: ProviderDefinition;
  if (providerArg) {
    def = getProviderDefinition(providerArg);
  } else {
    const s = p.spinner();
    s.start("Checking what's already set up");
    const statuses = await gatherStatus();
    s.stop("Here's what promptdiff can use:");
    const id = orExit(
      await p.select({
        message: "Which provider do you want to set up?",
        options: statuses.map((st) => ({
          value: st.def.id,
          label: st.def.displayName,
          hint: `${st.ready ? "✓ " : ""}${st.detail}`,
        })),
      }),
    );
    def = getProviderDefinition(id);
  }

  let ok: boolean;
  if (def.kind === "cli") {
    ok = await loginWithCli(def);
  } else if (def.id === "anthropic") {
    const method = orExit(
      await p.select({
        message: "How do you want to sign in to Anthropic?",
        options: [
          { value: "key", label: "Paste an API key" },
          { value: "browser", label: "Sign in with your browser", hint: "uses Anthropic's ant CLI; billed to your Console account" },
        ],
      }),
    );
    ok = method === "browser" ? await loginWithAnt() : await loginWithKey(def);
  } else {
    ok = await loginWithKey(def);
  }

  if (!ok) {
    p.outro("Not set up. Run `promptdiff login` to try again.");
    return false;
  }
  p.outro(`You're ready. Try:  promptdiff prompts/support.md --base main ${MODEL_HINT[def.id] ?? ""}`.trimEnd());
  return true;
}
