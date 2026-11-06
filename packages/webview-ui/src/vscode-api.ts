// The bridge to the extension. acquireVsCodeApi() may only be called once per page.

import type { ExtensionToPanel, PanelToExtension } from "./protocol/messages";

interface VsCodeApi {
  postMessage(message: PanelToExtension): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();

export function postToExtension(message: PanelToExtension): void {
  vscode.postMessage(message);
}

export function onExtensionMessage(listener: (message: ExtensionToPanel) => void): () => void {
  const handler = (e: MessageEvent<ExtensionToPanel>) => listener(e.data);
  window.addEventListener("message", handler);
  return () => window.removeEventListener("message", handler);
}
