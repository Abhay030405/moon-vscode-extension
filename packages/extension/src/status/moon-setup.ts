// Loads Moon's config and asks TrueForge for its status. Shared by the status bar and
// the "Moon: Check setup" command. Never throws: config problems become a status too.

import * as path from "node:path";
import * as vscode from "vscode";
import {
  CONFIG_DIR,
  CONFIG_FILE_NAME,
  ConfigError,
  loadMoonConfig,
  TrueForgeClient,
  type MoonConfig,
  type SetupReport,
} from "@moon/core";

export type SetupResult =
  | { kind: "ok"; configPath: string; config: MoonConfig; report: SetupReport }
  | { kind: "config-error"; configPath: string; message: string };

/**
 * Where config/moon.json is: the "moon.configPath" setting if set, otherwise the repo's
 * config folder next to the extension (the layout when running from a clone with F5).
 */
export function resolveConfigPath(context: vscode.ExtensionContext): string {
  const fromSetting = vscode.workspace.getConfiguration("moon").get<string>("configPath")?.trim();
  if (fromSetting) return fromSetting;
  return path.resolve(context.extensionPath, "..", "..", CONFIG_DIR, CONFIG_FILE_NAME);
}

/** Reads the config fresh each time, so edits apply without restarting VS Code. */
export async function checkMoonSetup(context: vscode.ExtensionContext): Promise<SetupResult> {
  const configPath = resolveConfigPath(context);
  let config: MoonConfig;
  try {
    config = loadMoonConfig(configPath);
  } catch (err) {
    if (err instanceof ConfigError) return { kind: "config-error", configPath, message: err.message };
    throw err;
  }
  const report = await new TrueForgeClient(config.trueforge).checkSetup(config.models);
  return { kind: "ok", configPath, config, report };
}
