// The memory of one conversation in the Moon panel (Phase 6B):
// - its work record (what was read, run, applied, undone, decided), saved after every change;
// - its labels in TrueForge (status, and the summary for the history list);
// - the note added to the next message after Stop or when the chat is continued later, with
//   the files that changed on disk since the agent read them;
// - the memory tools' hooks (work_log, save_summary, list_past_sessions, read_past_session).
//
// Conversations the user picked themselves (continued from the history) are "named": reading
// them needs no approval. Any other past conversation is read only after the recall card.

import {
  CHARS_PER_TOKEN,
  LABELS,
  TRUEFORGE_LABEL_MAX,
  labelValue,
  listConversations,
  readTranscript,
  searchConversations,
  staleFiles,
  summaryLabels,
  transcriptText,
  updateLabels,
  type ConversationInfo,
  type MemoryHooks,
  type MoonConfig,
  type MoonEvent,
  type RunResult,
  type WorkRecord,
} from "@moon/core";
import type * as vscode from "vscode";
import type { MoonService } from "./moon-service.js";

export class ConversationMemory {
  /** Conversations the user picked: read_past_session needs no approval for them. */
  readonly named = new Set<string>();
  private sessionId: string | undefined;
  private summarySaved = false;
  /** Why the next message needs the "where we are" note (undefined = it doesn't). */
  private pendingNote: "stopped" | "failed" | "resumed" | undefined;

  private constructor(
    readonly id: string,
    readonly record: WorkRecord,
    private readonly service: MoonService,
    private readonly config: MoonConfig,
    private readonly root: string,
    private readonly output: vscode.OutputChannel,
  ) {}

  static async open(id: string, service: MoonService, config: MoonConfig, root: string, output: vscode.OutputChannel): Promise<ConversationMemory> {
    return new ConversationMemory(id, await service.records.load(id), service, config, root, output);
  }

  /** A conversation continued from the history: the next message carries the record. */
  resumed(sessionId: string | undefined): void {
    this.sessionId = sessionId;
    this.named.add(this.id);
    this.pendingNote = "resumed";
  }

  stopped(): void {
    this.pendingNote = "stopped";
  }

  // ---- what happened ----

  request(text: string, model: string): void {
    this.summarySaved = false;
    this.record.request(text, model);
    this.save();
  }

  observe(event: MoonEvent, model: string): void {
    if (event.type === "session") this.sessionId = event.sessionId;
    this.record.observe(event, model);
    if (event.type === "tool-call" || event.type === "model-switch") this.save();
    if (event.type === "done" && event.status !== "paused") {
      this.save();
      if (event.status === "error") this.pendingNote = "failed";
      const status = event.status === "done" ? "done" : event.status === "cancelled" ? "stopped" : "failed";
      void this.finishTask(status);
    }
  }

  command(result: RunResult): void {
    this.record.command(result, this.settings().commandTailChars);
    this.save();
  }

  apply(files: { path: string; accepted: number; rejected: number }[]): void {
    this.record.apply(files);
    this.save();
  }

  undo(files: string[]): void {
    this.record.undo(files);
    this.save();
  }

  decision(text: string): void {
    this.record.decision(text);
    this.save();
  }

  // ---- what the agent is told ----

  /** The note for the next message: after Stop or a resume, or when tracked files changed on disk. */
  async noteForNextMessage(): Promise<string | undefined> {
    const settings = this.settings();
    let stale: string[] = [];
    try {
      stale = await staleFiles(this.root, this.record.trackedFiles(), settings.staleCheckMaxFiles);
    } catch (err) {
      this.output.appendLine(`[memory] could not check files on disk: ${(err as Error).message}`);
    }
    const reason = this.pendingNote;
    this.pendingNote = undefined;
    if (reason) return this.record.resumeNote(reason, stale, settings.workLogMaxTokens);
    if (stale.length === 0) return undefined;
    return `[Moon] Files that changed on disk since you read or applied them (read them again before editing): ${stale.join(", ")}`;
  }

  /** The record for a new session after a model switch. */
  workNote(): string | undefined {
    return this.record.resumeNote("switched", [], this.settings().workLogMaxTokens);
  }

  /** The past conversation behind a read_past_session call, for the recall card. */
  async findPast(id: string): Promise<ConversationInfo | undefined> {
    return (await this.pastConversations()).find((c) => c.id === id);
  }

  hooks(): MemoryHooks {
    return {
      workLog: () => this.record.view(this.settings().workLogMaxTokens),
      saveSummary: async (summary) => {
        this.summarySaved = true;
        await this.label(summaryLabels(summary));
      },
      listPast: async (query, limit) => {
        const found = searchConversations(await this.pastConversations(), query).slice(0, limit);
        if (found.length === 0) return query ? `No earlier conversation in this project matches "${query}".` : "No earlier conversations in this project.";
        return found
          .map((c) => [`id: ${c.id}`, `  ${c.title} (${c.updatedAt.slice(0, 16).replace("T", " ")}, ${c.status}, ${c.model})`, ...c.summary.filter(Boolean).map((s) => `  ${s}`)].join("\n"))
          .join("\n");
      },
      readPast: async (id, part) => {
        const past = await this.findPast(id);
        if (!past) return `No earlier conversation with id ${id} in this project.`;
        const maxTokens = this.settings().readPastMaxTokens;
        if (part === "summary") return [past.title, ...past.summary.filter(Boolean)].join("\n");
        if (part === "work") return (await this.service.records.load(id)).view(maxTokens);
        const { client } = this.service.history();
        return transcriptText(await readTranscript(client, past), maxTokens * CHARS_PER_TOKEN);
      },
    };
  }

  // ---- helpers ----

  /** After each task: the status label, and a summary built from the record if the agent saved none. */
  private async finishTask(status: "done" | "stopped" | "failed"): Promise<void> {
    const labels: Record<string, string> = { [LABELS.status]: status };
    if (!this.summarySaved) {
      const [one, two] = this.record.fallbackSummary(TRUEFORGE_LABEL_MAX);
      labels[LABELS.summary1] = labelValue(one);
      labels[LABELS.summary2] = labelValue(two);
    }
    await this.label(labels);
  }

  private async label(labels: Record<string, string>): Promise<void> {
    if (!this.sessionId) return;
    try {
      await updateLabels(this.service.history().client, this.sessionId, labels);
    } catch (err) {
      this.output.appendLine(`[memory] could not label the session: ${(err as Error).message}`);
    }
  }

  private async pastConversations(): Promise<ConversationInfo[]> {
    const { client, project } = this.service.history();
    return (await listConversations(client, project, this.config.memory.historyPageSize)).filter((c) => c.id !== this.id);
  }

  private settings(): MoonConfig["memory"] {
    return this.config.memory;
  }

  private save(): void {
    this.service.records.save(this.id, this.record).catch((err: Error) => this.output.appendLine(`[memory] could not save the work record: ${err.message}`));
  }
}
