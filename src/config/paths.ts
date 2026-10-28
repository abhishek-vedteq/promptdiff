import os from "node:os";
import path from "node:path";

/**
 * Directory for the user config file:
 * - $PROMPTDIFF_CONFIG_DIR if set (useful for tests and unusual setups)
 * - Windows: %APPDATA%\promptdiff
 * - elsewhere: $XDG_CONFIG_HOME/promptdiff or ~/.config/promptdiff
 */
export function userConfigDir(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string {
  if (env.PROMPTDIFF_CONFIG_DIR) return env.PROMPTDIFF_CONFIG_DIR;
  if (platform === "win32") {
    const appData = env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
    return path.join(appData, "promptdiff");
  }
  const xdg = env.XDG_CONFIG_HOME;
  return path.join(xdg && xdg.trim() !== "" ? xdg : path.join(os.homedir(), ".config"), "promptdiff");
}

export function userConfigPath(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string {
  return path.join(userConfigDir(env, platform), "config.json");
}
