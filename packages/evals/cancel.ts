// Cancel eval (docs/architecture.md section 5): press Stop at different moments of a real
// agent run and check that it left nothing behind.
//
// Moments: while the model is thinking, while the scout subagent works, while an approval card
// is open, while a command runs, while the review is open, and TrueForge cancelling the turn
// itself while a command runs (the second stop path).
// Stop is done in the extension's order: kill the command, cancel the TrueForge turn, delete
// the hidden copy. After each stop:
// - the project is unchanged (`git status` on a fresh checkout is empty);
// - the hidden copy is deleted;
// - no process of the stopped command is left;
// - the chat answers a new message (the panel is usable at once).
//
// Usage (from packages/evals): pnpm cancel [--only <moment>] [--trace]

import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { AgentRun, TrueForgeClient, modelRef, type AgentChat, type ApprovalAnswer, type MoonEvent } from "@moon/core";
import { flag, freshCheckout, gitBaseline, gitStatus, loadConfig, processesWith, saveResults, startLive, type Live } from "./runner";

type Moment = "thinking" | "scout" | "approval" | "command" | "review" | "trueforge-cancel";

const MOMENTS: Moment[] = ["thinking", "scout", "approval", "command", "review", "trueforge-cancel"];

/** How long to let things run before stopping, and how long to wait for each step (ms). */
const TIMING = {
  thinkingAfterSession: 1500,
  commandRunning: 3000,
  reachTimeout: 180000,
  processGone: 10000,
  usableTimeout: 90000,
};

const TASK_B =
  "Add a flask config CLI command that prints the app config as JSON with secret values masked. It should appear in flask --help, have tests, and be documented.";

function requestFor(moment: Moment, marker: string): string {
  if (moment === "thinking" || moment === "scout") return TASK_B;
  if (moment === "review") {
    return "This is a test of Stop. Create the new file notes/stop-test.txt containing the word hello (report it with report_context first), then call apply_changes.";
  }
  return `This is a test of Stop. Do not look at any files and do not edit anything. Call run_command once with exactly this command: node -e "setTimeout(()=>{},120000)" ${marker}`;
}

interface MomentResult {
  moment: Moment;
  /** The run reached the moment and was stopped there. */
  reached: boolean;
  /** Stop pressed -> the turn reported "cancelled" (ms). */
  stopToCancelledMs?: number;
  projectUnchanged: boolean;
  copyDeleted: boolean;
  leftoverProcesses: number[];
  /** For the command moments: the command was recorded as cancelled. */
  commandCancelled?: boolean;
  /** For the command moments: the command was really running when Stop was pressed. */
  commandWasRunning?: boolean;
  /** The same chat answered a new message after the stop. */
  chatUsable: boolean;
  pass: boolean;
  note?: string;
  sessionUrl?: string;
}

const trace = flag("trace") === true;

async function main(): Promise<void> {
  const only = flag("only");
  const moments = MOMENTS.filter((m) => typeof only !== "string" || m === only);
  const config = loadConfig();
  const client = new TrueForgeClient(config.trueforge);
  const live = await startLive(config, client);
  const results: MomentResult[] = [];
  try {
    for (const moment of moments) {
      const checkout = freshCheckout("flask");
      gitBaseline(checkout.root);
      try {
        const result = await stopAt(live, checkout.root, moment);
        results.push(result);
        console.log(
          `${moment}: ${result.pass ? "PASS" : "FAIL"} (stop->cancelled ${result.stopToCancelledMs ?? "-"} ms, ` +
            `project ${result.projectUnchanged ? "unchanged" : "CHANGED"}, copy ${result.copyDeleted ? "deleted" : "LEFT"}, ` +
            `processes ${result.leftoverProcesses.length}, chat ${result.chatUsable ? "usable" : "STUCK"})${result.note ? ` - ${result.note}` : ""}`,
        );
      } finally {
        checkout.dispose();
      }
    }
  } finally {
    await live.close();
  }
  const meta = { date: new Date().toISOString(), model: modelRef(config.models.main), platform: process.platform };
  const saved = saveResults("cancel", { ...meta, results }, report(meta, results));
  console.log(`\nReport: ${saved.md}\nData:   ${saved.json}`);
}

