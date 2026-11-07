// The panel's state and the reducer that applies user actions and extension events to it.
// An agent turn is a list of parts in the order they arrived: answer text and live-log lines
// can interleave (the agent may say something, call tools, then answer).

import type {
  CommandApprovalView,
  ContextSummary,
  ExtensionToPanel,
  MoonEvent,
  PanelSettings,
  ReviewView,
  TypingSettings,
} from "../protocol/messages";

export interface LogLine {
  id: string;
  /** "tool": a tool call ("Read" + target). "note": a plain line (subagent started, compaction). */
  kind: "tool" | "note";
  action: string;
  target: string;
  /** Tool calls run until their result arrives; notes are done at once. */
  done: boolean;
}

/** The files the agent chose and why (from its report_context call). */
export interface ChosenFile {
  path: string;
  reason: string;
}

export type TurnPart =
  | { kind: "text"; text: string }
  | { kind: "log"; lines: LogLine[] }
  /** The context card: what Moon gave the agent (summary) and the files it chose (files). */
  | { kind: "context"; summary?: ContextSummary; files?: ChosenFile[] };

/** "waiting": TrueForge paused the turn until the user answers an approval (command or review). */
export type TurnStatus = "running" | "waiting" | "done" | "cancelled" | "error";

/** The result of the last apply, shown under the conversation. */
export type ApplyNotice =
  | { kind: "applied"; files: number; hunks: number; undoable: boolean }
  | { kind: "undone"; files: number };

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
  /** A command waiting for the user's approval. */
  approval?: CommandApprovalView;
  /** The review screen (the agent called apply_changes). */
  review?: ReviewView;
  applyNotice?: ApplyNotice;
}

/** Extension messages that belong to one chat. */
type ChatMessage = Extract<ExtensionToPanel, { chatId: string }>;

export type ChatAction =
  | { type: "sent"; text: string }
  | { type: "new-chat"; chatId: string }
  | { type: "settings"; settings: PanelSettings }
  | { type: "message"; message: ChatMessage }
  | { type: "undo-sent" };

export const newChatId = (): string => crypto.randomUUID();

export function initialState(): ChatState {
  return { chatId: newChatId(), entries: [] };
}

export function isRunning(state: ChatState): boolean {
  const last = state.entries.at(-1);
  return last?.kind === "agent" && (last.status === "running" || last.status === "waiting");
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
    case "message":
      if (action.message.chatId !== state.chatId) return state; // late message from a chat that was replaced
      return applyMessage(state, action.message);
    case "undo-sent":
      // The button goes away at once so it is not pressed twice.
      return state.applyNotice?.kind === "applied" ? { ...state, applyNotice: { ...state.applyNotice, undoable: false } } : state;
  }
}

function applyMessage(state: ChatState, message: ChatMessage): ChatState {
  switch (message.type) {
    case "event":
      return applyEvent(state, message.event);
    case "context":
      return updateContextCard(state, { summary: message.summary });
    case "command-approval":
      return { ...state, approval: message.approval };
    case "review":
      return { ...state, review: message.review };
    case "applied":
      return { ...state, applyNotice: { kind: "applied", files: message.files, hunks: message.hunks, undoable: message.undoable } };
    case "undone":
      return { ...state, applyNotice: { kind: "undone", files: message.files } };
  }
}

function applyEvent(state: ChatState, event: MoonEvent): ChatState {
  if (event.type === "session") return { ...state, sessionUrl: event.url, model: event.model };
  if (event.type === "context-choice") return updateContextCard(state, { files: event.files });
  const last = state.entries.at(-1);
  if (last?.kind !== "agent") return state;
  const turn = { ...last, parts: [...last.parts] };
  // The agent continues after the user answered an approval.
  if (turn.status === "waiting" && event.type !== "done") turn.status = "running";

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
      if (event.status === "paused") {
        turn.status = "waiting";
        break; // tool calls waiting for approval are still open
      }
      turn.status = event.status;
      if (event.status === "error") turn.error = event.message;
      // Tool calls still "running" when a turn ends will never finish.
      turn.parts = turn.parts.map((p) => (p.kind === "log" ? { ...p, lines: p.lines.map((l) => ({ ...l, done: true })) } : p));
      break;
  }
  return { ...state, entries: [...state.entries.slice(0, -1), turn] };
}

/** Fills the current turn's context card (created at the start of the turn if missing). */
function updateContextCard(state: ChatState, update: { summary?: ContextSummary; files?: ChosenFile[] }): ChatState {
  const last = state.entries.at(-1);
  if (last?.kind !== "agent") return state;
  const parts = [...last.parts];
  const index = parts.findIndex((p) => p.kind === "context");
  if (index === -1) parts.unshift({ kind: "context", ...update });
  else parts[index] = { ...parts[index]!, ...update } as TurnPart;
  return { ...state, entries: [...state.entries.slice(0, -1), { ...last, parts }] };
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
