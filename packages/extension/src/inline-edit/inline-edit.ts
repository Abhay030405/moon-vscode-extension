// Inline edit (Ctrl+I), Copilot-style, built on VS Code's public API:
//
// 1. Ctrl+I opens Moon's instruction box right under the selected lines. It is VS Code's inline
//    comment box ("Add Comment"), which focuses the text field so the user can type at once.
// 2. Ctrl+Enter / "Edit" starts an inline session on TrueForge (agents/moon-inline.json). The box
//    shows each tool step live; Stop (or Escape) cancels it and the file stays untouched.
// 3. The agent hands its change back with propose_edit. Moon shows it Copilot-style in the editor
//    (preview.ts): new lines green, old lines red, Accept / Reject per change. The preview is
//    never saved to disk; only accepted changes are.

import * as vscode from "vscode";
import {
  buildInlinePrompt,
  STATUS_MESSAGE_MS,
  type AgentChat,
  type MoonConfig,
  type MoonEvent,
  type ToolContext,
  type ToolStep,
} from "@moon/core";
import type { MoonService } from "../agent-run/moon-service.js";
import { CONTEXT_KEYS, INLINE_COMMANDS, VSCODE_COMMANDS } from "../commands.js";
import { MOON_AUTHOR, USER_AUTHOR } from "./comment-author.js";
import { HunkCodeLensProvider } from "./hunk-actions.js";
import { PendingChangesDecorations } from "../review/pending-decorations.js";
import { InlinePreview, type ReviewResult } from "./preview.js";

/** Id of Moon's comment controller ("commentController" in package.json "when" clauses). */
export const INLINE_COMMENT_CONTROLLER = "moon-inline";

/** contextValue of the instruction box in each state ("commentThread" in "when" clauses). */
const BOX = { ask: "moon-ask", running: "moon-running", review: "moon-review" } as const;

export class InlineEditController implements vscode.Disposable {
  private readonly comments: vscode.CommentController;
  private readonly removedLines: vscode.TextEditorDecorationType;
  private readonly addedLines: vscode.TextEditorDecorationType;
  private readonly lenses: HunkCodeLensProvider;
  /** Green dot in the Explorer on files with changes waiting for review. */
  private readonly pendingFiles = new PendingChangesDecorations();
  private readonly disposables: vscode.Disposable[] = [];
  /** One inline edit at a time: its instruction box... */
  private session: InlineSession | undefined;
  /** ...and its preview. Kept after the review ends, so Ctrl+Z back into it shows the colours again. */
  private preview: InlinePreview | undefined;

