// propose_edit: the inline-edit agent's way of handing back its change.
// It never writes the file. It checks the edits against the editor's current text and passes
// the resulting full text to the running inline edit, which shows it as a diff for review.

import { z } from "zod";
import { applyTextEdits, EditApplyError } from "../workspace/apply.js";
import { diffLines, splitLines } from "../workspace/hunks.js";
import { ToolError } from "./context.js";
import { defineTool } from "./tool.js";

export const proposeEditTool = defineTool({
  name: "propose_edit",
  title: "Propose edit",
  description:
    "Propose a change to the file being edited inline. Nothing is written: the user reviews the change as a diff " +
    "and accepts or rejects each part. Give one or more exact find/replace edits; each old_text must be copied " +
    "exactly from the current file (no line numbers) and occur exactly once. Calling it again replaces the earlier proposal.",
  input: {
    path: z.string().min(1).describe("Path of the file being edited (relative to the project root)."),
    edits: z
      .array(
        z.object({
          old_text: z.string().describe("Exact current text to replace (whole lines are best)."),
          new_text: z.string().describe("Replacement text."),
        }),
      )
      .min(1)
      .describe("Find/replace edits, applied in order."),
  },
  // It changes nothing itself, but it is how a change is proposed, so it is not "read-only":
  // agent mode (which enables only read-only tools for now) never sees it.
  readOnly: false,
  run(ctx, args) {
    const target = ctx.inlineTarget;
    if (!target) throw new ToolError("propose_edit is only available during an inline edit.");
    const { abs, rel } = ctx.resolveReadable(args.path);
    if (rel !== target.rel) {
      throw new ToolError(`This inline edit may only change "${target.rel}", not "${rel}".`);
    }
    const current = ctx.readText(abs, rel);
    let proposed: string;
    try {
      proposed = applyTextEdits(current, args.edits);
    } catch (err) {
      if (err instanceof EditApplyError) throw new ToolError(err.message);
      throw err;
    }
    const hunks = diffLines(splitLines(current), splitLines(proposed));
    if (hunks.length === 0) throw new ToolError("These edits change nothing.");
    target.onProposal(proposed);
    const changed = hunks.reduce((n, h) => n + Math.max(h.oldLines.length, h.newLines.length), 0);
    return (
      `Proposal ready: ${hunks.length} change(s), about ${changed} line(s) in ${rel}. ` +
      "The user now reviews it in the editor. Finish with one short sentence saying what you changed."
    );
  },
  describe: (args) => ({ action: "Propose edit", target: args.path ?? "" }),
});
