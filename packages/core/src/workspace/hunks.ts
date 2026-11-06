// Line diff between the file as it is now and the version Moon proposes, split into hunks.
//
// Review works on two texts only: `current` (the editor's text) and `target` (what the file
// would be with every remaining change accepted). Hunks are always recalculated from these two:
// - Accept hunk i  -> current = current with only hunk i applied   (the editor changes)
// - Reject hunk i  -> target  = current with every hunk except i    (the proposal changes)
// Review is finished when current equals target.

import { DIFF_MAX_CELLS } from "../shared/constants.js";

export interface Hunk {
  /** First changed line in the old text (0-based). For a pure insertion: the line it goes before. */
  oldStart: number;
  /** Lines removed from the old text (may be empty). */
  oldLines: string[];
  /** First line of the replacement in the new text (0-based). */
  newStart: number;
  /** Lines that replace them (may be empty). */
  newLines: string[];
}

/** Splits text into lines, accepting both \n and \r\n. */
export function splitLines(text: string): string[] {
  return text.split(/\r?\n/);
}

/**
 * The changed regions between `oldLines` and `newLines`. Changes separated by at least one
 * unchanged line are separate hunks. Uses a longest-common-subsequence diff on the part
 * between the common start and end, which for an inline edit is small.
 */
export function diffLines(oldLines: readonly string[], newLines: readonly string[]): Hunk[] {
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start++;
  let oldEnd = oldLines.length;
  let newEnd = newLines.length;
  while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }
  const a = oldLines.slice(start, oldEnd);
  const b = newLines.slice(start, newEnd);
  if (a.length === 0 && b.length === 0) return [];

  // Too big to compare line by line: show the whole middle as one hunk.
  if (a.length * b.length > DIFF_MAX_CELLS) {
    return [{ oldStart: start, oldLines: a, newStart: start, newLines: b }];
  }

  // lcs[i][j] = length of the longest common subsequence of a[i..] and b[j..].
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

  // Walk the table; every run of non-matching lines becomes one hunk.
  const hunks: Hunk[] = [];
  let open: Hunk | undefined;
  let i = 0;
  let j = 0;
  const close = () => {
    if (open) hunks.push(open);
    open = undefined;
  };
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      close();
      i++;
      j++;
      continue;
    }
    open ??= { oldStart: start + i, oldLines: [], newStart: start + j, newLines: [] };
    if (j < b.length && (i === a.length || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) {
      open.newLines.push(b[j++]!);
    } else {
      open.oldLines.push(a[i++]!);
    }
  }
  close();
  return hunks;
}

/** `oldLines` with the given hunks (from diffLines(oldLines, ...)) applied. */
export function applyHunks(oldLines: readonly string[], hunks: readonly Hunk[]): string[] {
  const result: string[] = [];
  let next = 0;
  for (const hunk of [...hunks].sort((x, y) => x.oldStart - y.oldStart)) {
    result.push(...oldLines.slice(next, hunk.oldStart), ...hunk.newLines);
    next = hunk.oldStart + hunk.oldLines.length;
  }
  result.push(...oldLines.slice(next));
  return result;
}

/** The target after rejecting hunk `index`: every other hunk stays proposed. */
export function rejectHunk(currentLines: readonly string[], hunks: readonly Hunk[], index: number): string[] {
  return applyHunks(
    currentLines,
    hunks.filter((_, i) => i !== index),
  );
}

/** One text replacement, as character offsets into `lines.join(eol)`. */
export interface OffsetEdit {
  start: number;
  end: number;
  text: string;
}

/**
 * The single replacement that applies `hunk` to the text `lines.join(eol)`. The editor applies
 * it as a normal edit, so Ctrl+Z undoes it. Several hunks of the same diff do not overlap, so
 * their edits can be applied together.
 */
export function hunkTextEdit(lines: readonly string[], hunk: Hunk, eol: string): OffsetEdit {
  const lineStart = (k: number) => lines.slice(0, k).reduce((sum, line) => sum + line.length + eol.length, 0);
  const total = lineStart(lines.length) - eol.length;
  const endLine = hunk.oldStart + hunk.oldLines.length;
  if (endLine < lines.length) {
    // Whole lines (with their line breaks) are replaced.
    return { start: lineStart(hunk.oldStart), end: lineStart(endLine), text: hunk.newLines.map((l) => l + eol).join("") };
  }
  // The hunk runs to the end of the text, which has no line break after it: take the one before instead.
  if (hunk.oldStart === 0) return { start: 0, end: total, text: hunk.newLines.join(eol) };
  return { start: lineStart(hunk.oldStart) - eol.length, end: total, text: hunk.newLines.map((l) => eol + l).join("") };
}

/** Where one change sits in the preview: its old lines (red), then its new lines (green). */
export interface PreviewHunk {
  removedStart: number;
  removedCount: number;
  addedStart: number;
  addedCount: number;
}

export interface PreviewLayout {
  /** The editor text during review: the file with each change's new lines right under its old lines. */
  lines: string[];
  hunks: PreviewHunk[];
}

/**
 * Copilot-style preview: for every change between `original` and `target`, the old lines stay
 * (shown red) and the new lines are placed right after them (shown green).
 * With no changes the layout is just `original`.
 */
export function layoutPreview(original: readonly string[], target: readonly string[]): PreviewLayout {
  const lines: string[] = [];
  const hunks: PreviewHunk[] = [];
  let next = 0;
  for (const h of diffLines(original, target)) {
    lines.push(...original.slice(next, h.oldStart));
    const removedStart = lines.length;
    lines.push(...h.oldLines);
    const addedStart = lines.length;
    lines.push(...h.newLines);
    hunks.push({ removedStart, removedCount: h.oldLines.length, addedStart, addedCount: h.newLines.length });
    next = h.oldStart + h.oldLines.length;
  }
  lines.push(...original.slice(next));
  return { lines, hunks };
}

/** Text edits that turn `fromLines` into `toLines` (non-overlapping, so they can be applied as one edit). */
export function linesToEdits(fromLines: readonly string[], toLines: readonly string[], eol: string): OffsetEdit[] {
  return diffLines(fromLines, toLines).map((h) => hunkTextEdit(fromLines, h, eol));
}