  constructor(
    private readonly service: MoonService,
    private readonly output: vscode.OutputChannel,
  ) {
    this.comments = vscode.comments.createCommentController(INLINE_COMMENT_CONTROLLER, "Moon");
    this.comments.options = {
      prompt: "Ask Moon to change this code",
      placeHolder: "Describe the change, then press Ctrl+Enter",
    };
    // Every line of a file can get Moon's box; "Add Comment" needs this to open it.
    this.comments.commentingRangeProvider = {
      provideCommentingRanges: (doc) =>
        doc.uri.scheme === "file" ? [new vscode.Range(0, 0, Math.max(0, doc.lineCount - 1), 0)] : [],
    };
    this.removedLines = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor("diffEditor.removedLineBackground"),
      overviewRulerColor: new vscode.ThemeColor("editorOverviewRuler.deletedForeground"),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    });
    this.addedLines = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor("diffEditor.insertedLineBackground"),
      overviewRulerColor: new vscode.ThemeColor("editorOverviewRuler.addedForeground"),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    });
    this.lenses = new HunkCodeLensProvider((doc) => (this.preview?.document === doc ? this.preview : undefined));

    // CodeLens buttons pass the document's uri (and the change's index).
    const onHunk = (act: (preview: InlinePreview, index: number) => unknown) => (uri: string, index: number) => {
      const preview = this.previewFor(uri);
      if (preview) void act(preview, index);
    };

    this.disposables.push(
      this.comments,
      this.removedLines,
      this.addedLines,
      this.lenses,
      this.pendingFiles,
      vscode.languages.registerCodeLensProvider({ scheme: "file" }, this.lenses),
      vscode.commands.registerCommand(INLINE_COMMANDS.start, () => this.start()),
      vscode.commands.registerCommand(INLINE_COMMANDS.submit, (reply: vscode.CommentReply) => this.submit(reply)),
      vscode.commands.registerCommand(INLINE_COMMANDS.cancel, (reply?: vscode.CommentReply) => this.cancel(reply?.thread)),
      vscode.commands.registerCommand(INLINE_COMMANDS.stop, () => this.session?.stop()),
      vscode.commands.registerCommand(INLINE_COMMANDS.close, () => this.closeSession()),
      vscode.commands.registerCommand(INLINE_COMMANDS.acceptHunk, onHunk((r, i) => r.accept(i))),
      vscode.commands.registerCommand(INLINE_COMMANDS.rejectHunk, onHunk((r, i) => r.reject(i))),
      vscode.commands.registerCommand(INLINE_COMMANDS.acceptAll, (uri?: string) => this.previewFor(uri)?.acceptAll()),
      vscode.commands.registerCommand(INLINE_COMMANDS.rejectAll, (uri?: string) => this.previewFor(uri)?.rejectAll()),
      vscode.workspace.onDidCloseTextDocument((doc) => {
        if (this.session?.document === doc || this.preview?.document === doc) void this.closeSession();
      }),
    );
  }

  /** Ctrl+I: open the instruction box at the selection. */
  private async start(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== "file") {
      void vscode.window.showInformationMessage("Moon: open a file and select the code you want to change, then press Ctrl+I.");
      return;
    }
    await this.closeSession();
    try {
      // VS Code's own "Add Comment" opens the box with the cursor already in it.
      await vscode.commands.executeCommand(VSCODE_COMMANDS.addComment);
    } catch (err) {
      // Fallback: open the box ourselves (the user clicks into it).
      this.output.appendLine(`[inline] "Add Comment" failed, opening the box directly: ${(err as Error).message}`);
      const { start, end } = editor.selection;
      const thread = this.comments.createCommentThread(editor.document.uri, new vscode.Range(start.line, 0, end.line, 0), []);
      thread.canReply = true;
      thread.contextValue = BOX.ask;
      thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    }
  }

  /** "Edit" (or Ctrl+Enter) in the instruction box. */
  private async submit(reply: vscode.CommentReply): Promise<void> {
    const instruction = reply.text.trim();
    if (!instruction) return;
    const thread = reply.thread;
    if (this.session && this.session.thread !== thread) await this.closeSession();
    if (!this.session) {
      const document = vscode.workspace.textDocuments.find((d) => d.uri.toString() === thread.uri.toString());
      if (!document) return;
      this.session = new InlineSession(thread, document, {
        service: this.service,
        output: this.output,
        startPreview: (document, proposal) => this.startPreview(document, proposal),
      });
    }
    if (this.session.busy) return;
    await this.session.run(instruction);
  }

  private cancel(thread: vscode.CommentThread | undefined): void {
    if (thread && this.session?.thread !== thread) thread.dispose(); // box never used
    else void this.closeSession();
  }

  private previewFor(uri: string | undefined): InlinePreview | undefined {
    const preview = this.preview;
    return preview && (uri === undefined || preview.document.uri.toString() === uri) ? preview : undefined;
  }

  private async startPreview(document: vscode.TextDocument, proposal: string): Promise<InlinePreview> {
    this.preview?.dispose();
    this.preview = new InlinePreview(
      document,
      proposal,
      { removed: this.removedLines, added: this.addedLines },
      () => {
        this.session?.updateReviewLabel(this.preview?.pending.length ?? 0);
        this.pendingFiles.set(document.uri, this.preview?.isReviewing ?? false);
        this.lenses.refresh();
      },
      (result) => this.reviewEnded(result),
    );
    await this.preview.start();
    return this.preview;
  }

  /** Every change was accepted or rejected: close the box (the preview keeps watching for Ctrl+Z). */
  private reviewEnded(result: ReviewResult): void {
    this.session?.dispose();
    this.session = undefined;
    const total = result.accepted + result.rejected;
    const undo = result.accepted > 0 ? " Ctrl+Z undoes it." : "";
    vscode.window.setStatusBarMessage(`$(check) Moon: accepted ${result.accepted} of ${total} change(s).${undo}`, STATUS_MESSAGE_MS);
  }

  /** Closes the box and takes any pending preview out of the editor. */
  private async closeSession(): Promise<void> {
    this.session?.dispose();
    this.session = undefined;
    const preview = this.preview;
    this.preview = undefined;
    if (preview) {
      await preview.discard();
      preview.dispose();
      this.pendingFiles.set(preview.document.uri, false);
    }
    this.lenses.refresh();
  }

  dispose(): void {
    void this.closeSession();
    for (const d of this.disposables) d.dispose();
  }
}

