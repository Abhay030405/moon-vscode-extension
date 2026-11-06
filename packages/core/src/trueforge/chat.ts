// One chat in Moon's panel = one TrueForge session. Each message the user sends is a turn
// on that session; the turn's events are streamed back and mapped to MoonEvents.
//
// Stop = abort the local stream at once (the UI stops immediately) and ask TrueForge to
// cancel the session's running turn.
//
// Only turns that finished normally make up the conversation: each new turn continues from
// the last finished one. A stopped or failed turn becomes a dead branch, so its unanswered
// question is not answered again with the next message.

import type { TrueForgeClient } from "./client.js";
import { TurnEventMapper, type MoonEvent } from "./events.js";
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

  constructor(private readonly options: ChatOptions) {}

  get busy(): boolean {
    return this.running !== undefined;
  }

  /** Sends one user message and reports every event to `emit`. Resolves when the turn ends. */
  async send(message: string, emit: (event: MoonEvent) => void): Promise<void> {
    if (this.running) throw new Error("A turn is already running in this chat.");
    const abort = new AbortController();
    this.running = abort;
    let finished = false;
    let turnId: string | undefined;
    const report = (event: MoonEvent) => {
      if (event.type === "done") {
        finished = true;
        if (event.status === "done" && turnId) this.lastFinishedTurnId = turnId;
      }
      emit(event);
    };
    try {
      const { client, model } = this.options;
      if (!this.sessionId) {
        const spec = loadAgentDefinition(this.options.definitionFile, { model, mcpServer: this.options.mcpServer });
        this.sessionId = await createSession(client, spec, firstLine(message));
        const url = sessionUrl(this.options.sessionUrlTemplate, this.options.baseUrl, this.sessionId);
        report({ type: "session", sessionId: this.sessionId, url, model });
      }
      const stream = await client.sdk.sessions.createTurnStream(
        this.sessionId,
        {
          input: [{ type: "user.message", content: message }],
          // "none" = start the conversation fresh (first message, or nothing has finished yet).
          previousTurnId: this.lastFinishedTurnId ?? "none",
        },
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

  /** Stops the running turn. The UI is told "cancelled" right away; TrueForge is told in the background. */
  stop(): void {
    if (!this.running) return;
    this.running.abort();
    if (this.sessionId) {
      void this.options.client.sdk.sessions.cancel(this.sessionId, {}).catch(() => {
        // TrueForge may already have finished the turn; nothing to do.
      });
    }
  }
}

function firstLine(text: string): string {
  return text.trim().split(/\r?\n/)[0]!.slice(0, 80);
}
