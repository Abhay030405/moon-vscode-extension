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
//
// A question for the user (TrueForge's ask_user_question tool, {question, options[0-5]}): when
// the request is unclear the agent asks; TrueForge sends `tool.response_required` and ends the
// turn waiting for the client. Moon reports a "question" event and the turn as "paused"; the
// panel shows the options plus a box for the user's own answer, and the answer is sent back as
// the tool's result (`user.tool_response`, see chat.ts).

import { mergeEventDelta, type TrueForgeApi } from "@truefoundry/trueforge-sdk";
import { MAIN_THREAD_ID, REPORT_CONTEXT_TOOL, TRUEFORGE_ASK_USER_TOOL, TRUEFORGE_CALL_TOOL } from "../shared/constants.js";
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

/** The agent asked the user a question (TrueForge's ask_user_question). */
export interface QuestionRequest {
  toolCallId: string;
  threadId: string;
  question: string;
  /** The agent's choices (TrueForge allows 0-5); the user may also type their own answer. */
  options: string[];
}

export type MoonEvent =
  /** The session exists; `url` opens it in TrueForge's UI. */
  | { type: "session"; sessionId: string; url: string; model: string }
  /** A piece of the answer (main agent only). */
  | { type: "text"; text: string }
  /** The agent called a tool. `step` is how the live log shows it ("Read" + "src/app.py:1-80"). */
  | { type: "tool-call"; id: string; tool: string; step: ToolStep; subagent: boolean; args: Record<string, unknown> }
  /** The agent reported the files it chose and why (report_context): the panel's context card. */
  | { type: "context-choice"; files: { path: string; reason: string }[] }
  /** A tool call finished. */
  | { type: "tool-result"; id: string }
  /** Something worth a line in the live log (subagent started, context compacted, ...). */
  | { type: "notice"; text: string }
  /**
   * Moon changed models. "fallback": the attempt on `from` failed (`reason`, e.g. "invalid key");
   * everything it showed so far is dropped and the same request starts fresh on `to` (never
   * joined to the half answer). "back": the main model works again; this task uses it.
   */
  | { type: "model-switch"; direction: "fallback" | "back"; from: string; to: string; reason?: string }
  /** Tool calls waiting for the user's decision (the turn then ends "paused"). */
  | { type: "approval"; requests: ApprovalRequest[] }
  /** The agent asked the user a question (the turn then ends "paused" until it is answered). */
  | { type: "question"; request: QuestionRequest }
  /** The turn ended. "paused" = waiting for approval or an answer; answer it to continue. */
  | { type: "done"; status: "done" | "paused" | "cancelled" | "error"; message?: string };

type TurnEvent = TrueForgeApi.TurnStreamingEvent;
type ModelMessage = TrueForgeApi.ModelMessageEvent;

/** One per turn: remembers partly streamed messages until they finish. */
export class TurnEventMapper {
  private readonly messages = new Map<string, ModelMessage>();
  /** Finished tool calls of this turn, by id (to describe approval requests). */
  private readonly calls = new Map<string, ApprovalRequest>();
  private approvalAsked = false;
  /** The agent asked the user a question (ask_user_question); the turn waits for the answer. */
  private questionAsked = false;
  /** ask_user_question calls of this turn, by id. */
  private readonly questions = new Map<string, QuestionRequest>();

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

      case "tool.response_required": {
        this.questionAsked = true;
        return event.toolCalls.map((ref): MoonEvent => ({
          type: "question",
          request: this.questions.get(ref.id) ?? { toolCallId: ref.id, threadId: event.threadId, question: "The agent is waiting for your answer.", options: [] },
        }));
      }

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
          return [{ type: "done", status: this.approvalAsked || this.questionAsked ? "paused" : "done" }];
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
      const events: MoonEvent[] = [{ type: "tool-call", id: call.id, tool: name, step, subagent: message!.threadId !== MAIN_THREAD_ID, args }];
      if (name === TRUEFORGE_ASK_USER_TOOL) {
        this.questions.set(call.id, { toolCallId: call.id, threadId: message!.threadId, ...parseQuestion(args) });
      }
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
      ? [{ path: item.path, reason: item.new === true ? `new file: ${item.reason}` : item.reason }]
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

/**
 * TrueForge's own tools that show up in the live log: what to call the step, and which
 * argument names what it works on (create_sub_agent {name, ...} -> "Start subagent scout").
 */
const TRUEFORGE_TOOL_STEPS: Record<string, { action: string; targetArg?: string }> = {
  create_sub_agent: { action: "Start subagent", targetArg: "name" },
  list_tools: { action: "List tools" },
  get_tool_info: { action: "Look up tool", targetArg: "tool_name" },
  ask_user_question: { action: "Asked you", targetArg: "question" },
  load_tools: { action: "Load tools" },
  // TrueForge's built-in web tools (on when extras.webSearch is set and a provider is configured).
  web_search: { action: "Searched the web", targetArg: "search_queries" },
  web_fetch: { action: "Read web page", targetArg: "urls" },
};

function describeTool(name: string, args: Record<string, unknown>): ToolStep {
  const tool = MOON_TOOLS.find((t) => t.name === name);
  try {
    if (tool) return tool.describe(args as never);
  } catch {
    return { action: humanize(name), target: "" };
  }
  const known = TRUEFORGE_TOOL_STEPS[name];
  if (!known) return { action: humanize(name), target: "" };
  const target = known.targetArg ? args[known.targetArg] : undefined;
  const text = Array.isArray(target) ? target.filter((t) => typeof t === "string").join(", ") : target;
  return { action: known.action, target: typeof text === "string" ? text : "" };
}

function humanize(name: string): string {
  const words = name.replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The question and options of an ask_user_question call. TrueForge's schema (0.184):
 * { question: string, options: string[] } with 0-5 options. Anything else is dropped.
 */
export function parseQuestion(args: Record<string, unknown>): { question: string; options: string[] } {
  const question = typeof args.question === "string" && args.question.trim() ? args.question.trim() : "The agent is waiting for your answer.";
  const options = Array.isArray(args.options) ? args.options.filter((o): o is string => typeof o === "string" && o.trim() !== "") : [];
  return { question, options };
}
