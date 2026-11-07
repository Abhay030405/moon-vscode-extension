// One chat in the Moon panel in agent mode: the TrueForge chat plus the agent run (hidden copy)
// it works in, and the user's answers to TrueForge's tool approvals.
//
// TrueForge pauses a turn when the agent calls a tool that needs approval (run_command and
// apply_changes, see agents/moon-agent.json). Moon then asks the user in the panel and answers
// TrueForge; the agent continues in a new turn. So the review of the agent's changes is driven
// by TrueForge's tool approval:
// - run_command: Allow once / Always for this run (that exact command) / Deny.
// - apply_changes: the review screen. Apply = allow; TrueForge then runs the tool, which writes
//   only the accepted hunks (applyApproved below) and tells the agent what was rejected.
//   Nothing accepted = deny with the same report. Discard = deny and throw the copy away.
//
// Nothing reaches the user's files except through applyApproved, after the user's review.

import { readFileSync } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  AgentRun,
  commandRisks,
  finalText,
  hunkWithContext,
  REJECTED_HUNK_PREVIEW_LINES,
  reviewReport,
  type AgentChat,
  type ApprovalAnswer,
  type ApprovalDecision,
  type ApprovalRequest,
  type FileReview,
  type HunkDecisions,
  type MoonConfig,
  type MoonEvent,
} from "@moon/core";
import type { CommandDecision, ExtensionToPanel, ReviewView } from "@moon/webview-ui/protocol";
import { VsCodeEditorBridge } from "../editor-bridge/editor-bridge.js";
import type { PendingChangesDecorations } from "../review/pending-decorations.js";
import type { EditorHunk, ReviewInEditor } from "../review/review-in-editor.js";
import type { MoonService } from "./moon-service.js";

/** Tool names in agents/moon-agent.json that need the user's approval. */
const RUN_COMMAND_TOOL = "run_command";
const APPLY_CHANGES_TOOL = "apply_changes";

export interface AgentSessionDeps {
  service: MoonService;
  post(message: ExtensionToPanel): void;
  output: vscode.OutputChannel;
  pending: PendingChangesDecorations;
  inEditor: ReviewInEditor;
}

/** What the user chose on the review screen (undefined = the run was stopped). */
type ReviewChoice = { accepted: HunkDecisions } | "discard" | undefined;

/** Text of one file before and after the last apply (null = the file did not exist). */
interface AppliedFile {
  before: string | null;
  after: string | null;
}

export class AgentSession implements vscode.Disposable {
  private run: AgentRun | undefined;
  /** Commands the user allowed for the whole run (exact text). */
  private readonly alwaysAllowed = new Set<string>();
  /** The answer the session is waiting for from the panel. */
  private waiting:
    | { kind: "command"; requestId: string; resolve(decision: CommandDecision | undefined): void }
    | { kind: "review"; resolve(choice: ReviewChoice): void }
    | undefined;
  /** The approved review, used when TrueForge runs apply_changes. */
  private approved: { files: FileReview[]; accepted: HunkDecisions } | undefined;
  /** Files the last apply changed, for "Undo this whole run". */
  private lastApply: Map<string, AppliedFile> | undefined;
  /** Files currently marked in the Explorer as waiting for review. */
  private marked: vscode.Uri[] = [];
  /** Told to the agent with the next message (e.g. the user undid the last apply). */
  private notes: string[] = [];
  private stopped = false;

  private constructor(
    readonly chatId: string,
    private readonly chat: AgentChat,
    private readonly config: MoonConfig,
    private readonly root: string,
    private readonly deps: AgentSessionDeps,
  ) {}

  static async create(chatId: string, deps: AgentSessionDeps): Promise<AgentSession> {
    const root = deps.service.projectRoot();
    if (!root) throw new Error("Open a folder first: Moon's tools work on the open project.");
    const { chat, config } = await deps.service.createChat();
    return new AgentSession(chatId, chat, config, root, deps);
  }

