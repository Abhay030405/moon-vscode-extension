// Moon's chat history, read from TrueForge (its sessions are the store; see labels.ts).
//
// - list: this project's agent sessions (one filtered sessions.list), grouped into
//   conversations; the newest session of a conversation holds its current title, summary,
//   status and model. TrueForge cannot search text, so Moon filters titles and summaries itself.
// - transcript: the user's messages and the agent's answers, rebuilt from the stored events.
// - labels: PATCH merges Moon's labels into the session's metadata.

import type { TrueForgeApi } from "@truefoundry/trueforge-sdk";
import type { TrueForgeClient } from "../trueforge/client.js";
import { describeToolCall } from "../trueforge/events.js";
import { TRUEFORGE_LIST_PAGE_MAX } from "../shared/constants.js";
import { LABELS, type ConversationStatus } from "./labels.js";

export interface ConversationSession {
  id: string;
  model: string;
  createdAt: string;
  updatedAt: string;
  lastTurnId: string | undefined;
}

export interface ConversationInfo {
  /** Moon's conversation id (moon.conversation). */
  id: string;
  title: string;
  summary: [string, string];
  status: ConversationStatus;
  model: string;
  createdAt: string;
  updatedAt: string;
  /** Hidden copy kept for an unfinished review (moon.reviewCopy), if any. */
  reviewCopy: string | undefined;
  /** Its TrueForge sessions, newest first. */
  sessions: ConversationSession[];
}

/** One line of a past conversation, for the read-only view and read_past_session. */
export type TranscriptItem = { role: "user" | "agent"; text: string } | { role: "step"; action: string; target: string };

/** This project's conversations, newest first (at most `maxSessions` sessions are read). */
export async function listConversations(client: TrueForgeClient, project: string, maxSessions: number): Promise<ConversationInfo[]> {
  const sessions: TrueForgeApi.Session[] = [];
  const page = await client.sdk.sessions.list({ metadata: { [LABELS.project]: project, [LABELS.kind]: "agent" }, order: "desc", limit: Math.min(maxSessions, TRUEFORGE_LIST_PAGE_MAX) });
  for await (const session of page) {
    sessions.push(session);
    if (sessions.length >= maxSessions) break;
  }
  const byConversation = new Map<string, TrueForgeApi.Session[]>();
  for (const s of sessions) {
    const id = s.metadata?.[LABELS.conversation];
    if (!id) continue;
    byConversation.set(id, [...(byConversation.get(id) ?? []), s]);
  }
  const list: ConversationInfo[] = [];
  for (const [id, group] of byConversation) {
    group.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const newest = group[0]!;
    const labels = newest.metadata ?? {};
    // Title and summary may sit on an older session (a switch started a new one): take the newest that has them.
    const pick = (key: string) => group.map((s) => s.metadata?.[key]).find((v) => v) ?? "";
    list.push({
      id,
      title: pick(LABELS.title) || "(untitled)",
      summary: [pick(LABELS.summary1), pick(LABELS.summary2)],
      status: (labels[LABELS.status] as ConversationStatus | undefined) ?? "active",
      model: labels[LABELS.model] ?? "",
      createdAt: group.at(-1)!.createdAt,
      updatedAt: newest.updatedAt,
      reviewCopy: labels[LABELS.reviewCopy] || undefined,
      sessions: group.map((s) => ({
        id: s.id,
        model: s.metadata?.[LABELS.model] ?? "",
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        lastTurnId: s.lastTurnDetails?.id,
      })),
    });
  }
  return list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Conversations whose title or summary contains every word of `query` (any case). */
export function searchConversations(list: readonly ConversationInfo[], query: string | undefined): ConversationInfo[] {
  const words = (query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...list];
  return list.filter((c) => {
    const text = `${c.title} ${c.summary.join(" ")}`.toLowerCase();
    return words.every((w) => text.includes(w));
  });
}

/** Merges labels into a session's metadata (TrueForge replaces the whole map on PATCH). */
export async function updateLabels(client: TrueForgeClient, sessionId: string, labels: Record<string, string>): Promise<void> {
  const current = await client.sdk.sessions.get(sessionId);
  const merged = { ...(current.data.metadata ?? {}), ...labels };
  for (const [k, v] of Object.entries(merged)) if (v === "") delete merged[k];
  await client.sdk.sessions.update(sessionId, { metadata: merged });
}

/** Deletes every TrueForge session of a conversation. */
export async function deleteConversation(client: TrueForgeClient, conversation: ConversationInfo): Promise<void> {
  for (const s of conversation.sessions) await client.sdk.sessions.delete(s.id);
}

/**
 * The conversation's messages and tool steps, oldest first, rebuilt from TrueForge's stored
 * events (main thread only; Moon's opening messages are in the agent spec, not in turns).
 */
export async function readTranscript(client: TrueForgeClient, conversation: ConversationInfo): Promise<TranscriptItem[]> {
  const items: TranscriptItem[] = [];
  for (const session of [...conversation.sessions].reverse()) {
    const page = await client.sdk.sessions.listEvents(session.id, session.lastTurnId ? { lastTurnId: session.lastTurnId } : {});
    const events: TrueForgeApi.SessionEvent[] = [];
    for await (const { event } of page) events.push(event);
    // TrueForge lists the newest first (seen on 0.184): put them in the order they happened.
    events.sort((a, b) => eventTime(a).localeCompare(eventTime(b)));
    for (const event of events) {
      if (event.type === "turn.created") {
        for (const input of event.input ?? []) {
          if (input.type === "user.message") items.push({ role: "user", text: contentText(input.content) });
          // The user's answer to the agent's question (ask_user_question).
          if (input.type === "user.tool_response") items.push({ role: "step", action: "You answered", target: contentText(input.content) });
        }
      }
      if (event.type === "model.message" && event.threadId === "main") {
        const text = contentText(event.content ?? "");
        if (text.trim()) items.push({ role: "agent", text });
        for (const call of event.toolCalls ?? []) {
          const step = describeToolCall(call.function.name, call.function.arguments ?? "");
          items.push({ role: "step", action: step.action, target: step.target });
        }
      }
    }
  }
  return items;
}

/** A transcript as plain text, cut to `maxChars` from the end (the latest part matters most). */
export function transcriptText(items: readonly TranscriptItem[], maxChars: number): string {
  const lines = items.map((i) => (i.role === "step" ? `  - ${i.action} ${i.target}` : `${i.role === "user" ? "User" : "Agent"}: ${i.text}`));
  const text = lines.join("\n");
  return text.length > maxChars ? `(earlier part cut)\n${text.slice(-maxChars)}` : text;
}

function eventTime(event: TrueForgeApi.SessionEvent): string {
  return "createdAt" in event && typeof event.createdAt === "string" ? event.createdAt : "";
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((c) => (c && typeof c === "object" && "text" in c && typeof c.text === "string" ? c.text : "")).join("");
  }
  return "";
}
