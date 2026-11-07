// Command ids. They must match "contributes.commands" in packages/extension/package.json.
export const CHECK_SETUP_COMMAND = "moon.checkSetup";

/** Inline edit (Ctrl+I). */
export const INLINE_COMMANDS = {
  /** Opens Moon's instruction box at the selection. Bound to Ctrl+I (optional) and Ctrl+Alt+M. */
  start: "moon.inlineEdit",
  /** "Edit" button under the instruction box (also Ctrl+Enter). */
  submit: "moon.inlineEdit.submit",
  /** "Cancel" button under the instruction box. */
  cancel: "moon.inlineEdit.cancel",
  /** Stops a running inline edit (also Escape). The file is not changed. */
  stop: "moon.inlineEdit.stop",
  /** Closes the inline edit; pending changes are dropped. */
  close: "moon.inlineEdit.close",
  acceptHunk: "moon.inlineEdit.acceptHunk",
  rejectHunk: "moon.inlineEdit.rejectHunk",
  acceptAll: "moon.inlineEdit.acceptAll",
  rejectAll: "moon.inlineEdit.rejectAll",
} as const;

/** Agent-mode review. */
export const REVIEW_COMMANDS = {
  /** Opens one file under review in VS Code's diff editor (CodeLens in the file). */
  showDiff: "moon.agentReview.showDiff",
} as const;

/** Context keys used in package.json "when" clauses. */
export const CONTEXT_KEYS = {
  /** True while an inline edit is waiting for the agent (Escape = Stop). */
  inlineRunning: "moon.inlineEditRunning",
} as const;

/** VS Code's own commands that Moon runs. */
export const VSCODE_COMMANDS = {
  /** Opens an inline comment box at the selection, with the cursor in it. */
  addComment: "workbench.action.addComment",
} as const;
