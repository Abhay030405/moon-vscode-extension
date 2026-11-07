// The shape every Moon tool has. The registry turns these into MCP tools.

import type { z } from "zod";
import type { ToolContext } from "./context.js";

export interface MoonTool<Shape extends z.ZodRawShape = z.ZodRawShape> {
  /** Tool name the agent calls (snake_case). */
  name: string;
  /** One line shown in tool lists. */
  title: string;
  /** What the tool does and when to use it (the model reads this). */
  description: string;
  /** Input fields, as a zod object shape. */
  input: Shape;
  /** True when the tool only reads; TrueForge then never pauses it for approval. */
  readOnly: boolean;
  /**
   * Runs the tool. Returns the text the agent sees; throws ToolError for clear failures.
   * `signal` aborts when TrueForge cancels the call.
   */
  run(ctx: ToolContext, args: z.infer<z.ZodObject<Shape>>, signal?: AbortSignal): string | Promise<string>;
  /** One step for Moon's live log, e.g. { action: "Read", target: "src/app.py:1-80" }. */
  describe(args: Partial<z.infer<z.ZodObject<Shape>>>): ToolStep;
}

/** A tool call as shown in the live log: a verb, and what it acted on. */
export interface ToolStep {
  action: string;
  target: string;
}

/** The step as one line of text, e.g. for the output channel. */
export const stepText = (step: ToolStep): string => (step.target ? `${step.action} ${step.target}` : step.action);

/** Helper that keeps the generic type of `tool` while checking its shape. */
export function defineTool<Shape extends z.ZodRawShape>(tool: MoonTool<Shape>): MoonTool<Shape> {
  return tool;
}
