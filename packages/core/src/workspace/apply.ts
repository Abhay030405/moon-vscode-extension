// Applies an agent's text edits (find exact text, replace it) to a file's text, in memory.
// Nothing here writes to disk: the result is only ever shown for review.

export interface TextEdit {
  /** Exact text to find; must occur exactly once in the file. */
  old_text: string;
  /** Text that replaces it. */
  new_text: string;
}

export class EditApplyError extends Error {
  override readonly name = "EditApplyError";
}

/**
 * Applies the edits one after another and returns the new text.
 * Line endings: the edits are matched with "\n"; a "\r\n" file keeps its "\r\n".
 */
export function applyTextEdits(text: string, edits: readonly TextEdit[]): string {
  const crlf = text.includes("\r\n");
  let result = crlf ? text.replace(/\r\n/g, "\n") : text;
  edits.forEach((edit, n) => {
    const find = edit.old_text.replace(/\r\n/g, "\n");
    const replace = edit.new_text.replace(/\r\n/g, "\n");
    const label = edits.length > 1 ? `Edit ${n + 1}: ` : "";
    if (find.length === 0) throw new EditApplyError(`${label}old_text is empty. Copy the exact lines to replace.`);
    const first = result.indexOf(find);
    if (first < 0) {
      throw new EditApplyError(
        `${label}old_text was not found in the file. Copy it exactly from read_file (without the line numbers).`,
      );
    }
    if (result.indexOf(find, first + 1) >= 0) {
      throw new EditApplyError(`${label}old_text occurs more than once. Include a few more lines so it is unique.`);
    }
    result = result.slice(0, first) + replace + result.slice(first + find.length);
  });
  return crlf ? result.replace(/\n/g, "\r\n") : result;
}