interface SessionDeps {
  service: MoonService;
  output: vscode.OutputChannel;
  startPreview(document: vscode.TextDocument, proposal: string): Promise<InlinePreview>;
}

/** One instruction box and what happens in it: the run, then the review. */
class InlineSession {
  private reviewing = false;
  private chat: AgentChat | undefined;
  private tools: ToolContext | undefined;
  private config: MoonConfig | undefined;
  private running = false;
  private disposed = false;
  private readonly history: vscode.Comment[] = [];

  constructor(
    readonly thread: vscode.CommentThread,
    readonly document: vscode.TextDocument,
    private readonly deps: SessionDeps,
  ) {}

  get busy(): boolean {
    return this.running || this.reviewing;
  }

  async run(instruction: string): Promise<void> {
    const { thread, document } = this;
    const lines = selectedLines(thread);
    this.running = true;
    void vscode.commands.executeCommand("setContext", CONTEXT_KEYS.inlineRunning, true);
    thread.canReply = false;
    thread.contextValue = BOX.running;
    thread.label = `Moon · ${lines.start === lines.end ? `line ${lines.start + 1}` : `lines ${lines.start + 1}-${lines.end + 1}`}`;
    this.history.push({ author: USER_AUTHOR, body: instruction, mode: vscode.CommentMode.Preview });

    const view = new RunView((body) => this.show(body));
    const baseText = document.getText();
    let proposal: string | undefined;
    try {
      if (!this.chat) {
        const created = await this.deps.service.createInlineEdit();
        this.chat = created.chat;
        this.tools = created.tools;
        this.config = created.config;
      }
      const tools = this.tools!;
      const { rel } = tools.paths.resolve(document.uri.fsPath);
      if (tools.secrets.isSecret(rel)) throw new Error(`"${rel}" may contain secrets, so Moon does not edit it.`);
      tools.inlineTarget = { rel, onProposal: (text) => (proposal = text) };

      const prompt = buildInlinePrompt(
        {
          instruction,
          rel,
          languageId: document.languageId,
          text: baseText,
          startLine: lines.start,
          endLine: lines.end,
          problems: tools.editor?.diagnostics(rel) ?? [],
        },
        { contextLines: this.config!.inline.contextLines, maxProblems: this.config!.inline.maxProblems },
      );
      this.deps.output.appendLine(`[inline] ${rel} ${thread.label}: ${instruction}`);
      await this.chat.send(prompt, (event) => {
        if (!this.disposed) view.handle(event);
      });
    } catch (err) {
      view.handle({ type: "done", status: "error", message: (err as Error).message });
    } finally {
      if (this.tools?.inlineTarget) this.tools.inlineTarget = undefined;
      this.running = false;
      void vscode.commands.executeCommand("setContext", CONTEXT_KEYS.inlineRunning, false);
    }
    if (this.disposed) return;

    if (view.status === "done" && proposal !== undefined) {
      if (document.getText() !== baseText) {
        view.note("The file changed while Moon was working, so the proposal was dropped. Ask again.");
      } else {
        await this.startReview(proposal, view, lines.start);
        return;
      }
    }
    // Stopped, failed or no proposal: the file is untouched; the user may ask again.
    this.commitRun(view);
    thread.canReply = true;
    thread.contextValue = BOX.ask;
  }

