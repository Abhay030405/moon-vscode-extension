// Moon's labels on TrueForge sessions (session metadata). They make TrueForge the store of
// Moon's chat history: every session says which project and which Moon conversation it belongs
// to, so the history list is one filtered `sessions.list`, with no database of Moon's own.
//
// One Moon conversation can span several TrueForge sessions (a model fallback starts a new
// session), so sessions are grouped by `moon.conversation`. TrueForge allows at most
// TRUEFORGE_LABEL_MAX characters per value (checked on 0.184), so the two-line summary is two
// labels.

import { createHash, randomUUID } from "node:crypto";
import * as path from "node:path";
import { TRUEFORGE_LABEL_MAX } from "../shared/constants.js";

export const LABELS = {
  project: "moon.project",
  conversation: "moon.conversation",
  kind: "moon.kind",
  model: "moon.model",
  status: "moon.status",
  title: "moon.title",
  summary1: "moon.summary.1",
  summary2: "moon.summary.2",
  /** Folder name (inside the runs folder) of a hidden copy kept for an unfinished review. */
  reviewCopy: "moon.reviewCopy",
} as const;

/** agent = the panel's chats (listed in /resume); inline = inline edits; probe = background model checks. */
export type SessionKind = "agent" | "inline" | "probe";

/** How the conversation's last task ended (shown in the history list). */
export type ConversationStatus = "active" | "done" | "stopped" | "failed" | "review-pending";

/** The project's key: the same folder always gives the same key (case-insensitive on Windows). */
export function projectKey(root: string): string {
  const normal = path.resolve(root).replaceAll("\\", "/").replace(/\/+$/, "");
  return createHash("sha1").update(process.platform === "win32" ? normal.toLowerCase() : normal).digest("hex").slice(0, 16);
}

export function newConversationId(): string {
  return randomUUID();
}

/** A label value TrueForge accepts: one line, at most TRUEFORGE_LABEL_MAX characters. */
export function labelValue(text: string): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > TRUEFORGE_LABEL_MAX ? `${one.slice(0, TRUEFORGE_LABEL_MAX - 1)}…` : one;
}

/** The labels a new session starts with. */
export function sessionLabels(input: { project: string; conversation: string; kind: SessionKind; model: string; title: string }): Record<string, string> {
  const labels: Record<string, string> = {
    [LABELS.project]: input.project,
    [LABELS.conversation]: input.conversation,
    [LABELS.kind]: input.kind,
    [LABELS.model]: labelValue(input.model),
    [LABELS.status]: "active",
  };
  if (input.title.trim()) labels[LABELS.title] = labelValue(input.title);
  return labels;
}

/** Splits a summary into the two label lines (first two non-empty lines). */
export function summaryLabels(summary: string): Record<string, string> {
  const [one = "", two = ""] = summary.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return { [LABELS.summary1]: labelValue(one), [LABELS.summary2]: labelValue(two) };
}
