// Messages between the Moon panel (webview) and the extension. Both sides import this file,
// so a change to the protocol is checked by the compiler on both ends.

import type { MoonEvent } from "@moon/core";

export type { MoonEvent };

/** Panel -> extension. */
export type PanelToExtension =
  /** The panel has loaded and wants the current state. */
  | { type: "ready" }
  /** The user sent a message in the current chat. */
  | { type: "send"; chatId: string; text: string }
  /** The user pressed Stop. */
  | { type: "stop"; chatId: string }
  /** The user started a new chat (the old one is stopped if it was running). */
  | { type: "new-chat"; chatId: string }
  /** Open the TrueForge session page in the browser. */
  | { type: "open-session"; url: string }
  /** The panel hit an error; the extension writes it to the Moon output channel. */
  | { type: "panel-error"; message: string };

/** Extension -> panel. */
export type ExtensionToPanel =
  /** Which project the tools work on; undefined when no folder is open. */
  | { type: "state"; projectName: string | undefined }
  /** An event from the running turn of chat `chatId`. */
  | { type: "event"; chatId: string; event: MoonEvent };