async function stopAt(live: Live, root: string, moment: Moment): Promise<MomentResult> {
  const { config, client } = live;
  const marker = `moon-cancel-${moment}-${Date.now()}`;
  const run = await AgentRun.create({ projectRoot: root, config, applyApproved: async () => "Evaluation run: nothing was applied." });
  live.setRun(run);
  const chat = live.newChat();
  const readText = (rel: string) => {
    try {
      return readFileSync(path.join(root, rel), "utf8");
    } catch {
      return null;
    }
  };
  const request = requestFor(moment, marker);
  const pack = await live.assembler.prepare({ root, request, mentions: [], windowTokens: config.context.fallbackContextLength, readText });
  chat.setSessionContext({ openingMessages: [pack.openingMessage], compactAtTokens: pack.compactAtTokens });

  let sessionId: string | undefined;
  let sessionUrl: string | undefined;
  let stoppedAt: number | undefined;
  let cancelledAt: number | undefined;
  let commandWasRunning: boolean | undefined;
  const timers: NodeJS.Timeout[] = [];
  const later = (ms: number, fn: () => void) => timers.push(setTimeout(fn, ms));

  // Moon's Stop, in the extension's order (AgentSession.stop): command, turn, then the copy.
  const stop = (how: "moon" | "trueforge") => {
    if (stoppedAt !== undefined) return;
    stoppedAt = Date.now();
    if (how === "moon") {
      run.stop();
      chat.stop();
    } else if (sessionId) {
      void client.sdk.sessions.cancel(sessionId, {}).catch(() => undefined);
    }
  };

  const emit = (event: MoonEvent) => {
    if (trace && event.type !== "text") console.log("  ", JSON.stringify(event).slice(0, 150));
    if (event.type === "session") {
      sessionId = event.sessionId;
      sessionUrl = event.url;
      if (moment === "thinking") later(TIMING.thinkingAfterSession, () => stop("moon"));
    }
    if (event.type === "tool-call" && event.subagent && moment === "scout") stop("moon");
    if (event.type === "done" && event.status === "cancelled" && stoppedAt !== undefined) cancelledAt ??= Date.now();
  };

  later(TIMING.reachTimeout, () => stop("moon")); // never reached: stop anyway, reported below
  await chat.send(request, emit);
  while (stoppedAt === undefined && chat.waitingFor.length > 0) {
    const waiting = chat.waitingFor;
    if ((moment === "approval" && waiting.some((r) => r.tool === "run_command")) || (moment === "review" && waiting.some((r) => r.tool === "apply_changes"))) {
      stop("moon"); // the card is open; the user presses Stop instead of answering
      break;
    }
    const answers: ApprovalAnswer[] = waiting.map((request) => {
      // As the extension does: an allowed command is recorded, or run_command refuses it.
      if (request.tool === "run_command") run.approvals.grant("run_command", { command: request.args.command, cwd: request.args.cwd });
      return { request, decision: request.tool === "run_command" ? { allow: true } : { allow: false, reason: "Evaluation run: not applied." } };
    });
    if (moment === "command" || moment === "trueforge-cancel") {
      later(TIMING.commandRunning, () => {
        commandWasRunning = processesWith(marker).length > 0;
        stop(moment === "command" ? "moon" : "trueforge");
      });
    }
    await chat.answer(answers, emit);
  }
  const reachedInTime = stoppedAt !== undefined && Date.now() - stoppedAt < TIMING.reachTimeout;
  if (stoppedAt === undefined) stop("moon");
  // A turn waiting for approval has already ended: Stop has no stream to cancel, it is instant.
  if (cancelledAt === undefined && (moment === "approval" || moment === "review")) cancelledAt = stoppedAt;

  // The command must be gone (TrueForge's cancel reaches it through MCP; give it a moment).
  const isCommand = moment === "command" || moment === "trueforge-cancel";
  const deadline = Date.now() + TIMING.processGone;
  // Wait until the process is gone and run_command recorded its (cancelled) result.
  while (isCommand && (processesWith(marker).length > 0 || run.commands.length === 0) && Date.now() < deadline) await sleep(250);
  const leftoverProcesses = processesWith(marker);
  const commandCancelled = isCommand ? run.commands.some((c) => c.cancelled) : undefined;

  for (const t of timers) clearTimeout(t);
  await run.dispose();
  live.setRun(undefined);
  const copyDeleted = !existsSync(run.copy.dir);
  const projectUnchanged = gitStatus(root) === "";
  const chatUsable = await answersAgain(chat);
  for (const pid of leftoverProcesses) killQuietly(pid); // clean up after a failure

  const reached = reachedInTime;
  const pass =
    reached && projectUnchanged && copyDeleted && leftoverProcesses.length === 0 && chatUsable && commandCancelled !== false && commandWasRunning !== false;
  return {
    moment,
    reached,
    stopToCancelledMs: stoppedAt !== undefined && cancelledAt !== undefined ? cancelledAt - stoppedAt : undefined,
    projectUnchanged,
    copyDeleted,
    leftoverProcesses,
    commandCancelled,
    commandWasRunning,
    chatUsable,
    pass,
    note: reached ? undefined : "the run never reached this moment (stopped at the time limit)",
    sessionUrl,
  };
}

