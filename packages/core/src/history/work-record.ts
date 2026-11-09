// The work record of one conversation: what the agent and the user actually did, so the agent
// never loses track (after Stop, a model switch, compaction, or when a chat is continued later).
//
// Built from what Moon already sees: the turn events (tool calls with their arguments), the
// commands the run finished, and the user's decisions (applies, undos, approvals, answers).
// It never holds file contents: only paths, line ranges, short command endings and decisions.
//
// Like Cline's file context tracker and Claude Code's read-before-edit check, the record also
// knows which files were read or applied, so Moon can tell the agent which of them changed on
// disk since (see staleness.ts).

import { CHARS_PER_TOKEN, TRUEFORGE_ASK_USER_TOOL } from "../shared/constants.js";
import type { RunResult } from "../process/runner.js";
import type { MoonEvent } from "../trueforge/events.js";

export type TurnEnd = "done" | "stopped" | "failed" | "switched" | "waiting";

export type WorkEntry =
  | { kind: "request"; text: string; model: string; at: number }
  | { kind: "read"; path: string; range?: string; at: number }
  | { kind: "search"; what: string; at: number }
  | { kind: "edit"; path: string; at: number }
  | { kind: "command"; command: string; exitCode: number | null; cancelled: boolean; timedOut: boolean; tail: string; at: number }
  | { kind: "apply"; files: { path: string; accepted: number; rejected: number }[]; at: number }
  | { kind: "undo"; files: string[]; at: number }
  | { kind: "decision"; text: string; at: number }
  | { kind: "turn"; end: TurnEnd; model: string; at: number };

/** Tools that only look (their calls count as searches in the record). */
const LOOKING_TOOLS = new Set(["search_text", "find_definition", "find_usages", "list_files", "get_errors"]);

export class WorkRecord {
  private readonly entries: WorkEntry[];

  constructor(entries: readonly WorkEntry[] = []) {
    this.entries = [...entries];
  }

  get all(): readonly WorkEntry[] {
    return this.entries;
  }

