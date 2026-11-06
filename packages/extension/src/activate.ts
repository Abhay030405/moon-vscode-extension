// Extension start-up. Kept thin: all logic lives in @moon/core.

import * as vscode from "vscode";
import { MoonService } from "./agent-run/moon-service.js";
import { CHECK_SETUP_COMMAND } from "./commands.js";
import { runCheckSetup } from "./status/check-setup.js";
import { MoonStatusBar } from "./status/status-bar.js";
import { MoonPanelProvider, PANEL_VIEW_ID } from "./webview-host/panel-provider.js";

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("Moon");
  const statusBar = new MoonStatusBar(context, output);
  const service = new MoonService(context, output);
  const panel = new MoonPanelProvider(context.extensionUri, service);

  context.subscriptions.push(
    output,
    statusBar,
    service,
    panel,
    vscode.commands.registerCommand(CHECK_SETUP_COMMAND, () => runCheckSetup(context, output, statusBar)),
    vscode.window.registerWebviewViewProvider(PANEL_VIEW_ID, panel, { webviewOptions: { retainContextWhenHidden: true } }),
  );

  statusBar.start();
}

export function deactivate(): void {}
