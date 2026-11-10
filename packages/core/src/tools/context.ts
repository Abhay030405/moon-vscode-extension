// What every tool needs: the project folder (behind the path guard), the secret guard,
// and the limits from config. Plus a safe file walker shared by the tools.

import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import * as path from "node:path";
import { PathGuard } from "../safety/path-guard.js";
import { SecretGuard } from "../safety/secret-guard.js";
import type { MoonConfig } from "../shared/config.js";
import { BINARY_SNIFF_BYTES } from "../shared/constants.js";
import type { RunResult } from "../process/runner.js";
import type { ApprovalLedger } from "../safety/approval-ledger.js";
import type { AuditEntry } from "../safety/audit-log.js";
import { hasRedactionMarker } from "../safety/secret-scan.js";
import { hasRevealMarker } from "../safety/unicode.js";
import type { ShadowCopy } from "../workspace/shadow-copy.js";

export class ToolError extends Error {
  override readonly name = "ToolError";
}

/** A problem the editor reports for a file (VS Code's Problems panel). */
export interface EditorDiagnostic {
  /** Project-relative path. */
  path: string;
  /** 1-based. */
  line: number;
  column: number;
  severity: "error" | "warning" | "info" | "hint";
  message: string;
  source?: string;
}

/** What the editor tells the tools. Without it (tests, evals) tools use the files on disk. */
export interface EditorBridge {
  /** Text of the file as open in the editor, including unsaved changes; undefined if not open. */
  openText(abs: string): string | undefined;
  /** Problems for one file (project-relative), or for every open file when `rel` is undefined. */
  diagnostics(rel?: string): EditorDiagnostic[];
}

/** What agent-mode tools need from the running agent run (set only on agent mode's tool context). */
export interface AgentRunHooks {
  /** The hidden copy the agent works in (also this context's root). */
  copy: ShadowCopy;
  /**
   * The user's approvals of tool calls that change things (recorded by the extension when the
   * user clicks Allow). run_command runs only with a matching approval (complete mediation).
   */
  approvals: ApprovalLedger;
  /** Called after every change to the copy (edit_file). */
  onEdit?(): void;
  /** Aborted when the user presses Stop: kills a running command. */
  signal: AbortSignal;
  /** Every finished command, for the review screen's test results. */
  onCommand?(result: RunResult): void;
  /**
   * Runs after the user approved apply_changes in TrueForge: writes the accepted changes to
   * the real project and returns the report the agent sees (applied and rejected hunks).
   */
  applyApproved(summary: string): Promise<string>;
}

/** The running inline edit: the one file propose_edit may change, and where the proposal goes. */
export interface InlineTarget {
  /** Project-relative path of the file being edited. */
  rel: string;
  /** Receives the full proposed text. Called on every successful propose_edit (last one wins). */
  onProposal(proposedText: string): void;
}

/**
 * The conversation's memory, set by agent mode on the run's context: the work record
 * (work_log), the agent's summary (save_summary) and earlier conversations of this project
 * (list_past_sessions / read_past_session).
 */
export interface MemoryHooks {
  /** This conversation's work record as text. */
  workLog(): string;
  /** The agent's two-line summary of the finished task, for the history list. */
  saveSummary(summary: string): Promise<void>;
  /** This project's earlier conversations whose title or summary matches the query. */
  listPast(query: string | undefined, limit: number): Promise<string>;
  /** One earlier conversation: its summary, its work record, or its transcript. */
  readPast(id: string, part: "summary" | "work" | "transcript"): Promise<string>;
}

export class ToolContext {
  readonly paths: PathGuard;
  readonly secrets: SecretGuard;
  readonly limits: MoonConfig["tools"];
  private readonly ignoredDirs: Set<string>;
  /** Set by the VS Code extension. */
  editor: EditorBridge | undefined;
  /** Set only while an inline edit runs. */
  inlineTarget: InlineTarget | undefined;
  /** Set only on agent mode's context, for the run it belongs to. */
  agentRun: AgentRunHooks | undefined;
  /** Set only on agent mode's context: this conversation's memory. */
  memory: MemoryHooks | undefined;
  readonly runSettings: MoonConfig["agentRun"];
  readonly security: MoonConfig["security"];
  /** Moon's security log, when the extension keeps one (never given file contents or secrets). */
  audit: ((entry: AuditEntry) => void) | undefined;
  /**
   * True once the agent called report_context in this run. edit_file waits for it, so the user
   * always sees which files the agent chose (and why) before the first change.
   */
  contextReported = false;
  /** True while a plan from propose_plan waits for the user: edit_file is refused until it is approved. */
  planWaiting = false;

