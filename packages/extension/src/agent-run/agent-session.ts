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
  AGENT_TOOLS,
  EDITOR_TOOLS,
  checkCommand,
  containsSecret,
  hasHidden,
  revealHidden,
  RunBudget,
  TRUEFORGE_INTERNAL_TOOLS,
  UNTRUSTED_SOURCE_TOOLS,
  type AuditEntry,
  expandMentions,
  finalText,
  hunkWithContext,
  parsePlan,
  newConversationId,
  REJECTED_HUNK_PREVIEW_LINES,
  STATUS_MESSAGE_MS,
  reviewReport,
  type ResilientChat,
  type ApprovalAnswer,
  type ApprovalDecision,
  type ApprovalRequest,
  type QuestionRequest,
  type ContextAssembler,
  type FileReview,
  type HunkDecisions,
  type Mention,
  type MoonConfig,
  type MoonEvent,
  type ConversationInfo,
} from "@moon/core";
import type { CommandDecision, ExtensionToPanel, ReviewView } from "@moon/webview-ui/protocol";
import { VsCodeEditorBridge } from "../editor-bridge/editor-bridge.js";
import type { PendingChangesDecorations } from "../review/pending-decorations.js";
import type { EditorHunk, ReviewInEditor } from "../review/review-in-editor.js";
import { ConversationMemory } from "./conversation-memory.js";
import type { MoonService } from "./moon-service.js";

/** Tool names in agents/moon-agent.json that need the user's approval. */
const RUN_COMMAND_TOOL = "run_command";
const APPLY_CHANGES_TOOL = "apply_changes";
const READ_PAST_SESSION_TOOL = "read_past_session";
const PROPOSE_PLAN_TOOL = "propose_plan";

export interface AgentSessionDeps {
  service: MoonService;
  /** Moon's security log (approvals, blocks, taint, budget stops). */
  audit(entry: AuditEntry): void;
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

/** Agent mode in a folder VS Code marks as not trusted (Restricted Mode): look, but change nothing. */
const RESTRICTED_MODE_REASON =
  "This folder is not trusted in VS Code (Restricted Mode), so Moon runs no commands and applies no changes here. " +
  "Tell the user they can trust the folder (Manage Workspace Trust) if they want you to continue.";

/** Names of Moon's own tools (anything else the agent calls comes from TrueForge or a third-party server). */
const MOON_TOOL_NAMES = new Set([...AGENT_TOOLS, ...EDITOR_TOOLS].map((t) => t.name));

/** Secrets and hidden characters in the text a review would write (shown on the review screen). */
function reviewWarnings(files: readonly FileReview[]): { rel: string; text: string }[] {
  const warnings: { rel: string; text: string }[] = [];
  for (const file of files) {
    const added = file.hunks.flatMap((h) => h.newLines).join("\n");
    if (containsSecret(added)) warnings.push({ rel: file.rel, text: "adds what looks like a secret (a key, token or password)" });
    if (hasHidden(added)) warnings.push({ rel: file.rel, text: "adds hidden characters (shown as ⟦U+...⟧ in the diff): they can make code look different from what it does" });
  }
  return warnings;
}

export class AgentSession implements vscode.Disposable {
  private run: AgentRun | undefined;
  /** Commands the user allowed for the whole run (exact text). */
  private readonly alwaysAllowed = new Set<string>();
  /** The answer the session is waiting for from the panel. */
  private waiting:
    | { kind: "command"; requestId: string; resolve(decision: CommandDecision | undefined): void }
    | { kind: "review"; resolve(choice: ReviewChoice): void }
    | { kind: "question"; requestId: string; resolve(answer: string | undefined): void }
    | { kind: "tool"; requestId: string; resolve(allow: boolean | undefined): void }
    | { kind: "recall"; requestId: string; resolve(allow: boolean | undefined): void }
    | { kind: "plan"; requestId: string; resolve(answer: { approve: boolean; changes?: string } | undefined): void }
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
  /**
   * Set (to where it came from) once this task took in content from outside the project: a web
   * page, a GitHub result, an earlier conversation. Network commands are then blocked and
   * "Always allow" is off (the Rule of Two, docs/security.md).
   */
  private tainted: string | undefined;
  /** Hard limits for the current task (tool calls, loops, commands, tokens, time). */
  private budget: RunBudget | undefined;
  /** When the agent's last command finished, and how (for the review's "Verified" line). */
  private lastCommand: { at: number; command: string; exitCode: number | null } | undefined;

