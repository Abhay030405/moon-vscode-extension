import { z } from "zod";
import { wrapUntrusted } from "../safety/untrusted-text.js";
import { ToolError } from "./context.js";
import { defineTool } from "./tool.js";

export const readFileTool = defineTool({
  name: "read_file",
  title: "Read file",
  description:
    "Read part of a text file, with line numbers (files open in the editor are read with their unsaved changes). Give start_line/end_line to read only what you need " +
    "(one call returns a limited number of lines). Use search_text or find_definition first to know where to look.",
  input: {
    path: z.string().min(1).describe("File path relative to the project root."),
    start_line: z.number().int().min(1).optional().describe("First line (1-based). Default 1."),
    end_line: z.number().int().min(1).optional().describe("Last line, inclusive. Default: start_line + the line limit - 1."),
  },
  readOnly: true,
  run(ctx, args) {
    const { abs, rel } = ctx.resolveReadable(args.path);
    const lines = ctx.readText(abs, rel || args.path).split(/\r?\n/);
    const total = lines.length;
    const maxLines = ctx.limits.readFileMaxLines;
    const start = Math.min(args.start_line ?? 1, Math.max(total, 1));
    const requestedEnd = args.end_line ?? start + maxLines - 1;
    if (requestedEnd < start) throw new ToolError("end_line must not be smaller than start_line.");
    const end = Math.min(requestedEnd, total, start + maxLines - 1);

    const width = String(end).length;
    const body = lines
      .slice(start - 1, end)
      .map((text, i) => `${String(start + i).padStart(width)}  ${text}`)
      .join("\n");
    const more = end < total ? `\n[Lines ${end + 1}-${total} not shown. Call read_file with start_line=${end + 1} to continue.]` : "";
    return ctx.capOutput(`${rel} (lines ${start}-${end} of ${total})\n${wrapUntrusted(rel, body)}${more}`);
  },
  describe: (args) => ({
    action: "Read",
    target: `${args.path ?? ""}${args.start_line ? `:${args.start_line}${args.end_line ? `-${args.end_line}` : ""}` : ""}`,
  }),
});
