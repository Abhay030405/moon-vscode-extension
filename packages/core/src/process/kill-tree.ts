// Stops a command and every process it started (pytest can start helpers).
// - Windows: taskkill /T ends the whole tree (/F: console programs ignore polite requests).
// - macOS/Linux: the command runs in its own process group; SIGTERM the group, then SIGKILL
//   after the grace period if anything is still alive.

import { execFile } from "node:child_process";

export async function killTree(pid: number, graceMs: number): Promise<void> {
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      execFile("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }, () => resolve());
    });
    return;
  }
  if (!signalGroup(pid, "SIGTERM")) return;
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, Math.min(100, graceMs)));
    if (!isGroupAlive(pid)) return;
  }
  signalGroup(pid, "SIGKILL");
}

function signalGroup(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pid, signal); // negative pid = the whole process group
    return true;
  } catch {
    return false; // already gone
  }
}

function isGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}
