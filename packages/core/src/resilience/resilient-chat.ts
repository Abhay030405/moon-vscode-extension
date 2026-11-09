// A chat that survives a broken model: the same interface as AgentChat (send, answer, stop,
// waitingFor), so inline edit and agent mode use it unchanged.
//
// When a turn fails, the failure is classified (error-classifier.ts):
// - Moon's tools or TrueForge itself unreachable: the backup would fail the same way, so the
//   error is shown as it is;
// - "too many requests": wait (resilience.rateLimitWaitMs, doubling) and try the same model
//   again, at most resilience.rateLimitRetries times;
// - otherwise: tell the panel (model-switch event), throw away the failed attempt (its half
//   answer, its edits: beforeRestart) and start the SAME request fresh on a new TrueForge
//   session with the other model. Never joined to the half answer; never a direct model call.
// Each model is tried at most once per task. Both failed: a clear message, nothing changed.
// Earlier finished messages of the chat are given to the new session as context, so a switch
// in the middle of a conversation keeps what was said.

import type { AgentChat } from "../trueforge/chat.js";
import type { ApprovalAnswer } from "../trueforge/approvals.js";
import type { ApprovalRequest, MoonEvent, QuestionRequest } from "../trueforge/events.js";
import { classifyFailure, type Failure } from "./error-classifier.js";
import type { ModelRouter } from "./model-router.js";

export interface ResilienceSettings {
  rateLimitRetries: number;
  rateLimitWaitMs: number;
}

export interface ResilientChatOptions {
  router: ModelRouter;
  /** A new TrueForge chat (same agent definition and tools) whose session uses `model`. */
  makeChat(model: string): AgentChat;
  settings: ResilienceSettings;
  /**
   * Before the request starts again on another model: throw away what the failed attempt did
   * (agent mode: a fresh hidden copy; inline edit: drop any proposal).
   */
  beforeRestart?(): Promise<void> | void;
  /** One line per decision, for the output channel. */
  log?(line: string): void;
  /**
   * What was done so far (the work record), for the new session after a switch: files read,
   * commands and their results, what the user applied. Undefined when nothing was done.
   */
  workNote?(): string | undefined;
}

type SessionContext = { openingMessages: string[]; compactAtTokens?: number };

/** The request being worked on: what to send again if the model changes. */
interface Task {
  message: string;
  reply: string;
  tried: Set<string>;
  failures: { model: string; failure: Failure }[];
  rateRetries: number;
}

export class ResilientChat {
  private chat: AgentChat;
  private sessionContext: SessionContext | undefined;
  /** Finished exchanges, for a new session after a switch. */
  private readonly history: { user: string; reply: string }[] = [];
  private task: Task | undefined;
  private stopped = false;
  private wakeUp: (() => void) | undefined;

  constructor(private readonly options: ResilientChatOptions) {
    this.chat = options.makeChat(options.router.current);
  }

  /** The model the current session uses ("provider/model"). */
  get model(): string {
    return this.chat.model;
  }

  get started(): boolean {
    return this.chat.started || this.history.length > 0;
  }

  /** A turn is streaming right now (stopping it makes the chat report "cancelled" itself). */
  get turnRunning(): boolean {
    return this.chat.busy;
  }

  get waitingFor(): readonly ApprovalRequest[] {
    return this.chat.waitingFor;
  }

  /** The current TrueForge session and the turn the next message continues from. */
  get position(): { sessionId: string; lastTurnId: string | undefined } | undefined {
    return this.chat.position;
  }

  /**
   * Continues a session from the history (a reopened chat): the next message chains onto
   * `lastTurnId`. The stored session is first moved to the current model and MCP server name
   * (in place, its history is kept).
   */
  attach(sessionId: string, lastTurnId: string | undefined): void {
    this.chat.attach(sessionId, lastTurnId);
  }

  setSessionContext(context: SessionContext): void {
    this.sessionContext = context;
    this.chat.setSessionContext(context);
  }

  async send(message: string, emit: (event: MoonEvent) => void): Promise<void> {
    this.stopped = false;
    this.task = { message, reply: "", tried: new Set(), failures: [], rateRetries: 0 };
    const { model, switchedBack } = this.options.router.startTask();
    if (model !== this.chat.model) {
      if (switchedBack) emit({ type: "model-switch", direction: "back", from: this.chat.model, to: model });
      this.log(`task starts on ${model}${switchedBack ? " (main model is back)" : ""}`);
      // A session with history moves to the model in place, so nothing said or done is lost.
      if (this.chat.started) this.chat.switchModel(model);
      else this.replaceChat(model);
    }
    await this.attempt((e) => this.chat.send(message, e), emit);
  }

  async answer(answers: readonly ApprovalAnswer[], emit: (event: MoonEvent) => void): Promise<void> {
    await this.attempt((e) => this.chat.answer(answers, e), emit);
  }