  private constructor(
    readonly chatId: string,
    private readonly chat: ResilientChat,
    private readonly config: MoonConfig,
    private readonly assembler: ContextAssembler,
    private readonly windowTokens: number,
    private readonly root: string,
    private readonly deps: AgentSessionDeps,
    readonly memory: ConversationMemory,
  ) {}

  /**
   * A new chat, or (with `resume`) a conversation from the history continued: its newest
   * TrueForge session is continued when it uses the current model; otherwise the next message
   * starts a new session of the same conversation. Either way the agent gets the work record.
   */
  static async create(chatId: string, deps: AgentSessionDeps, resume?: ConversationInfo): Promise<AgentSession> {
    const root = deps.service.projectRoot();
    if (!root) throw new Error("Open a folder first: Moon's tools work on the open project.");
    const conversation = resume?.id ?? newConversationId();
    // The session is made after its chat, so the chat's hooks reach it through this variable.
    let session: AgentSession | undefined;
    const { chat, config, assembler, windowTokens } = await deps.service.createChat({
      conversation,
      beforeRestart: () => session?.freshRun(),
      workNote: () => session?.memory.workNote(),
    });
    const memory = await ConversationMemory.open(conversation, deps.service, config, root, deps.output);
    session = new AgentSession(chatId, chat, config, assembler, windowTokens, root, deps, memory);
    if (resume) {
      const newest = resume.sessions[0];
      if (newest) chat.attach(newest.id, newest.lastTurnId);
      memory.resumed(chat.position?.sessionId);
    }
    return session;
  }

  /** Sends a message; answers every approval the agent asks for until the agent is done. */
  async send(text: string, mentions: readonly Mention[] = []): Promise<void> {
    this.stopped = false;
    // A new task: a fresh budget and no taint (each request is judged on what it reads).
    this.tainted = undefined;
    this.budget = new RunBudget(this.config.security.budget, RUN_COMMAND_TOOL);
    // A new message instead of answering a plan: the user moved on, so edits are not held back.
    if (this.run) this.run.tools.planWaiting = false;
    // The hidden copy and the project map are made at the same time, both without holding
    // the editor (async I/O, short slices).
    const [ready, mentionText] = await Promise.all([this.ensureRun(), this.assembleContext(text, mentions)]);
    // Stop pressed while preparing: no turn was started, so end it here.
    if (this.stopped) return this.emit({ type: "done", status: "cancelled" });
    if (ready !== true) return this.emit({ type: "done", status: "error", message: ready.error });
    const memoryNote = await this.memory.noteForNextMessage();
    const message = [memoryNote, ...this.notes, text, mentionText].filter(Boolean).join("\n\n");
    this.notes = [];
    this.memory.request(text, this.chat.model);
    await this.chat.send(message, this.emit);
    // The agent may pause for approvals or ask a question; answer each until it is done.
    while (!this.stopped) {
      if (this.chat.waitingFor.length > 0) {
        const answers = await this.decide(this.chat.waitingFor);
        if (!answers || this.stopped) return;
        await this.chat.answer(answers, this.emit);
      } else if (this.chat.question) {
        const answer = await this.askUser(this.chat.question);
        if (answer === undefined || this.stopped) return;
        await this.chat.answerQuestion(answer, this.emit);
      } else {
        return;
      }
    }
  }

