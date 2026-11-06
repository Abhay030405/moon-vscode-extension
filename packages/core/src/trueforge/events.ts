// Turns TrueForge's streamed turn events into the small set of events Moon's UI shows.
//
// TrueForge streams each model message as an empty `model.message` followed by
// `model.message.delta`s with the same id (text pieces, tool-call pieces, then one with a
// finishReason). Text is passed on piece by piece; tool calls are reported once the message
// is finished, when their names and arguments are complete.

import { mergeEventDelta, type TrueForgeApi } from "@truefoundry/trueforge-sdk";
import { MAIN_THREAD_ID, TRUEFORGE_CALL_TOOL } from "../shared/constants.js";
import { MOON_TOOLS } from "../tools/registry.js";
import type { ToolStep } from "../tools/tool.js";

export type MoonEvent =
  /** The session exists; `url` opens it in TrueForge's UI. */
  | { type: "session"; sessionId: string; url: string; model: string }
  /** A piece of the answer (main agent only). */
  | { type: "text"; text: string }
  /** The agent called a tool. `step` is how the live log shows it ("Read" + "src/app.py:1-80"). */
  | { type: "tool-call"; id: string; tool: string; step: ToolStep; subagent: boolean }
  /** A tool call finished. */
  | { type: "tool-result"; id: string }
  /** Something worth a line in the live log (subagent started, context compacted, ...). */
  | { type: "notice"; text: string }
  /** The turn ended. */
  | { type: "done"; status: "done" | "cancelled" | "error"; message?: string };

type TurnEvent = TrueForgeApi.TurnStreamingEvent;
type ModelMessage = TrueForgeApi.ModelMessageEvent;

/** One per turn: remembers partly streamed messages until they finish. */
export class TurnEventMapper {
  private readonly messages = new Map<string, ModelMessage>();

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

      case "tool.approval_required":
        return [{ type: "notice", text: `waiting for approval of ${event.toolCalls.length} tool call(s)` }];

      case "turn.done": {
        const state = event.state;
        if (state.status === "done") return [{ type: "done", status: "done" }];
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
    return (message?.toolCalls ?? []).map((call) => ({
      type: "tool-call" as const,
      id: call.id,
      tool: call.function.name,
      step: describeToolCall(call.toolInfo?.name ?? call.function.name, call.function.arguments),
      subagent: message!.threadId !== MAIN_THREAD_ID,
    }));
  }
}

/**
 * Live-log step for a tool call, using the Moon tool's own describe() when it is ours.
 * Other tools (TrueForge's own, e.g. list_tools) show their name as words: "List tools".
 */
export function describeToolCall(toolName: string, argumentsJson: string): ToolStep {
  const fallback = { action: humanize(toolName), target: "" };
  try {
    let name = toolName;
    let args = JSON.parse(argumentsJson || "{}");
    // With deferred tool loading the model may call a tool through TrueForge's wrapper:
    // call_tool {mcp_server, tool_name, input}. Show the wrapped tool's own step.
    if (name === TRUEFORGE_CALL_TOOL && typeof args?.tool_name === "string") {
      name = args.tool_name;
      args = args.input ?? {};
    }
    const tool = MOON_TOOLS.find((t) => t.name === name);
    return tool ? tool.describe(args) : { action: humanize(name), target: "" };
  } catch {
    return fallback;
  }
}

function humanize(name: string): string {
  const words = name.replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
