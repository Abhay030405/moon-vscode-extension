// The review of an agent run: every file the agent changed in the hidden copy, split into
// hunks against the real file as it is now. The user accepts or rejects each hunk; then
// finalText() says what each real file becomes (only accepted hunks).

import { listChanges, type FileChange } from "./change-tracker.js";
import { readFileSync } from "node:fs";
import { applyHunks, diffLines, splitLines, type Hunk } from "./hunks.js";
import { hashBytes, type ShadowCopy } from "./shadow-copy.js";

export interface FileReview {
  /** Project-relative path with "/". */
  rel: string;
  kind: FileChange["kind"];
  /** Binary changes are listed but never applied. */
  binary: boolean;
  /** The real file's text now (null when it does not exist). */
  baseText: string | null;
  /** The file's text in the copy (null when the agent deleted it). */
  newText: string | null;
  hunks: Hunk[];
  /**
   * The real file was changed by hand after the copy was made (or a new file now exists).
   * Applying could overwrite that work, so it is not applied.
   */
  conflict: boolean;
  /** Line ending used when writing the file. */
  eol: string;
}

/**
 * Builds the review. `readProjectText` gives the real file's current text, from the editor when
 * it is open (unsaved changes included), or null when the file does not exist.
 */
export function buildReview(copy: ShadowCopy, readProjectText: (rel: string) => string | null): FileReview[] {
  return listChanges(copy).map((change) => {
    const baseText = readProjectText(change.rel);
    const newText = change.kind === "deleted" ? null : readCopyText(copy, change.rel);
    const before = copy.baseline.get(change.rel);
    const conflict =
      change.kind === "added" ? baseText !== null : baseText === null || before !== hashBytes(baseText);
    const eol = detectEol(baseText ?? newText ?? "");
    const hunks = change.binary
      ? []
      : diffLines(baseText === null ? [] : splitLines(baseText), newText === null ? [] : splitLines(newText));
    return { rel: change.rel, kind: change.kind, binary: change.binary, baseText, newText, hunks, conflict, eol };
  });
}

/**
 * What the real file should become with only the `accepted` hunks:
 * a string to write, null to delete the file, or undefined to leave it as it is.
 */
export function finalText(file: FileReview, accepted: ReadonlySet<number>): string | null | undefined {
  if (file.binary || file.conflict) return undefined;
  const chosen = file.hunks.filter((_, i) => accepted.has(i));
  if (chosen.length === 0) return undefined;
  if (file.kind === "deleted") return null; // one hunk: the whole file
  if (file.kind === "added") return file.newText;
  const base = splitLines(file.baseText ?? "");
  return applyHunks(base, chosen).join(file.eol);
}

function readCopyText(copy: ShadowCopy, rel: string): string | null {
  try {
    return readFileSync(copy.copyPath(rel), "utf8");
  } catch {
    return null;
  }
}

function detectEol(text: string): string {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

/** One line of a hunk as the review screen shows it: unchanged (" "), removed ("-") or added ("+"). */
export interface HunkLine {
  kind: " " | "-" | "+";
  text: string;
}

/** A hunk with `contextLines` unchanged lines of the real file above and below it. */
export function hunkWithContext(file: FileReview, hunk: Hunk, contextLines: number): HunkLine[] {
  const base = file.baseText === null ? [] : splitLines(file.baseText);
  const before = base.slice(Math.max(0, hunk.oldStart - contextLines), hunk.oldStart);
  const afterStart = hunk.oldStart + hunk.oldLines.length;
  const after = base.slice(afterStart, afterStart + contextLines);
  return [
    ...before.map((text) => ({ kind: " " as const, text })),
    ...hunk.oldLines.map((text) => ({ kind: "-" as const, text })),
    ...hunk.newLines.map((text) => ({ kind: "+" as const, text })),
    ...after.map((text) => ({ kind: " " as const, text })),
  ];
}
