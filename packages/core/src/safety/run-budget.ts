// Limits for one task (OWASP LLM06 #2, #8, #9: hard caps, loop detection, agentic circuit
// breakers). TrueForge already stops a turn after iterationLimit model calls; this adds what it
// can't see from inside one turn: total tool calls, the same call repeated (a loop, often from
// an injected "read this again"), commands run, tokens spent and time taken, across every turn
// of the task (approvals and answers continue a task in new turns). A breach stops the task
// the same way Stop does, so nothing half-done reaches the user's files.

import { approvalKey } from "./approval-ledger.js";
import type { MoonEvent } from "../trueforge/events.js";
import type { MoonConfig } from "../shared/config.js";

export class RunBudget {
  private toolCalls = 0;
  private commands = 0;
  private tokens = 0;
  private readonly sameCalls = new Map<string, number>();
  private readonly startedAt: number;

  constructor(
    private readonly limits: MoonConfig["security"]["budget"],
    private readonly runCommandTool: string,
    private readonly now: () => number = Date.now,
  ) {
    this.startedAt = now();
  }

  /** Counts one event; returns why the task must stop, or undefined. */
  observe(event: MoonEvent): string | undefined {
    if (event.type === "usage") {
      this.tokens += event.inputTokens + event.outputTokens;
      if (this.tokens > this.limits.maxTokensPerTask) return `it used more than ${this.limits.maxTokensPerTask} tokens`;
    }
    if (event.type === "tool-call") {
      this.toolCalls++;
      if (this.toolCalls > this.limits.maxToolCallsPerTask) return `it made more than ${this.limits.maxToolCallsPerTask} tool calls`;
      if (event.tool === this.runCommandTool && ++this.commands > this.limits.maxCommandsPerTask) {
        return `it asked to run more than ${this.limits.maxCommandsPerTask} commands`;
      }
      const key = approvalKey(event.tool, event.args);
      const same = (this.sameCalls.get(key) ?? 0) + 1;
      this.sameCalls.set(key, same);
      if (same > this.limits.maxIdenticalCalls) return `it called ${event.tool} with the same arguments ${same} times (a loop)`;
    }
    return this.timeUp();
  }

  /** Why the task must stop for time, or undefined. */
  timeUp(): string | undefined {
    const ms = this.now() - this.startedAt;
    return ms > this.limits.maxTaskMs ? `it ran for more than ${Math.round(this.limits.maxTaskMs / 60000)} minutes` : undefined;
  }

  get usedTokens(): number {
    return this.tokens;
  }
}
