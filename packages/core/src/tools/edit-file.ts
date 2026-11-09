// edit_file: changes a file in the hidden copy (never the real project).
// Existing files: exact find/replace edits. New files only: the whole content.
// Refused until the agent called report_context in this run (the context card comes first).

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { PROPOSE_PLAN_TOOL, REPORT_CONTEXT_TOOL } from "../shared/constants.js";
import * as path from "node:path";
import { z } from "zod";
import { lineCounts } from "../workspace/change-tracker.js";
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

    if (args.content !== undefined) {
      if (existsSync(abs)) throw new ToolError(`"${rel}" already exists. Use \`edits\` to change it.`);
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, args.content);
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
    const { added, removed } = lineCounts(before, after);
    return `Edited ${rel} in the working copy (+${added} -${removed} lines).`;
  },
  describe: (args) => ({ action: args.content !== undefined ? "Create" : "Edit", target: args.path ?? "" }),
});
