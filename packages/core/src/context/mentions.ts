// @-mentions: files and symbols the user names in agent mode.
// - @file: the whole file if it fits the budget; otherwise its outline (the names it defines)
//   and a note to read the parts it needs.
// - @symbol: the code of that one definition (picked from a list, so it is never ambiguous).
// The panel's @ picker searches the project's files and the names the project map found.

import { wrapUntrusted } from "../safety/untrusted-text.js";
import { estimateTokens } from "./budget.js";
import type { Definition, FileTags } from "./tags.js";

export type Mention = { kind: "file"; rel: string } | { kind: "symbol"; name: string; rel: string; line: number };

export interface MentionOptions {
  /** A project file's text (unsaved editor text first), or null if it can't be read. */
  readText(rel: string): string | null;
  tags(rel: string): FileTags | undefined;
  maxTokens: number;
  symbolMaxLines: number;
}

/** What one mention added, for the panel's context card. */
export interface ExpandedMention {
  label: string;
  /** full = the whole file; outline = names only (too big); definition = one symbol's code. */
  mode: "full" | "outline" | "definition" | "missing";
  tokens: number;
}

/** The text the agent gets for the mentions (empty when there are none). */
export function expandMentions(mentions: readonly Mention[], options: MentionOptions): { text: string; items: ExpandedMention[] } {
  const blocks: string[] = [];
  const items: ExpandedMention[] = [];
  for (const mention of mentions) {
    const { block, item } = mention.kind === "file" ? expandFile(mention.rel, options) : expandSymbol(mention, options);
    blocks.push(block);
    items.push(item);
  }
  if (blocks.length === 0) return { text: "", items };
  return { text: `The user attached these with @:\n\n${blocks.join("\n\n")}`, items };
}

function expandFile(rel: string, options: MentionOptions): { block: string; item: ExpandedMention } {
  const label = `@${rel}`;
  const text = options.readText(rel);
  if (text === null) return { block: `${label}: file not found.`, item: { label, mode: "missing", tokens: 0 } };
  const tokens = estimateTokens(text);
  if (tokens <= options.maxTokens) {
    const block = `${label} (whole file):\n${wrapUntrusted(rel, text)}`;
    return { block, item: { label, mode: "full", tokens: estimateTokens(block) } };
  }
  const defs = options.tags(rel)?.defs ?? [];
  const outline = defs.length ? defs.map((d) => `${d.kind} ${d.name} :${d.line + 1}`).join("\n") : "(no outline for this file type)";
  const block =
    `${label} is large (about ${tokens} tokens), so here is its outline. ` +
    `Read the parts you need with read_file and a line range.\n${wrapUntrusted(`outline of ${rel}`, outline)}`;
  return { block, item: { label, mode: "outline", tokens: estimateTokens(block) } };
}

function expandSymbol(mention: Extract<Mention, { kind: "symbol" }>, options: MentionOptions): { block: string; item: ExpandedMention } {
  const label = `@${mention.name}`;
  const text = options.readText(mention.rel);
  if (text === null) return { block: `${label} (${mention.rel}): file not found.`, item: { label, mode: "missing", tokens: 0 } };
  const lines = text.split(/\r?\n/);
  const end = definitionEnd(lines, mention.line, options.tags(mention.rel)?.defs ?? [], options.symbolMaxLines);
  const code = lines.slice(mention.line, end).join("\n");
  const more = end - mention.line >= options.symbolMaxLines ? ` (first ${options.symbolMaxLines} lines; read_file for the rest)` : "";
  const block = `${label}, defined in ${mention.rel} at line ${mention.line + 1}${more}:\n${wrapUntrusted(`${mention.rel}:${mention.line + 1}`, code)}`;
  return { block, item: { label, mode: "definition", tokens: estimateTokens(block) } };
}

/**
 * Where a definition ends: at the next definition that is not nested inside it (same or
 * smaller indent), or after maxLines. Works for any language the map parses.
 */
function definitionEnd(lines: readonly string[], start: number, defs: readonly Definition[], maxLines: number): number {
  const indent = (line: number) => (lines[line] ?? "").match(/^\s*/)![0].length;
  const own = indent(start);
  const next = defs.find((d) => d.line > start && indent(d.line) <= own);
  return Math.min(next?.line ?? lines.length, start + maxLines, lines.length);
}

/** One entry of the @ picker. */
export interface MentionCandidate {
  mention: Mention;
  /** What the picker shows, e.g. "cli.py" or "routes_command". */
  label: string;
  /** Second line, e.g. "src/flask/cli.py" or "function · src/flask/cli.py:1060". */
  detail: string;
}

/** Files and names matching what the user typed after "@" (best matches first). */
export function searchMentions(
  query: string,
  files: readonly string[],
  tags: ReadonlyMap<string, FileTags>,
  max: number,
): MentionCandidate[] {
  const q = query.toLowerCase();
  const scored: { score: number; candidate: MentionCandidate }[] = [];
  for (const rel of files) {
    const name = rel.slice(rel.lastIndexOf("/") + 1);
    const score = matchScore(name.toLowerCase(), rel.toLowerCase(), q);
    if (score > 0) scored.push({ score: score + 0.5, candidate: { mention: { kind: "file", rel }, label: name, detail: rel } });
  }
  for (const [rel, fileTags] of tags) {
    for (const def of fileTags.defs) {
      const score = matchScore(def.name.toLowerCase(), def.name.toLowerCase(), q);
      if (score > 0) {
        scored.push({
          score,
          candidate: {
            mention: { kind: "symbol", name: def.name, rel, line: def.line },
            label: def.name,
            detail: `${def.kind} · ${rel}:${def.line + 1}`,
          },
        });
      }
    }
  }
  return scored
    .sort((a, b) => b.score - a.score || a.candidate.label.length - b.candidate.label.length || a.candidate.detail.localeCompare(b.candidate.detail))
    .slice(0, max)
    .map((s) => s.candidate);
}

/** 3 = the name starts with the query, 2 = the name contains it, 1 = the path contains it. */
function matchScore(name: string, full: string, q: string): number {
  if (!q) return 1;
  if (name.startsWith(q)) return 3;
  if (name.includes(q)) return 2;
  if (full.includes(q)) return 1;
  return 0;
}
