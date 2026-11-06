// Copilot-style review of an inline-edit proposal, inside the editor:
// - each change's new lines are placed right under its old lines, new lines green, old lines red;
// - "Accept | Reject" (CodeLens) above each change, "Accept all | Reject all" above the first.
//
// The preview lives only in the editor's unsaved text. It is never written to disk:
// - saving during review saves the file WITHOUT the preview (only accepted changes), then the
//   preview is put back in the editor;
// - closing the review removes the preview.
//
// State: `original` (the file with the changes accepted so far) and `target` (original with every
// remaining change accepted). The editor shows layoutPreview(original, target). Every state Moon
// puts in the editor is remembered, so Ctrl+Z / Ctrl+Y back to one of them brings its colours and
// buttons back; any other text (the user typed) just hides them until the text matches again.

import * as vscode from "vscode";
import { applyHunks, diffLines, layoutPreview, linesToEdits, rejectHunk, splitLines, type PreviewHunk } from "@moon/core";

export interface ReviewResult {
  accepted: number;
  rejected: number;
}

export interface PreviewDecorations {
  removed: vscode.TextEditorDecorationType;
  added: vscode.TextEditorDecorationType;
}

interface ReviewState {
  original: string[];
  target: string[];
  /** The editor text for this state, and where each change is in it. */
  text: string;
  hunks: PreviewHunk[];
}

export class InlinePreview implements vscode.Disposable {
  private readonly history: ReviewState[] = [];
  /** The state whose text is in the editor now; undefined when the text is something else. */
  private shown: ReviewState | undefined;
  /** The latest state Moon moved to (what a save puts back after saving without the preview). */
  private latest: ReviewState;
  private readonly baseText: string;
  private readonly listeners: vscode.Disposable[] = [];
  private accepted = 0;
  private rejected = 0;
  private finished = false;
  /** Set while saving: the preview was taken out for the save and goes back afterwards. */
  private restoreAfterSave = false;

  constructor(
    readonly document: vscode.TextDocument,
    proposedText: string,
    private readonly decorations: PreviewDecorations,
    private readonly onChange: () => void,
    private readonly onFinish: (result: ReviewResult) => void,
  ) {
    this.baseText = document.getText();
    this.latest = this.state(splitLines(this.baseText), splitLines(proposedText));
    this.listeners.push(
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document === this.document) this.sync();
      }),
      vscode.window.onDidChangeVisibleTextEditors(() => this.decorate()),
      vscode.workspace.onWillSaveTextDocument((e) => {
        if (e.document !== this.document || !this.isReviewing) return;
        // Never save the preview: save the file with only the accepted changes.
        this.latest = this.shown!;
        this.restoreAfterSave = e.reason !== vscode.TextDocumentSaveReason.AfterDelay;
        e.waitUntil(Promise.resolve(this.textEdits(this.shown!.original)));
      }),
      vscode.workspace.onDidSaveTextDocument((doc) => {
        if (doc !== this.document || !this.restoreAfterSave) return;
        this.restoreAfterSave = false;
        void this.show(this.latest);
      }),
    );
  }

  /** Puts the preview in the editor. */
  async start(): Promise<void> {
    await this.show(this.latest);
  }

  /** True while the editor shows changes waiting for a decision. */
  get isReviewing(): boolean {
    return (this.shown?.hunks.length ?? 0) > 0;
  }

  /** Changes waiting for a decision (empty when not reviewing). */
  get pending(): readonly PreviewHunk[] {
    return this.shown?.hunks ?? [];
  }

  async accept(index: number): Promise<void> {
    const s = this.shown;
    const hunk = s && diffLines(s.original, s.target)[index];
    if (!s || !hunk) return;
    this.accepted++;
    await this.show(this.state(applyHunks(s.original, [hunk]), s.target));
  }

  async reject(index: number): Promise<void> {
    const s = this.shown;
    if (!s || !s.hunks[index]) return;
    this.rejected++;
    await this.show(this.state(s.original, rejectHunk(s.original, diffLines(s.original, s.target), index)));
  }

  async acceptAll(): Promise<void> {
    const s = this.shown;
    if (!s) return;
    this.accepted += s.hunks.length;
    await this.show(this.state(s.target, s.target));
  }

  async rejectAll(): Promise<void> {
    const s = this.shown;
    if (!s) return;
    this.rejected += s.hunks.length;
    await this.show(this.state(s.original, s.original));
  }

  /** Takes the preview out of the editor (pending changes are dropped). Used when closing. */
  async discard(): Promise<void> {
    if (!this.isReviewing) return;
    this.finished = true; // closing is not a finished review: no summary message
    await this.show(this.state(this.shown!.original, this.shown!.original));
  }

  dispose(): void {
    for (const l of this.listeners) l.dispose();
    this.shown = undefined;
    this.decorate();
  }

  private state(original: string[], target: string[]): ReviewState {
    const layout = layoutPreview(original, target);
    return { original, target, text: layout.lines.join(this.eol()), hunks: layout.hunks };
  }

  /** Moves the editor to `next` with one edit (one Ctrl+Z step). */
  private async show(next: ReviewState): Promise<void> {
    this.history.push(next);
    this.latest = next;
    const done = next.hunks.length === 0;
    if (done && !this.finished && next.text !== this.baseText) {
      // Last decision: first go back to the text before the preview, then apply the result.
      // The first Ctrl+Z afterwards then returns straight to the original code.
      await this.applyText(this.baseText);
    }
    await this.applyText(next.text);
    if (done && !this.finished) {
      this.finished = true;
      this.onFinish({ accepted: this.accepted, rejected: this.rejected });
    }
  }

  private async applyText(text: string): Promise<void> {
    const edits = this.textEdits(splitLines(text));
    if (edits.length === 0) return this.sync();
    const edit = new vscode.WorkspaceEdit();
    edit.set(this.document.uri, edits);
    if (!(await vscode.workspace.applyEdit(edit))) {
      void vscode.window.showErrorMessage("Moon could not change the editor text (is the file read-only?).");
    }
  }

  /** Editor edits from the current text to `lines`. */
  private textEdits(lines: string[]): vscode.TextEdit[] {
    const doc = this.document;
    return linesToEdits(splitLines(doc.getText()), lines, this.eol()).map(
      (e) => new vscode.TextEdit(new vscode.Range(doc.positionAt(e.start), doc.positionAt(e.end)), e.text),
    );
  }

  /** Matches the editor text to a known state (Ctrl+Z / Ctrl+Y included) and redraws. */
  private sync(): void {
    const text = this.document.getText();
    let found: ReviewState | undefined;
    for (let i = this.history.length - 1; i >= 0 && !found; i--) {
      if (this.history[i]!.text === text) found = this.history[i];
    }
    this.shown = found;
    this.decorate();
    this.onChange();
  }

  private decorate(): void {
    const removed: vscode.Range[] = [];
    const added: vscode.Range[] = [];
    for (const h of this.pending) {
      if (h.removedCount) removed.push(new vscode.Range(h.removedStart, 0, h.removedStart + h.removedCount - 1, 0));
      if (h.addedCount) added.push(new vscode.Range(h.addedStart, 0, h.addedStart + h.addedCount - 1, 0));
    }
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document !== this.document) continue;
      editor.setDecorations(this.decorations.removed, removed);
      editor.setDecorations(this.decorations.added, added);
    }
  }

  private eol(): string {
    return this.document.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n";
  }
}
