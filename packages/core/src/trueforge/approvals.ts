// Answers to TrueForge tool approvals. TrueForge's answer is allow, or deny with a reason the
// agent sees. Moon sends them as the input of a new turn chained to the paused one.

import type { TrueForgeApi } from "@truefoundry/trueforge-sdk";
import type { ApprovalRequest } from "./events.js";

export type ApprovalDecision = { allow: true } | { allow: false; reason: string };

export interface ApprovalAnswer {
  request: ApprovalRequest;
  decision: ApprovalDecision;
}

/** The turn input that carries the answers. */
export function approvalInput(answers: readonly ApprovalAnswer[]): TrueForgeApi.TurnInputItem[] {
  return answers.map(({ request, decision }) => ({
    type: "user.tool_approval" as const,
    threadId: request.threadId,
    toolCallId: request.toolCallId,
    approval: decision.allow ? { status: "allow" as const } : { status: "deny" as const, reason: decision.reason },
  }));
}
