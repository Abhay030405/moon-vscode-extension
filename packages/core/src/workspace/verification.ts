// Proof, not claims (docs/design-decisions.md sections 12 and 13).
// Moon, not the model, decides whether the agent's change was checked. It uses only facts it
// recorded itself: every edit (file, text before and after, attempt) and every check command
// the agent ran (exit code, output, when). No model call.
//
// The four results:
//   verified        a check ran after the last change and passed
//   failed          a check ran after the last change and failed
//   not-verified    no check could run (environment problem, denied, nothing to test, ...)
//   partly-verified some checks passed and some could not run (or hunks were rejected)

import picomatch from "picomatch";
import type { RunResult } from "../process/runner.js";
import type { MoonConfig } from "../shared/config.js";
import { COMMAND_NOT_FOUND_EXIT_CODES, ENV_REASON_MAX_CHARS } from "../shared/constants.js";
import { diffLines, splitLines } from "./hunks.js";

export type VerificationSettings = MoonConfig["verification"];

/** One change to a file in the hidden copy, as edit_file made it. */
export interface EditEntry {
  /** Project-relative path with "/". */
  rel: string;
  /** The file's text before this edit (null = the edit created it). */
  before: string | null;
  after: string;
  /** Which fix attempt this edit belongs to (1, 2, ...). */
  attempt: number;
  at: number;
}

/** How a check command ended, as Moon reads it. */
export type CheckOutcome = "passed" | "failed" | "environment" | "stopped";

/** One check command (tests, a build) the agent ran. */
export interface CheckEntry {
  command: string;
  exitCode: number | null;
  outcome: CheckOutcome;
  /** "before-change": no code (non-test) file was changed yet, so this ran on the original code. */
  phase: "before-change" | "after-change";
  /** For "environment": the line that shows the environment problem. */
  environmentReason?: string;
  at: number;
}

export type VerificationState = "verified" | "failed" | "not-verified" | "partly-verified";

export interface Verification {
  state: VerificationState;
  /** One plain sentence: why this result. */
  reason: string;
  /** The command the user can run to check, or the one that decided the result. */
  command?: string;
  /** Extra facts, e.g. "failed before the change and passes after it". */
  evidence: string[];
}

export class VerificationTracker {
  /** Every edit in this run, in order (the edit record). */
  readonly edits: EditEntry[] = [];
  /** Every check command in this run, in order. */
  readonly checks: CheckEntry[] = [];
  /** Check commands the user denied. */
  readonly denied: { command: string; at: number }[] = [];
  /** The current fix attempt (starts at 1; a failed check after a code change starts the next). */
  attempt = 1;
  /** Attempts that ended with a failed check. */
  readonly failedAttempts: number[] = [];

  private readonly isCheck: (command: string) => boolean;
  private readonly environmentPatterns: RegExp[];
  private readonly isTestFileGlob: (rel: string) => boolean;
  private readonly isNothingToTestGlob: (rel: string) => boolean;
  private readonly testCheckPatterns: RegExp[];

  constructor(private readonly settings: VerificationSettings) {
    const checkPatterns = settings.checkCommandPatterns.map((p) => new RegExp(p, "i"));
    this.isCheck = (command) => checkPatterns.some((p) => p.test(command));
    this.environmentPatterns = settings.environmentErrorPatterns.map((p) => new RegExp(p, "i"));
    const globOptions = { dot: true, nocase: true };
    this.isTestFileGlob = picomatch(settings.testFileGlobs, globOptions);
    this.isNothingToTestGlob = picomatch(settings.nothingToTestGlobs, globOptions);
    this.testCheckPatterns = settings.testCheckPatterns.map((p) => new RegExp(p));
  }

  isCheckCommand(command: string): boolean {
    return this.isCheck(command);
  }

  isTestFile(rel: string): boolean {
    return this.isTestFileGlob(rel);
  }

  /** Called by edit_file after every change it wrote to the copy. */
  recordEdit(rel: string, before: string | null, after: string): void {
    this.edits.push({ rel, before, after, attempt: this.attempt, at: Date.now() });
  }

  /** The user denied a command (the review then says what could not run, and why). */
  recordDenied(command: string): void {
    if (this.isCheck(command)) this.denied.push({ command, at: Date.now() });
  }

  /**
   * Called after every command. Returns a note for the agent when the command was a check
   * (what Moon recorded), or undefined for other commands.
   */
  recordCommand(result: RunResult): string | undefined {
    if (!this.isCheck(result.command)) return undefined;
    const phase = this.codeChangedInAttempt() ? "after-change" : "before-change";
    const { outcome, environmentReason } = this.classify(result);
    this.checks.push({ command: result.command, exitCode: result.exitCode, outcome, phase, environmentReason, at: Date.now() });

    if (outcome === "environment") {
      return (
        `[Moon: this check could not run because of the environment (${environmentReason}). That is not a failed ` +
        "attempt: do not change code because of it and do not retry it. Finish the change and say it is not verified.]"
      );
    }
    if (outcome === "failed" && phase === "after-change") {
      this.failedAttempts.push(this.attempt);
      const used = this.failedAttempts.length;
      this.attempt++;
      const left = this.settings.maxAttempts - used;
      return left > 0
        ? `[Moon: attempt ${used} failed this check. If the failure comes from your change, you have ${left} more attempt(s) and ` +
            "the next one must use a different approach. If only tests unrelated to your task fail (for example one that needs a " +
            "secret file left out of your copy), do not change code for them: run just the tests for your change.]"
        : `[Moon: ${used} attempts failed. Stop changing code and ask the user with ask_user_question: what you tried in each ` +
            "attempt, why it still fails, and a few other ways you could try.]";
    }
    if (outcome === "failed") return "[Moon: recorded as the result on the original code (before your change).]";
    return undefined;
  }