  /**
   * Stop, in this order: kill a running command (and what it started), cancel the TrueForge
   * turn (the panel shows "cancelled" at once), close any approval or review card, delete the
   * hidden copy, then say "Stopped". The user's files were never touched by the run, so
   * nothing needs undoing. The slow part (deleting the copy) is async: the editor never waits.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    this.memory.stopped();
    // No turn streaming (Moon was waiting for the user: an approval, a review, or a question):
    // nothing else will report the end, so the panel is told here. Stop always ends the turn.
    const turnRunning = this.chat.turnRunning;
    this.run?.stop();
    this.chat.stop();
    this.resolveWaiting();
    if (!turnRunning) this.emit({ type: "done", status: "cancelled" });
    const hadRun = this.run !== undefined;
    await this.disposeRun();
    if (hadRun) vscode.window.setStatusBarMessage("$(debug-stop) Moon stopped. Its working copy was deleted.", STATUS_MESSAGE_MS);
  }

  // ---- answers from the panel ----

  commandDecision(requestId: string, decision: CommandDecision): void {
    if (this.waiting?.kind === "command" && this.waiting.requestId === requestId) this.resolveWaiting(decision);
  }

  /** The user picked an option or typed their own answer on the question card. */
  questionAnswer(requestId: string, answer: string): void {
    if (this.waiting?.kind === "question" && this.waiting.requestId === requestId && answer.trim()) this.resolveWaiting(answer.trim());
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
    this.memory.undo([...applied.keys()].filter((rel) => !skipped.includes(rel)));
    this.notes.push("(Note: the user undid every change applied by your last apply_changes.)");
    if (skipped.length) {
      void vscode.window.showWarningMessage(`Moon did not undo ${skipped.join(", ")}: changed after the apply.`);
    }
    this.deps.post({ type: "undone", chatId: this.chatId, files: restored });
  }

  /** New chat or panel closed: stop quietly (no "Stopped" message). */
  dispose(): void {
    this.stopped = true;
    this.run?.stop();
    this.chat.stop();
    this.resolveWaiting();
    void this.disposeRun();
  }

  // ---- approvals ----

  private readonly emit = (event: MoonEvent): void => {
    if (event.type === "tool-call") this.noteTaint(event.tool);
    const breach = this.budget?.observe(event);
    if (breach) void this.budgetStop(breach);
    // Token counts are for the budget only; the panel never shows them.
    if (event.type === "usage") return;
    this.memory.observe(event, this.chat.model);
    // A plan was proposed: no edits until the user approves it (the guard in edit_file).
    if (event.type === "tool-call" && event.tool === PROPOSE_PLAN_TOOL && this.run) this.run.tools.planWaiting = true;
    if (event.type === "session") this.deps.post({ type: "conversation", chatId: this.chatId, conversationId: this.memory.id });
    this.deps.post({ type: "event", chatId: this.chatId, event });
  };

  /** Marks the task as tainted when the agent used a tool whose result comes from outside the project. */
  private noteTaint(tool: string): void {
    if (this.tainted) return;
    const outside = UNTRUSTED_SOURCE_TOOLS.includes(tool) || (!MOON_TOOL_NAMES.has(tool) && !TRUEFORGE_INTERNAL_TOOLS.includes(tool));
    if (!outside) return;
    this.tainted = tool;
    this.deps.audit({ kind: "taint", detail: `the task read outside content (${tool}): network commands blocked, "Always" off`, tool });
  }

