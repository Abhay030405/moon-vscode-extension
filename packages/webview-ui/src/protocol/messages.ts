// Messages between the Moon panel (webview) and the extension. Both sides import this file,
// so a change to the protocol is checked by the compiler on both ends.

import type { ContextSummary, Mention, MentionCandidate, MoonEvent } from "@moon/core";

export type { ContextSummary, Mention, MentionCandidate, MoonEvent };

/** How the panel reveals streamed text (from ui.* in config/moon.json). */
export interface TypingSettings {
  charsPerSecond: number;
  maxLagMs: number;
}

/** Sent when the panel loads or the workspace changes. */
export interface PanelSettings {
  type: "state";
  /** Which project the tools work on; undefined when no folder is open. */
  projectName: string | undefined;
  /** How streamed text is revealed; undefined = show it at once. */
  typing: TypingSettings | undefined;
  /** "provider/model" a new chat will use (models.main in config). */
  model: string | undefined;
}

/** One line of a hunk in the review: context (" "), removed ("-") or added ("+"). */
export interface ReviewLine {
  kind: " " | "-" | "+";
  text: string;
}

export interface ReviewHunkView {
  index: number;
  /** 1-based line in the real file where the change starts. */
  line: number;
  lines: ReviewLine[];
}

export interface ReviewFileView {
  rel: string;
  kind: "added" | "modified" | "deleted";
  binary: boolean;
  /** The user edited the real file after the agent's copy was made: it will not be applied. */
  conflict: boolean;
  hunks: ReviewHunkView[];
}

export interface CommandResultView {
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  cancelled: boolean;
  /** Last lines of the output. */
  outputTail: string;
}

/** What the review screen shows when the agent calls apply_changes. */
export interface ReviewView {
  /** The agent's summary of what it changed and how it checked it. */
  summary: string;
  files: ReviewFileView[];
  /** Commands the agent ran in its copy (test results). */
  commands: CommandResultView[];
  /** Security warnings: secrets or hidden characters in what would be written. */
  warnings: { rel: string; text: string }[];
  /**
   * Did the agent check its work? "passed"/"failed": the last command ran after the last edit
   * and exited 0 / not 0; "stale": edits came after the last command; "none": nothing ran.
   */
  verified: { state: "passed" | "failed" | "stale" | "none"; command?: string; exitCode?: number | null };
}

/** The agent wants to run a command; TrueForge is waiting for the user's answer. */
export interface CommandApprovalView {
  requestId: string;
  command: string;
  cwd: string | undefined;
  /** Why the command looks risky (empty when nothing stands out). */
  risks: string[];
  /** Set when the agent read outside content in this task (web, GitHub, a past chat): "Always" is off. */
  tainted?: string;
}

export type CommandDecision = "once" | "always" | "deny";

/**
 * A tool call waiting for approval that has no card of its own (for example a GitHub write
 * tool): the tool's name and its arguments, so the user sees exactly what will happen.
 */
export interface ToolApprovalView {
  requestId: string;
  tool: string;
  /** The arguments as pretty JSON, cut to ui.approvalArgsMaxChars. */
  args: string;
  truncated: boolean;
  /** Set when the agent read outside content in this task: the card says so. */
  tainted?: string;
}

/** The agent asked a question (TrueForge's ask_user_question); the turn waits for the answer. */
export interface QuestionView {
  requestId: string;
  question: string;
  /** The agent's choices (it is asked for 3); the user may also type their own answer. */
  options: string[];
}

/** Panel -> extension. */
/** One earlier conversation in the history list. */
export interface HistoryItemView {
  id: string;
  title: string;
  summary: [string, string];
  status: "active" | "done" | "stopped" | "failed" | "review-pending";
  model: string;
  updatedAt: string;
}

/** One line of a past conversation (the read-only view). */
export type TranscriptItemView = { role: "user" | "agent"; text: string } | { role: "step"; action: string; target: string };

/** The agent's plan before a big task (propose_plan), waiting for approval. */
export interface PlanView {
  requestId: string;
  title: string;
  steps: string[];
  files: string[];
  risks: string[];
}

/** The agent asks to read an earlier conversation (read_past_session). */
export interface RecallView {
  requestId: string;
  conversationId: string;
  title: string;
  updatedAt: string;
  /** "summary", "work" or "transcript". */
  part: string;
  summary: [string, string];
}

