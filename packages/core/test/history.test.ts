import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  LABELS,
  WorkRecord,
  WorkRecordStore,
  labelValue,
  projectKey,
  searchConversations,
  sessionLabels,
  staleFiles,
  summaryLabels,
  type ConversationInfo,
  type RunResult,
} from "../src/index.js";

const step = { action: "Read", target: "" };
const command = (cmd: string, exitCode: number, output = ""): RunResult => ({
  command: cmd,
  exitCode,
  output,
  truncated: false,
  timedOut: false,
  cancelled: false,
  durationMs: 1,
});

function sampleRecord(): WorkRecord {
  const r = new WorkRecord();
  r.request("add a flask config command", "anthropic/claude");
  r.observe({ type: "tool-call", id: "1", tool: "read_file", step, subagent: false, args: { path: "src/flask/cli.py", start_line: 1, end_line: 80 } }, "m");
  r.observe({ type: "tool-call", id: "2", tool: "search_text", step, subagent: false, args: { query: "routes_command" } }, "m");
  r.observe({ type: "tool-call", id: "3", tool: "edit_file", step, subagent: false, args: { path: "src/flask/cli.py" } }, "m");
  r.command(command("pytest tests/test_cli.py", 1, "line\n".repeat(50) + "1 failed"), 40);
  r.apply([{ path: "src/flask/cli.py", accepted: 2, rejected: 1 }]);
  r.observe({ type: "done", status: "cancelled" }, "anthropic/claude");
  return r;
}

describe("work record", () => {
  it("groups what was done by request", () => {
    const view = sampleRecord().view(1000);
    expect(view).toContain("1. Request: add a flask config command (stopped by the user)");
    expect(view).toContain("Read: src/flask/cli.py (lines 1-80)");
    expect(view).toContain("Searches: 1");
    expect(view).toContain("Edited in the working copy: src/flask/cli.py");
    expect(view).toContain("Ran: pytest tests/test_cli.py (exit 1)");
    expect(view).toContain("1 failed");
    expect(view).toContain("Applied to the user's files: src/flask/cli.py");
    expect(view).toContain("Rejected by the user (some or all changes): src/flask/cli.py");
  });

  it("keeps the newest requests when the view is cut", () => {
    const r = new WorkRecord();
    for (let i = 0; i < 50; i++) r.request(`request number ${i} ${"x".repeat(100)}`, "m");
    const view = r.view(200);
    expect(view).toContain("request number 49");
    expect(view).not.toContain("request number 0 ");
    expect(view).toMatch(/earlier requests? not shown/);
  });

  it("writes a note after Stop and lists files changed on disk", () => {
    const note = sampleRecord().resumeNote("stopped", ["src/flask/cli.py"], 1000)!;
    expect(note).toContain("pressed Stop");
    expect(note).toContain("Files that changed on disk since you read or applied them");
    expect(note).toContain("work_log");
    expect(new WorkRecord().resumeNote("resumed", [], 1000)).toBeUndefined();
  });

  it("builds a summary from the record when the agent saved none", () => {
    const [one, two] = sampleRecord().fallbackSummary(128);
    expect(one).toBe("add a flask config command");
    expect(two).toBe("stopped by the user; applied src/flask/cli.py; 1 command (1 failed)");
  });

  it("does not record a paused turn as ended, and tracks read and applied files", () => {
    const r = new WorkRecord();
    r.request("x", "m");
    r.observe({ type: "done", status: "paused" }, "m");
    expect(r.lastTurnEnd).toBeUndefined();
    r.observe({ type: "tool-call", id: "1", tool: "read_file", step, subagent: false, args: { path: "a.py" } }, "m", 10);
    r.apply([{ path: "b.py", accepted: 1, rejected: 0 }, { path: "c.py", accepted: 0, rejected: 2 }], 20);
    expect([...r.trackedFiles()]).toEqual([["a.py", 10], ["b.py", 20]]);
  });

  it("is saved and loaded per conversation", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "moon-record-"));
    try {
      const store = new WorkRecordStore(dir);
      await store.save("abc-123", sampleRecord());
      expect((await store.load("abc-123")).view(1000)).toBe(sampleRecord().view(1000));
      expect((await store.load("missing")).all).toEqual([]);
      expect(() => store.save("../evil", new WorkRecord())).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("staleness", () => {
  let dir: string | undefined;
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

  it("lists files changed or deleted after they were read", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "moon-stale-"));
    writeFileSync(path.join(dir, "same.py"), "a");
    writeFileSync(path.join(dir, "changed.py"), "b");
    const readAt = Date.now() - 60_000;
    utimesSync(path.join(dir, "same.py"), new Date(readAt - 10_000), new Date(readAt - 10_000));
    const tracked = new Map([["same.py", readAt], ["changed.py", readAt], ["gone.py", readAt]]);
    expect((await staleFiles(dir, tracked, 10)).sort()).toEqual(["changed.py", "gone.py (deleted)"]);
  });
});

describe("labels", () => {
  it("keeps every value within TrueForge's limit", () => {
    expect(labelValue("x".repeat(300))).toHaveLength(128);
    expect(labelValue("two\nlines")).toBe("two lines");
    const labels = sessionLabels({ project: "p", conversation: "c", kind: "agent", model: "a/b", title: "" });
    expect(labels).toEqual({ [LABELS.project]: "p", [LABELS.conversation]: "c", [LABELS.kind]: "agent", [LABELS.model]: "a/b", [LABELS.status]: "active" });
    expect(summaryLabels("asked\n\n did it ")).toEqual({ [LABELS.summary1]: "asked", [LABELS.summary2]: "did it" });
  });

  it("gives one project the same key however the path is written", () => {
    expect(projectKey("/work/flask/")).toBe(projectKey("/work/flask"));
    expect(projectKey("/work/flask")).not.toBe(projectKey("/work/other"));
  });

  it("searches titles and summaries for every word", () => {
    const c = (id: string, title: string, summary: [string, string]): ConversationInfo => ({
      id, title, summary, status: "done", model: "", createdAt: "", updatedAt: "", reviewCopy: undefined, sessions: [],
    });
    const list = [c("1", "Add flask config command", ["", ""]), c("2", "Fix debug flag", ["changed helpers.py", "tests pass"])];
    expect(searchConversations(list, "CONFIG").map((x) => x.id)).toEqual(["1"]);
    expect(searchConversations(list, "helpers tests").map((x) => x.id)).toEqual(["2"]);
    expect(searchConversations(list, "")).toHaveLength(2);
  });
});
