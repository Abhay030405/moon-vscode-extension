// Turns TrueForge's streamed turn events into the small set of events Moon's UI shows.
//
// TrueForge streams each model message as an empty `model.message` followed by
// `model.message.delta`s with the same id (text pieces, tool-call pieces, then one with a
// finishReason). Text is passed on piece by piece; tool calls are reported once the message
// is finished, when their names and arguments are complete.
//
// Approval (checked against TrueForge 0.184): when a tool needs approval, TrueForge sends
// `tool.approval_required` and then ends the turn ("done", with requiredActions). Moon reports
// the waiting calls as one "approval" event and the turn as "paused"; the answer is sent as a
// new turn (see chat.ts).

import { mergeEventDelta, type TrueForgeApi } from "@truefoundry/trueforge-sdk";
import { MAIN_THREAD_ID, REPORT_CONTEXT_TOOL, TRUEFORGE_CALL_TOOL } from "../shared/constants.js";
import { MOON_TOOLS } from "../tools/registry.js";
import type { ToolStep } from "../tools/tool.js";

/** A tool call waiting for the user's allow / deny. */
export interface ApprovalRequest {
  toolCallId: string;
  threadId: string;
  /** The tool's own name (unwrapped from TrueForge's call_tool), e.g. "run_command". */
  tool: string;
  args: Record<string, unknown>;
  step: ToolStep;
}

export type MoonEvent =
  /** The session exists; `url` opens it in TrueForge's UI. */
  | { type: "session"; sessionId: string; url: string; model: string }
  /** A piece of the answer (main agent only). */
  | { type: "text"; text: string }
  /** The agent called a tool. `step` is how the live log shows it ("Read" + "src/app.py:1-80"). */
  | { type: "tool-call"; id: string; tool: string; step: ToolStep; subagent: boolean }
  /** The agent reported the files it chose and why (report_context): the panel's context card. */
  | { type: "context-choice"; files: { path: string; reason: string }[] }
  /** A tool call finished. */
  | { type: "tool-result"; id: string }
  /** Something worth a line in the live log (subagent started, context compacted, ...). */
  | { type: "notice"; text: string }
  /** Tool calls waiting for the user's decision (the turn then ends "paused"). */
  | { type: "approval"; requests: ApprovalRequest[] }
  /** The turn ended. "paused" = waiting for approval; answer it to continue. */
  | { type: "done"; status: "done" | "paused" | "cancelled" | "error"; message?: string };

type TurnEvent = TrueForgeApi.TurnStreamingEvent;
type ModelMessage = TrueForgeApi.ModelMessageEvent;

/** One per turn: remembers partly streamed messages until they finish. */
export class TurnEventMapper {
  private readonly messages = new Map<string, ModelMessage>();
  /** Finished tool calls of this turn, by id (to describe approval requests). */
  private readonly calls = new Map<string, ApprovalRequest>();
  private approvalAsked = false;

  map(event: TurnEvent): MoonEvent[] {
    switch (event.type) {
      case "model.message":
        this.messages.set(event.id, { ...event, toolCalls: event.toolCalls ? [...event.toolCalls] : undefined });
        // A message sent whole (not streamed) is already finished.
        return event.finishReason !== undefined ? this.finish(event.id) : [];

      case "model.message.delta": {
        const out: MoonEvent[] = [];
        if (event.threadId === MAIN_THREAD_ID && event.content) out.push({ type: "text", text: event.content });
        const base = this.messages.get(event.id);
        if (base) mergeEventDelta(base, event);
        if (event.finishReason) out.push(...this.finish(event.id));
        return out;
      }

      case "tool.response":
        return [{ type: "tool-result", id: event.toolCallId }];

      case "thread.created":
        return [{ type: "notice", text: `subagent started: ${event.title}` }];

      case "thread.context_compaction_started":
        return [{ type: "notice", text: "compacting the conversation to fit the model's context" }];

      case "tool.approval_required": {
        this.approvalAsked = true;
        const requests = event.toolCalls.map(
          (ref) =>
            this.calls.get(ref.id) ?? {
              toolCallId: ref.id,
              threadId: event.threadId,
              tool: "unknown",
              args: {},
              step: { action: "Tool call", target: "" },
            },
        );
        return [{ type: "approval", requests: requests.map((r) => ({ ...r, threadId: event.threadId })) }];
      }

      case "turn.done": {
        const state = event.state;
        if (state.status === "done") {
          const waiting = this.approvalAsked || (state.requiredActions?.length ?? 0) > 0;
          return [{ type: "done", status: waiting ? "paused" : "done" }];
        }
        if (state.status === "cancelled") return [{ type: "done", status: "cancelled", message: state.reason }];
        return [{ type: "done", status: "error", message: state.message }];
      }

      default:
        return [];
    }
  }

  private finish(messageId: string): MoonEvent[] {
    const message = this.messages.get(messageId);
    this.messages.delete(messageId);
    return (message?.toolCalls ?? []).flatMap((call): MoonEvent[] => {
      const { name, args } = resolveToolCall(call.toolInfo?.name ?? call.function.name, call.function.arguments);
      const step = describeTool(name, args);
      this.calls.set(call.id, { toolCallId: call.id, threadId: message!.threadId, tool: name, args, step });
      const events: MoonEvent[] = [{ type: "tool-call", id: call.id, tool: name, step, subagent: message!.threadId !== MAIN_THREAD_ID }];
      if (name === REPORT_CONTEXT_TOOL) {
        const files = contextFiles(args.files);
        if (files.length > 0) events.push({ type: "context-choice", files });
      }
      return events;
    });
  }
}

/** The files of a report_context call (ignores malformed entries). */
function contextFiles(value: unknown): { path: string; reason: string }[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) =>
    item && typeof item === "object" && typeof item.path === "string" && typeof item.reason === "string"
      ? [{ path: item.path, reason: item.reason }]
      : [],
  );
}

/**
 * The tool really called and its arguments. With deferred tool loading the model may call a
 * tool through TrueForge's wrapper, call_tool {mcp_server, tool_name, input}: that is unwrapped.
 */
export function resolveToolCall(toolName: string, argumentsJson: string): { name: string; args: Record<string, unknown> } {
  let args: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(argumentsJson || "{}");
    if (parsed && typeof parsed === "object") args = parsed as Record<string, unknown>;
  } catch {
    // arguments not valid JSON: describe the call without them
  }
  if (toolName === TRUEFORGE_CALL_TOOL && typeof args.tool_name === "string") {
    const inner = args.input;
    return { name: args.tool_name, args: inner && typeof inner === "object" ? (inner as Record<string, unknown>) : {} };
  }
  return { name: toolName, args };
}

/**
 * Live-log step for a tool call, using the Moon tool's own describe() when it is ours.
 * Other tools (TrueForge's own, e.g. list_tools) show their name as words: "List tools".
 */
export function describeToolCall(toolName: string, argumentsJson: string): ToolStep {
  const { name, args } = resolveToolCall(toolName, argumentsJson);
  return describeTool(name, args);
}

function describeTool(name: string, args: Record<string, unknown>): ToolStep {
  const tool = MOON_TOOLS.find((t) => t.name === name);
  try {
    return tool ? tool.describe(args as never) : { action: humanize(name), target: "" };
  } catch {
    return { action: humanize(name), target: "" };
  }
}

function humanize(name: string): string {
  const words = name.replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
