// propose_plan: for a big task (or one starting from nothing) the agent shows its plan before
// any edit. It needs the user's approval (requireApprovalForTools in agents/moon-agent.json):
// Moon's panel shows the plan card. Approve = TrueForge runs this tool; "Edit" = a deny whose
// reason is the user's requested changes, so the agent revises and proposes again.
//
// While a plan waits for the user, edit_file is refused (ToolContext.planWaiting): Moon sets the
// flag as soon as the call appears in the stream, and this tool clears it when it runs.

import { z } from "zod";
import { PROPOSE_PLAN_TOOL } from "../shared/constants.js";
import { defineTool } from "./tool.js";

export const proposePlanTool = defineTool({
  name: PROPOSE_PLAN_TOOL,
  title: "Propose a plan",
  description:
    "Before a big task, or one that builds something from nothing, show the user your plan and wait for approval. " +
    "Give a short title, the steps in order, the files you expect to create or change, and any risks. " +
    "If the user asks for changes, revise the plan and call this again. Do not edit files until the plan is approved.",
  input: {
    title: z.string().min(1).describe("What the plan achieves, in a few words."),
    steps: z.array(z.string().min(1)).min(1).describe("The steps, in order, one short line each."),
    files: z.array(z.string().min(1)).describe("Project-relative files you expect to create or change."),
    risks: z.array(z.string().min(1)).optional().describe("Anything that could go wrong or that the user should know."),
  },
  readOnly: true,
  run(ctx) {
    ctx.planWaiting = false;
    return "The user approved the plan. Carry it out.";
  },
  describe: (args) => ({ action: "Proposed plan", target: args.title ?? "" }),
});

/** A propose_plan call's arguments, cleaned for the plan card (missing parts become empty). */
export function parsePlan(args: Record<string, unknown>): { title: string; steps: string[]; files: string[]; risks: string[] } {
  const list = (value: unknown) => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.trim() !== "").map((v) => v.trim()) : []);
  return {
    title: typeof args.title === "string" && args.title.trim() ? args.title.trim() : "Plan",
    steps: list(args.steps),
    files: list(args.files),
    risks: list(args.risks),
  };
}
