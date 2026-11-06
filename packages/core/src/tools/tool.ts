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
  /** Runs the tool. Returns the text the agent sees; throws ToolError for clear failures. */
  run(ctx: ToolContext, args: z.infer<z.ZodObject<Shape>>): string | Promise<string>;
  /** Short line for Moon's live log, e.g. `reading src/app.py:1-80`. */
  describe(args: Partial<z.infer<z.ZodObject<Shape>>>): string;
}

/** Helper that keeps the generic type of `tool` while checking its shape. */
export function defineTool<Shape extends z.ZodRawShape>(tool: MoonTool<Shape>): MoonTool<Shape> {
  return tool;
}
