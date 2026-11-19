// Impact check (docs/design-decisions.md section 13.1): when the agent renamed or removed a
// function or class, or changed a function's inputs, Moon finds the places that use it (from the
// project map's tags) and lists the ones the agent did not update. No model call.
//
// Kept simple and quiet on purpose:
// - only names defined once in the whole project (a common name like `run` would match
//   unrelated code);
// - new inputs that all have a default ("=", "?", "*...") keep old calls working, so they are
//   not a change of inputs;
// - for changed inputs only calls (`name(`) on lines the agent did not touch count; for a
//   removed name every remaining use counts, since that code would break.

import type { FileTags } from "../context/tags.js";
import { IMPACT_SIGNATURE_MAX_LINES } from "../shared/constants.js";
import { definitionRegExp } from "../tools/find-definition.js";
import { escapeRegExp } from "../tools/line-search.js";
import { diffLines, splitLines } from "./hunks.js";

export interface ImpactChange {
  rel: string;
  /** The real file's text (null = the agent created it). */
  baseText: string | null;
  /** The copy's text (null = the agent deleted it). */
  newText: string | null;
}

export interface ImpactInput {
  changes: readonly ImpactChange[];
  /** Every project file's tags, from the project map (the original code). */
  projectTags: ReadonlyMap<string, FileTags>;
  /** Tags of a text (undefined for a language the map does not read). */
  readTags(rel: string, text: string): FileTags | undefined;
  /** A file's text in the agent's copy now (null when missing). */
  readText(rel: string): string | null;
  maxUses: number;
}

export interface MissedUse {
  name: string;
  why: "removed" | "inputs";
  rel: string;
  /** 1-based. */
  line: number;
  text: string;
}

interface Changed {
  name: string;
  why: MissedUse["why"];
}

export function findMissedUses(input: ImpactInput): MissedUse[] {
  const changed = changedNames(input);
  if (changed.length === 0) return [];
  const byRel = new Map(input.changes.map((c) => [c.rel, c]));
  const missed: MissedUse[] = [];

  for (const { name, why } of changed) {
    const word = new RegExp(`(^|[^\\w$])${escapeRegExp(name)}(?![\\w$])`);
    const call = new RegExp(`(^|[^\\w$])${escapeRegExp(name)}\\s*\\(`);
    const definition = definitionRegExp(name);
    // Files that use the name: from the map, plus every file the agent changed or created.
    const files = new Set<string>(byRel.keys());
    for (const [rel, tags] of input.projectTags) if (tags.refs[name]) files.add(rel);

    for (const rel of [...files].sort()) {
      const text = input.readText(rel);
      if (text === null) continue;
      const lines = splitLines(text);
      const touched = touchedLines(byRel.get(rel));
      lines.forEach((line, i) => {
        if (missed.length >= input.maxUses || definition.test(line) || !word.test(line)) return;
        if (why === "inputs" && (touched.has(i) || !call.test(line))) return;
        missed.push({ name, why, rel, line: i + 1, text: line.trim() });
      });
    }
  }
  return missed;
}

/** What the agent renamed/removed, or whose inputs it changed (names defined once only). */
function changedNames(input: ImpactInput): Changed[] {
  const definedIn = new Map<string, number>();
  for (const tags of input.projectTags.values()) {
    // Every definition counts, so overloads (`@overload` stubs, TS overload signatures) make a
    // name "defined more than once" and it is skipped: their inputs differ on purpose.
    for (const d of tags.defs) definedIn.set(d.name, (definedIn.get(d.name) ?? 0) + 1);
  }
  // Names the copy defines in the changed files now (a moved function is not removed).
  const definedNow = new Set<string>();
  const after = new Map<string, FileTags | undefined>();
  for (const change of input.changes) {
    const tags = change.newText === null ? undefined : input.readTags(change.rel, change.newText);
    after.set(change.rel, tags);
    for (const d of tags?.defs ?? []) definedNow.add(d.name);
  }

  const result: Changed[] = [];
  const seen = new Set<string>();
  for (const change of input.changes) {
    if (change.baseText === null) continue;
    const before = input.readTags(change.rel, change.baseText);
    if (!before) continue;
    const baseLines = splitLines(change.baseText);
    const newLines = change.newText === null ? [] : splitLines(change.newText);
    const newDefs = after.get(change.rel)?.defs ?? [];
    for (const def of before.defs) {
      const name = def.name;
      if (seen.has(name) || name.startsWith("__") || (definedIn.get(name) ?? 0) !== 1) continue;
      const now = newDefs.find((d) => d.name === name && d.kind === def.kind);
      if (!now) {
        if (definedNow.has(name)) continue;
        seen.add(name);
        result.push({ name, why: "removed" });
        continue;
      }
      if (def.kind === "class") continue; // A class's "(...)" lists its bases, not its inputs.
      const oldParams = params(baseLines, def.line);
      const newParams = params(newLines, now.line);
      if (oldParams === undefined || newParams === undefined || compatible(oldParams, newParams)) continue;
      seen.add(name);
      result.push({ name, why: "inputs" });
    }
  }
  return result;
}

/** The inputs between a definition's first "(" and its matching ")", split at top-level commas. */
function params(lines: readonly string[], start: number): string[] | undefined {
  const text = lines.slice(start, start + IMPACT_SIGNATURE_MAX_LINES).join("\n");
  const open = text.indexOf("(");
  if (open === -1) return undefined;
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (let i = open + 1; i < text.length; i++) {
    const ch = text[i]!;
    // "<"/">" are left out: "=>" and "->" in types would unbalance them.
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    if (ch === ")" || ch === "]" || ch === "}") {
      if (depth === 0 && ch === ")") {
        if (current.trim()) parts.push(current.replace(/\s+/g, ""));
        return parts;
      }
      depth--;
    }
    if (ch === "," && depth === 0) {
      parts.push(current.replace(/\s+/g, ""));
      current = "";
    } else current += ch;
  }
  return undefined;
}

/** Same inputs, or only new inputs that have a default (old calls still work). */
function compatible(oldParams: readonly string[], newParams: readonly string[]): boolean {
  if (newParams.length < oldParams.length) return false;
  if (oldParams.some((p, i) => p !== newParams[i])) return false;
  return newParams.slice(oldParams.length).every((p) => p.includes("=") || p.includes("?") || p.startsWith("*"));
}

/** 0-based lines of the copy's text that the agent added or changed. */
function touchedLines(change: ImpactChange | undefined): Set<number> {
  const touched = new Set<number>();
  if (!change || change.newText === null) return touched;
  if (change.baseText === null) {
    splitLines(change.newText).forEach((_, i) => touched.add(i));
    return touched;
  }
  for (const hunk of diffLines(splitLines(change.baseText), splitLines(change.newText))) {
    for (let i = 0; i < hunk.newLines.length; i++) touched.add(hunk.newStart + i);
  }
  return touched;
}

/** One line per missed use, e.g. "`get_debug_flag` (inputs changed): src/app.py:120". */
export function missedUsesText(missed: readonly MissedUse[]): string {
  const names = new Map<string, MissedUse[]>();
  for (const m of missed) names.set(m.name, [...(names.get(m.name) ?? []), m]);
  return [...names.values()]
    .map((uses) => {
      const { name, why } = uses[0]!;
      const what = why === "removed" ? "was renamed or removed" : "has different inputs now";
      return `\`${name}\` ${what}, but ${uses.length} use(s) were not updated: ${uses.map((u) => `${u.rel} line ${u.line}`).join(", ")}`;
    })
    .join("\n");
}