/** After a stop the same chat must take a new message and finish it. */
async function answersAgain(chat: AgentChat): Promise<boolean> {
  let status: string | undefined;
  const timer = setTimeout(() => chat.stop(), TIMING.usableTimeout);
  try {
    await chat.send("Stopped. Do not use any tools: reply with just the word OK.", (e) => {
      if (e.type === "done") status = e.status;
    });
    // A run that is gone may still ask for approval of a leftover call: deny and finish.
    while (chat.waitingFor.length > 0) {
      await chat.answer(chat.waitingFor.map((request) => ({ request, decision: { allow: false, reason: "Stopped." } })), (e) => {
        if (e.type === "done") status = e.status;
      });
    }
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
  return status === "done";
}

function report(meta: { date: string; model: string; platform: string }, results: MomentResult[]): string {
  const yes = (b: boolean | undefined) => (b === undefined ? "-" : b ? "yes" : "**NO**");
  const lines = [
    "# Cancel eval",
    "",
    `${meta.date} · model ${meta.model} · ${meta.platform}`,
    "",
    `**${results.filter((r) => r.pass).length}/${results.length} moments passed.**`,
    "",
    "| Stop pressed while | Reached | Stop → cancelled | Project unchanged | Copy deleted | Processes left | Command cancelled | Chat usable after | Result |",
    "|---|---|---|---|---|---|---|---|---|",
  ];
  for (const r of results) {
    lines.push(
      `| ${r.moment} | ${yes(r.reached)} | ${r.stopToCancelledMs ?? "-"} ms | ${yes(r.projectUnchanged)} | ${yes(r.copyDeleted)} | ${r.leftoverProcesses.length} | ${yes(r.commandCancelled)} | ${yes(r.chatUsable)} | ${r.pass ? "PASS" : "FAIL"} |`,
    );
  }
  lines.push("", "Stop order (as in the extension): kill the command, cancel the TrueForge turn, delete the hidden copy.");
  lines.push("`trueforge-cancel`: TrueForge cancels the session itself; Moon's run is not stopped, so the command must be stopped by TrueForge's cancel reaching the tool (second stop path).");
  for (const r of results) if (r.sessionUrl) lines.push(`- ${r.moment}: ${r.sessionUrl}`);
  return `${lines.join("\n")}\n`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function killQuietly(pid: number): void {
  try {
    process.kill(pid);
  } catch {
    // already gone
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
