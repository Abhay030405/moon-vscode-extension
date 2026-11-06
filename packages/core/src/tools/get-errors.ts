import { z } from "zod";
import { wrapUntrusted } from "../safety/untrusted-text.js";
import { defineTool } from "./tool.js";

export const getErrorsTool = defineTool({
  name: "get_errors",
  title: "Get errors",
  description:
    "List the errors and warnings the editor reports (compiler, linter, type checker) for one file, " +
    "or for every open file when no path is given. Use it to see what is broken before you change code.",
  input: {
    path: z.string().min(1).optional().describe("File path relative to the project root. Omit for all open files."),
  },
  readOnly: true,
  run(ctx, args) {
    const rel = args.path === undefined ? undefined : ctx.resolveReadable(args.path).rel;
    if (!ctx.editor) return "The editor's problem list is not available here (Moon is running outside VS Code).";
    const all = ctx.editor.diagnostics(rel).filter((d) => !ctx.secrets.isSecret(d.path));
    const where = rel ?? "the open files";
    if (all.length === 0) return `No errors or warnings reported for ${where}.`;
    const max = ctx.limits.searchMaxResults;
    const shown = all.slice(0, max);
    const body = shown
      .map((d) => `${d.path}:${d.line}:${d.column} ${d.severity}${d.source ? ` (${d.source})` : ""}: ${d.message}`)
      .join("\n");
    const header = `${all.length} problem(s) in ${where}${all.length > max ? ` (first ${max} shown)` : ""}:`;
    // Messages can quote project text, so they are wrapped like file content.
    return ctx.capOutput(`${header}\n${wrapUntrusted("editor-problems", body)}`);
  },
  describe: (args) => ({ action: "Check errors", target: args.path ?? "open files" }),
});
