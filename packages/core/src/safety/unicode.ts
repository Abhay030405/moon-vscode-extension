// Characters you can't see (OWASP LLM01 #5, LLM10 #8).
// - Hidden characters (tag block U+E0000-E007F, variation selectors, zero-width, bidi controls)
//   can carry instructions to the model, or make an approval card or a diff look different
//   from what will really run ("Trojan Source"). Moon makes them VISIBLE, as ⟦U+202E⟧, instead
//   of deleting them, so nothing is silently changed and the user and the agent both see them.
// - Terminal control sequences (ANSI colours, OSC links, bell, backspace, lone carriage
//   return) in command output can hide or overwrite text: they are removed.

import { HIDDEN_CHAR_RANGES } from "../shared/constants.js";

const HIDDEN = new RegExp(`[${HIDDEN_CHAR_RANGES.join("")}]`, "gu");
/** ESC [ ... (CSI), ESC ] ... BEL/ST (OSC), other ESC sequences, and C0 controls except tab and newline. */
const CONTROL = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(\u0007|\u001b\\)|\u001b[@-Z\\-_]|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]|\r(?!\n)/g;

/** Marks every hidden character as ⟦U+XXXX⟧. `count` is how many there were. */
export function revealHidden(text: string): { text: string; count: number } {
  let count = 0;
  const out = text.replace(HIDDEN, (ch) => {
    count++;
    return `⟦U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}⟧`;
  });
  return { text: out, count };
}

/** True if `text` holds a hidden character. */
export function hasHidden(text: string): boolean {
  HIDDEN.lastIndex = 0;
  const found = HIDDEN.test(text);
  HIDDEN.lastIndex = 0;
  return found;
}

/** True when `text` carries a ⟦U+...⟧ mark made by revealHidden (edit_file must not write it back). */
export function hasRevealMarker(text: string): boolean {
  return /⟦U\+[0-9A-F]{4,6}⟧/.test(text);
}

/** Removes terminal control sequences (keeps tabs and newlines; CRLF stays a line break). */
export function stripControl(text: string): string {
  return text.replace(CONTROL, "");
}
