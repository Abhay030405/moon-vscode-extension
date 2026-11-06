// Extension start-up. Kept thin: all logic lives in @moon/core.

import * as vscode from "vscode";
import { CHECK_SETUP_COMMAND } from "./commands.js";
import { runCheckSetup } from "./status/check-setup.js";
import { MoonStatusBar } from "./status/status-bar.js";

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("Moon");
  const statusBar = new MoonStatusBar(context);

  context.subscriptions.push(
    output,
    statusBar,
    vscode.commands.registerCommand(CHECK_SETUP_COMMAND, () => runCheckSetup(context, output, statusBar)),
  );

  statusBar.start();
}

export function deactivate(): void {}
