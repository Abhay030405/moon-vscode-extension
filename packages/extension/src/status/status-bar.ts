// Status bar item: "Moon: connected to TrueForge (N models)" or what is wrong.
// Re-checks in the background so stopping/starting TrueForge shows up without a reload.
// Checks never block the editor; a failed check is shown, never thrown.

import * as vscode from "vscode";
import { CONFIG_RETRY_MS } from "@moon/core";
import { CHECK_SETUP_COMMAND } from "../commands.js";
import { checkMoonSetup, type SetupResult } from "./moon-setup.js";

export class MoonStatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  private lastText: string | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
  ) {
    this.item.command = CHECK_SETUP_COMMAND;
    this.item.text = "$(sync~spin) Moon: checking TrueForge…";
    this.item.show();
  }

  /** Runs a check now, then keeps re-checking at trueforge.statusCheckIntervalMs. */
  start(): void {
    void this.refresh();
  }

  /** Shows a result produced elsewhere (e.g. by "Check setup") without waiting for the next poll. */
  show(result: SetupResult): void {
    const { text, tooltip, problem } = describe(result);
    this.item.text = text;
    this.item.tooltip = tooltip;
    this.item.backgroundColor = problem ? new vscode.ThemeColor("statusBarItem.warningBackground") : undefined;
    this.logChange(text, tooltip);
  }

  /** Writes status changes (not every poll) to the Moon output panel. */
  private logChange(text: string, detail: string): void {
    if (text === this.lastText) return;
    this.lastText = text;
    const plain = text.replace(/\$\([^)]*\)\s*/g, "");
    const firstLine = detail.split("\n")[0];
    this.output.appendLine(`[${new Date().toLocaleTimeString()}] ${plain} | ${firstLine}`);
  }

  private async refresh(): Promise<void> {
    let nextCheckMs = CONFIG_RETRY_MS;
    try {
      const result = await checkMoonSetup(this.context);
      if (this.disposed) return;
      this.show(result);
      if (result.kind === "ok") nextCheckMs = result.config.trueforge.statusCheckIntervalMs;
    } catch (err) {
      this.item.text = "$(error) Moon: status check failed";
      this.item.tooltip = (err as Error).message;
      this.logChange(this.item.text, this.item.tooltip);
    }
    if (!this.disposed) this.timer = setTimeout(() => void this.refresh(), nextCheckMs);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.item.dispose();
  }
}

function describe(result: SetupResult): { text: string; tooltip: string; problem: boolean } {
  if (result.kind === "config-error") {
    return {
      text: "$(error) Moon: config error",
      tooltip: `${result.message}\n\nConfig: ${result.configPath}\nClick for details.`,
      problem: true,
    };
  }
  const { status, configuredModels, baseUrl } = result.report;
  if (status.state === "unreachable") {
    return {
      text: "$(debug-disconnect) Moon: TrueForge not reachable",
      tooltip: `${status.message}\nStart it with scripts/start-trueforge. Click for details.`,
      problem: true,
    };
  }
  if (status.state === "error") {
    return { text: "$(error) Moon: TrueForge error", tooltip: `${status.message}\nClick for details.`, problem: true };
  }
  const missing = configuredModels.filter((m) => !m.found);
  const count = status.models.length;
  const text = `$(check) Moon: connected to TrueForge (${count} model${count === 1 ? "" : "s"})`;
  if (missing.length > 0) {
    return {
      text: text.replace("$(check)", "$(warning)"),
      tooltip: `Connected to ${baseUrl}, but TrueForge has no ${missing
        .map((m) => `${m.role} model ${m.ref}`)
        .join(" or ")}.\nRun scripts/setup-providers. Click for details.`,
      problem: true,
    };
  }
  return { text, tooltip: `Connected to ${baseUrl}. Click to check setup.`, problem: false };
}
