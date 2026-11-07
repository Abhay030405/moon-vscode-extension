// What the agent changed in the hidden copy, compared with the copy as it was made.
// Found by looking at the files (not by remembering edits), so changes made by commands
// count too, and the answer stays right after the conversation is compacted.

import { readFileSync } from "node:fs";
import { BINARY_SNIFF_BYTES } from "../shared/constants.js";
import { diffLines, splitLines } from "./hunks.js";
import { hashBytes, walkProjectFiles, type ShadowCopy } from "./shadow-copy.js";

export interface FileChange {
  /** Project-relative path with "/". */
  rel: string;
  kind: "added" | "modified" | "deleted";
  binary: boolean;
}

export function listChanges(copy: ShadowCopy): FileChange[] {
  const changes: FileChange[] = [];
  const seen = new Set<string>();
  for (const rel of walkProjectFiles(copy.dir, copy.ignoredDirs)) {
    if (copy.isSecret(rel)) continue;
    seen.add(rel);
    let data: Buffer;
    try {
      data = readFileSync(copy.copyPath(rel));
    } catch {
      continue;
    }
    const before = copy.baseline.get(rel);
    if (before === undefined) changes.push({ rel, kind: "added", binary: isBinary(data) });
    else if (before !== hashBytes(data)) changes.push({ rel, kind: "modified", binary: isBinary(data) });
  }
  for (const rel of copy.baseline.keys()) {
    if (!seen.has(rel)) changes.push({ rel, kind: "deleted", binary: false });
  }
  return changes.sort((a, b) => a.rel.localeCompare(b.rel));
}

export function isBinary(data: Buffer): boolean {
  return data.subarray(0, BINARY_SNIFF_BYTES).includes(0);
}

/** Lines added and removed between two texts (null = the file does not exist). */
export function lineCounts(before: string | null, after: string | null): { added: number; removed: number } {
  // A final line break does not start another line.
  const lines = (text: string | null) => {
    if (text === null) return [];
    const all = splitLines(text);
    if (all.at(-1) === "") all.pop();
    return all;
  };
  const hunks = diffLines(lines(before), lines(after));
  return {
    added: hunks.reduce((n, h) => n + h.newLines.length, 0),
    removed: hunks.reduce((n, h) => n + h.oldLines.length, 0),
  };
}
