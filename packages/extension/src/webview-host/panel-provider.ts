// Hosts the Moon panel (the React app from packages/webview-ui, built into dist/webview)
// in the Moon view of the activity bar, and connects its messages to agent chats.

import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import type { AgentChat } from "@moon/core";
import type { ExtensionToPanel, MoonEvent, PanelToExtension } from "@moon/webview-ui/protocol";
import type { MoonService } from "../agent-run/moon-service.js";

export const PANEL_VIEW_ID = "moon.panel";

export class MoonPanelProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  /** The panel's current chat. A new chat id replaces it (and stops it if running). */
  private chat: { id: string; agent: AgentChat | undefined } | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly service: MoonService,
    private readonly output: vscode.OutputChannel,
  ) {
    this.disposables.push(vscode.workspace.onDidChangeWorkspaceFolders(() => this.postState()));
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const webviewRoot = vscode.Uri.joinPath(this.extensionUri, "dist", "webview");
    view.webview.options = { enableScripts: true, localResourceRoots: [webviewRoot] };
    view.webview.html = this.html(view.webview, webviewRoot);
    view.webview.onDidReceiveMessage((message: PanelToExtension) => void this.onMessage(message), undefined, this.disposables);
    view.onDidDispose(() => (this.view = undefined), undefined, this.disposables);
  }

  private async onMessage(message: PanelToExtension): Promise<void> {
    switch (message.type) {
      case "ready":
        this.postState();
        return;
      case "new-chat":
        this.chat?.agent?.stop();
        this.chat = { id: message.chatId, agent: undefined };
        return;
      case "stop":
        if (this.chat?.id === message.chatId) this.chat.agent?.stop();
        return;
      case "open-session":
        if (/^https?:\/\//.test(message.url)) void vscode.env.openExternal(vscode.Uri.parse(message.url));
        return;
      case "panel-error":
        this.output.appendLine(`[panel] error: ${message.message}`);
        return;
      case "send":
        await this.send(message.chatId, message.text);
        return;
    }
  }

  private async send(chatId: string, text: string): Promise<void> {
    const emit = (event: MoonEvent) => this.post({ type: "event", chatId, event });
    if (this.chat?.id !== chatId) {
      this.chat?.agent?.stop();
      this.chat = { id: chatId, agent: undefined };
    }
    const chat = this.chat;
    try {
      chat.agent ??= await this.service.createChat();
    } catch (err) {
      emit({ type: "done", status: "error", message: (err as Error).message });
      return;
    }
    // The user may have started a new chat while this one was being created.
    if (this.chat !== chat) return;
    await chat.agent.send(text, emit);
  }

  private postState(): void {
    const root = this.service.projectRoot();
    this.post({ type: "state", projectName: root ? vscode.workspace.workspaceFolders?.[0]?.name : undefined });
  }

  private post(message: ExtensionToPanel): void {
    void this.view?.webview.postMessage(message);
  }

  private html(webview: vscode.Webview, root: vscode.Uri): string {
    const nonce = randomBytes(16).toString("base64");
    const script = webview.asWebviewUri(vscode.Uri.joinPath(root, "index.js"));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(root, "index.css"));
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource}`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${style}">
  <title>Moon</title>
</head>
<body>
  <div id="root"></div>
  <script type="module" nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }

  dispose(): void {
    this.chat?.agent?.stop();
    for (const d of this.disposables) d.dispose();
  }
}