  /** Sends a message; answers every approval the agent asks for until the agent is done. */
  async send(text: string): Promise<void> {
    this.stopped = false;
    try {
      this.ensureRun();
    } catch (err) {
      this.emit({ type: "done", status: "error", message: (err as Error).message });
      return;
    }
    const message = this.notes.length ? `${this.notes.join("\n")}\n\n${text}` : text;
    this.notes = [];
    await this.chat.send(message, this.emit);
    while (this.chat.waitingFor.length > 0 && !this.stopped) {
      const answers = await this.decide(this.chat.waitingFor);
      if (!answers || this.stopped) return;
      await this.chat.answer(answers, this.emit);
    }
  }

  /** Stop: cancels the turn, kills a running command, closes any card and deletes the copy. */
  stop(): void {
    this.stopped = true;
    this.chat.stop();
    this.resolveWaiting();
    this.disposeRun();
  }

  // ---- answers from the panel ----

  commandDecision(requestId: string, decision: CommandDecision): void {
    if (this.waiting?.kind === "command" && this.waiting.requestId === requestId) this.resolveWaiting(decision);
  }

  reviewApply(accepted: Record<string, number[]>): void {
    if (this.waiting?.kind !== "review") return;
    this.resolveWaiting({ accepted: new Map(Object.entries(accepted).map(([rel, hunks]) => [rel, new Set(hunks)])) });
  }

  reviewDiscard(): void {
    if (this.waiting?.kind === "review") this.resolveWaiting("discard");
  }

  /** Shows the agent's version of a file next to the real one in VS Code's diff editor. */
  async openDiff(rel: string): Promise<void> {
    if (!this.run) return;
    const real = vscode.Uri.file(path.join(this.root, rel));
    const copy = vscode.Uri.file(this.run.copy.copyPath(rel));
    const realExists = this.readProjectText(rel) !== null;
    const copyExists = readFileOrNull(copy.fsPath) !== null;
    if (realExists && copyExists) {
      await vscode.commands.executeCommand("vscode.diff", real, copy, `${rel} (yours ↔ Moon's)`, { preview: true });
    } else {
      await vscode.window.showTextDocument(copyExists ? copy : real, { preview: true });
    }
  }

  /** Puts every file the last apply changed back as it was (skips files changed since). */
  async undo(): Promise<void> {
    const applied = this.lastApply;
    if (!applied) return;
    this.lastApply = undefined;
    const edit = new vscode.WorkspaceEdit();
    const toSave: vscode.Uri[] = [];
    const skipped: string[] = [];
    let restored = 0;
    for (const [rel, file] of applied) {
      if (this.readProjectText(rel) !== file.after) {
        skipped.push(rel);
        continue;
      }
      const uri = vscode.Uri.file(path.join(this.root, rel));
      if (file.before === null) edit.deleteFile(uri, { ignoreIfNotExists: true });
      else if (file.after === null) edit.createFile(uri, { contents: Buffer.from(file.before, "utf8"), overwrite: true });
      else {
        await replaceDocument(edit, uri, file.before);
        toSave.push(uri);
      }
      restored++;
    }
    if (!(await vscode.workspace.applyEdit(edit))) {
      void vscode.window.showErrorMessage("Moon could not undo the run: VS Code refused the change.");
      return;
    }
    await saveAll(toSave);
    this.notes.push("(Note: the user undid every change applied by your last apply_changes.)");
    if (skipped.length) {
      void vscode.window.showWarningMessage(`Moon did not undo ${skipped.join(", ")}: changed after the apply.`);
    }
    this.deps.post({ type: "undone", chatId: this.chatId, files: restored });
  }

  dispose(): void {
    this.stop();
  }

  // ---- approvals ----

  private readonly emit = (event: MoonEvent): void => {
    this.deps.post({ type: "event", chatId: this.chatId, event });
  };

  private async decide(requests: readonly ApprovalRequest[]): Promise<ApprovalAnswer[] | undefined> {
    const answers: ApprovalAnswer[] = [];
    for (const request of requests) {
      const decision = await this.decideOne(request);
      if (!decision) return undefined;
      answers.push({ request, decision });
    }
    return answers;
  }

