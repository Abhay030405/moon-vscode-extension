// Hosts the Moon panel (the React app from packages/webview-ui, built into dist/webview)
// in the Moon view of the activity bar, and connects its messages to agent chats.

import { randomBytes } from "node:crypto";
import * as path from "node:path";
import * as vscode from "vscode";
import type { ExtensionToPanel, Mention, MentionCandidate, PanelToExtension } from "@moon/webview-ui/protocol";
import { AgentSession } from "../agent-run/agent-session.js";
import type { MoonService } from "../agent-run/moon-service.js";
import { REVIEW_COMMANDS } from "../commands.js";
import { PendingChangesDecorations } from "../review/pending-decorations.js";
import { ReviewInEditor } from "../review/review-in-editor.js";

export const PANEL_VIEW_ID = "moon.panel";

export class MoonPanelProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  /** The panel's current chat. A new chat id replaces it (and stops it if running). */
  private chat: { id: string; agent: AgentSession | undefined } | undefined;
  /** Explorer dots on files waiting in the agent-mode review. */
  private readonly pending = new PendingChangesDecorations();
  /** Red lines, green notes and "Show diff" lenses in files under review. */
  private readonly inEditor: ReviewInEditor;
  private readonly disposables: vscode.Disposable[] = [this.pending];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly service: MoonService,
    private readonly output: vscode.OutputChannel,
  ) {
    this.inEditor = new ReviewInEditor(() => this.service.projectRoot());
    this.disposables.push(
      this.inEditor,
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.postState()),
      vscode.commands.registerCommand(REVIEW_COMMANDS.showDiff, (rel: string) => this.chat?.agent?.openDiff(rel)),
    );
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
      case "open-link":
        if (/^https?:\/\//.test(message.url)) void vscode.env.openExternal(vscode.Uri.parse(message.url));
        return;
      case "panel-error":
        this.output.appendLine(`[panel] error: ${message.message}`);
        return;
      case "send":
        await this.send(message.chatId, message.text, message.mentions);
        return;
      case "open-file":
        await this.openFile(message.rel);
        return;
      case "mention-search":
        await this.searchMentions(message.requestId, message.query);
        return;
    }
    // The rest act on the current chat's agent session.
    const agent = this.chat?.id === message.chatId ? this.chat.agent : undefined;
    if (!agent) return;
    switch (message.type) {
      case "command-decision":
        agent.commandDecision(message.requestId, message.decision);
        return;
      case "review-apply":
        agent.reviewApply(message.accepted);
        return;
      case "review-discard":
        agent.reviewDiscard();
        return;
      case "open-diff":
        await agent.openDiff(message.rel);
        return;
      case "undo-run":
        await agent.undo();
        return;
    }
  }

  /** Opens a project file the agent chose (only files inside the open folder). */
  private async openFile(rel: string): Promise<void> {
    const root = this.service.projectRoot();
    if (!root) return;
    const abs = path.resolve(root, rel);
    if (path.relative(root, abs).startsWith("..") || path.isAbsolute(path.relative(root, abs))) return;
    try {
      await vscode.window.showTextDocument(vscode.Uri.file(abs), { preview: true });
    } catch (err) {
      this.output.appendLine(`[panel] cannot open ${rel}: ${(err as Error).message}`);
    }
  }

  /** The @ picker: files and names in the open project matching what was typed. */
  private async searchMentions(requestId: number, query: string): Promise<void> {
    const root = this.service.projectRoot();
    let items: MentionCandidate[] = [];
    try {
      if (root) items = await this.service.contextAssembler().search(root, query);
    } catch (err) {
      this.output.appendLine(`[context] @ search failed: ${(err as Error).message}`);
    }
    this.post({ type: "mention-results", requestId, items });
  }

  private async send(chatId: string, text: string, mentions: Mention[]): Promise<void> {
    if (this.chat?.id !== chatId) {
      this.chat?.agent?.stop();
      this.chat = { id: chatId, agent: undefined };
    }
    const chat = this.chat;
    try {
      chat.agent ??= await AgentSession.create(chatId, {
        service: this.service,
        post: (message) => this.post(message),
        output: this.output,
        pending: this.pending,
        inEditor: this.inEditor,
      });
    } catch (err) {
      this.post({ type: "event", chatId, event: { type: "done", status: "error", message: (err as Error).message } });
      return;
    }
    // The user may have started a new chat while this one was being created.
    if (this.chat !== chat) return;
    await chat.agent.send(text, mentions);
  }

  private postState(): void {
    const root = this.service.projectRoot();
    this.post({
      type: "state",
      projectName: root ? vscode.workspace.workspaceFolders?.[0]?.name : undefined,
      ...this.service.panelSettings(),
    });
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
      `img-src ${webview.cspSource}`,
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