  /** A hard limit was hit: the task stops exactly as with Stop (nothing half-done reaches the files). */
  private async budgetStop(reason: string): Promise<void> {
    this.budget = undefined;
    this.deps.audit({ kind: "budget", detail: `task stopped: ${reason}` });
    this.deps.post({ type: "event", chatId: this.chatId, event: { type: "notice", text: `Moon stopped this task: ${reason} (security.budget in config).` } });
    void vscode.window.showWarningMessage(`Moon stopped the task: ${reason}. Nothing was written to your files.`);
    await this.stop();
  }

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
    if (request.tool === READ_PAST_SESSION_TOOL) return this.decideRecall(request);
    if (request.tool === PROPOSE_PLAN_TOOL) return this.decidePlan(request);
    // Any other tool that pauses (for example a GitHub write): the user sees exactly what it
    // will do and decides. Nothing is ever allowed silently.
    return this.decideTool(request);
  }

  private async decideTool(request: ApprovalRequest): Promise<ApprovalDecision | undefined> {
    // Hidden characters made visible: what the user reads is what will be sent.
    const full = revealHidden(JSON.stringify(request.args, null, 2)).text;
    this.deps.audit({ kind: "approval", detail: "asked", tool: request.tool, tainted: this.tainted !== undefined });
    const max = this.config.ui.approvalArgsMaxChars;
    const allow = await new Promise<boolean | undefined>((resolve) => {
      this.waiting = { kind: "tool", requestId: request.toolCallId, resolve };
      this.deps.post({
        type: "tool-approval",
        chatId: this.chatId,
        approval: { requestId: request.toolCallId, tool: request.tool, args: full.slice(0, max), truncated: full.length > max, tainted: this.tainted },
      });
    });
    this.deps.post({ type: "tool-approval", chatId: this.chatId, approval: undefined });
    if (allow === undefined) return undefined;
    this.deps.output.appendLine(`[agent] ${request.tool}: ${allow ? "allowed" : "denied"} by the user`);
    this.deps.audit({ kind: "approval", detail: allow ? "allowed" : "denied", tool: request.tool });
    return allow ? { allow: true } : { allow: false, reason: `The user denied ${request.tool}.` };
  }

  /** The user answered the approval card of a tool with no card of its own. */
  toolDecision(requestId: string, allow: boolean): void {
    if (this.waiting?.kind === "tool" && this.waiting.requestId === requestId) this.resolveWaiting(allow);
  }

  /**
   * read_past_session: old conversations could carry planted instructions, so the user decides
   * (the recall card, with a link to open that conversation first). A conversation the user
   * picked themselves (continued from the history) needs no approval.
   */
  private async decideRecall(request: ApprovalRequest): Promise<ApprovalDecision | undefined> {
    const id = String(request.args.id ?? "");
    if (this.memory.named.has(id)) return { allow: true };
    let past: ConversationInfo | undefined;
    try {
      past = await this.memory.findPast(id);
    } catch (err) {
      this.deps.output.appendLine(`[memory] could not look up ${id}: ${(err as Error).message}`);
    }
    if (!past) return { allow: false, reason: `There is no earlier conversation with id ${id} in this project.` };
    const found = past;
    const part = typeof request.args.part === "string" ? request.args.part : "work";
    const allow = await new Promise<boolean | undefined>((resolve) => {
      this.waiting = { kind: "recall", requestId: request.toolCallId, resolve };
      this.deps.post({
        type: "recall-approval",
        chatId: this.chatId,
        recall: { requestId: request.toolCallId, conversationId: found.id, title: found.title, updatedAt: found.updatedAt, part, summary: found.summary },
      });
    });
    this.deps.post({ type: "recall-approval", chatId: this.chatId, recall: undefined });
    if (allow === undefined) return undefined;
    this.memory.decision(`the user ${allow ? "allowed" : "declined"} reading the earlier conversation "${found.title}"`);
    if (allow) this.memory.named.add(id);
    return allow ? { allow: true } : { allow: false, reason: "The user declined: do not use that earlier conversation." };
  }

