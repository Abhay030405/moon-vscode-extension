// "Accept | Reject" above each proposed change (CodeLens), plus "Accept all | Reject all"
// above the first one. The commands themselves live in inline-edit.ts.

import * as vscode from "vscode";
import { INLINE_COMMANDS } from "../commands.js";
import type { InlinePreview } from "./preview.js";

export class HunkCodeLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.changed.event;

  constructor(private readonly previewFor: (doc: vscode.TextDocument) => InlinePreview | undefined) {}

  /** Call when a review starts, changes or ends. */
  refresh(): void {
    this.changed.fire();
  }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    const preview = this.previewFor(doc);
    if (!preview) return [];
    const uri = doc.uri.toString();
    const total = preview.pending.length;
    const lenses: vscode.CodeLens[] = [];
    preview.pending.forEach((hunk, i) => {
      // Above the change's first line (its red lines, or its green lines when it only adds).
      const line = hunk.removedCount > 0 ? hunk.removedStart : hunk.addedStart;
      const range = new vscode.Range(line, 0, line, 0);
      lenses.push(
        new vscode.CodeLens(range, { title: "$(check) Accept", command: INLINE_COMMANDS.acceptHunk, arguments: [uri, i] }),
        new vscode.CodeLens(range, { title: "$(discard) Reject", command: INLINE_COMMANDS.rejectHunk, arguments: [uri, i] }),
      );
      if (i === 0 && total > 1) {
        lenses.push(
          new vscode.CodeLens(range, { title: `$(check-all) Accept all (${total})`, command: INLINE_COMMANDS.acceptAll, arguments: [uri] }),
          new vscode.CodeLens(range, { title: "$(close-all) Reject all", command: INLINE_COMMANDS.rejectAll, arguments: [uri] }),
        );
      }
    });
    return lenses;
  }

  dispose(): void {
    this.changed.dispose();
  }
}
