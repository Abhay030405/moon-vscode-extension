// undo_applied_run (docs/design-decisions.md section 13.5): changes from an earlier run of this
// conversation were applied and turn out to be wrong. The agent proposes undoing all of that
// run's applied changes; this changes real files, so it pauses for the user's approval
// (requireApprovalForTools in agents/moon-agent.json) and the card lists the files that go back.
// The undo itself restores the backup Moon saved just before that apply. A file the user edited
// by hand after the apply is asked about separately; if the user says no, it is left as it is.

import { z } from "zod";
import { UNDO_RUN_TOOL } from "../shared/constants.js";
import { ToolError } from "./context.js";
import { defineTool } from "./tool.js";

export const undoRunTool = defineTool({
  name: UNDO_RUN_TOOL,
  title: "Undo an applied run",
  description:
    "Undo ALL the changes one earlier apply_changes of this conversation wrote to the user's files, when they turned out " +
    "to be wrong. Each apply_changes result names its run number. The user must approve; files they edited by hand " +
    "since are asked about one by one. Use it only when the user wants that run's changes gone, not to fix a small part.",
  input: {
    run: z.number().int().min(1).describe("The applied run's number, from that apply_changes result."),
    reason: z.string().min(1).describe("One line: why these changes should be undone."),
  },
  readOnly: false,
  async run(ctx, args) {
    if (!ctx.undoRuns) throw new ToolError(`${UNDO_RUN_TOOL} only works in agent mode.`);
    return ctx.undoRuns.undo(args.run);
  },
  describe: (args) => ({ action: "Undo applied run", target: args.run === undefined ? "" : `#${args.run}` }),
});