  stop(): void {
    this.chat?.stop();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.chat?.stop();
    this.thread.dispose();
  }

  private async startReview(proposal: string, view: RunView, firstSelectedLine: number): Promise<void> {
    // Keep this box above the selection, out of the way of the green and red lines.
    const above = Math.max(0, firstSelectedLine - 1);
    this.thread.range = new vscode.Range(above, 0, above, 0);
    this.reviewing = true;
    view.note("New lines are **green**, removed lines **red**. Use **Accept** / **Reject** above each change. Only accepted changes are ever saved.");
    this.commitRun(view);
    this.thread.contextValue = BOX.review;
    const preview = await this.deps.startPreview(this.document, proposal);
    this.updateReviewLabel(preview.pending.length);
  }

  updateReviewLabel(pending: number): void {
    if (this.disposed || !this.reviewing) return;
    this.thread.label = `Moon · ${pending} change${pending === 1 ? "" : "s"} to review`;
  }

  /** Keeps the finished run's text in the box's history. */
  private commitRun(view: RunView): void {
    this.history.push(this.moonComment(view.render()));
    this.thread.comments = [...this.history];
  }

  private show(body: vscode.MarkdownString): void {
    if (this.disposed) return;
    this.thread.comments = [...this.history, this.moonComment(body)];
  }

  private moonComment(body: vscode.MarkdownString): vscode.Comment {
    return { author: MOON_AUTHOR, body, mode: vscode.CommentMode.Preview };
  }
}

/** Turns one run's events into the Markdown shown in the box. */
class RunView {
  status: "running" | "done" | "cancelled" | "error" = "running";
  private readonly steps: ToolStep[] = [];
  private answer = "";
  private sessionUrl: string | undefined;
  private readonly notes: string[] = [];

  constructor(private readonly onUpdate: (body: vscode.MarkdownString) => void) {
    this.onUpdate(this.render());
  }

  handle(event: MoonEvent): void {
    switch (event.type) {
      case "session":
        this.sessionUrl = event.url;
        break;
      case "tool-call":
        this.steps.push(event.step);
        break;
      case "text":
        this.answer += event.text;
        break;
      case "notice":
        this.notes.push(event.text);
        break;
      case "done":
        this.status = event.status;
        if (event.status === "cancelled") this.notes.push("Stopped. The file was not changed.");
        if (event.status === "error") this.notes.push(`Moon could not finish: ${event.message ?? "unknown error"}. The file was not changed.`);
        break;
      default:
        return;
    }
    this.onUpdate(this.render());
  }

  note(text: string): void {
    this.notes.push(text);
  }

  render(): vscode.MarkdownString {
    const md = new vscode.MarkdownString(undefined, true);
    for (const step of this.steps) {
      md.appendMarkdown(`- **${escapeMd(step.action)}** ${step.target ? `\`${step.target.replaceAll("`", "'")}\`` : ""}\n`);
    }
    if (this.steps.length) md.appendMarkdown("\n");
    if (this.answer) md.appendMarkdown(`${this.answer}\n\n`);
    if (this.status === "running") md.appendMarkdown("$(loading~spin) Working… (Esc to stop)\n\n");
    for (const note of this.notes) md.appendMarkdown(`${note}\n\n`);
    if (this.sessionUrl) md.appendMarkdown(`[Open the TrueForge session](${this.sessionUrl})`);
    return md;
  }
}

/** The selected lines (0-based, inclusive) the box was opened on. */
function selectedLines(thread: vscode.CommentThread): { start: number; end: number } {
  const range = thread.range;
  if (!range) {
    const sel = vscode.window.activeTextEditor?.selection;
    return { start: sel?.start.line ?? 0, end: sel?.end.line ?? 0 };
  }
  // A selection that ends at the start of a line does not include that line.
  const end = range.end.character === 0 && range.end.line > range.start.line ? range.end.line - 1 : range.end.line;
  return { start: range.start.line, end };
}

function escapeMd(text: string): string {
  return text.replace(/[\\`*_[\]<>]/g, (c) => `\\${c}`);
}
