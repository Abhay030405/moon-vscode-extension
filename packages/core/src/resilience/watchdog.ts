// Moon's own timer for a model that never answers (a hanging server). TrueForge alone would
// wait minutes; Task C needs the backup to take over within ~10-15 s.
//
// Checked on real TrueForge: with a hanging provider the turn still sends turn.created,
// mcp.initialize and an EMPTY model.message at once, then nothing. So the watchdog waits for
// real model output (a text delta, a message with text or tool calls, or the turn's end),
// not for "any event".
// - Before the first output: resilience.watchdogMs (short: this is the Task C case).
// - Later model calls in the same turn: resilience.stallMs (big contexts start slower).
// - Paused while tools run (a long pytest is not a hang) and while waiting for approval.

/** The part of a TrueForge stream event the watchdog looks at. */
export interface WatchedEvent {
  type: string;
  content?: unknown;
  toolCalls?: readonly unknown[] | null;
}

export interface WatchdogTimes {
  firstReplyMs: number;
  stallMs: number;
}

export class ReplyWatchdog {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private replied = false;
  /** Tool calls the model asked for that have not answered yet. */
  private openCalls = 0;

  constructor(
    private readonly times: WatchdogTimes,
    /** Called once when the model did not answer in time (with the time waited). */
    private readonly onTimeout: (waitedMs: number) => void,
  ) {}

  /**
   * A new turn. "message": the model is called at once. "answer": approved tools run first,
   * so the watchdog starts when their results come back.
   */
  start(kind: "message" | "answer"): void {
    this.replied = kind === "answer";
    this.openCalls = 0;
    if (kind === "message") this.arm(this.times.firstReplyMs);
    else this.disarm();
  }

  observe(event: WatchedEvent): void {
    switch (event.type) {
      case "model.message.delta":
        this.output();
        return;
      case "model.message": {
        const calls = event.toolCalls?.length ?? 0;
        const hasText = typeof event.content === "string" ? event.content.length > 0 : Boolean(event.content);
        if (calls === 0 && !hasText) return; // the empty placeholder TrueForge sends first
        this.openCalls += calls;
        this.output();
        return;
      }
      case "tool.response":
        this.openCalls = Math.max(0, this.openCalls - 1);
        if (this.openCalls === 0) this.arm(this.waitMs());
        return;
      case "thread.context_compaction_started":
      case "thread.context_compaction_finished":
        if (this.openCalls === 0) this.arm(this.waitMs());
        return;
      case "tool.approval_required":
      case "turn.done":
        this.disarm();
        return;
      default:
        return;
    }
  }

  stop(): void {
    this.disarm();
  }

  private output(): void {
    this.replied = true;
    if (this.openCalls > 0) this.disarm(); // tools run now; restart when they answer
    else this.arm(this.times.stallMs);
  }

  private waitMs(): number {
    return this.replied ? this.times.stallMs : this.times.firstReplyMs;
  }

  private arm(ms: number): void {
    this.disarm();
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.onTimeout(ms);
    }, ms);
  }

  private disarm(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