  private async decideOne(request: ApprovalRequest): Promise<ApprovalDecision | undefined> {
    if (request.tool === RUN_COMMAND_TOOL) return this.decideCommand(request);
    if (request.tool === APPLY_CHANGES_TOOL) return this.decideReview();
    // Only the two tools above need approval in the agent definition.
    this.deps.output.appendLine(`[agent] unexpected approval for ${request.tool}; allowed`);
    return { allow: true };
  }

  private async decideCommand(request: ApprovalRequest): Promise<ApprovalDecision | undefined> {
    const command = String(request.args.command ?? "");
    if (this.alwaysAllowed.has(command)) return { allow: true };
    const cwd = typeof request.args.cwd === "string" ? request.args.cwd : undefined;
    const decision = await new Promise<CommandDecision | undefined>((resolve) => {
      this.waiting = { kind: "command", requestId: request.toolCallId, resolve };
      this.deps.post({
        type: "command-approval",
        chatId: this.chatId,
        approval: { requestId: request.toolCallId, command, cwd, risks: commandRisks(command) },
      });
    });
    this.deps.post({ type: "command-approval", chatId: this.chatId, approval: undefined });
    if (decision === undefined) return undefined;
    if (decision === "deny") return { allow: false, reason: "The user denied this command." };
    if (decision === "always") this.alwaysAllowed.add(command);
    return { allow: true };
  }

  private async decideReview(): Promise<ApprovalDecision | undefined> {
    const run = this.run;
    if (!run) return { allow: false, reason: "Your working copy is gone (the run was stopped)." };
    const files = run.review((rel) => this.readProjectText(rel)).filter((f) => f.binary || f.hunks.length > 0);
    if (files.length === 0) {
      return { allow: false, reason: "There is nothing to apply: your working copy matches the user's files." };
    }
    const summary = String(this.chat.waitingFor.find((r) => r.tool === APPLY_CHANGES_TOOL)?.args.summary ?? "");
    this.mark(files.map((f) => f.rel));
    this.deps.inEditor.show(new Map(files.map((f) => [f.rel, editorHunks(f)])));
    const choice = await new Promise<ReviewChoice>((resolve) => {
      this.waiting = { kind: "review", resolve };
      this.deps.post({ type: "review", chatId: this.chatId, review: this.reviewView(summary, files, run) });
    });
    this.deps.post({ type: "review", chatId: this.chatId, review: undefined });
    this.mark([]);
    this.deps.inEditor.show(new Map());
    if (choice === undefined) return undefined;
    if (choice === "discard") {
      this.disposeRun();
      return {
        allow: false,
        reason: "The user discarded all your changes and your working copy was thrown away. Do not make more changes unless the user asks.",
      };
    }
    const acceptedCount = [...choice.accepted.values()].reduce((n, set) => n + set.size, 0);
    if (acceptedCount === 0) return { allow: false, reason: reviewReport(files, choice.accepted, REJECTED_HUNK_PREVIEW_LINES) };
    this.approved = { files, accepted: choice.accepted };
    return { allow: true };
  }

  private reviewView(summary: string, files: FileReview[], run: AgentRun): ReviewView {
    const { reviewContextLines, reviewOutputChars } = this.config.agentRun;
    return {
      summary,
      files: files.map((file) => ({
        rel: file.rel,
        kind: file.kind,
        binary: file.binary,
        conflict: file.conflict,
        hunks: file.hunks.map((hunk, index) => ({
          index,
          line: hunk.oldStart + 1,
          lines: hunkWithContext(file, hunk, reviewContextLines),
        })),
      })),
      commands: run.commands.map((c) => ({
        command: c.command,
        exitCode: c.exitCode,
        timedOut: c.timedOut,
        cancelled: c.cancelled,
        outputTail: c.output.slice(-reviewOutputChars),
      })),
    };
  }

  // ---- applying (runs inside TrueForge's call of apply_changes, after the user approved) ----

