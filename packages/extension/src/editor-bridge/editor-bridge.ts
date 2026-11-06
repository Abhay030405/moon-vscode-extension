// Gives Moon's tools what only the editor knows: unsaved text of open files and the
// problems VS Code reports (red and yellow underlines).

import * as path from "node:path";
import * as vscode from "vscode";
import type { EditorBridge, EditorDiagnostic } from "@moon/core";

const SEVERITY: Record<vscode.DiagnosticSeverity, EditorDiagnostic["severity"]> = {
  [vscode.DiagnosticSeverity.Error]: "error",
  [vscode.DiagnosticSeverity.Warning]: "warning",
  [vscode.DiagnosticSeverity.Information]: "info",
  [vscode.DiagnosticSeverity.Hint]: "hint",
};

export class VsCodeEditorBridge implements EditorBridge {
  constructor(private readonly root: string) {}

  openText(abs: string): string | undefined {
    return findOpenDocument(abs)?.getText();
  }

  diagnostics(rel?: string): EditorDiagnostic[] {
    const entries: [vscode.Uri, readonly vscode.Diagnostic[]][] =
      rel === undefined
        ? vscode.languages.getDiagnostics()
        : [[vscode.Uri.file(path.join(this.root, rel)), vscode.languages.getDiagnostics(vscode.Uri.file(path.join(this.root, rel)))]];
    const result: EditorDiagnostic[] = [];
    for (const [uri, list] of entries) {
      if (uri.scheme !== "file") continue;
      const fileRel = path.relative(this.root, uri.fsPath);
      if (fileRel.startsWith("..") || path.isAbsolute(fileRel)) continue; // outside the project
      for (const d of list) {
        result.push({
          path: fileRel.split(path.sep).join("/"),
          line: d.range.start.line + 1,
          column: d.range.start.character + 1,
          severity: SEVERITY[d.severity],
          message: d.message,
          source: d.source,
        });
      }
    }
    return result;
  }
}

/** The open document for a file path, if any (case-insensitive on Windows). */
export function findOpenDocument(abs: string): vscode.TextDocument | undefined {
  const norm = (p: string) => (process.platform === "win32" ? path.normalize(p).toLowerCase() : path.normalize(p));
  const want = norm(abs);
  return vscode.workspace.textDocuments.find((doc) => doc.uri.scheme === "file" && norm(doc.uri.fsPath) === want);
}
