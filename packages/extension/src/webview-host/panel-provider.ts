// Hosts the Moon panel (the React app from packages/webview-ui, built into dist/webview)
// in the Moon view of the activity bar, and connects its messages to agent chats.

import { randomBytes } from "node:crypto";
import * as path from "node:path";
import * as vscode from "vscode";
import { deleteConversation, listConversations, readTranscript, searchConversations, type ConversationInfo } from "@moon/core";
import type { ExtensionToPanel, Mention, MentionCandidate, PanelToExtension } from "@moon/webview-ui/protocol";
import { AgentSession } from "../agent-run/agent-session.js";
import type { MoonService } from "../agent-run/moon-service.js";
import { REVIEW_COMMANDS } from "../commands.js";
import { PendingChangesDecorations } from "../review/pending-decorations.js";
import { ReviewInEditor } from "../review/review-in-editor.js";

export const PANEL_VIEW_ID = "moon.panel";

export class MoonPanelProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  /**
   * The panel's current chat. A new chat id replaces it (and stops it if running).
   * `stopped`: Stop was pressed before its agent session existed.
   */
  private chat: { id: string; agent: AgentSession | undefined; stopped?: boolean } | undefined;
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
        this.chat?.agent?.dispose();
        this.chat = { id: message.chatId, agent: undefined };
        return;
      case "stop":
        if (this.chat?.id !== message.chatId) return;
        if (this.chat.agent) void this.chat.agent.stop();
        else this.stopBeforeStart(this.chat);
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
      case "history-list":
        await this.listHistory(message.query);
        return;
      case "history-open":
        await this.openPast(message.conversationId);
        return;
      case "history-continue":
        await this.continueConversation(message.chatId, message.conversationId);
        return;
      case "history-delete":
        await this.deletePast(message.conversationId);
        return;
    }
    // The rest act on the current chat's agent session.
    const agent = this.chat?.id === message.chatId ? this.chat.agent : undefined;
    if (!agent) return;
    switch (message.type) {
      case "command-decision":
        agent.commandDecision(message.requestId, message.decision);
        return;
      case "tool-decision":
        agent.toolDecision(message.requestId, message.allow);
        return;
      case "recall-decision":
        agent.recallDecision(message.requestId, message.allow);
        return;
      case "plan-decision":
        agent.planDecision(message.requestId, message.approve, message.changes);
        return;
      case "question-answer":
        agent.questionAnswer(message.requestId, message.answer);
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

  // ---- history (TrueForge sessions labelled with this project) ----

  private async conversations(): Promise<ConversationInfo[]> {
    const { client, config, project } = this.service.history();
    return listConversations(client, project, config.memory.historyPageSize);
  }

  private async listHistory(query: string): Promise<void> {
    try {
      const items = searchConversations(await this.conversations(), query).map(({ id, title, summary, status, model, updatedAt }) => ({ id, title, summary, status, model, updatedAt }));
      this.post({ type: "history", items });
    } catch (err) {
      this.post({ type: "history", items: [], error: (err as Error).message });
    }
  }

  private async openPast(conversationId: string): Promise<void> {
    try {
      const past = (await this.conversations()).find((c) => c.id === conversationId);
      if (!past) throw new Error("That conversation is gone.");
      const items = await readTranscript(this.service.history().client, past);
      this.post({ type: "past-conversation", conversationId, title: past.title, items });
    } catch (err) {
      this.post({ type: "past-conversation", conversationId, title: "", items: [], error: (err as Error).message });
    }
  }

  /** Continues an earlier conversation as the panel's chat `chatId` (after Continue, or a reload). */
  private async continueConversation(chatId: string, conversationId: string): Promise<void> {
    this.chat?.agent?.dispose();
    const chat: { id: string; agent: AgentSession | undefined; stopped?: boolean } = { id: chatId, agent: undefined };
    this.chat = chat;
    try {
      const past = (await this.conversations()).find((c) => c.id === conversationId);
      if (!past) throw new Error("That conversation is gone (deleted, or TrueForge's data was reset).");
      const items = await readTranscript(this.service.history().client, past);
      const agent = await AgentSession.create(chatId, this.sessionDeps(), past);
      if (this.chat !== chat) return agent.dispose();
      chat.agent = agent;
      this.post({ type: "resumed", chatId, conversationId, title: past.title, items });
      this.output.appendLine(`[memory] continuing "${past.title}" (${conversationId})`);
    } catch (err) {
      this.output.appendLine(`[memory] could not continue ${conversationId}: ${(err as Error).message}`);
      void vscode.window.showWarningMessage(`Moon could not continue that chat: ${(err as Error).message}`);
    }
  }

  private async deletePast(conversationId: string): Promise<void> {
    try {
      const past = (await this.conversations()).find((c) => c.id === conversationId);
      if (past) await deleteConversation(this.service.history().client, past);
      await this.service.records.delete(conversationId);
    } catch (err) {
      void vscode.window.showWarningMessage(`Moon could not delete that chat: ${(err as Error).message}`);
    }
    await this.listHistory("");
  }

  private sessionDeps() {
    return { service: this.service, post: (message: ExtensionToPanel) => this.post(message), output: this.output, pending: this.pending, inEditor: this.inEditor };
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
      this.chat?.agent?.dispose();
      this.chat = { id: chatId, agent: undefined };
    }
    const chat = this.chat;
    chat.stopped = false;
    try {
      chat.agent ??= await AgentSession.create(chatId, this.sessionDeps());
    } catch (err) {
      this.post({ type: "event", chatId, event: { type: "done", status: "error", message: (err as Error).message } });
      return;
    }
    // The user may have started a new chat, or pressed Stop, while this one was being created.
    if (this.chat !== chat) return;
    if (chat.stopped) return;
    await chat.agent.send(text, mentions);
  }

  /** Stop before the agent session exists: nothing to cancel yet, just end the turn in the panel. */
  private stopBeforeStart(chat: { id: string; stopped?: boolean }): void {
    chat.stopped = true;
    this.post({ type: "event", chatId: chat.id, event: { type: "done", status: "cancelled" } });
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
    this.chat?.agent?.dispose();
    for (const d of this.disposables) d.dispose();
  }
}
