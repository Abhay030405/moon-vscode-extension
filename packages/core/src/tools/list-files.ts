import picomatch from "picomatch";
import { z } from "zod";
import { wrapUntrusted } from "../safety/untrusted-text.js";
import { defineTool } from "./tool.js";

export const listFilesTool = defineTool({
  name: "list_files",
  title: "List files",
  description:
    "List files in the project (or in one folder of it), optionally filtered by a glob such as '**/*.py'. " +
    "Skips dependency/build folders and secret files. Use it to get your bearings; use search_text to find code.",
  input: {
    path: z.string().optional().describe("Folder relative to the project root. Default: the whole project."),
    glob: z.string().optional().describe("Only paths matching this glob, e.g. 'src/**/*.ts'."),
  },
  readOnly: true,
  run(ctx, args) {
    const start = ctx.paths.resolve(args.path ?? "");
    const matches = args.glob ? picomatch(args.glob, { dot: true }) : () => true;
    const max = ctx.limits.listFilesMaxResults;
    const files: string[] = [];
    let truncated = false;
    for (const rel of ctx.walkFiles(start.rel)) {
      if (!matches(rel)) continue;
      if (files.length >= max) {
        truncated = true;
        break;
      }
      files.push(rel);
    }
    const where = start.rel || "project root";
    if (files.length === 0) return `No files found under ${where}${args.glob ? ` matching ${args.glob}` : ""}.`;
    const note = truncated ? `\n[Only the first ${max} files shown. Use path or glob to narrow it.]` : "";
    return ctx.capOutput(wrapUntrusted(`file list: ${where}`, files.join("\n")) + note);
  },
  describe: (args) => `listing ${args.path || "project"}${args.glob ? ` (${args.glob})` : ""}`,
});
