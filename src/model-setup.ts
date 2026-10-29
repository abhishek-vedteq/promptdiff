import { resolveCredential } from "./auth.js";
import { missingKeyError, readUserConfig } from "./config/keys.js";
import { detectDefaultModel } from "./detect.js";
import { PromptdiffError } from "./errors.js";
import { getProviderDefinition, parseModelSpec } from "./providers/registry.js";
import type { Credential, Provider } from "./providers/types.js";

export interface ModelSetup {
  provider: Provider;
  modelId: string;
  /** "provider:model-id" */
  modelSpec: string;
  secrets: string[];
}

/** Picks the model (explicit, configured, or detected) and creates its provider with the right credential. */
export async function setupModel(args: {
  model?: string;
  env: NodeJS.ProcessEnv;
  userConfigFile?: string;
  createProvider?: (providerId: string, credential: Credential) => Provider;
}): Promise<ModelSetup> {
  const userConfig = await readUserConfig(args.userConfigFile);
  const model = args.model ?? (await detectDefaultModel(userConfig, args.env))?.model;
  if (!model) throw new PromptdiffError("No model set up.", { hint: "Pass --model <provider:model>, set `model:` in promptdiff.config.yaml, or run `promptdiff login`." });
  const spec = parseModelSpec(model);
  const def = getProviderDefinition(spec.provider);
  const credential = resolveCredential(def, userConfig, args.env);
  if (!credential) throw missingKeyError(def);
  return {
    provider: args.createProvider ? args.createProvider(spec.provider, credential.credential) : def.create(credential.credential),
    modelId: spec.model,
    modelSpec: `${spec.provider}:${spec.model}`,
    secrets: credential.secrets,
  };
}
