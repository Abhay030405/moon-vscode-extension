// work_log: what has been done in this conversation (files read, edits, commands and their
// results, what the user applied, undid or decided), so the agent can check instead of
// trusting its memory: after Stop, a model switch, a compaction, or when a chat is continued.

import { ToolError } from "./context.js";
import { defineTool } from "./tool.js";

export const workLogTool = defineTool({
  name: "work_log",
  title: "Work log",
  description:
    "Show what has been done in this conversation so far: for each user request, the files read, the files edited in your " +
    "working copy, the commands run and how they ended, what the user applied, rejected or undid, and their decisions. " +
    "Use it after a stop, a model switch or a long conversation, or whenever you are unsure what was already done.",
  input: {},
  readOnly: true,
  run(ctx) {
    if (!ctx.memory) throw new ToolError("work_log only works in agent mode.");
    return ctx.capOutput(ctx.memory.workLog());
  },
  describe: () => ({ action: "Checked work log", target: "" }),
});
