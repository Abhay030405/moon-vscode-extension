// Shared by search_text, find_definition and find_usages: scan text files line by line
// and collect matches, stopping at tools.searchMaxResults.

import { readFileSync } from "node:fs";
import * as path from "node:path";
import { MAX_MATCH_LINE_CHARS } from "../shared/constants.js";
import type { ToolContext } from "./context.js";

export interface LineMatch {
  rel: string;
  line: number;
  text: string;
}

export interface LineSearchResult {
  matches: LineMatch[];
  /** True when more matches existed than the limit allowed. */
  truncated: boolean;
  filesSearched: number;
}

export function searchLines(
  ctx: ToolContext,
  test: (line: string) => boolean,
  options: { startRel?: string; fileFilter?: (rel: string) => boolean } = {},
): LineSearchResult {
  const max = ctx.limits.searchMaxResults;
  const matches: LineMatch[] = [];
  let filesSearched = 0;
  for (const rel of ctx.walkFiles(options.startRel ?? "")) {
    if (options.fileFilter && !options.fileFilter(rel)) continue;
    const abs = path.join(ctx.paths.root, rel);
    if (!ctx.isSearchableText(abs)) continue;
    filesSearched++;
    const lines = readFileSync(abs, "utf8").split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (!test(line)) continue;
      if (matches.length >= max) return { matches, truncated: true, filesSearched };
      matches.push({ rel, line: i + 1, text: shorten(line.trim()) });
    }
  }
  return { matches, truncated: false, filesSearched };
}

/** "path:line: text" lines, plus a note when the limit cut the list. */
export function formatMatches(result: LineSearchResult, what: string): string {
  if (result.matches.length === 0) return `No ${what} found (${result.filesSearched} files searched).`;
  const lines = result.matches.map((m) => `${m.rel}:${m.line}: ${m.text}`);
  const header = `${result.matches.length} ${what}${result.truncated ? " (limit reached; more exist, narrow the search)" : ""}:`;
  return [header, ...lines].join("\n");
}

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function shorten(line: string): string {
  return line.length <= MAX_MATCH_LINE_CHARS ? line : `${line.slice(0, MAX_MATCH_LINE_CHARS)}…`;
}
