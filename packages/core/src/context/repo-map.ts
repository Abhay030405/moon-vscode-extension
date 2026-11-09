// The project map (Aider-style): the most relevant files for the request, each with the main
// names it defines and their lines, packed into a token budget. The agent gets it at the
// start of agent mode, so it can go straight to the right files instead of searching blind.
// Parsing runs in short slices (TimeSlicer), so a large project never holds the editor.

import { readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import { MAP_MAX_NAMES_PER_FILE } from "../shared/constants.js";
import { TimeSlicer } from "../shared/time-slice.js";
import { walkProjectFiles } from "../workspace/shadow-copy.js";
import { estimateTokens } from "./budget.js";
import type { MapCache } from "./map-cache.js";
import { rankFiles, type RankFocus, type RankedFile } from "./ranking.js";
import type { FileTags, TagReader } from "./tags.js";

export interface ProjectMapOptions {
  root: string;
  reader: TagReader;
  cache: MapCache;
  ignoredDirs: ReadonlySet<string>;
  isSecret(rel: string): boolean;
  /** Parse at most this many files. */
  maxFiles: number;
  /** Skip files larger than this. */
  maxFileBytes: number;
  budgetTokens: number;
  focus: RankFocus;
}

export interface ProjectMap {
  text: string;
  tokens: number;
  budgetTokens: number;
  /** Files in the project (after ignored folders and secrets). */
  totalFiles: number;
  /** Files shown in the map, most relevant first. */
  shown: string[];
  /** Every file's tags (for the @ picker and @symbol). */
  tags: ReadonlyMap<string, FileTags>;
  /** Every file in the project. */
  files: string[];
}

export async function buildProjectMap(options: ProjectMapOptions): Promise<ProjectMap> {
  const slicer = new TimeSlicer();
  const files: string[] = [];
  for (const rel of walkProjectFiles(options.root, options.ignoredDirs)) {
    await slicer.pause();
    if (!options.isSecret(rel)) files.push(rel);
  }
  const tags = await readAllTags(options, files, slicer);
  await slicer.pause();
  const ranked = await rankFiles(files, tags, options.focus, slicer);
  const { text, shown } = renderMap(ranked, files.length, options.budgetTokens);
  return { text, tokens: estimateTokens(text), budgetTokens: options.budgetTokens, totalFiles: files.length, shown, tags, files };
}

async function readAllTags(options: ProjectMapOptions, files: readonly string[], slicer: TimeSlicer): Promise<Map<string, FileTags>> {
  const tags = new Map<string, FileTags>();
  let parsed = 0;
  for (const rel of files) {
    await slicer.pause();
    if (!options.reader.supports(rel) || parsed >= options.maxFiles) continue;
    parsed++;
    const abs = path.join(options.root, rel);
    try {
      const stat = statSync(abs);
      if (stat.size > options.maxFileBytes) continue;
      let fileTags = options.cache.get(rel, stat.size, stat.mtimeMs);
      if (fileTags === undefined) {
        fileTags = options.reader.read(rel, readFileSync(abs, "utf8")) ?? null;
        options.cache.set(rel, stat.size, stat.mtimeMs, fileTags);
      }
      if (fileTags) tags.set(rel, fileTags);
    } catch {
      // Unreadable file: leave it out of the map.
    }
  }
  options.cache.keepOnly(new Set(files));
  options.cache.save();
  return tags;
}

/** Adds files in rank order until the budget is used. */
function renderMap(ranked: readonly RankedFile[], totalFiles: number, budgetTokens: number): { text: string; shown: string[] } {
  const header = "Project map: the files most likely to matter for this request, most relevant first, " +
    "with the main names each defines (line numbers are 1-based).\n";
  let text = header;
  const shown: string[] = [];
  for (const file of ranked) {
    const block = fileBlock(file);
    if (estimateTokens(text + block) > budgetTokens) {
      if (shown.length === 0) continue; // a huge first entry should not hide everything
      break;
    }
    text += block;
    shown.push(file.rel);
  }
  const hidden = totalFiles - shown.length;
  if (hidden > 0) text += `(${hidden} more files not shown: use list_files and search_text to find them.)\n`;
  return { text, shown };
}

function fileBlock(file: RankedFile): string {
  const names = file.defs.slice(0, MAP_MAX_NAMES_PER_FILE);
  const lines = names.map((d) => `  ${d.kind} ${d.name} :${d.line + 1}`);
  const more = file.defs.length - names.length;
  if (more > 0) lines.push(`  (+${more} more)`);
  return `${file.rel}\n${lines.map((l) => `${l}\n`).join("")}`;
}