  constructor(root: string, config: Pick<MoonConfig, "tools" | "safety" | "agentRun" | "security">) {
    this.security = config.security;
    this.paths = new PathGuard(root);
    this.secrets = new SecretGuard(config.safety);
    this.limits = config.tools;
    this.runSettings = config.agentRun;
    this.ignoredDirs = new Set(config.tools.ignoredDirs);
  }

  /** Resolves a path for reading and refuses secret files. */
  resolveReadable(input: string): { abs: string; rel: string } {
    const resolved = this.paths.resolve(input);
    if (this.secrets.isSecret(resolved.rel)) {
      throw new ToolError(`"${resolved.rel}" may contain secrets (keys, passwords), so Moon's tools do not read it.`);
    }
    return resolved;
  }

  /**
   * Text of a readable file: the editor's (unsaved) text when it is open, else the file on disk.
   * Refuses missing, too large and binary files with a ToolError.
   */
  readText(abs: string, rel: string): string {
    const open = this.editor?.openText(abs);
    if (open !== undefined) return open;
    let size: number;
    try {
      const stat = statSync(abs);
      if (!stat.isFile()) throw new ToolError(`"${rel}" is not a file.`);
      size = stat.size;
    } catch (err) {
      if (err instanceof ToolError) throw err;
      throw new ToolError(`File not found: ${rel}`);
    }
    if (size > this.limits.maxFileBytes) {
      throw new ToolError(`"${rel}" is too large to read (${size} bytes). Use search_text to find the part you need.`);
    }
    if (looksBinary(abs)) throw new ToolError(`"${rel}" looks like a binary file.`);
    return readFileSync(abs, "utf8");
  }

  /**
   * Yields project-relative file paths under `startRel`, skipping ignored folders,
   * secret files and symlinks (never followed, so the walk can't leave the project).
   */
  *walkFiles(startRel = ""): Generator<string> {
    const start = this.paths.resolve(startRel);
    const stack: string[] = [start.abs];
    while (stack.length > 0) {
      const dir = stack.pop()!;
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue; // unreadable folder: skip
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      const subdirs: string[] = [];
      for (const entry of entries) {
        const abs = path.join(dir, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          if (!this.ignoredDirs.has(entry.name)) subdirs.push(abs);
          continue;
        }
        if (!entry.isFile()) continue;
        const rel = this.paths.toRel(abs);
        if (!this.secrets.isSecret(rel)) yield rel;
      }
      // Reverse so folders come out in alphabetical order from the stack.
      for (const sub of subdirs.reverse()) stack.push(sub);
    }
  }

  /** True when the file is small enough and not binary, so it is worth searching. */
  isSearchableText(abs: string): boolean {
    try {
      if (statSync(abs).size > this.limits.maxFileBytes) return false;
      return !looksBinary(abs);
    } catch {
      return false;
    }
  }

  /**
   * Refuses text an edit would write when it carries a marker Moon put in a tool result (a
   * redacted secret or a ⟦U+...⟧ hidden character): writing it back would destroy the real value.
   */
  checkWritable(text: string): void {
    if (hasRedactionMarker(text) || hasRevealMarker(text)) {
      throw new ToolError(
        "This edit contains a marker Moon put in place of a secret («secret redacted: ...») or a hidden character (⟦U+...⟧). " +
          "Leave those lines as they are: change the code around them, or ask the user to edit them.",
      );
    }
  }

  /** Caps a tool result at tools.maxOutputChars, saying so when it cut. */
  capOutput(text: string): string {
    const max = this.limits.maxOutputChars;
    if (text.length <= max) return text;
    return `${text.slice(0, max)}\n[... output cut at ${max} characters. Narrow the request to see more.]`;
  }
}

function looksBinary(abs: string): boolean {
  const fd = openSync(abs, "r");
  try {
    const buffer = Buffer.alloc(BINARY_SNIFF_BYTES);
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, read).includes(0);
  } finally {
    closeSync(fd);
  }
}
