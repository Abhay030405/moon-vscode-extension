// The bridge to the extension. acquireVsCodeApi() may only be called once per page.

import type { ExtensionToPanel, PanelToExtension } from "./protocol/messages";

interface VsCodeApi {
  postMessage(message: PanelToExtension): void;
  getState(): unknown;
  setState(state: unknown): void;
}

/** What the panel remembers across reloads (VS Code keeps it with the view). */
export interface SavedPanelState {
  conversationId?: string;
}

declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();

export function postToExtension(message: PanelToExtension): void {
  vscode.postMessage(message);
}

export function savedState(): SavedPanelState {
  const state = vscode.getState();
  return state && typeof state === "object" ? (state as SavedPanelState) : {};
}

export function saveState(state: SavedPanelState): void {
  vscode.setState(state);
}

export function onExtensionMessage(listener: (message: ExtensionToPanel) => void): () => void {
  const handler = (e: MessageEvent<ExtensionToPanel>) => listener(e.data);
  window.addEventListener("message", handler);
  return () => window.removeEventListener("message", handler);
}