  /**
   * propose_plan: the plan card. Approve = allow (the agent carries out the plan). Edit = deny
   * with the user's requested changes as the reason, so the agent revises and proposes again.
   */
  private async decidePlan(request: ApprovalRequest): Promise<ApprovalDecision | undefined> {
    const plan = parsePlan(request.args);
    const answer = await new Promise<{ approve: boolean; changes?: string } | undefined>((resolve) => {
      this.waiting = { kind: "plan", requestId: request.toolCallId, resolve };
      this.deps.post({ type: "plan-approval", chatId: this.chatId, plan: { requestId: request.toolCallId, ...plan } });
    });
    this.deps.post({ type: "plan-approval", chatId: this.chatId, plan: undefined });
    if (answer === undefined) return undefined;
    if (answer.approve) {
      this.memory.decision(`the user approved the plan "${plan.title}": ${plan.steps.join("; ")}`);
      return { allow: true };
    }
    const changes = answer.changes?.trim() || "The user did not approve this plan.";
    this.memory.decision(`the user asked to change the plan "${plan.title}": ${changes}`);
    return { allow: false, reason: `The user wants changes to the plan: ${changes}\nRevise it and call propose_plan again before editing.` };
  }

  /** The user approved the plan, or asked for changes. */
  planDecision(requestId: string, approve: boolean, changes?: string): void {
    if (this.waiting?.kind === "plan" && this.waiting.requestId === requestId) this.resolveWaiting({ approve, changes });
  }

  /** The user answered the recall card. */
  recallDecision(requestId: string, allow: boolean): void {
    if (this.waiting?.kind === "recall" && this.waiting.requestId === requestId) this.resolveWaiting(allow);
  }

  private async decideCommand(request: ApprovalRequest): Promise<ApprovalDecision | undefined> {
    const command = String(request.args.command ?? "");
    const cwd = typeof request.args.cwd === "string" ? request.args.cwd : undefined;
    if (!vscode.workspace.isTrusted) {
      this.deps.audit({ kind: "blocked", detail: "command in an untrusted workspace", tool: RUN_COMMAND_TOOL });
      return { allow: false, reason: RESTRICTED_MODE_REASON };
    }
    // The policy decides first: a blocked command never reaches a card.
    const verdict = checkCommand(command, this.config.security, this.tainted !== undefined);
    if (verdict.blocked) {
      this.deps.audit({ kind: "blocked", detail: verdict.blocked, tool: RUN_COMMAND_TOOL });
      this.memory.decision(`Moon blocked the command (${verdict.blocked}): ${command}`);
      this.deps.post({ type: "event", chatId: this.chatId, event: { type: "notice", text: `Moon blocked a command: ${verdict.blocked}` } });
      return {
        allow: false,
        reason: `Moon blocked this command: ${verdict.blocked}. Do not try to reach the same result another way; if it is really needed, tell the user to run it themselves.`,
      };
    }
    const grant = (always: boolean) => this.run?.approvals.grant(RUN_COMMAND_TOOL, { command, cwd }, always);
    if (this.alwaysAllowed.has(command) && !this.tainted) {
      grant(true);
      return { allow: true };
    }
    this.deps.audit({ kind: "approval", detail: "asked", tool: RUN_COMMAND_TOOL, warnings: verdict.warnings.length, tainted: this.tainted !== undefined });
    const decision = await new Promise<CommandDecision | undefined>((resolve) => {
      this.waiting = { kind: "command", requestId: request.toolCallId, resolve };
      this.deps.post({
        type: "command-approval",
        chatId: this.chatId,
        approval: { requestId: request.toolCallId, command, cwd, risks: verdict.warnings, tainted: this.tainted },
      });
    });
    this.deps.post({ type: "command-approval", chatId: this.chatId, approval: undefined });
    if (decision === undefined) return undefined;
    this.deps.audit({ kind: "approval", detail: decision === "deny" ? "denied" : decision === "always" ? "allowed always" : "allowed once", tool: RUN_COMMAND_TOOL });
    if (decision === "deny") {
      this.memory.decision(`the user denied the command: ${command}`);
      return { allow: false, reason: "The user denied this command." };
    }
    // "Always" never applies in a tainted task (the card hides it too).
    const always = decision === "always" && !this.tainted;
    if (always) this.alwaysAllowed.add(command);
    // Recorded for run_command, which runs only with this approval (complete mediation).
    grant(always);
    return { allow: true };
  }

