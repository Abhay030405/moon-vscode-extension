// The lists of Moon's MCP tools, and the code that registers them on an MCP server.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PathGuardError } from "../safety/path-guard.js";
import { applyChangesTool } from "./apply-changes.js";
import { ToolError, type ToolContext } from "./context.js";
import { editFileTool } from "./edit-file.js";
import { findDefinitionTool } from "./find-definition.js";
import { findUsagesTool } from "./find-usages.js";
import { getErrorsTool } from "./get-errors.js";
import { listFilesTool } from "./list-files.js";
import { listPendingChangesTool } from "./list-pending-changes.js";
import { listPastSessionsTool, readPastSessionTool, saveSummaryTool } from "./memory-tools.js";
import { workLogTool } from "./work-log.js";
import { proposePlanTool } from "./propose-plan.js";
import { proposeEditTool } from "./propose-edit.js";
import { readFileTool } from "./read-file.js";
import { runCommandTool } from "./run-command.js";
import { searchTextTool } from "./search-text.js";
import { stepText, type MoonTool } from "./tool.js";
import { filterForModel } from "../safety/output-filter.js";
import { reportContextTool } from "./report-context.js";

/** Looking around: never changes anything. */
const LOOK_TOOLS = [listFilesTool, searchTextTool, findDefinitionTool, findUsagesTool, readFileTool, getErrorsTool];

/** The editor endpoint (inline edit): works on the real project. */
export const EDITOR_TOOLS: MoonTool[] = [...LOOK_TOOLS, proposeEditTool] as MoonTool[];

/** The agent endpoint (agent mode): works in the run's hidden copy. */
export const AGENT_TOOLS: MoonTool[] = [
  ...LOOK_TOOLS,
  reportContextTool,
  proposePlanTool,
  editFileTool,
  listPendingChangesTool,
  runCommandTool,
  applyChangesTool,
  workLogTool,
  saveSummaryTool,
  listPastSessionsTool,
  readPastSessionTool,
] as MoonTool[];

/** Every Moon tool (used for step labels in the live log). */
export const MOON_TOOLS: MoonTool[] = [...new Set([...EDITOR_TOOLS, ...AGENT_TOOLS])];

/** Reported for every tool call, so the extension can log what the agent did. */
export interface ToolCallEvent {
  tool: string;
  summary: string;
  ok: boolean;
  error?: string;
  durationMs: number;
}

export type ToolCallListener = (event: ToolCallEvent) => void;

/**
 * Registers `tools` on an MCP server. `context` is asked on every call, so agent mode can point
 * the tools at the current run's copy (undefined = no run active: the call is refused).
 */
export function registerMoonTools(
  server: McpServer,
  context: () => ToolContext | undefined,
  tools: readonly MoonTool[],
  onCall?: ToolCallListener,
): void {
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.input,
        // No Moon tool deletes the user's files or reaches outside the project.
        annotations: { title: tool.title, readOnlyHint: tool.readOnly, destructiveHint: false, openWorldHint: false },
      },
      async (args: Record<string, unknown>, extra: { signal?: AbortSignal }) => {
        const started = Date.now();
        const summary = safeDescribe(tool, args);
        try {
          const ctx = context();
          if (!ctx) throw new ToolError("No agent run is active, so this tool cannot be used right now.");
          const raw = await tool.run(ctx, args as never, extra.signal);
          // Secrets redacted, hidden characters shown, control codes removed (safety/output-filter.ts).
          const { text, report } = filterForModel(raw, ctx.security.hiddenCharWarnThreshold);
          if (report.redactions.length > 0 || report.hiddenChars > 0) {
            ctx.audit?.({
              kind: "filtered",
              detail: `${tool.name}: ${report.redactions.length} secret(s) redacted, ${report.hiddenChars} hidden character(s) shown`,
              kinds: [...new Set(report.redactions.map((r) => r.kind))].join(","),
            });
          }
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
