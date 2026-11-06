import { z } from "zod";
import { wrapUntrusted } from "../safety/untrusted-text.js";
import { definitionRegExp } from "./find-definition.js";
import { escapeRegExp, formatMatches, searchLines } from "./line-search.js";
import { defineTool } from "./tool.js";

export const findUsagesTool = defineTool({
  name: "find_usages",
  title: "Find usages",
  description:
    "Find where a symbol is used (called, imported, referenced) by exact whole-word name, leaving out " +
    "its definitions. Returns 'path:line: text'.",
  input: {
    name: z.string().min(1).describe("Exact symbol name, e.g. 'get_debug_flag'."),
  },
  readOnly: true,
  run(ctx, args) {
    const name = args.name.trim();
    const word = new RegExp(`(^|[^\\w$])${escapeRegExp(name)}(?![\\w$])`);
    const definition = definitionRegExp(name);
    const result = searchLines(ctx, (line) => word.test(line) && !definition.test(line));
    return ctx.capOutput(wrapUntrusted(`usages of ${name}`, formatMatches(result, `usages of ${name}`)));
  },
  describe: (args) => ({ action: "Find usages", target: args.name ?? "" }),
});
