// The panel's state and the reducer that applies user actions and extension events to it.
// An agent turn is a list of parts in the order they arrived: answer text and live-log lines
// can interleave (the agent may say something, call tools, then answer).

import type { MoonEvent, PanelSettings, TypingSettings } from "../protocol/messages";

export interface LogLine {
  id: string;
  /** "tool": a tool call ("Read" + target). "note": a plain line (subagent started, compaction). */
  kind: "tool" | "note";
  action: string;
  target: string;
  /** Tool calls run until their result arrives; notes are done at once. */
  done: boolean;
}

export type TurnPart = { kind: "text"; text: string } | { kind: "log"; lines: LogLine[] };

export type TurnStatus = "running" | "done" | "cancelled" | "error";

export type Entry =
  | { kind: "user"; text: string }
  | { kind: "agent"; parts: TurnPart[]; status: TurnStatus; error?: string };

export interface ChatState {
  chatId: string;
  entries: Entry[];
  sessionUrl?: string;
  /** Model of this chat's TrueForge session (known once the session exists). */
  model?: string;
  /** Model a new chat will use, from config. */
  configuredModel?: string;
  projectName?: string;
  typing?: TypingSettings;
}

export type ChatAction =
  | { type: "sent"; text: string }
  | { type: "new-chat"; chatId: string }
  | { type: "settings"; settings: PanelSettings }
  | { type: "event"; chatId: string; event: MoonEvent };

export const newChatId = (): string => crypto.randomUUID();

export function initialState(): ChatState {
  return { chatId: newChatId(), entries: [] };
}

export function isRunning(state: ChatState): boolean {
  const last = state.entries.at(-1);
  return last?.kind === "agent" && last.status === "running";
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case "sent":
      return {
        ...state,
        entries: [...state.entries, { kind: "user", text: action.text }, { kind: "agent", parts: [], status: "running" }],
      };
    case "new-chat":
      return {
        chatId: action.chatId,
        entries: [],
        projectName: state.projectName,
        typing: state.typing,
        configuredModel: state.configuredModel,
      };
    case "settings": {
      const { projectName, typing, model } = action.settings;
      return { ...state, projectName, typing, configuredModel: model };
    }
    case "event":
      if (action.chatId !== state.chatId) return state; // late event from a chat that was replaced
      return applyEvent(state, action.event);
  }
}

function applyEvent(state: ChatState, event: MoonEvent): ChatState {
  if (event.type === "session") return { ...state, sessionUrl: event.url, model: event.model };
  const last = state.entries.at(-1);
  if (last?.kind !== "agent") return state;
  const turn = { ...last, parts: [...last.parts] };

  switch (event.type) {
    case "text":
      appendText(turn.parts, event.text);
      break;
    case "tool-call":
      appendLog(turn.parts, {
        id: event.id,
        kind: "tool",
        action: event.subagent ? `Subagent · ${event.step.action}` : event.step.action,
        target: event.step.target,
        done: false,
      });
      break;
    case "tool-result":
      turn.parts = turn.parts.map((p) =>
        p.kind === "log" ? { ...p, lines: p.lines.map((l) => (l.id === event.id ? { ...l, done: true } : l)) } : p,
      );
      break;
    case "notice":
      appendLog(turn.parts, {
        id: `note-${turn.parts.length}-${event.text}`,
        kind: "note",
        action: event.text,
        target: "",
        done: true,
      });
      break;
    case "done":
      turn.status = event.status;
      if (event.status === "error") turn.error = event.message;
      // Tool calls still "running" when a turn ends will never finish.
      turn.parts = turn.parts.map((p) => (p.kind === "log" ? { ...p, lines: p.lines.map((l) => ({ ...l, done: true })) } : p));
      break;
  }
  return { ...state, entries: [...state.entries.slice(0, -1), turn] };
}

function appendText(parts: TurnPart[], text: string): void {
  const last = parts.at(-1);
  if (last?.kind === "text") parts[parts.length - 1] = { kind: "text", text: last.text + text };
  else parts.push({ kind: "text", text });
}

function appendLog(parts: TurnPart[], line: LogLine): void {
  const last = parts.at(-1);
  if (last?.kind === "log") parts[parts.length - 1] = { kind: "log", lines: [...last.lines, line] };
  else parts.push({ kind: "log", lines: [line] });
}