  private async applyApproved(): Promise<string> {
    const approved = this.approved;
    this.approved = undefined;
    if (!approved) return "Nothing was applied: the user has not approved a review.";
    // The user may have edited a file while the review was open: never overwrite that.
    const files = approved.files.map((f) => ({ ...f, conflict: f.conflict || this.readProjectText(f.rel) !== f.baseText }));
    const edit = new vscode.WorkspaceEdit();
    const toSave: vscode.Uri[] = [];
    const applied = new Map<string, AppliedFile>();
    let hunks = 0;
    for (const file of files) {
      const accepted = approved.accepted.get(file.rel) ?? new Set<number>();
      const text = finalText(file, accepted);
      if (text === undefined) continue;
      const uri = vscode.Uri.file(path.join(this.root, file.rel));
      if (text === null) edit.deleteFile(uri, { ignoreIfNotExists: true });
      else if (file.baseText === null) edit.createFile(uri, { contents: Buffer.from(text, "utf8"), overwrite: false });
      else {
        await replaceDocument(edit, uri, text);
        toSave.push(uri);
      }
      applied.set(file.rel, { before: file.baseText, after: text });
      hunks += file.hunks.filter((_, i) => accepted.has(i)).length;
    }
    if (applied.size > 0 && !(await vscode.workspace.applyEdit(edit))) {
      return "Nothing was applied: the editor refused the change. Tell the user.";
    }
    await saveAll(toSave);
    this.lastApply = applied.size > 0 ? applied : undefined;
    this.deps.post({ type: "applied", chatId: this.chatId, files: applied.size, hunks, undoable: applied.size > 0 });
    return reviewReport(files, approved.accepted, REJECTED_HUNK_PREVIEW_LINES);
  }

  // ---- helpers ----

  private ensureRun(): void {
    if (this.run) return;
    const editor = new VsCodeEditorBridge(this.root);
    this.run = new AgentRun({ projectRoot: this.root, config: this.config, editor, applyApproved: () => this.applyApproved() });
    this.deps.service.setActiveRun(this.run);
    this.deps.output.appendLine(`[agent] working copy: ${this.run.copy.dir}`);
  }

  private disposeRun(): void {
    if (!this.run) return;
    this.deps.service.setActiveRun(undefined);
    this.run.dispose();
    this.run = undefined;
    this.approved = undefined;
    this.alwaysAllowed.clear();
  }

  private resolveWaiting(answer?: CommandDecision | ReviewChoice): void {
    const waiting = this.waiting;
    this.waiting = undefined;
    if (!waiting) return;
    if (waiting.kind === "command") waiting.resolve(answer as CommandDecision | undefined);
    else waiting.resolve(answer as ReviewChoice);
  }

  /** The real file's text: the editor's (unsaved changes included) or the disk's; null = missing. */
  private readProjectText(rel: string): string | null {
    const abs = path.join(this.root, rel);
    return new VsCodeEditorBridge(this.root).openText(abs) ?? readFileOrNull(abs);
  }

  private mark(rels: string[]): void {
    for (const uri of this.marked) this.deps.pending.set(uri, false);
    this.marked = rels.map((rel) => vscode.Uri.file(path.join(this.root, rel)));
    for (const uri of this.marked) this.deps.pending.set(uri, true);
  }
}

/** The file's changes as the editor marks them (none for new, deleted, binary or conflicting files). */
function editorHunks(file: FileReview): EditorHunk[] {
  if (file.kind !== "modified" || file.binary || file.conflict) return [];
  return file.hunks.map((h) => ({ oldStart: h.oldStart, removed: h.oldLines.length, added: h.newLines.length }));
}

function readFileOrNull(abs: string): string | null {
  try {
    return readFileSync(abs, "utf8");
  } catch {
    return null;
  }
}

async function replaceDocument(edit: vscode.WorkspaceEdit, uri: vscode.Uri, text: string): Promise<void> {
  const document = await vscode.workspace.openTextDocument(uri);
  const all = new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length));
  edit.replace(uri, all, text);
}

async function saveAll(uris: readonly vscode.Uri[]): Promise<void> {
  for (const uri of uris) await (await vscode.workspace.openTextDocument(uri)).save();
}
