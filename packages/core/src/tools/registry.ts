// The list of Moon's MCP tools, and the code that registers them on an MCP server.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PathGuardError } from "../safety/path-guard.js";
import { ToolError, type ToolContext } from "./context.js";
import { findDefinitionTool } from "./find-definition.js";
import { findUsagesTool } from "./find-usages.js";
import { listFilesTool } from "./list-files.js";
import { readFileTool } from "./read-file.js";
import { searchTextTool } from "./search-text.js";
import { stepText, type MoonTool } from "./tool.js";

/** Phase 1: read-only tools. Write and command tools are added in later phases. */
export const MOON_TOOLS: MoonTool[] = [
  listFilesTool,
  searchTextTool,
  findDefinitionTool,
  findUsagesTool,
  readFileTool,
] as MoonTool[];

/** Reported for every tool call, so the extension can log what the agent did. */
export interface ToolCallEvent {
  tool: string;
  summary: string;
  ok: boolean;
  error?: string;
  durationMs: number;
}

export type ToolCallListener = (event: ToolCallEvent) => void;

export function registerMoonTools(
  server: McpServer,
  ctx: ToolContext,
  onCall?: ToolCallListener,
  tools: MoonTool[] = MOON_TOOLS,
): void {
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.input,
        annotations: { title: tool.title, readOnlyHint: tool.readOnly, openWorldHint: false },
      },
      async (args: Record<string, unknown>) => {
        const started = Date.now();
        const summary = safeDescribe(tool, args);
        try {
          const text = await tool.run(ctx, args as never);
          onCall?.({ tool: tool.name, summary, ok: true, durationMs: Date.now() - started });
          return { content: [{ type: "text" as const, text }] };
        } catch (err) {
          const message = errorMessage(err);
          onCall?.({ tool: tool.name, summary, ok: false, error: message, durationMs: Date.now() - started });
          return { content: [{ type: "text" as const, text: message }], isError: true };
        }
      },
    );
  }
}

function safeDescribe(tool: MoonTool, args: Record<string, unknown>): string {
  try {
    return stepText(tool.describe(args as never));
  } catch {
    return tool.name;
  }
}

/** Clear failures (bad path, secret file, bad regex) go to the agent as-is; anything else is labelled. */
function errorMessage(err: unknown): string {
  if (err instanceof ToolError || err instanceof PathGuardError) return err.message;
  return `Unexpected error: ${err instanceof Error ? err.message : String(err)}`;
}
