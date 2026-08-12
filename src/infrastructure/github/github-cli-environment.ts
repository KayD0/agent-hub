import * as os from "node:os";
import * as path from "node:path";

export function githubCliConfigDirectory(environment: NodeJS.ProcessEnv = process.env, platform = process.platform): string {
  const configured = environment.GH_CONFIG_DIR?.trim();
  if (configured) return path.resolve(configured);
  if (platform === "win32") return path.join(environment.APPDATA?.trim() || path.join(os.homedir(), "AppData", "Roaming"), "GitHub CLI");
  return path.join(environment.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), ".config"), "gh");
}

export function sharedGitHubEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...environment, GH_CONFIG_DIR: githubCliConfigDirectory(environment) };
}
