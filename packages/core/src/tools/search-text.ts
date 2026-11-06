import picomatch from "picomatch";
import { z } from "zod";
import { wrapUntrusted } from "../safety/untrusted-text.js";
import { ToolError } from "./context.js";
import { escapeRegExp, formatMatches, searchLines } from "./line-search.js";
import { defineTool } from "./tool.js";

export const searchTextTool = defineTool({
  name: "search_text",
  title: "Search text",
  description:
    "Search the project's text files for a word, phrase or regular expression. Returns 'path:line: text' " +
    "for each match (limited). Use it to find where something is mentioned, then read_file to see context.",
  input: {
    query: z.string().min(1).describe("Text to look for (or a regular expression when regex is true)."),
    regex: z.boolean().optional().describe("Treat query as a JavaScript regular expression. Default false."),
    case_sensitive: z.boolean().optional().describe("Default false."),
    path: z.string().optional().describe("Only search inside this folder (relative to the project root)."),
    glob: z.string().optional().describe("Only search files matching this glob, e.g. '**/*.py'."),
  },
  readOnly: true,
  run(ctx, args) {
    const flags = args.case_sensitive ? "" : "i";
    let pattern: RegExp;
    try {
      pattern = new RegExp(args.regex ? args.query : escapeRegExp(args.query), flags);
    } catch (err) {
      throw new ToolError(`Invalid regular expression: ${(err as Error).message}`);
    }
    const start = ctx.paths.resolve(args.path ?? "");
    const fileFilter = args.glob ? picomatch(args.glob, { dot: true }) : undefined;
    const result = searchLines(ctx, (line) => pattern.test(line), { startRel: start.rel, fileFilter });
    return ctx.capOutput(wrapUntrusted(`search results for "${args.query}"`, formatMatches(result, "matches")));
  },
  describe: (args) => ({ action: "Search", target: `"${args.query ?? ""}"${args.path ? ` in ${args.path}` : ""}` }),
});
