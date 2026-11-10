// One agent run: the hidden copy, the tool context pointed at it, the commands it ran, and
// Stop. The extension creates one when agent mode starts working and disposes it after the
// review (applied or discarded) or on Stop; disposing deletes the copy.

import type { RunResult } from "../process/runner.js";
import type { MoonConfig } from "../shared/config.js";
import { SecretGuard } from "../safety/secret-guard.js";
import { ToolContext, type EditorBridge } from "../tools/context.js";
import { buildReview, type FileReview } from "./review.js";
import { ApprovalLedger } from "../safety/approval-ledger.js";
import { ShadowCopy } from "./shadow-copy.js";

export interface AgentRunOptions {
  projectRoot: string;
  config: Pick<MoonConfig, "tools" | "safety" | "agentRun" | "security">;
  editor?: EditorBridge;
  /** Called when the user approved apply_changes; returns the report for the agent. */
  applyApproved(run: AgentRun, summary: string): Promise<string>;
  /** Called after each command finishes (the work record keeps a short note of it). */
  onCommand?(result: RunResult): void;
}

export class AgentRun {
  readonly tools: ToolContext;
  /** Every command the agent ran, in order (test results for the review screen). */
  readonly commands: RunResult[] = [];
  /** The user's approvals for this run (run_command checks it before running anything). */
  readonly approvals: ApprovalLedger;
  /** When the agent last changed a file in the copy (ms); the review shows if tests ran after it. */
  lastEditAt = 0;
  private readonly abort = new AbortController();

  /** Makes the hidden copy (async, so the editor never waits on it) and the run around it. */
  static async create(options: AgentRunOptions): Promise<AgentRun> {
    const secrets = new SecretGuard(options.config.safety);
    const copy = await ShadowCopy.create({
      projectRoot: options.projectRoot,
      ignoredDirs: options.config.tools.ignoredDirs,
      isSecret: (rel) => secrets.isSecret(rel),
      openText: options.editor ? (abs) => options.editor!.openText(abs) : undefined,
      maxFiles: options.config.agentRun.maxCopyFiles,
      maxBytes: options.config.agentRun.maxCopyBytes,
    });
    return new AgentRun(copy, options);
  }

  private constructor(
    readonly copy: ShadowCopy,
    options: AgentRunOptions,
  ) {
    this.tools = new ToolContext(this.copy.dir, options.config);
    this.tools.editor = options.editor;
    this.approvals = new ApprovalLedger(options.config.security.approvalTtlMs);
    this.tools.agentRun = {
      copy: this.copy,
      approvals: this.approvals,
      onEdit: () => {
        this.lastEditAt = Date.now();
      },
      signal: this.abort.signal,
      onCommand: (result) => {
        this.commands.push(result);
        options.onCommand?.(result);
      },
      applyApproved: (summary) => options.applyApproved(this, summary),
    };
  }

  get stopped(): boolean {
    return this.abort.signal.aborted;
  }

  /** Stop: kills a running command. */
  stop(): void {
    this.abort.abort();
  }

  /** The agent's changes, as hunks against the real files now. */
  review(readProjectText: (rel: string) => string | null): FileReview[] {
    return buildReview(this.copy, readProjectText);
  }

  /** Stop (kills a running command), then deletes the hidden copy in the background. */
  dispose(): Promise<void> {
    this.abort.abort();
    return this.copy.dispose();
  }
}

/** Which hunks the user accepted, by file. */
export type HunkDecisions = ReadonlyMap<string, ReadonlySet<number>>;

/**
 * What the agent is told after the review: what was applied and what was rejected (with the
 * first lines of each rejected hunk, so it understands which part the user did not want).
 */
export function reviewReport(files: readonly FileReview[], accepted: HunkDecisions, previewLines: number): string {
  const applied: string[] = [];
  const rejected: string[] = [];
  const skipped: string[] = [];
  for (const file of files) {
    if (file.binary) {
      skipped.push(`${file.rel} (binary file, not applied)`);
      continue;
    }
    if (file.conflict) {
      skipped.push(`${file.rel} (the user changed this file after your copy was made, so it was not applied)`);
      continue;
    }
    const ok = accepted.get(file.rel) ?? new Set<number>();
    const kept = file.hunks.filter((_, i) => ok.has(i)).length;
    if (kept > 0) applied.push(`${file.rel} (${kept} of ${file.hunks.length} change(s))`);
    file.hunks.forEach((hunk, i) => {
      if (ok.has(i)) return;
      const lines = (hunk.newLines.length ? hunk.newLines : hunk.oldLines).slice(0, previewLines);
      const what = hunk.newLines.length ? "adding" : "removing";
      rejected.push(`${file.rel}, change ${i + 1} at line ${hunk.oldStart + 1} (${what}):\n    ${lines.join("\n    ")}`);
    });
  }
  const parts: string[] = [];
  parts.push(applied.length ? `Applied to the user's files:\n- ${applied.join("\n- ")}` : "Nothing was applied.");
  if (rejected.length) parts.push(`Rejected by the user (not applied):\n- ${rejected.join("\n- ")}`);
  if (skipped.length) parts.push(`Not applied:\n- ${skipped.join("\n- ")}`);
  if (rejected.length || skipped.length) {
    parts.push("Your working copy still has every change. Do not re-apply rejected changes unless the user asks.");
  }
  return parts.join("\n\n");
}
