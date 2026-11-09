// One chat in Moon's panel = one TrueForge session. Each message the user sends is a turn
// on that session; the turn's events are streamed back and mapped to MoonEvents.
//
// Stop = abort the local stream at once (the UI stops immediately) and ask TrueForge to
// cancel the session's running turn.
//
// Each new turn continues from the last finished one. A turn the user stopped, or that failed
// (for example Moon's tools were unreachable), is kept too: the next message continues from it,
// so the agent still sees what it did (TrueForge accepts a cancelled turn as the previous turn,
// checked on 0.184). If TrueForge refuses that turn, the next message continues from the last
// finished turn instead, and Moon's work record tells the agent what was done.
//
// Before every turn Moon re-registers its MCP server (beforeTurn), so a restarted TrueForge,
// a reloaded window or a new port never leaves the session calling a dead address.
//
// The session's model can change in place (switchModel): the stored agent spec is updated
// (PATCH, checked on 0.184: the history is kept), so going back to the main model, or
// continuing an old chat on another model, keeps the whole conversation.
//
// A turn that pauses for tool approval is answered with answer(): a new turn whose input is
// the decisions, chained to the paused turn. While paused, send() first denies the waiting
// calls (the user moved on), so the conversation never hangs on an unanswered approval.
//
// A turn that pauses on a question (ask_user_question) is answered with answerQuestion(): the
// answer goes back as the tool's result and the agent continues. A new message instead of an
// answer (or after Stop) continues from the question's turn: TrueForge closes the open question
// and passes the message on (checked on 0.184), so the agent's work in that turn is kept.

import type { TrueForgeApi } from "@truefoundry/trueforge-sdk";
import { approvalInput, type ApprovalAnswer } from "./approvals.js";
import type { TrueForgeClient } from "./client.js";
import { TurnEventMapper, type ApprovalRequest, type MoonEvent, type QuestionRequest } from "./events.js";
import { NO_REPLY_PREFIX } from "../resilience/error-classifier.js";
import { ReplyWatchdog, type WatchdogTimes, type WatchedEvent } from "../resilience/watchdog.js";
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
  /** Ends a turn whose model never answers (resilience.watchdogMs / stallMs). Off when undefined. */
  watchdog?: WatchdogTimes;
  /** Labels (session metadata) for the new session, given its first message (history/labels.ts). */
  labels?(firstMessage: string): Record<string, string>;
  /** Last changes to the agent definition before the session is made (web search, GitHub). */
  adjustSpec?(spec: TrueForgeApi.AgentSpec): TrueForgeApi.AgentSpec;
  /** Runs before every turn: Moon re-registers its MCP server with TrueForge. */
  beforeTurn?(): Promise<void>;
  /** Moon's MCP servers in a stored spec start with this (mcp.serverName); renamed to mcpServer on refresh. */
  moonServerPrefix?: string;
}

export class AgentChat {
  private sessionId: string | undefined;
  private running: AbortController | undefined;
  /** Last turn that finished normally; the next turn continues from it. */
  private lastFinishedTurnId: string | undefined;
  /** The turn the user stopped (or that failed) last, if no turn ran since: the next message continues from it. */
  private stoppedTurnId: string | undefined;
  /** The model this chat's session uses (can change in place, see switchModel). */
  private currentModel: string;
  /** The stored spec must get the current model and MCP server name before the next turn. */
  private refreshSpec = false;
  /** A turn waiting for the user, and what it waits for (approvals and/or questions). */
  private paused: { turnId: string; requests: ApprovalRequest[]; questions: QuestionRequest[] } | undefined;
  /** Added to the agent definition when the session is created (see setSessionContext). */
  private sessionContext: { openingMessages: string[]; compactAtTokens?: number } | undefined;

  constructor(private readonly options: ChatOptions) {
    this.currentModel = options.model;
  }

  get busy(): boolean {
    return this.running !== undefined;
  }

  /** Tool calls waiting for the user's decision (empty when not paused). */
  get waitingFor(): readonly ApprovalRequest[] {
    return this.paused?.requests ?? [];
  }

  /**
   * Context for the session, used when it is created (before the first message): opening
   * messages the agent reads first (project rules and map), and when to compact.
   * Ignored once the session exists.
   */
  setSessionContext(context: { openingMessages: string[]; compactAtTokens?: number }): void {
    if (!this.sessionId) this.sessionContext = context;
  }

  /** True once the TrueForge session exists (the first message was sent). */
  get started(): boolean {
    return this.sessionId !== undefined;
  }

  /** The TrueForge session and the turn the next message continues from (undefined before the first message). */
  get position(): { sessionId: string; lastTurnId: string | undefined } | undefined {
    return this.sessionId ? { sessionId: this.sessionId, lastTurnId: this.stoppedTurnId ?? this.lastFinishedTurnId } : undefined;
  }

