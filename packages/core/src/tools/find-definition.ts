import { z } from "zod";
import { wrapUntrusted } from "../safety/untrusted-text.js";
import { DEFINITION_PATTERNS } from "../shared/constants.js";
import { escapeRegExp, formatMatches, searchLines } from "./line-search.js";
import { defineTool } from "./tool.js";

/** One regular expression matching any known way of defining `name`. */
export function definitionRegExp(name: string): RegExp {
  const symbol = escapeRegExp(name);
  return new RegExp(DEFINITION_PATTERNS.map((p) => `(?:${p.replaceAll("NAME", symbol)})`).join("|"));
}

export const findDefinitionTool = defineTool({
  name: "find_definition",
  title: "Find definition",
  description:
    "Find where a function, class, method, type or variable is defined, by exact name, in any language. " +
    "Returns 'path:line: text'. Faster and more precise than search_text for definitions.",
  input: {
    name: z.string().min(1).describe("Exact symbol name, e.g. 'get_debug_flag' or 'Flask'."),
  },
  readOnly: true,
  run(ctx, args) {
    const pattern = definitionRegExp(args.name.trim());
    const result = searchLines(ctx, (line) => pattern.test(line));
    return ctx.capOutput(wrapUntrusted(`definitions of ${args.name}`, formatMatches(result, `definitions of ${args.name}`)));
  },
  describe: (args) => ({ action: "Find definition", target: args.name ?? "" }),
});
