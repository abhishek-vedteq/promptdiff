import { cliLoginCheckers, resolveCredential } from "../auth.js";
import { readUserConfig } from "../config/keys.js";
import { userConfigPath } from "../config/paths.js";
import { listProviders } from "../providers/registry.js";
import type { ProviderDefinition } from "../providers/types.js";

export interface ProviderStatus {
  def: ProviderDefinition;
  ready: boolean;
  /** e.g. "sk-...a1b2 from ANTHROPIC_API_KEY", "logged in (claude.ai (max))", "not installed" */
  detail: string;
}

/** Works out which providers are usable right now, without printing or reading any CLI's credentials. */
export async function gatherStatus(env: NodeJS.ProcessEnv = process.env, configFile = userConfigPath()): Promise<ProviderStatus[]> {
  const config = await readUserConfig(configFile);
  return Promise.all(
    listProviders().map(async (def): Promise<ProviderStatus> => {
      if (def.kind === "cli") {
        const login = await cliLoginCheckers[def.id]?.(env);
        if (!login?.installed) return { def, ready: false, detail: "not installed" };
        if (!login.loggedIn) return { def, ready: false, detail: "installed, not logged in" };
        return { def, ready: true, detail: `logged in${login.method ? ` (${login.method})` : ""}` };
      }
      if (def.checkReady) {
        const r = await def.checkReady(env);
        return { def, ready: r.ready, detail: r.detail };
      }
      const resolved = resolveCredential(def, config, env);
      return resolved ? { def, ready: true, detail: resolved.label } : { def, ready: false, detail: "not set up" };
    }),
  );
}
