// list_pending_changes: what the agent has changed so far in its working copy, so it can
// re-check instead of trusting its memory (for example after the conversation was compacted).

import { readFileSync } from "node:fs";
import { listChanges, lineCounts } from "../workspace/change-tracker.js";
import { ToolError } from "./context.js";
import { defineTool } from "./tool.js";

const MARK = { added: "A", modified: "M", deleted: "D" } as const;

export const listPendingChangesTool = defineTool({
  name: "list_pending_changes",
  title: "List pending changes",
  description:
    "List every file you have created, changed or deleted in your working copy so far, with lines added/removed. " +
    "Nothing has reached the user's files yet; they review these changes when you call apply_changes.",
  input: {},
  readOnly: true,
  run(ctx) {
    const run = ctx.agentRun;
    if (!run) throw new ToolError("list_pending_changes only works in agent mode.");
    const changes = listChanges(run.copy);
    if (changes.length === 0) return "No changes yet.";
    const read = (abs: string) => {
      try {
        return readFileSync(abs, "utf8");
      } catch {
        return null;
      }
    };
    const lines = changes.map((c) => {
      if (c.binary) return `${MARK[c.kind]} ${c.rel} (binary)`;
      // The copy's original text is gone once edited, so compare with the real project's file.
      const before = c.kind === "added" ? null : read(run.copy.projectPath(c.rel));
      const after = c.kind === "deleted" ? null : read(run.copy.copyPath(c.rel));
      const { added, removed } = lineCounts(before, after);
      return `${MARK[c.kind]} ${c.rel} (+${added} -${removed})`;
    });
    return ctx.capOutput(`${changes.length} file(s) changed (A = added, M = modified, D = deleted):\n${lines.join("\n")}`);
  },
  describe: () => ({ action: "List pending changes", target: "" }),
});
