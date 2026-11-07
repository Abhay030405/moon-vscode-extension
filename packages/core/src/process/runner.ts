// Runs one command for the agent, in the hidden copy, through the system shell.
// - Working folder: the copy (or a folder inside it).
// - Environment: the current one plus agentRun.commandEnv (placeholders filled in).
// - Output: stdout and stderr together; only the last part is kept (errors are usually at the end).
// - Stop (abort signal) or timeout kills the command and everything it started.

import { spawn } from "node:child_process";
import * as path from "node:path";
import { killTree } from "./kill-tree.js";

export interface RunOptions {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  /** Keep only the last this-many characters of output. */
  maxOutputChars: number;
  killGraceMs: number;
  signal?: AbortSignal;
}

export interface RunResult {
  command: string;
  /** null when the command was killed. */
  exitCode: number | null;
  output: string;
  /** True when earlier output was dropped to stay within maxOutputChars. */
  truncated: boolean;
  timedOut: boolean;
  cancelled: boolean;
  durationMs: number;
}

export function runCommand(options: RunOptions): Promise<RunResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    let output = "";
    let truncated = false;
    let timedOut = false;
    let cancelled = false;
    let killing: Promise<void> | undefined;

    const child = spawn(options.command, {
      cwd: options.cwd,
      env: options.env,
      shell: true,
      windowsHide: true,
      // Own process group on macOS/Linux, so the whole group can be killed.
      detached: process.platform !== "win32",
    });

    const append = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.length > options.maxOutputChars) {
        output = output.slice(output.length - options.maxOutputChars);
        truncated = true;
      }
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);

    const kill = () => {
      if (!killing && child.pid !== undefined) killing = killTree(child.pid, options.killGraceMs);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, options.timeoutMs);
    const onAbort = () => {
      cancelled = true;
      kill();
    };
    if (options.signal?.aborted) onAbort();
    options.signal?.addEventListener("abort", onAbort, { once: true });

    let finished = false;
    const finish = (exitCode: number | null, error?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (error) append(Buffer.from(`\n${error.message}`));
      resolve({
        command: options.command,
        exitCode: timedOut || cancelled ? null : exitCode,
        output,
        truncated,
        timedOut,
        cancelled,
        durationMs: Date.now() - started,
      });
    };
    child.on("error", (err) => finish(null, err));
    child.on("close", (code) => finish(code));
  });
}

/**
 * The environment for a command: the current one plus `extra`, where values may use
 * {copy}, {project}, {pathSep} and {env:NAME}. On Windows, names match case-insensitively
 * (so "PATH" replaces the existing "Path" instead of adding a second one).
 */
export function buildCommandEnv(
  base: NodeJS.ProcessEnv,
  extra: Readonly<Record<string, string>>,
  places: { copy: string; project: string },
): NodeJS.ProcessEnv {
  const win = process.platform === "win32";
  const env: NodeJS.ProcessEnv = { ...base };
  const keyOf = (name: string) =>
    win ? (Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase()) ?? name) : name;
  for (const [name, template] of Object.entries(extra)) {
    // Paths in the setting use "/"; on Windows they become "\" (the {env:...} values are left as they are).
    const parts = template.split(/(\{env:[^}]+\})/);
    const value = parts
      .map((part) => {
        const envRef = /^\{env:([^}]+)\}$/.exec(part);
        if (envRef) return env[keyOf(envRef[1]!)] ?? "";
        const filled = part
          .replaceAll("{copy}", places.copy)
          .replaceAll("{project}", places.project)
          .replaceAll("{pathSep}", path.delimiter);
        return win ? filled.replaceAll("/", "\\") : filled;
      })
      .join("");
    env[keyOf(name)] = value;
  }
  return env;
}