  /**
   * Continues an existing session (a chat reopened from the history): the next message chains
   * onto `lastTurnId`. That turn may have been stopped, failed or left waiting; if TrueForge
   * refuses to continue from it, the next message starts fresh in the same session (the agent
   * definition's opening messages are kept, and Moon adds the work record).
   */
  attach(sessionId: string, lastTurnId: string | undefined): void {
    this.sessionId = sessionId;
    this.lastFinishedTurnId = undefined;
    this.stoppedTurnId = lastTurnId;
    this.paused = undefined;
    // An old session may name another model or an old MCP server name: brought up to date first.
    this.refreshSpec = true;
  }

  /** Moves this chat's session to another model, keeping its whole history (applied before the next turn). */
  switchModel(model: string): void {
    if (model === this.currentModel) return;
    this.currentModel = model;
    if (this.sessionId) this.refreshSpec = true;
  }

  /** Sends one user message and reports every event to `emit`. Resolves when the turn ends. */
  async send(message: string, emit: (event: MoonEvent) => void): Promise<void> {
    if (this.paused && this.paused.requests.length > 0) {
      const reason = "The user sent a new message instead of answering.";
      await this.answer(this.paused.requests.map((request) => ({ request, decision: { allow: false, reason } })), () => {});
    }
    this.keepQuestionTurn();
    const stopped = this.stoppedTurnId;
    this.stoppedTurnId = undefined;
    const finished = this.lastFinishedTurnId ?? "none";
    await this.runTurn("message", [{ type: "user.message", content: message }], () => stopped ?? finished, emit, message, stopped ? finished : undefined);
  }

  /** Answers the paused turn's approvals; the agent continues in a new turn. */
  async answer(answers: readonly ApprovalAnswer[], emit: (event: MoonEvent) => void): Promise<void> {
    const paused = this.paused;
    if (!paused) throw new Error("Nothing is waiting for approval.");
    this.paused = undefined;
    await this.runTurn("answer", approvalInput(answers), () => paused.turnId, emit);
  }

  /** The question the agent is waiting on (undefined when none). */
  get question(): QuestionRequest | undefined {
    return this.paused?.requests.length ? undefined : this.paused?.questions[0];
  }

  /** Answers the paused question; the answer is the tool's result and the agent continues. */
  async answerQuestion(answer: string, emit: (event: MoonEvent) => void): Promise<void> {
    const paused = this.paused;
    if (!paused || paused.questions.length === 0) throw new Error("No question is waiting for an answer.");
    this.paused = undefined;
    // TrueForge's question tool asks one thing at a time; any extra open question gets the same answer.
    const input = paused.questions.map((q) => ({ type: "user.tool_response" as const, threadId: q.threadId, toolCallId: q.toolCallId, content: answer }));
    await this.runTurn("message", input, () => paused.turnId, emit);
  }

  /** A turn paused only on a question stays part of the conversation (its work is kept). */
  private keepQuestionTurn(): void {
    if (this.paused && this.paused.requests.length === 0 && this.paused.questions.length > 0) this.lastFinishedTurnId = this.paused.turnId;
    this.paused = undefined;
  }

  /** Stops the running turn. The UI is told "cancelled" right away; TrueForge is told in the background. */
  stop(): void {
    this.keepQuestionTurn();
    if (!this.running) return;
    this.running.abort();
    this.cancelRemote();
  }

  /** The model this chat's session uses ("provider/model"). */
  get model(): string {
    return this.currentModel;
  }

  /** Gives the stored session spec the current model and MCP server name (history is kept). */
  private async updateStoredSpec(): Promise<void> {
    const { client } = this.options;
    const session = await client.sdk.sessions.get(this.sessionId!);
    const agent = session.data.agent as { spec?: TrueForgeApi.AgentSpec };
    if (agent.spec) {
      const spec = refreshedSpec(agent.spec, this.currentModel, this.options.mcpServer, this.options.moonServerPrefix);
      await client.sdk.sessions.update(this.sessionId!, { agent: { spec } });
    }
    this.refreshSpec = false;
  }

  private cancelRemote(): void {
    if (!this.sessionId) return;
    void this.options.client.sdk.sessions.cancel(this.sessionId, {}).catch(() => {
      // TrueForge may already have finished the turn; nothing to do.
    });
  }

