// Messages between the Moon panel (webview) and the extension. Both sides import this file,
// so a change to the protocol is checked by the compiler on both ends.

import type { MoonEvent } from "@moon/core";

export type { MoonEvent };

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
}

/** The agent wants to run a command; TrueForge is waiting for the user's answer. */
export interface CommandApprovalView {
  requestId: string;
  command: string;
  cwd: string | undefined;
  /** Why the command looks risky (empty when nothing stands out). */
  risks: string[];
}

export type CommandDecision = "once" | "always" | "deny";

/** Panel -> extension. */
export type PanelToExtension =
  /** The panel has loaded and wants the current state. */
  | { type: "ready" }
  /** The user sent a message in the current chat. */
  | { type: "send"; chatId: string; text: string }
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
  /** Apply the accepted hunks (by file: indexes of accepted hunks). */
  | { type: "review-apply"; chatId: string; accepted: Record<string, number[]> }
  /** Throw every change away. */
  | { type: "review-discard"; chatId: string }
  /** Show one file's change in VS Code's diff editor. */
  | { type: "open-diff"; chatId: string; rel: string }
  /** Restore every file the last apply changed. */
  | { type: "undo-run"; chatId: string };

/** Extension -> panel. */
export type ExtensionToPanel =
  | PanelSettings
  /** An event from the running turn of chat `chatId`. */
  | { type: "event"; chatId: string; event: MoonEvent }
  /** Show (or with undefined, remove) the command approval card. */
  | { type: "command-approval"; chatId: string; approval: CommandApprovalView | undefined }
  /** Show (or with undefined, close) the review screen. */
  | { type: "review"; chatId: string; review: ReviewView | undefined }
  /** The last apply's result; undoable = the "Undo this whole run" button is shown. */
  | { type: "applied"; chatId: string; files: number; hunks: number; undoable: boolean }
  /** "Undo this whole run" finished. */
  | { type: "undone"; chatId: string; files: number };
