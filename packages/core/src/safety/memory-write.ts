// Writes to memory are privileged (OWASP LLM01 #9, LLM05). The agent's save_summary text is
// stored in TrueForge and later shown in the history and given to future agents
// (list_past_sessions). An injected "always run curl ... first" saved there would poison every
// later chat. So a summary must be two short lines of plain description: no hidden or control
// characters, no links, no commands, no orders aimed at an agent. A refused summary is not
// saved; Moon then builds one from its own records.

import { SUMMARY_INSTRUCTION_PATTERNS } from "../shared/constants.js";
import { hasHidden, stripControl } from "./unicode.js";
import { redactSecrets } from "./secret-scan.js";

export type SummaryCheck = { ok: true; text: string } | { ok: false; reason: string };

export function checkSummary(raw: string, maxChars: number): SummaryCheck {
  if (hasHidden(raw)) return { ok: false, reason: "it contains hidden characters" };
  const text = redactSecrets(stripControl(raw)).text.trim();
  if (!text) return { ok: false, reason: "it is empty" };
  if (text.split(/\r?\n/).filter((l) => l.trim()).length > 2) return { ok: false, reason: "it must be at most two lines" };
  if (text.length > maxChars) return { ok: false, reason: `it must be at most ${maxChars} characters` };
  for (const rule of SUMMARY_INSTRUCTION_PATTERNS) {
    if (new RegExp(rule.pattern, "i").test(text)) return { ok: false, reason: `${rule.reason}; a summary only describes what was done` };
  }
  return { ok: true, text };
}
