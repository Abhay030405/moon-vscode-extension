// A green dot in the Explorer on every file with Moon changes still waiting for review,
// and on the folders that contain it (like Git's markers). Shared by inline edit and,
// later, agent-mode review.

import * as vscode from "vscode";

/** Theme colour id contributed in package.json ("contributes.colors"). */
const PENDING_COLOR = "moon.pendingChangesForeground";
const BADGE = "●";

export class PendingChangesDecorations implements vscode.FileDecorationProvider, vscode.Disposable {
  private readonly pending = new Map<string, vscode.Uri>();
  private readonly changed = new vscode.EventEmitter<vscode.Uri[]>();
  readonly onDidChangeFileDecorations = this.changed.event;
  private readonly registration = vscode.window.registerFileDecorationProvider(this);

  /** Marks or unmarks a file as having changes waiting for review. */
  set(uri: vscode.Uri, hasPending: boolean): void {
    const key = uri.toString();
    if (hasPending === this.pending.has(key)) return;
    if (hasPending) this.pending.set(key, uri);
    else this.pending.delete(key);
    this.changed.fire([uri]);
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (!this.pending.has(uri.toString())) return undefined;
    const decoration = new vscode.FileDecoration(BADGE, "Moon: changes waiting for your review", new vscode.ThemeColor(PENDING_COLOR));
    decoration.propagate = true; // the folders above get the dot too
    return decoration;
  }

  dispose(): void {
    const uris = [...this.pending.values()];
    this.pending.clear();
    this.changed.fire(uris);
    this.registration.dispose();
    this.changed.dispose();
  }
}
