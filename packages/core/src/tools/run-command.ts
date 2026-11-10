// run_command: runs a shell command in the agent's working copy (tests, linters, the CLI).
// TrueForge pauses it for the user's approval first (agents/moon-agent.json).

import * as path from "node:path";
import { z } from "zod";
import { buildCommandEnv, runCommand } from "../process/runner.js";
import { allowedEnv } from "../safety/command-env.js";
import { checkCommand } from "../safety/command-policy.js";
import { stripControl } from "../safety/unicode.js";
import { wrapUntrusted } from "../safety/untrusted-text.js";
import { ToolError } from "./context.js";
import { defineTool } from "./tool.js";

export const runCommandTool = defineTool({
  name: "run_command",
  title: "Run command",
  description:
    "Run a shell command (for example the project's tests) in your working copy of the project. The user approves " +
    "each command first. Returns the exit code and the end of the output. Keep commands focused (run the relevant " +
    "tests, not everything). Commands cannot reach the user's real files.",
  input: {
    command: z.string().min(1).describe("The command line, e.g. `python -m pytest tests/test_cli.py -q`."),
    cwd: z.string().optional().describe("Folder to run in, relative to the project root. Default: the project root."),
  },
  readOnly: false,
  async run(ctx, args, signal) {
    const run = ctx.agentRun;
    if (!run) throw new ToolError("run_command only works in agent mode.");
    // Complete mediation: only a call the user approved, with exactly these arguments, runs.
    if (!run.approvals.consume("run_command", { command: args.command, cwd: args.cwd })) {
      ctx.audit?.({ kind: "blocked", detail: "run_command without the user's approval", tool: "run_command" });
      throw new ToolError("This command was not approved by the user, so it was not run. Ask again through run_command.");
    }
    // Blocked commands never run, even when approved (defence in depth; the card refuses them first).
    const verdict = checkCommand(args.command, ctx.security, false);
    if (verdict.blocked) {
      ctx.audit?.({ kind: "blocked", detail: verdict.blocked, tool: "run_command" });
      throw new ToolError(`Moon blocked this command: ${verdict.blocked}.`);
    }
    const cwd = args.cwd ? ctx.paths.resolve(args.cwd).abs : run.copy.dir;
    const settings = ctx.runSettings;

    // Either Stop (the run's signal) or TrueForge cancelling the call stops the command.
    const stop = new AbortController();
    const onStop = () => stop.abort();
    run.signal.addEventListener("abort", onStop, { once: true });
    signal?.addEventListener("abort", onStop, { once: true });
    if (run.signal.aborted || signal?.aborted) stop.abort();
    let result;
    try {
      result = await runCommand({
        command: args.command,
        cwd,
        // Only allowed variables (no tokens or keys), plus Moon's commandEnv (safety/command-env.ts).
        env: buildCommandEnv(allowedEnv(process.env, ctx.security), settings.commandEnv, { copy: run.copy.dir, project: run.copy.projectRoot }),
        timeoutMs: settings.commandTimeoutMs,
        maxOutputChars: settings.commandOutputMaxChars,
        killGraceMs: settings.killGraceMs,
        signal: stop.signal,
      });
    } finally {
      run.signal.removeEventListener("abort", onStop);
      signal?.removeEventListener("abort", onStop);
    }
    result = { ...result, output: stripControl(result.output) };
    run.onCommand?.(result);

    const status = result.cancelled
      ? "Stopped by the user."
      : result.timedOut
        ? `Timed out after ${settings.commandTimeoutMs} ms and was stopped.`
        : `Exit code ${result.exitCode}.`;
    const notes: string[] = [];
    if (result.truncated) notes.push(`[Only the last ${settings.commandOutputMaxChars} characters of output are shown.]`);
    // Safeguard: tests should load the copy. If the output names the real project's folder but
    // not the copy's, the command probably used the user's files instead (e.g. an editable install).
    if (mentions(result.output, run.copy.projectRoot) && !mentions(result.output, run.copy.dir)) {
      notes.push(
        "[Warning: the output refers to the user's real project folder, not your working copy, so this command " +
          "may have run the original code. Check agentRun.commandEnv (e.g. PYTHONPATH) in Moon's config.]",
      );
    }
    const body = result.output.trim() ? wrapUntrusted(`command output: ${args.command}`, result.output.trimEnd()) : "(no output)";
    return ctx.capOutput([`$ ${args.command}`, `${status} (${result.durationMs} ms)`, body, ...notes].join("\n"));
  },
  describe: (args) => ({ action: "Run", target: args.command ?? "" }),
});

function mentions(output: string, folder: string): boolean {
  const norm = (s: string) => s.replaceAll("\\", "/").toLowerCase();
  return norm(output).includes(norm(path.resolve(folder)));
}
