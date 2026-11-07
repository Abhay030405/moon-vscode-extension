// One chat in Moon's panel = one TrueForge session. Each message the user sends is a turn
// on that session; the turn's events are streamed back and mapped to MoonEvents.
//
// Stop = abort the local stream at once (the UI stops immediately) and ask TrueForge to
// cancel the session's running turn.
//
// Only turns that finished normally make up the conversation: each new turn continues from
// the last finished one. A stopped or failed turn becomes a dead branch, so its unanswered
// question is not answered again with the next message.
//
// A turn that pauses for tool approval is answered with answer(): a new turn whose input is
// the decisions, chained to the paused turn. While paused, send() first denies the waiting
// calls (the user moved on), so the conversation never hangs on an unanswered approval.

import type { TrueForgeApi } from "@truefoundry/trueforge-sdk";
import { approvalInput, type ApprovalAnswer } from "./approvals.js";
import type { TrueForgeClient } from "./client.js";
import { TurnEventMapper, type ApprovalRequest, type MoonEvent } from "./events.js";
import { createSession, loadAgentDefinition, sessionUrl } from "./sessions.js";

export interface ChatOptions {
  client: TrueForgeClient;
  /** Absolute path of the agent definition (agents/moon-agent.json). */
  definitionFile: string;
  /** "provider/model" for this chat's session. */
  model: string;
  mcpServer: string;
  baseUrl: string;
  sessionUrlTemplate: string;
}

export class AgentChat {
  private sessionId: string | undefined;
  private running: AbortController | undefined;
  /** Last turn that finished normally; the next turn continues from it. */
  private lastFinishedTurnId: string | undefined;
  /** A turn waiting for approval, and what it waits for. */
  private paused: { turnId: string; requests: ApprovalRequest[] } | undefined;

  constructor(private readonly options: ChatOptions) {}

  get busy(): boolean {
    return this.running !== undefined;
  }

  /** Tool calls waiting for the user's decision (empty when not paused). */
  get waitingFor(): readonly ApprovalRequest[] {
    return this.paused?.requests ?? [];
  }

  /** Sends one user message and reports every event to `emit`. Resolves when the turn ends. */
  async send(message: string, emit: (event: MoonEvent) => void): Promise<void> {
    if (this.paused) {
      const reason = "The user sent a new message instead of answering.";
      await this.answer(this.paused.requests.map((request) => ({ request, decision: { allow: false, reason } })), () => {});
    }
    await this.runTurn([{ type: "user.message", content: message }], () => this.lastFinishedTurnId ?? "none", emit, message);
  }

  /** Answers the paused turn's approvals; the agent continues in a new turn. */
  async answer(answers: readonly ApprovalAnswer[], emit: (event: MoonEvent) => void): Promise<void> {
    const paused = this.paused;
    if (!paused) throw new Error("Nothing is waiting for approval.");
    this.paused = undefined;
    await this.runTurn(approvalInput(answers), () => paused.turnId, emit);
  }

  /** Stops the running turn. The UI is told "cancelled" right away; TrueForge is told in the background. */
  stop(): void {
    this.paused = undefined;
    if (!this.running) return;
    this.running.abort();
    if (this.sessionId) {
      void this.options.client.sdk.sessions.cancel(this.sessionId, {}).catch(() => {
        // TrueForge may already have finished the turn; nothing to do.
      });
    }
  }

  private async runTurn(
    input: TrueForgeApi.TurnInputItem[],
    previousTurnId: () => string,
    emit: (event: MoonEvent) => void,
    title?: string,
  ): Promise<void> {
    if (this.running) throw new Error("A turn is already running in this chat.");
    const abort = new AbortController();
    this.running = abort;
    let finished = false;
    let turnId: string | undefined;
    let approvals: ApprovalRequest[] = [];
    const report = (event: MoonEvent) => {
      if (event.type === "approval") approvals = event.requests;
      if (event.type === "done") {
        finished = true;
        if (event.status === "done" && turnId) this.lastFinishedTurnId = turnId;
        if (event.status === "paused" && turnId) this.paused = { turnId, requests: approvals };
      }
      emit(event);
    };
    try {
      const { client, model } = this.options;
      if (!this.sessionId) {
        const spec = loadAgentDefinition(this.options.definitionFile, { model, mcpServer: this.options.mcpServer });
        this.sessionId = await createSession(client, spec, title ? firstLine(title) : undefined);
        const url = sessionUrl(this.options.sessionUrlTemplate, this.options.baseUrl, this.sessionId);
        report({ type: "session", sessionId: this.sessionId, url, model });
      }
      const stream = await client.sdk.sessions.createTurnStream(
        this.sessionId,
        // "none" = start the conversation fresh (first message, or nothing has finished yet).
        { input, previousTurnId: previousTurnId() },
        { abortSignal: abort.signal },
      );
      const mapper = new TurnEventMapper();
      for await (const event of stream) {
        if (event.type === "turn.created") turnId = event.turnId;
        for (const moonEvent of mapper.map(event)) report(moonEvent);
        if (finished) break;
      }
      if (!finished) report(abort.signal.aborted ? { type: "done", status: "cancelled" } : { type: "done", status: "error", message: "The stream ended without a result." });
    } catch (err) {
      if (!finished) {
        report(abort.signal.aborted ? { type: "done", status: "cancelled" } : { type: "done", status: "error", message: (err as Error).message });
      }
    } finally {
      this.running = undefined;
    }
  }
}

function firstLine(text: string): string {
  return text.trim().split(/\r?\n/)[0]!.slice(0, 80);
}
