import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { PanelErrorBoundary } from "./notices/PanelErrorBoundary";
import { postToExtension } from "./vscode-api";
import "./styles/global.css";

// Errors outside React's drawing (event handlers, promises) are reported too.
window.addEventListener("error", (e) => postToExtension({ type: "panel-error", message: String(e.error?.stack ?? e.message) }));
window.addEventListener("unhandledrejection", (e) =>
  postToExtension({ type: "panel-error", message: String(e.reason?.stack ?? e.reason) }),
);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <PanelErrorBoundary>
      <App />
    </PanelErrorBoundary>
  </StrictMode>,
);
