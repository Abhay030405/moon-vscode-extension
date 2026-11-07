// apply_changes: the agent's last step. TrueForge pauses it for approval, which opens Moon's
// review screen. When the user allows it, this tool writes only the hunks they accepted to the
// real project and tells the agent what was applied and what was rejected. If the user rejects
// everything, TrueForge denies the call and the deny reason tells the agent the same.

import { z } from "zod";
import { ToolError } from "./context.js";
import { defineTool } from "./tool.js";

export const applyChangesTool = defineTool({
  name: "apply_changes",
  title: "Apply changes",
  description:
    "Call this once, when your work is complete and checked: it asks the user to review all your changes (hunk by " +
    "hunk) and writes the ones they accept to their real files. The result says which changes were applied and which " +
    "were rejected. Give a short summary of what you changed and how you verified it.",
  input: {
    summary: z.string().min(1).describe("What you changed and how you checked it (a few lines)."),
  },
  readOnly: false,
  async run(ctx, args) {
    const run = ctx.agentRun;
    if (!run) throw new ToolError("apply_changes only works in agent mode.");
    return run.applyApproved(args.summary);
  },
  describe: () => ({ action: "Apply changes", target: "waiting for your review" }),
});
