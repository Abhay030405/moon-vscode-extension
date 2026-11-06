// Builds the one user message an inline edit sends to its TrueForge session:
// the instruction, the selected lines, the file around them, and the editor's problems.
// The agent can still read more of the file (or other files) with its tools.

import { wrapUntrusted } from "../safety/untrusted-text.js";
import type { EditorDiagnostic } from "../tools/context.js";
import { splitLines } from "../workspace/hunks.js";

export interface InlineRequest {
  /** What the user typed. */
  instruction: string;
  /** Project-relative path of the file. */
  rel: string;
  /** Editor language id, e.g. "python". */
  languageId: string;
  /** The file's current text (editor text, unsaved changes included). */
  text: string;
  /** Selected lines, 0-based and inclusive. Equal when nothing (or one line) is selected. */
  startLine: number;
  endLine: number;
  /** Problems the editor reports for this file. */
  problems: EditorDiagnostic[];
}

export interface InlinePromptLimits {
  /** Lines shown before and after the selection. */
  contextLines: number;
  /** Most problems listed. */
  maxProblems: number;
}

export function buildInlinePrompt(req: InlineRequest, limits: InlinePromptLimits): string {
  const lines = splitLines(req.text);
  const from = Math.max(0, req.startLine - limits.contextLines);
  const to = Math.min(lines.length - 1, req.endLine + limits.contextLines);
  const width = String(to + 1).length;
  const numbered = lines
    .slice(from, to + 1)
    .map((line, i) => {
      const n = from + i;
      const mark = n >= req.startLine && n <= req.endLine ? ">" : " ";
      return `${mark} ${String(n + 1).padStart(width)}  ${line}`;
    })
    .join("\n");

  const hidden: string[] = [];
  if (from > 0) hidden.push(`1-${from}`);
  if (to < lines.length - 1) hidden.push(`${to + 2}-${lines.length}`);
  const hiddenNote = hidden.length
    ? `\n[Lines ${hidden.join(" and ")} of ${lines.length} not shown. Use read_file if you need them.]`
    : "";

  const first = req.startLine + 1;
  const last = req.endLine + 1;
  const selection = first === last ? `line ${first}` : `lines ${first}-${last}`;

  const problems = req.problems.slice(0, limits.maxProblems);
  const problemText = problems.length
    ? wrapUntrusted(
        "editor-problems",
        problems.map((p) => `${p.path}:${p.line}:${p.column} ${p.severity}: ${p.message}`).join("\n"),
      )
    : "None.";

  return [
    `Inline edit of \`${req.rel}\` (${req.languageId}), ${selection} selected.`,
    "",
    "## Instruction",
    req.instruction.trim(),
    "",
    `## The file around the selection (selected lines are marked with ">")`,
    wrapUntrusted(req.rel, numbered) + hiddenNote,
    "",
    "## Problems the editor reports in this file",
    problemText,
  ].join("\n");
}
