// While an agent-mode review is open, every file under review shows Moon's changes where the
// user looks at code, without touching the file's text (nothing is written before Apply):
// - lines Moon would remove or replace get a red background;
// - where Moon adds lines, a green note at the end of the line before says how many;
// - a CodeLens above each change opens VS Code's diff editor (real file vs Moon's version),
//   which shows the full green/red diff. Accept/Reject happens in the review screen.

import * as path from "node:path";
import * as vscode from "vscode";
import { REVIEW_COMMANDS } from "../commands.js";

/** One change in a file under review, in the real file's lines (0-based). */
export interface EditorHunk {
  /** First line Moon removes or replaces; for a pure insertion, the line it goes before. */
  oldStart: number;
  removed: number;
  added: number;
}

/** Theme colour ids contributed in package.json ("contributes.colors"). */
const REMOVED_BG = "diffEditor.removedLineBackground";
const ADDED_FG = "moon.pendingChangesForeground";

export class ReviewInEditor implements vscode.CodeLensProvider, vscode.Disposable {
  /** Files under review, by absolute path (lower-cased on Windows). */
  private files = new Map<string, { rel: string; hunks: EditorHunk[] }>();
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.changed.event;
  private readonly removedLines = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor(REMOVED_BG),
    overviewRulerColor: new vscode.ThemeColor(REMOVED_BG),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  });
  private readonly addedNote = vscode.window.createTextEditorDecorationType({
    after: { color: new vscode.ThemeColor(ADDED_FG), margin: "0 0 0 2em" },
  });
  private readonly disposables: vscode.Disposable[] = [
    this.changed,
    this.removedLines,
    this.addedNote,
    vscode.languages.registerCodeLensProvider({ scheme: "file" }, this),
    vscode.window.onDidChangeVisibleTextEditors(() => this.decorateAll()),
  ];

  constructor(private readonly root: () => string | undefined) {}

  /** Shows these files as under review (an empty map ends the review). */
  show(files: ReadonlyMap<string, EditorHunk[]>): void {
    const root = this.root();
    this.files = new Map();
    if (root) {
      for (const [rel, hunks] of files) this.files.set(key(path.join(root, rel)), { rel, hunks });
    }
    this.changed.fire();
    this.decorateAll();
  }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    const file = this.files.get(key(doc.uri.fsPath));
    if (!file) return [];
    if (file.hunks.length === 0) {
      // A new, deleted or binary file: one lens at the top.
      return [this.lens(0, file.rel, "Moon: this file is in the review")];
    }
    return file.hunks.map((hunk, i) =>
      this.lens(
        Math.min(hunk.oldStart, Math.max(0, doc.lineCount - 1)),
        file.rel,
        `Moon: change ${i + 1} of ${file.hunks.length} (+${hunk.added} −${hunk.removed}) waiting for review · Show diff`,
      ),
    );
  }

  private lens(line: number, rel: string, title: string): vscode.CodeLens {
    return new vscode.CodeLens(new vscode.Range(line, 0, line, 0), { title, command: REVIEW_COMMANDS.showDiff, arguments: [rel] });
  }

  private decorateAll(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.uri.scheme !== "file") continue;
      const hunks = this.files.get(key(editor.document.uri.fsPath))?.hunks ?? [];
      const last = editor.document.lineCount - 1;
      const removed: vscode.Range[] = [];
      const notes: vscode.DecorationOptions[] = [];
      for (const hunk of hunks) {
        if (hunk.removed > 0) {
          const end = Math.min(hunk.oldStart + hunk.removed - 1, last);
          removed.push(new vscode.Range(hunk.oldStart, 0, end, 0));
        }
        if (hunk.added > 0) {
          // The note goes on the last line before the new lines (or the first line of the file).
          const line = Math.max(0, Math.min(hunk.oldStart + hunk.removed - 1, last));
          const text = `＋ Moon adds ${hunk.added} line${hunk.added === 1 ? "" : "s"} here`;
          notes.push({ range: new vscode.Range(line, Number.MAX_SAFE_INTEGER, line, Number.MAX_SAFE_INTEGER), renderOptions: { after: { contentText: text } } });
        }
      }
      editor.setDecorations(this.removedLines, removed);
      editor.setDecorations(this.addedNote, notes);
    }
  }

  dispose(): void {
    this.files.clear();
    for (const d of this.disposables) d.dispose();
  }
}

/** Paths compare case-insensitively on Windows. */
function key(abs: string): string {
  const normal = path.normalize(abs);
  return process.platform === "win32" ? normal.toLowerCase() : normal;
}