  /** True when a code (non-test) file was changed in the current attempt. */
  private codeChangedInAttempt(): boolean {
    return this.edits.some((e) => e.attempt === this.attempt && !this.isTestFileGlob(e.rel));
  }

  private classify(result: RunResult): { outcome: CheckOutcome; environmentReason?: string } {
    if (result.cancelled || result.timedOut) return { outcome: "stopped" };
    if (result.exitCode === 0) return { outcome: "passed" };
    if (result.exitCode !== null && COMMAND_NOT_FOUND_EXIT_CODES.includes(result.exitCode)) {
      return { outcome: "environment", environmentReason: "the command was not found" };
    }
    for (const line of result.output.split(/\r?\n/)) {
      if (this.environmentPatterns.some((p) => p.test(line))) {
        return { outcome: "environment", environmentReason: line.trim().slice(0, ENV_REASON_MAX_CHARS) };
      }
    }
    return { outcome: "failed" };
  }

  /**
   * The result for the review screen. `changed` is every file the agent changed (from the copy),
   * `rejectedHunks` how many hunks the user rejected (0 before the review).
   */
  result(changed: readonly string[], rejectedHunks = 0): Verification {
    const evidence: string[] = [];
    if (changed.length === 0) return { state: "not-verified", reason: "Nothing was changed.", evidence };
    if (changed.every((rel) => this.isNothingToTestGlob(rel))) {
      return { state: "not-verified", reason: "Nothing to test: only documentation or settings changed.", evidence };
    }
    const lastEdit = this.edits.at(-1)?.at ?? 0;
    const after = this.checks.filter((c) => c.at >= lastEdit);
    const last = after.at(-1);

    if (!last) {
      const denied = this.denied.filter((d) => d.at >= lastEdit).at(-1);
      if (denied) return { state: "not-verified", reason: "You denied the check command, so it did not run.", command: denied.command, evidence };
      const earlier = this.checks.at(-1);
      if (earlier) {
        return { state: "not-verified", reason: "Files were changed after the last check, so it no longer counts.", command: earlier.command, evidence };
      }
      return { state: "not-verified", reason: "The agent ran no tests or checks.", evidence };
    }

    const before = this.checks.find((c) => c.phase === "before-change" && c.command === last.command && c.outcome === "failed");
    if (last.outcome === "passed" && before) evidence.push("It failed on the original code and passes after the change.");
    const untested = after.filter((c) => c.outcome === "environment" || c.outcome === "stopped");

    if (last.outcome === "failed") {
      return { state: "failed", reason: `The check failed after the last change (exit ${String(last.exitCode)}).`, command: last.command, evidence };
    }
    if (last.outcome === "environment") {
      return { state: "not-verified", reason: `The check could not run: ${last.environmentReason}.`, command: last.command, evidence };
    }
    if (last.outcome === "stopped") {
      return { state: "not-verified", reason: "The check was stopped before it finished.", command: last.command, evidence };
    }
    // Passed.
    if (untested.length > 0) {
      return {
        state: "partly-verified",
        reason: `The check passed, but ${untested.length} other check(s) could not run.`,
        command: untested.at(-1)!.command,
        evidence,
      };
    }
    if (rejectedHunks > 0) {
      return {
        state: "partly-verified",
        reason: `The check passed on all the changes, but ${rejectedHunks} change(s) were rejected, so the result may be out of date.`,
        command: last.command,
        evidence,
      };
    }
    return { state: "verified", reason: "The check passed after the last change.", command: last.command, evidence };
  }

  /**
   * Hunks in test files that remove test checks (assertions, test functions) without adding as
   * many back: the review flags them, since weakening a test can make a broken change look fine.
   */
  weakenedTests(files: readonly { rel: string; baseText: string | null; newText: string | null }[]): { rel: string; text: string }[] {
    const warnings: { rel: string; text: string }[] = [];
    const count = (lines: readonly string[]) => lines.filter((l) => this.testCheckPatterns.some((p) => p.test(l))).length;
    for (const file of files) {
      if (!this.isTestFileGlob(file.rel) || file.baseText === null) continue;
      if (file.newText === null) {
        warnings.push({ rel: file.rel, text: "deletes a test file" });
        continue;
      }
      const hunks = diffLines(splitLines(file.baseText), splitLines(file.newText));
      const removed = hunks.reduce((n, h) => n + count(h.oldLines), 0);
      const added = hunks.reduce((n, h) => n + count(h.newLines), 0);
      if (removed > added) warnings.push({ rel: file.rel, text: `removes ${removed - added} test check(s) (assertions or tests): check the tests were not weakened` });
    }
    return warnings;
  }
}

/** The result as the line the agent reads (in apply_changes' report). */
export function verificationText(v: Verification): string {
  const label = { verified: "Verified", failed: "Failed", "not-verified": "Not verified", "partly-verified": "Partly verified" }[v.state];
  const parts = [`Moon's check result: ${label}. ${v.reason}`];
  if (v.command) parts.push(`Command: ${v.command}`);
  parts.push(...v.evidence);
  if (v.state !== "verified") {
    parts.push('Do not say the change is fixed or working: say it is not verified, why, and the command the user can run to check.');
  }
  return parts.join("\n");
}
