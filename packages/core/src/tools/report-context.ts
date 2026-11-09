// report_context: the agent says which files it chose to work from and why (one line each).
// Moon's panel shows this as the context card, so the user sees the agent's choices; the
// reasons come from the agent, not from Moon. Files that exist are reported as they are; a
// file the agent is going to create is marked `new` (so an empty project can be worked on).
// edit_file refuses until this was called once in the run (see ToolContext.contextReported).

import { existsSync, statSync } from "node:fs";
import { z } from "zod";
import { REPORT_CONTEXT_TOOL } from "../shared/constants.js";
import { ToolError } from "./context.js";
import { defineTool } from "./tool.js";

export const reportContextTool = defineTool({
  name: REPORT_CONTEXT_TOOL,
  title: "Report chosen files",
  description:
    "Tell the user which files you chose to work from and why, once you know them (before editing). " +
    "List the 3 to 5 files that matter most, each with one short reason, e.g. " +
    '{"files":[{"path":"src/app/cli.py","reason":"defines the existing CLI commands; the new one goes here"}]}. ' +
    "A file you are going to create gets \"new\": true (for example in an empty project). " +
    "The user sees this list in Moon's panel.",
  input: {
    files: z
      .array(
        z.object({
          path: z.string().min(1).describe("Project-relative path of the file."),
          reason: z.string().min(1).describe("One short line: why this file matters for the task."),
          new: z.boolean().optional().describe("True for a file you are going to create (it does not exist yet)."),
        }),
      )
      .min(1)
      .describe("The files you chose, most important first."),
  },
  readOnly: true,
  run(ctx, args) {
    const exists = (p: string) => {
      const abs = ctx.paths.resolve(p).abs;
      return existsSync(abs) && statSync(abs).isFile();
    };
    const missing = args.files.filter((f) => !f.new && !exists(f.path));
    if (missing.length > 0) {
      throw new ToolError(
        `These files do not exist: ${missing.map((f) => f.path).join(", ")}. Report only real files, or mark a file you are going to create with "new": true.`,
      );
    }
    const clash = args.files.filter((f) => f.new && exists(f.path));
    if (clash.length > 0) throw new ToolError(`These files already exist, so they are not new: ${clash.map((f) => f.path).join(", ")}.`);
    ctx.contextReported = true;
    return `Shown to the user: ${args.files.length} file(s).`;
  },
  describe: (args) => ({ action: "Chose files", target: `${args.files?.length ?? 0} files` }),
});