export type PanelToExtension =
  /** The panel has loaded and wants the current state. */
  | { type: "ready" }
  /** The user sent a message in the current chat, with what they picked in the @ picker. */
  | { type: "send"; chatId: string; text: string; mentions: Mention[] }
  /** Open a project file in the editor (from the context card). */
  | { type: "open-file"; rel: string }
  /** The @ picker wants files and names matching `query` (answered with mention-results). */
  | { type: "mention-search"; requestId: number; query: string }
  /** The user pressed Stop. */
  | { type: "stop"; chatId: string }
  /** The user started a new chat (the old one is stopped if it was running). */
  | { type: "new-chat"; chatId: string }
  /** Open the TrueForge session page in the browser. */
  | { type: "open-session"; url: string }
  /** Open a link from an answer in the browser (only http/https links are opened). */
  | { type: "open-link"; url: string }
  /** The panel hit an error; the extension writes it to the Moon output channel. */
  | { type: "panel-error"; message: string }
  /** The user answered a command approval card. */
  | { type: "command-decision"; chatId: string; requestId: string; decision: CommandDecision }
  /** The user answered the approval card of a tool with no card of its own. */
  | { type: "tool-decision"; chatId: string; requestId: string; allow: boolean }
  /** The user answered the agent's question: one of its options, or their own text. */
  | { type: "question-answer"; chatId: string; requestId: string; answer: string }
  /** Apply the accepted hunks (by file: indexes of accepted hunks). */
  | { type: "review-apply"; chatId: string; accepted: Record<string, number[]> }
  /** Throw every change away. */
  | { type: "review-discard"; chatId: string }
  /** Show one file's change in VS Code's diff editor. */
  | { type: "open-diff"; chatId: string; rel: string }
  /** Restore every file the last apply changed. */
  | { type: "undo-run"; chatId: string }
  /** The user answered the recall card (the agent wants to read an earlier conversation). */
  | { type: "recall-decision"; chatId: string; requestId: string; allow: boolean }
  /** The user approved the plan, or asked for changes (sent to the agent as the reason it must revise). */
  | { type: "plan-decision"; chatId: string; requestId: string; approve: boolean; changes?: string }
  /** The history list for this project; the words filter titles and summaries. */
  | { type: "history-list"; query: string }
  /** Show an earlier conversation read-only. */
  | { type: "history-open"; conversationId: string }
  /** Continue an earlier conversation in the panel as the chat `chatId`. */
  | { type: "history-continue"; chatId: string; conversationId: string }
  /** Delete an earlier conversation (its TrueForge sessions and its work record). */
  | { type: "history-delete"; conversationId: string };

/** Extension -> panel. */
export type ExtensionToPanel =
  | PanelSettings
  /** An event from the running turn of chat `chatId`. */
  | { type: "event"; chatId: string; event: MoonEvent }
  /** What Moon put in the agent's context at the start of the chat (map, rules, @-mentions). */
  | { type: "context"; chatId: string; summary: ContextSummary }
  /** Answer to mention-search. */
  | { type: "mention-results"; requestId: number; items: MentionCandidate[] }
  /** Show (or with undefined, remove) the command approval card. */
  | { type: "command-approval"; chatId: string; approval: CommandApprovalView | undefined }
  /** Show (or with undefined, remove) the approval card of a tool with no card of its own. */
  | { type: "tool-approval"; chatId: string; approval: ToolApprovalView | undefined }
  /** Show (or with undefined, remove) the agent's question card. */
  | { type: "question"; chatId: string; question: QuestionView | undefined }
  /** Show (or with undefined, close) the review screen. */
  | { type: "review"; chatId: string; review: ReviewView | undefined }
  /** The last apply's result; undoable = the "Undo this whole run" button is shown. */
  | { type: "applied"; chatId: string; files: number; hunks: number; undoable: boolean }
  /** "Undo this whole run" finished. */
  | { type: "undone"; chatId: string; files: number }
  /** The chat's conversation id (remembered by the panel, so a reload continues it). */
  | { type: "conversation"; chatId: string; conversationId: string }
  /** Show (or with undefined, remove) the recall card. */
  | { type: "recall-approval"; chatId: string; recall: RecallView | undefined }
  /** Show (or with undefined, remove) the plan card. */
  | { type: "plan-approval"; chatId: string; plan: PlanView | undefined }
  /** The history list (error: TrueForge could not be read). */
  | { type: "history"; items: HistoryItemView[]; error?: string }
  /** An earlier conversation, read-only. */
  | { type: "past-conversation"; conversationId: string; title: string; items: TranscriptItemView[]; error?: string }
  /** The chat `chatId` now continues an earlier conversation: its messages so far. */
  | { type: "resumed"; chatId: string; conversationId: string; title: string; items: TranscriptItemView[] };