  /** The question the agent is waiting on (undefined when none). */
  get question(): QuestionRequest | undefined {
    return this.chat.question;
  }

  /** Answers the agent's question; the agent continues (a failing model falls back like any turn). */
  async answerQuestion(answer: string, emit: (event: MoonEvent) => void): Promise<void> {
    await this.attempt((e) => this.chat.answerQuestion(answer, e), emit);
  }

  stop(): void {
    this.stopped = true;
    // Keep the stopped request in the history: if a later message moves to another model
    // (e.g. "continue" after a switch back), that model must know what was asked.
    if (this.task) {
      this.history.push({ user: this.task.message, reply: `${this.task.reply}${this.task.reply ? " " : ""}(stopped by the user before finishing)` });
      this.task = undefined;
    }
    this.chat.stop();
    this.wakeUp?.();
  }

  /** Runs one turn; a failure is held back and handled (retry, switch, or reported). */
  private async attempt(run: (emit: (event: MoonEvent) => void) => Promise<void>, emit: (event: MoonEvent) => void): Promise<void> {
    const task = this.task;
    task?.tried.add(this.chat.model);
    let failed: string | undefined;
    await run((event) => {
      if (event.type === "done" && event.status === "error") {
        failed = event.message ?? "unknown error";
        return;
      }
      if (event.type === "text" && task) task.reply += event.text;
      if (event.type === "done" && event.status === "done" && task) {
        this.history.push({ user: task.message, reply: task.reply });
        this.task = undefined;
      }
      emit(event);
    });
    if (failed === undefined) return;
    if (this.stopped) return emit({ type: "done", status: "cancelled" });
    await this.recover(failed, emit);
  }

  private async recover(text: string, emit: (event: MoonEvent) => void): Promise<void> {
    const task = this.task;
    const model = this.chat.model;
    const failure = classifyFailure(text);
    this.log(`${model} failed (${failure.kind}): ${text}`);
    if (!task || !failure.switchModel) return emit({ type: "done", status: "error", message: text });
    task.failures.push({ model, failure });

    if (failure.retryFirst && task.rateRetries < this.options.settings.rateLimitRetries) {
      const waitMs = this.options.settings.rateLimitWaitMs * 2 ** task.rateRetries;
      task.rateRetries++;
      emit({ type: "notice", text: `${model}: too many requests, trying again in ${Math.round(waitMs / 1000)} s` });
      await this.sleep(waitMs);
      if (this.stopped) return emit({ type: "done", status: "cancelled" });
      return this.restart(model, emit);
    }

    this.options.router.reportFailure(model, failure);
    const next = this.options.router.next(task.tried);
    if (!next) return emit({ type: "done", status: "error", message: allFailedMessage(task, this.options.router) });
    emit({ type: "model-switch", direction: "fallback", from: model, to: next, reason: failure.label });
    this.log(`switching to ${next}: the same request starts fresh`);
    await this.restart(next, emit);
  }

  /** The same request, from the start, on a new session with `model`. */
  private async restart(model: string, emit: (event: MoonEvent) => void): Promise<void> {
    const task = this.task!;
    task.reply = "";
    this.chat.stop();
    await this.options.beforeRestart?.();
    if (this.stopped) return emit({ type: "done", status: "cancelled" });
    this.replaceChat(model);
    await this.attempt((e) => this.chat.send(task.message, e), emit);
  }

  private replaceChat(model: string): void {
    this.chat = this.options.makeChat(model);
    const opening = [...(this.sessionContext?.openingMessages ?? [])];
    if (this.history.length > 0) opening.push(historyMessage(this.history));
    const work = this.options.workNote?.();
    if (work) opening.push(work);
    if (opening.length > 0 || this.sessionContext) {
      this.chat.setSessionContext({ openingMessages: opening, compactAtTokens: this.sessionContext?.compactAtTokens });
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        resolve();
      }
      this.wakeUp = done;
    });
  }

  private log(line: string): void {
    this.options.log?.(`[models] ${line}`);
  }
}

function allFailedMessage(task: Task, router: ModelRouter): string {
  const parts = task.failures.map(({ model, failure }) => `${router.role(model)} model ${model}: ${failure.label}`);
  return `Every model failed (${parts.join("; ")}). Nothing was changed. Check the models in TrueForge, then press Retry.`;
}

/** Earlier exchanges for a new session after a switch (the new model has not seen them). */
function historyMessage(history: readonly { user: string; reply: string }[]): string {
  const lines = history.map((h, i) => `${i + 1}. User: ${h.user}\n   You answered: ${h.reply || "(no text)"}`);
  return `Earlier in this conversation (Moon switched models since, so you have not seen these):\n${lines.join("\n")}`;
}
