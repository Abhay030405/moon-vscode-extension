// Complete mediation (OWASP LLM03 #7): a tool that changes things runs only if the user
// approved THIS call. TrueForge asks the user before it calls the tool, but Moon's MCP server
// cannot see that answer, so the extension records each approval here and the tool checks it
// before it does anything. A call that reaches Moon some other way (a local program that got
// past the server's token, a replayed request) finds no approval and is refused.

import { createHash } from "node:crypto";

interface Grant {
  /** Gone after this time (ms since epoch); sticky grants ("Always for this run") never expire. */
  expiresAt: number;
  sticky: boolean;
}

export class ApprovalLedger {
  private readonly grants = new Map<string, Grant>();

  /** `ttlMs`: how long a one-time approval waits for its tool call (security.approvalTtlMs). */
  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** The user allowed `tool` with exactly these arguments. `sticky` = "Always for this run". */
  grant(tool: string, args: Record<string, unknown>, sticky = false): void {
    this.grants.set(approvalKey(tool, args), { expiresAt: this.now() + this.ttlMs, sticky });
  }

  /**
   * True if this exact call was approved. A one-time approval is used up by this check, so
   * the same approval can't run a command twice.
   */
  consume(tool: string, args: Record<string, unknown>): boolean {
    const key = approvalKey(tool, args);
    const grant = this.grants.get(key);
    if (!grant) return false;
    if (grant.sticky) return true;
    this.grants.delete(key);
    return grant.expiresAt >= this.now();
  }

  clear(): void {
    this.grants.clear();
  }
}

/** Stable key for a call: the tool name and its arguments with sorted keys (missing = undefined). */
export function approvalKey(tool: string, args: Record<string, unknown>): string {
  const canonical = Object.keys(args)
    .filter((k) => args[k] !== undefined && args[k] !== null && args[k] !== "")
    .sort()
    .map((k) => [k, args[k]]);
  return createHash("sha256").update(JSON.stringify([tool, canonical])).digest("hex");
}
