// "Moon: Check setup": lists the models TrueForge has (with window sizes) and whether
// Moon's main and backup models are among them. Full details go to the "Moon" output channel.

import * as vscode from "vscode";
import type { ModelInfo } from "@moon/core";
import { checkMoonSetup, type SetupResult } from "./moon-setup.js";
import type { MoonStatusBar } from "./status-bar.js";

export async function runCheckSetup(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  statusBar: MoonStatusBar,
): Promise<void> {
  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: "Moon: checking setup" },
    () => checkMoonSetup(context),
  );
  statusBar.show(result);

  output.clear();
  for (const line of formatReport(result)) output.appendLine(line);

  const { ok, summary } = summarize(result);
  const details = "Show details";
  const choice = ok
    ? await vscode.window.showInformationMessage(summary, details)
    : await vscode.window.showWarningMessage(summary, details);
  if (choice === details) output.show(true);
}

function summarize(result: SetupResult): { ok: boolean; summary: string } {
  if (result.kind === "config-error") return { ok: false, summary: "Moon: the config file has a problem." };
  const { status, configuredModels } = result.report;
  if (status.state !== "connected") return { ok: false, summary: `Moon: ${status.message}` };
  const missing = configuredModels.filter((m) => !m.found);
  if (missing.length > 0) {
    return {
      ok: false,
      summary: `Moon: connected, but TrueForge is missing ${missing.map((m) => m.ref).join(", ")}. Run scripts/setup-providers.`,
    };
  }
  return { ok: true, summary: `Moon: setup OK. ${status.models.length} models in TrueForge, main and backup found.` };
}

function formatReport(result: SetupResult): string[] {
  const lines = [`Moon setup check (${new Date().toLocaleString()})`, "", `Config:     ${result.configPath}`];
  if (result.kind === "config-error") {
    lines.push("", result.message, "", "Fix the file above (copy config/moon.example.json if it is missing).");
    return lines;
  }

  const { status, configuredModels, baseUrl } = result.report;
  lines.push(`TrueForge:  ${baseUrl}`);
  if (status.state !== "connected") {
    lines.push(`Status:     ${status.state === "unreachable" ? "not reachable" : "error"}`, "", status.message);
    if (status.state === "unreachable") lines.push("Start it with scripts/start-trueforge.");
    return lines;
  }

  lines.push("Status:     connected", "", `Models in TrueForge (${status.models.length}):`);
  const width = Math.max(0, ...status.models.map((m) => m.ref.length));
  for (const m of status.models) lines.push(`  ${m.ref.padEnd(width)}  ${limits(m)}`);

  lines.push("", "Moon's models (config/moon.json):");
  for (const m of configuredModels) {
    const state = m.found ? "found" : "NOT in TrueForge (run scripts/setup-providers)";
    lines.push(`  ${m.role.padEnd(6)}  ${m.ref}  ${state}`);
  }
  return lines;
}

function limits(m: ModelInfo): string {
  const n = (v: number | undefined) => (v === undefined ? "unknown" : v.toLocaleString("en-US"));
  return `window ${n(m.contextLength)} tokens, max output ${n(m.maxOutputTokens)}`;
}