  /** How the last turn ended (undefined before the first turn ends). */
  get lastTurnEnd(): TurnEnd | undefined {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i]!;
      if (e.kind === "turn") return e.end;
      if (e.kind === "request") return undefined;
    }
    return undefined;
  }

  /** The user's request that started a task (one per message sent). */
  request(text: string, model: string, at = Date.now()): void {
    this.entries.push({ kind: "request", text, model, at });
  }

  /** One event of the running turn: tool calls are recorded, and how the turn ended. */
  observe(event: MoonEvent, model: string, at = Date.now()): void {
    if (event.type === "tool-call") return this.toolCall(event.tool, event.args, at);
    if (event.type === "model-switch" && event.direction === "fallback") {
      this.entries.push({ kind: "turn", end: "switched", model: event.from, at });
      return;
    }
    if (event.type !== "done") return;
    const end: TurnEnd = event.status === "done" ? "done" : event.status === "paused" ? "waiting" : event.status === "cancelled" ? "stopped" : "failed";
    // A paused turn continues after the user's answer: only its final end is recorded.
    if (end !== "waiting") this.entries.push({ kind: "turn", end, model, at });
  }

  command(result: RunResult, tailChars: number, at = Date.now()): void {
    const tail = result.output.length > tailChars ? `…${result.output.slice(-tailChars)}` : result.output;
    this.entries.push({ kind: "command", command: result.command, exitCode: result.exitCode, cancelled: result.cancelled, timedOut: result.timedOut, tail: tail.trim(), at });
  }

  apply(files: { path: string; accepted: number; rejected: number }[], at = Date.now()): void {
    this.entries.push({ kind: "apply", files, at });
  }

  undo(files: string[], at = Date.now()): void {
    this.entries.push({ kind: "undo", files, at });
  }

  decision(text: string, at = Date.now()): void {
    this.entries.push({ kind: "decision", text, at });
  }

  /** Files the agent read or the user applied, with the last time: the ones to check on disk. */
  trackedFiles(): Map<string, number> {
    const files = new Map<string, number>();
    for (const e of this.entries) {
      if (e.kind === "read") files.set(e.path, e.at);
      if (e.kind === "apply") for (const f of e.files) if (f.accepted > 0) files.set(f.path, e.at);
    }
    return files;
  }

  /**
   * The record as text for the agent, newest work last, cut to about `maxTokens`
   * (the oldest requests are dropped first, so what was done last is always there).
   */
  view(maxTokens: number): string {
    const tasks = this.tasks();
    if (tasks.length === 0) return "Nothing has been done in this conversation yet.";
    const parts = tasks.map((task, i) => describeTask(task, i + 1));
    const maxChars = maxTokens * CHARS_PER_TOKEN;
    let kept = parts;
    while (kept.length > 1 && kept.join("\n\n").length > maxChars) kept = kept.slice(1);
    const dropped = parts.length - kept.length;
    const head = dropped > 0 ? `(${dropped} earlier request${dropped === 1 ? "" : "s"} not shown)\n\n` : "";
    const text = head + kept.join("\n\n");
    return text.length > maxChars ? `${text.slice(0, maxChars)}\n(cut to fit)` : text;
  }

  /**
   * A short note for the next message after something broke the agent's thread: Stop, a model
   * switch, or a chat continued later. Undefined when there is nothing worth saying.
   */
  resumeNote(reason: "stopped" | "failed" | "switched" | "resumed", stale: readonly string[], maxTokens: number): string | undefined {
    const tasks = this.tasks();
    if (tasks.length === 0 && stale.length === 0) return undefined;
    const lines: string[] = [];
    if (reason === "stopped") lines.push("[Moon] The user pressed Stop during your last turn. What you had done in it is below; anything you edited then was discarded with the working copy, so redo edits you still need.");
    if (reason === "failed") lines.push("[Moon] Your last turn ended with an error before you finished. What you had done is below. Your working copy still has your edits (list_pending_changes shows them): continue from where you stopped, do not start over.");
    if (reason === "switched") lines.push("[Moon] Moon switched models, so this is a new session for you. This is what was done earlier in this conversation:");
    if (reason === "resumed") lines.push("[Moon] The user is continuing this conversation later. Your working copy is new (a fresh copy of the project). This is what was done before:");
    if (tasks.length > 0) lines.push(this.view(maxTokens));
    if (stale.length > 0) lines.push(`Files that changed on disk since you read or applied them (read them again before editing): ${stale.join(", ")}`);
    lines.push("Call work_log any time for this record.");
    return lines.join("\n\n");
  }

  /**
   * Two short lines for the history list when the agent saved no summary itself (a stopped or
   * failed task): the request, then what came of it. Built from the record only (no model call).
   */
  fallbackSummary(maxChars: number): [string, string] {
    const tasks = this.tasks();
    const last = tasks.at(-1);
    if (!last) return ["", ""];
    const applied = [...new Set(tasks.flatMap((t) => t.applied))];
    const commands = tasks.flatMap((t) => t.commands);
    const failing = commands.filter((c) => c.exitCode !== 0).length;
    const outcome = last.end === "done" ? "finished" : last.end === "stopped" ? "stopped by the user" : last.end === "failed" ? "failed" : "unfinished";
    const second = [
      outcome,
      applied.length > 0 ? `applied ${applied.slice(0, 3).join(", ")}${applied.length > 3 ? ` +${applied.length - 3}` : ""}` : "nothing applied",
      commands.length > 0 ? `${commands.length} command${commands.length === 1 ? "" : "s"}${failing ? ` (${failing} failed)` : ""}` : "",
    ].filter(Boolean).join("; ");
    return [cut(tasks[0]!.request, maxChars), cut(second, maxChars)];
  }

  private toolCall(tool: string, args: Record<string, unknown>, at: number): void {
    const path = typeof args.path === "string" ? args.path : undefined;
    if (tool === "read_file" && path) {
      const start = typeof args.start_line === "number" ? args.start_line : undefined;
      const end = typeof args.end_line === "number" ? args.end_line : undefined;
      this.entries.push({ kind: "read", path, range: start ? `${start}${end ? `-${end}` : ""}` : undefined, at });
    } else if (tool === "edit_file" && path) {
      this.entries.push({ kind: "edit", path, at });
    } else if (LOOKING_TOOLS.has(tool)) {
      const what = String(args.query ?? args.name ?? args.glob ?? args.path ?? tool);
      this.entries.push({ kind: "search", what: `${tool} ${what}`, at });
    } else if (tool === TRUEFORGE_ASK_USER_TOOL && typeof args.question === "string") {
      this.entries.push({ kind: "decision", text: `you asked: ${args.question}`, at });
    }
    // run_command is recorded when it finishes (command()), apply_changes when the user
    // decides (apply()); other tools add nothing the record needs.
  }

  /** The entries grouped by user request. */
  private tasks(): Task[] {
    const tasks: Task[] = [];
    let task: Task | undefined;
    for (const e of this.entries) {
      if (e.kind === "request") {
        task = { request: e.text, model: e.model, reads: new Map(), searches: 0, edits: new Set(), commands: [], applied: [], rejected: [], undone: [], decisions: [], end: undefined };
        tasks.push(task);
        continue;
      }
      if (!task) continue;
      if (e.kind === "read") task.reads.set(e.path, e.range ? `${task.reads.get(e.path) ? `${task.reads.get(e.path)}, ` : ""}${e.range}` : (task.reads.get(e.path) ?? ""));
      if (e.kind === "search") task.searches++;
      if (e.kind === "edit") task.edits.add(e.path);
      if (e.kind === "command") task.commands.push(e);
      if (e.kind === "apply") {
        for (const f of e.files) {
          if (f.accepted > 0) task.applied.push(f.path);
          if (f.rejected > 0) task.rejected.push(f.path);
        }
      }
      if (e.kind === "undo") task.undone.push(...e.files);
      if (e.kind === "decision") task.decisions.push(e.text);
      if (e.kind === "turn") {
        task.end = e.end;
        task.model = e.model;
      }
    }
    return tasks;
  }
}

