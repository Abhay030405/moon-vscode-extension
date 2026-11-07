// report_context: the agent says which files it chose to work from and why (one line each).
// Moon's panel shows this as the context card, so the user sees the agent's choices; the
// reasons come from the agent, not from Moon. Only files that exist can be reported.
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
    "The user sees this list in Moon's panel.",
  input: {
    files: z
      .array(
        z.object({
          path: z.string().min(1).describe("Project-relative path of the file."),
          reason: z.string().min(1).describe("One short line: why this file matters for the task."),
        }),
      )
      .min(1)
      .describe("The files you chose, most important first."),
  },
  readOnly: true,
  run(ctx, args) {
    const missing = args.files.filter((f) => {
      const abs = ctx.paths.resolve(f.path).abs;
      return !existsSync(abs) || !statSync(abs).isFile();
    });
    if (missing.length > 0) {
      throw new ToolError(`These files do not exist: ${missing.map((f) => f.path).join(", ")}. Report only real files.`);
    }
    ctx.contextReported = true;
    return `Shown to the user: ${args.files.length} file(s).`;
  },
  describe: (args) => ({ action: "Chose files", target: `${args.files?.length ?? 0} files` }),
});