  private async decideReview(): Promise<ApprovalDecision | undefined> {
    if (!vscode.workspace.isTrusted) {
      this.deps.audit({ kind: "blocked", detail: "apply in an untrusted workspace", tool: APPLY_CHANGES_TOOL });
      return { allow: false, reason: RESTRICTED_MODE_REASON };
    }
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
      this.memory.decision("the user discarded all the changes on the review screen");
      void this.disposeRun();
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
          // Hidden characters shown as ⟦U+...⟧ (display only: what is applied is the real text).
          lines: hunkWithContext(file, hunk, reviewContextLines).map((line) => ({ ...line, text: revealHidden(line.text).text })),
        })),
      })),
      commands: run.commands.map((c) => ({
        command: c.command,
        exitCode: c.exitCode,
        timedOut: c.timedOut,
        cancelled: c.cancelled,
        outputTail: c.output.slice(-reviewOutputChars),
      })),
      warnings: reviewWarnings(files),
      verified: this.verified(run),
    };
  }

  /** Whether the agent's last command ran after its last edit, and how it ended (claim, check, act). */
  private verified(run: AgentRun): ReviewView["verified"] {
    const last = this.lastCommand;
    if (!last) return { state: "none" };
    if (last.at < run.lastEditAt) return { state: "stale", command: last.command, exitCode: last.exitCode };
    return { state: last.exitCode === 0 ? "passed" : "failed", command: last.command, exitCode: last.exitCode };
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
    this.memory.apply(
      files.map((f) => {
        const accepted = applied.has(f.rel) ? (approved.accepted.get(f.rel)?.size ?? 0) : 0;
        return { path: f.rel, accepted, rejected: f.hunks.length - accepted };
      }),
    );
    this.deps.post({ type: "applied", chatId: this.chatId, files: applied.size, hunks, undoable: applied.size > 0 });
    return reviewReport(files, approved.accepted, REJECTED_HUNK_PREVIEW_LINES);
  }

  // ---- context ----

  /**
   * Before the first message: builds the project map and rules into the session's opening
   * message and shows the summary in the panel. Returns the text for the @-mentions.
   * A failure here never blocks the chat: the agent still has its search tools.
   */
  private async assembleContext(request: string, mentions: readonly Mention[]): Promise<string> {
    const readText = (rel: string) => this.readProjectText(rel);
    try {
      if (!this.chat.started) {
        const pack = await this.assembler.prepare({ root: this.root, request, mentions, windowTokens: this.windowTokens, readText });
        this.chat.setSessionContext({ openingMessages: [pack.openingMessage], compactAtTokens: pack.compactAtTokens });
        this.deps.post({ type: "context", chatId: this.chatId, summary: pack.summary });
        const { map } = pack.summary;
        this.deps.output.appendLine(
          `[context] map ${map.tokens}/${map.budgetTokens} tokens, ${map.shownFiles} of ${map.totalFiles} files, window ${this.windowTokens}`,
        );
        return pack.mentionText;
      }
      const { context } = this.config;
      return expandMentions(mentions, {
        readText,
        tags: (rel) => this.assembler.tagsFor(this.root, rel),
        maxTokens: context.mentionMaxTokens,
        symbolMaxLines: context.symbolMaxLines,
      }).text;
    } catch (err) {
      this.deps.output.appendLine(`[context] could not build the project map: ${(err as Error).message}`);
      return "";
    }
  }

  // ---- helpers ----

  /**
   * The model failed and the same request starts again on the other one: throw away what the
   * failed attempt did (its hidden copy, any open approval or review card) and start from a
   * fresh copy of the project. The user's files were never touched by the failed attempt.
   */
  private async freshRun(): Promise<void> {
    this.run?.stop();
    this.resolveWaiting();
    this.deps.post({ type: "command-approval", chatId: this.chatId, approval: undefined });
    this.deps.post({ type: "review", chatId: this.chatId, review: undefined });
    this.deps.post({ type: "question", chatId: this.chatId, question: undefined });
    this.deps.post({ type: "tool-approval", chatId: this.chatId, approval: undefined });
    this.deps.post({ type: "recall-approval", chatId: this.chatId, recall: undefined });
    this.deps.post({ type: "plan-approval", chatId: this.chatId, plan: undefined });
    await this.disposeRun();
    if (this.stopped) return;
    const ready = await this.ensureRun();
    if (ready !== true) throw new Error(ready.error);
    this.deps.output.appendLine("[agent] model switched: the request starts again on a fresh working copy");
  }

  /** Makes the hidden copy if this chat has none. True when ready, else the reason. */
  private async ensureRun(): Promise<true | { error: string }> {
    if (this.run) return true;
    const editor = new VsCodeEditorBridge(this.root);
    let run: AgentRun;
    try {
      run = await AgentRun.create({
        projectRoot: this.root,
        config: this.config,
        editor,
        applyApproved: () => this.applyApproved(),
        onCommand: (result) => {
          this.lastCommand = { at: Date.now(), command: result.command, exitCode: result.exitCode };
          this.memory.command(result);
        },
      });
    } catch (err) {
      return { error: (err as Error).message };
    }
    // Stopped while the copy was being made: throw it away at once.
    if (this.stopped || this.run) {
      void run.dispose();
      return true;
    }
    this.run = run;
    run.tools.memory = this.memory.hooks();
    run.tools.audit = (entry) => this.deps.audit(entry);
    this.lastCommand = undefined;
    this.deps.service.setActiveRun(run);
    this.deps.output.appendLine(`[agent] working copy: ${run.copy.dir}`);
    return true;
  }

  private async disposeRun(): Promise<void> {
    const run = this.run;
    if (!run) return;
    this.run = undefined;
    this.deps.service.setActiveRun(undefined);
    this.approved = undefined;
    this.alwaysAllowed.clear();
    await run.dispose();
  }

  private resolveWaiting(answer?: CommandDecision | ReviewChoice | string | boolean | { approve: boolean; changes?: string }): void {
    const waiting = this.waiting;
    this.waiting = undefined;
    if (!waiting) return;
    if (waiting.kind === "command") waiting.resolve(answer as CommandDecision | undefined);
    else if (waiting.kind === "question") waiting.resolve(answer as string | undefined);
    else if (waiting.kind === "tool" || waiting.kind === "recall") waiting.resolve(answer as boolean | undefined);
    else if (waiting.kind === "plan") waiting.resolve(answer as { approve: boolean; changes?: string } | undefined);
    else waiting.resolve(answer as ReviewChoice);
  }

  /**
   * The agent asked a question (ask_user_question): the panel shows it with the agent's options
   * and a box for the user's own answer. Undefined = stopped before answering.
   */
  private async askUser(question: QuestionRequest): Promise<string | undefined> {
    const answer = await new Promise<string | undefined>((resolve) => {
      this.waiting = { kind: "question", requestId: question.toolCallId, resolve };
      this.deps.post({
        type: "question",
        chatId: this.chatId,
        question: { requestId: question.toolCallId, question: question.question, options: question.options },
      });
    });
    this.deps.post({ type: "question", chatId: this.chatId, question: undefined });
    if (answer !== undefined) {
      this.deps.output.appendLine(`[agent] question "${question.question}" answered: ${answer}`);
      this.memory.decision(`the user answered "${answer}"`);
    }
    return answer;
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