interface Task {
  request: string;
  model: string;
  /** path -> line ranges read ("" = from the start). */
  reads: Map<string, string>;
  searches: number;
  edits: Set<string>;
  commands: Extract<WorkEntry, { kind: "command" }>[];
  applied: string[];
  rejected: string[];
  undone: string[];
  decisions: string[];
  end: TurnEnd | undefined;
}

function describeTask(task: Task, n: number): string {
  const end = task.end === "done" ? "finished" : task.end === "stopped" ? "stopped by the user" : task.end === "failed" ? "failed" : task.end === "switched" ? "moved to the other model" : "in progress";
  const lines = [`${n}. Request: ${cut(task.request, 300)} (${end})`];
  if (task.reads.size > 0) lines.push(`   Read: ${[...task.reads].map(([p, r]) => (r ? `${p} (lines ${r})` : p)).join(", ")}`);
  if (task.searches > 0) lines.push(`   Searches: ${task.searches}`);
  if (task.edits.size > 0) lines.push(`   Edited in the working copy: ${[...task.edits].join(", ")}`);
  for (const c of task.commands) {
    const result = c.cancelled ? "stopped" : c.timedOut ? "timed out" : `exit ${c.exitCode}`;
    lines.push(`   Ran: ${c.command} (${result})${c.tail ? `\n      ...${cut(c.tail.split("\n").slice(-3).join(" / "), 200)}` : ""}`);
  }
  if (task.applied.length > 0) lines.push(`   Applied to the user's files: ${[...new Set(task.applied)].join(", ")}`);
  if (task.rejected.length > 0) lines.push(`   Rejected by the user (some or all changes): ${[...new Set(task.rejected)].join(", ")}`);
  if (task.undone.length > 0) lines.push(`   Undone by the user: ${[...new Set(task.undone)].join(", ")}`);
  for (const d of task.decisions) lines.push(`   Decision: ${cut(d, 200)}`);
  return lines.join("\n");
}

function cut(text: string, max: number): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}