  private async runTurn(
    kind: "message" | "answer",
    input: TrueForgeApi.TurnInputItem[],
    previousTurnId: () => string,
    emit: (event: MoonEvent) => void,
    firstMessage?: string,
    /** Tried when TrueForge refuses `previousTurnId` (a stopped turn whose cancel has not landed). */
    fallbackPreviousTurnId?: string,
  ): Promise<void> {
    if (this.running) throw new Error("A turn is already running in this chat.");
    const abort = new AbortController();
    this.running = abort;
    let finished = false;
    let turnId: string | undefined;
    let approvals: ApprovalRequest[] = [];
    const questions: QuestionRequest[] = [];
    // Set when the watchdog (not the user) ended the turn: reported as an error, so the
    // fallback can switch models.
    let noReplyMs: number | undefined;
    const watchdog = this.options.watchdog
      ? new ReplyWatchdog(this.options.watchdog, (ms) => {
          noReplyMs = ms;
          abort.abort();
          this.cancelRemote();
        })
      : undefined;
    const ended = (): MoonEvent =>
      noReplyMs !== undefined
        ? { type: "done", status: "error", message: `${NO_REPLY_PREFIX} within ${Math.round(noReplyMs / 1000)} s.` }
        : { type: "done", status: "cancelled" };
    const report = (event: MoonEvent) => {
      if (event.type === "approval") approvals = event.requests;
      if (event.type === "question") questions.push(event.request);
      if (event.type === "done") {
        finished = true;
        if (event.status === "done" && turnId) this.lastFinishedTurnId = turnId;
        // Stopped by the user, or failed (not a model that never answered): the next message continues from it.
        if ((event.status === "cancelled" || event.status === "error") && turnId && noReplyMs === undefined) this.stoppedTurnId = turnId;
        if (event.status === "paused" && turnId) this.paused = { turnId, requests: approvals, questions };
      }
      emit(event);
    };
    try {
      const { client } = this.options;
      const model = this.currentModel;
      await this.options.beforeTurn?.();
      if (this.sessionId && this.refreshSpec) await this.updateStoredSpec();
      if (!this.sessionId) {
        const loaded = loadAgentDefinition(this.options.definitionFile, { model, mcpServer: this.options.mcpServer });
        const spec = withSessionContext(this.options.adjustSpec ? this.options.adjustSpec(loaded) : loaded, this.sessionContext);
        this.sessionId = await createSession(client, spec, this.options.labels?.(firstMessage ? firstLine(firstMessage) : ""));
        const url = sessionUrl(this.options.sessionUrlTemplate, this.options.baseUrl, this.sessionId);
        report({ type: "session", sessionId: this.sessionId, url, model });
      }
      watchdog?.start(kind);
      // "none" = start the conversation fresh (first message, or nothing has finished yet).
      const open = (previous: string) =>
        client.sdk.sessions.createTurnStream(this.sessionId!, { input, previousTurnId: previous }, { abortSignal: abort.signal });
      let stream: Awaited<ReturnType<typeof open>>;
      try {
        stream = await open(previousTurnId());
      } catch (err) {
        if (fallbackPreviousTurnId === undefined || abort.signal.aborted) throw err;
        stream = await open(fallbackPreviousTurnId);
      }
      const mapper = new TurnEventMapper();
      for await (const event of stream) {
        if (event.type === "turn.created") turnId = event.turnId;
        watchdog?.observe(event as WatchedEvent);
        for (const moonEvent of mapper.map(event)) report(moonEvent);
        if (finished) break;
      }
      if (!finished) report(abort.signal.aborted ? ended() : { type: "done", status: "error", message: "The stream ended without a result." });
    } catch (err) {
      if (!finished) {
        report(abort.signal.aborted ? ended() : { type: "done", status: "error", message: (err as Error).message });
      }
    } finally {
      watchdog?.stop();
      this.running = undefined;
    }
  }
}

/** Moon's opening messages and the rest of the stored spec stay; only the model and Moon's MCP server name change. */
function refreshedSpec(spec: TrueForgeApi.AgentSpec, model: string, mcpServer: string, prefix: string | undefined): TrueForgeApi.AgentSpec {
  const servers = spec.mcpServers?.map((s) => (prefix && s.name.startsWith(prefix) ? { ...s, name: mcpServer } : s));
  return { ...spec, model: { ...spec.model, name: model }, ...(servers ? { mcpServers: servers } : {}) };
}

/** Adds Moon's opening messages and compaction threshold to an agent definition. */
function withSessionContext(
  spec: TrueForgeApi.AgentSpec,
  context: { openingMessages: string[]; compactAtTokens?: number } | undefined,
): TrueForgeApi.AgentSpec {
  if (!context) return spec;
  const messages = [...(spec.messages ?? []), ...context.openingMessages.map((content) => ({ type: "user.message" as const, content }))];
  const config = context.compactAtTokens
    ? {
        ...spec.config,
        contextManagement: {
          ...spec.config?.contextManagement,
          compaction: { ...spec.config?.contextManagement?.compaction, trigger: { type: "input_tokens" as const, value: context.compactAtTokens } },
        },
      }
    : spec.config;
  return { ...spec, messages, config };
}

function firstLine(text: string): string {
  return text.trim().split(/\r?\n/)[0]!.slice(0, 80);
}
