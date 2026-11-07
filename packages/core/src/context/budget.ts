// Token budgets. Counting is approximate (characters / CHARS_PER_TOKEN): budgets only need to
// be roughly right, and a real tokenizer would depend on the model.

import type { MoonConfig } from "../shared/config.js";
import { CHARS_PER_TOKEN } from "../shared/constants.js";

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** The project map's budget: a share of the model's window, between a minimum and a maximum. */
export function mapBudget(windowTokens: number, settings: MoonConfig["context"]): number {
  const share = Math.round(windowTokens * settings.mapBudgetRatio);
  return Math.min(settings.mapBudgetMaxTokens, Math.max(settings.mapBudgetMinTokens, share));
}

/** When TrueForge should compact the conversation (same window number as the map budget). */
export function compactionTokens(windowTokens: number, settings: MoonConfig["context"]): number {
  return Math.round(windowTokens * settings.compactionRatio);
}

/** Cuts text to about `maxTokens`, at a line break, and says so. */
export function cutToTokens(text: string, maxTokens: number): { text: string; cut: boolean } {
  const maxChars = maxTokens * CHARS_PER_TOKEN;
  if (text.length <= maxChars) return { text, cut: false };
  const head = text.slice(0, maxChars);
  const lastBreak = head.lastIndexOf("\n");
  return { text: lastBreak > 0 ? head.slice(0, lastBreak) : head, cut: true };
}
