// edit_file: changes a file in the hidden copy (never the real project).
// Existing files: exact find/replace edits. New files only: the whole content.
// Refused until the agent called report_context in this run (the context card comes first).

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { PROPOSE_PLAN_TOOL, REPORT_CONTEXT_TOOL } from "../shared/constants.js";
import * as path from "node:path";
import { z } from "zod";
import { lineCounts } from "../workspace/change-tracker.js";
import { diffLines, splitLines } from "../workspace/hunks.js";
import { applyTextEdits, EditApplyError } from "../workspace/apply.js";
import { ToolError } from "./context.js";
import { defineTool } from "./tool.js";

export const editFileTool = defineTool({
  name: "edit_file",
  title: "Edit file",
  description:
    "Change a file in your working copy of the project (the user reviews every change before it reaches their files). " +
    "For an existing file give `edits`: exact find/replace pairs; each old_text must be copied exactly from read_file " +
    "(no line numbers) and occur once. To create a NEW file give `content` instead (never for existing files).",
  input: {
    path: z.string().min(1).describe("File path relative to the project root."),
    edits: z
      .array(z.object({ old_text: z.string(), new_text: z.string() }))
      .min(1)
      .optional()
      .describe("Find/replace edits for an existing file, applied in order."),
    content: z.string().optional().describe("Full content, only when creating a new file."),
  },
  readOnly: false,
  run(ctx, args) {
    if (!ctx.agentRun) throw new ToolError("edit_file only works in agent mode.");
    if (!ctx.contextReported) {
      throw new ToolError(`Call ${REPORT_CONTEXT_TOOL} first: tell the user which files you chose and why, then edit.`);
    }
    if (ctx.planWaiting) {
      throw new ToolError(`Your plan (${PROPOSE_PLAN_TOOL}) is waiting for the user. Edit only after it is approved.`);
    }
    if ((args.edits === undefined) === (args.content === undefined)) {
      throw new ToolError("Give either `edits` (existing file) or `content` (new file), not both.");
    }
    const { abs, rel } = ctx.resolveReadable(args.path);
    if (!rel) throw new ToolError("Give a file path, not the project folder.");
    // Never write back a marker Moon put in a tool result (a redacted secret, a shown hidden character).
    for (const text of [args.content ?? "", ...(args.edits ?? []).flatMap((e) => [e.old_text, e.new_text])]) ctx.checkWritable(text);

    if (args.content !== undefined) {
      if (existsSync(abs)) throw new ToolError(`"${rel}" already exists. Use \`edits\` to change it.`);
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, args.content);
      ctx.agentRun.onEdit?.(rel, null, args.content);
      const { added } = lineCounts(null, args.content);
      return `Created ${rel} (${added} lines) in the working copy.`;
    }

    const before = ctx.readText(abs, rel);
    let after: string;
    try {
      after = applyTextEdits(before, args.edits!);
    } catch (err) {
      if (err instanceof EditApplyError) throw new ToolError(`${rel}: ${err.message}`);
      throw err;
    }
    if (after === before) throw new ToolError("These edits change nothing.");
    writeFileSync(abs, after);
    ctx.agentRun.onEdit?.(rel, before, after);
    const { added, removed } = lineCounts(before, after);
    const { editResultContextLines, editResultMaxLines } = ctx.limits;
    const view = changedLines(before, after, editResultContextLines, editResultMaxLines);
    return `Edited ${rel} in the working copy (+${added} -${removed} lines). The changed part now reads:\n${view}`;
  },
  describe: (args) => ({ action: args.content !== undefined ? "Create" : "Edit", target: args.path ?? "" }),
});

/**
 * The changed lines of the new text with a few unchanged lines around them, numbered, so the
 * agent's view of the file stays current without reading it again (design-decisions 13.2).
 */
export function changedLines(before: string, after: string, contextLines: number, maxLines: number): string {
  const newLines = splitLines(after);
  const shown: string[] = [];
  let lastShown = -1;
  for (const hunk of diffLines(splitLines(before), newLines)) {
    const from = Math.max(lastShown + 1, hunk.newStart - contextLines);
    const to = Math.min(newLines.length, hunk.newStart + hunk.newLines.length + contextLines);
    if (lastShown >= 0 && from > lastShown + 1) shown.push("...");
    // Same layout as read_file: the line number, two spaces, the text.
    const width = String(newLines.length).length;
    for (let i = from; i < to; i++) shown.push(`${String(i + 1).padStart(width)}  ${newLines[i]}`);
    lastShown = to - 1;
  }
  if (shown.length <= maxLines) return shown.join("\n");
  return [...shown.slice(0, maxLines), `[... ${shown.length - maxLines} more lines; read_file shows the rest]`].join("\n");
}
