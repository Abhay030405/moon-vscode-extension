import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AGENT_TOOLS,
  AgentRun,
  CONFIG_DIR,
  EXAMPLE_CONFIG_FILE_NAME,
  TurnEventMapper,
  approvalInput,
  buildCommandEnv,
  commandRisks,
  finalText,
  hunkWithContext,
  listChanges,
  loadMoonConfig,
  reviewReport,
  runCommand,
  type MoonConfig,
} from "../src/index.js";

const config: MoonConfig = loadMoonConfig(
  fileURLToPath(new URL(`../../../${CONFIG_DIR}/${EXAMPLE_CONFIG_FILE_NAME}`, import.meta.url)),
);
const node = JSON.stringify(process.execPath);

let project: string;
let run: AgentRun;
const tool = (name: string, args: Record<string, unknown>, signal?: AbortSignal) =>
  AGENT_TOOLS.find((t) => t.name === name)!.run(run.tools, args as never, signal) as Promise<string> | string;
const write = (root: string, rel: string, text: string) => {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  writeFileSync(path.join(root, rel), text);
};
const readProject = (rel: string) => {
  try {
    return readFileSync(path.join(project, rel), "utf8");
  } catch {
    return null;
  }
};

beforeEach(async () => {
  project = mkdtempSync(path.join(tmpdir(), "moon-project-"));
  write(project, "src/app.py", "import os\n\ndef a():\n    return 1\n\ndef b():\n    return 2\n");
  write(project, "src/old.py", "x = 1\n");
  write(project, ".env", "SECRET=1\n");
  write(project, ".git/HEAD", "ref\n");
  write(project, "node_modules/x/index.js", "1\n");
  run = await AgentRun.create({
    projectRoot: project,
    config,
    // The editor has unsaved text for app.py: the copy must use it.
    editor: { openText: (abs) => (abs.endsWith(path.join("src", "old.py")) ? "x = 1  # unsaved\n" : undefined), diagnostics: () => [] },
    applyApproved: async () => "applied",
  });
  // Edits need the chosen files reported first (tested on its own below).
  run.tools.contextReported = true;
});

afterEach(async () => {
  await run.dispose();
  rmSync(project, { recursive: true, force: true });
});

describe("hidden copy", () => {
  it("copies the project outside it, skipping ignored folders and secrets, using unsaved editor text", () => {
    expect(run.copy.dir.startsWith(project)).toBe(false);
    expect(path.basename(run.copy.dir)).toBe(path.basename(project));
    expect(existsSync(path.join(run.copy.dir, "src/app.py"))).toBe(true);
    expect(existsSync(path.join(run.copy.dir, ".env"))).toBe(false);
    expect(existsSync(path.join(run.copy.dir, ".git"))).toBe(false);
    expect(existsSync(path.join(run.copy.dir, "node_modules"))).toBe(false);
    expect(readFileSync(path.join(run.copy.dir, "src/old.py"), "utf8")).toBe("x = 1  # unsaved\n");
    expect(listChanges(run.copy)).toEqual([]);
  });

  it("is deleted on dispose", async () => {
    const dir = run.copy.dir;
    await run.dispose();
    expect(existsSync(dir)).toBe(false);
  });

  it("refuses projects over the file limit", async () => {
    await expect(AgentRun.create({ projectRoot: project, config: { ...config, agentRun: { ...config.agentRun, maxCopyFiles: 1 } }, applyApproved: async () => "" })).rejects.toThrow(/more than 1 files/);
  });
});

describe("agent tools in the copy", () => {
  it("edit_file changes only the copy; list_pending_changes and the review see it", async () => {
    expect(await tool("edit_file", { path: "src/app.py", edits: [{ old_text: "    return 1", new_text: "    return 10" }] })).toMatch(/\+1 -1/);
    expect(await tool("edit_file", { path: "tests/test_new.py", content: "def test():\n    pass\n" })).toMatch(/Created/);
    unlinkSync(path.join(run.copy.dir, "src/old.py"));

    expect(readProject("src/app.py")).toContain("return 1\n"); // real file untouched
    const listed = await tool("list_pending_changes", {});
    expect(listed).toContain("M src/app.py (+1 -1)");
    expect(listed).toContain("A tests/test_new.py (+2 -0)");
    expect(listed).toContain("D src/old.py");
    expect(listChanges(run.copy).map((c) => [c.rel, c.kind])).toEqual([
      ["src/app.py", "modified"],
      ["src/old.py", "deleted"],
      ["tests/test_new.py", "added"],
    ]);
  });

  it("edit_file refuses: both or neither of edits/content, content for an existing file, secrets, outside paths", async () => {
    await expect(async () => tool("edit_file", { path: "src/app.py" })).rejects.toThrow(/either/);
    await expect(async () => tool("edit_file", { path: "src/app.py", content: "x" })).rejects.toThrow(/already exists/);
    await expect(async () => tool("edit_file", { path: ".env", content: "x" })).rejects.toThrow(/secrets/);
    await expect(async () => tool("edit_file", { path: "../escape.py", content: "x" })).rejects.toThrow();
  });

  it("run_command runs in the copy with the configured environment", async () => {
    const out = await tool("run_command", { command: `${node} -e "console.log(process.cwd()); console.log(process.env.MOON_T)"` });
    expect(out).toContain("Exit code 0");
    expect(out.toLowerCase()).toContain(path.resolve(run.copy.dir).toLowerCase());
    expect(run.commands).toHaveLength(1);
  });

  it("run_command warns when the output points at the real project instead of the copy", async () => {
    const out = await tool("run_command", { command: `${node} -e "console.log(${JSON.stringify(project.replaceAll("\\", "/"))})"` });
    expect(out).toContain("may have run the original code");
  });
});

describe("review", () => {
  it("builds hunks against the real files and applies only accepted hunks", async () => {
    await tool("edit_file", {
      path: "src/app.py",
      edits: [
        { old_text: "    return 1", new_text: "    return 10" },
        { old_text: "    return 2", new_text: "    return 20" },
      ],
    });
    await tool("edit_file", { path: "tests/test_new.py", content: "ok\n" });
    const files = run.review(readProject);
    const app = files.find((f) => f.rel === "src/app.py")!;
    expect(app.hunks).toHaveLength(2);
    expect(app.conflict).toBe(false);
    expect(finalText(app, new Set([1]))).toBe("import os\n\ndef a():\n    return 1\n\ndef b():\n    return 20\n");
    expect(finalText(app, new Set())).toBeUndefined();

    const added = files.find((f) => f.rel === "tests/test_new.py")!;
    expect(finalText(added, new Set([0]))).toBe("ok\n");

    const report = reviewReport(files, new Map([["src/app.py", new Set([1])]]), 3);
    expect(report).toContain("src/app.py (1 of 2 change(s))");
    expect(report).toContain("src/app.py, change 1 at line 4 (adding):\n        return 10");
    expect(report).toContain("tests/test_new.py, change 1");
  });

  it("shows each hunk with unchanged lines around it", async () => {
    await tool("edit_file", { path: "src/app.py", edits: [{ old_text: "    return 2", new_text: "    return 20" }] });
    const app = run.review(readProject).find((f) => f.rel === "src/app.py")!;
    expect(hunkWithContext(app, app.hunks[0]!, 1)).toEqual([
      { kind: " ", text: "def b():" },
      { kind: "-", text: "    return 2" },
      { kind: "+", text: "    return 20" },
      { kind: " ", text: "" },
    ]);
  });

  it("marks a file the user edited by hand after the copy as a conflict, and never applies it", async () => {
    await tool("edit_file", { path: "src/app.py", edits: [{ old_text: "    return 1", new_text: "    return 10" }] });
    writeFileSync(path.join(project, "src/app.py"), "hand edited\n");
    const app = run.review(readProject).find((f) => f.rel === "src/app.py")!;
    expect(app.conflict).toBe(true);
    expect(finalText(app, new Set([0]))).toBeUndefined();
  });

  it("deleted files are deleted only when accepted", () => {
    unlinkSync(path.join(run.copy.dir, "src/app.py"));
    // src/old.py differs (unsaved editor text was copied) but the real file on disk is older: a conflict.
    const files = run.review(readProject);
    const app = files.find((f) => f.rel === "src/app.py")!;
    expect(app.kind).toBe("deleted");
    expect(finalText(app, new Set([0]))).toBeNull();
  });
});

describe("runner", () => {
  it("Stop kills the command (and what it started) quickly", async () => {
    const stop = new AbortController();
    const started = Date.now();
    const pending = runCommand({
      command: `${node} -e "setTimeout(() => {}, 60000)"`,
      cwd: project,
      env: process.env,
      timeoutMs: 120000,
      maxOutputChars: 1000,
      killGraceMs: 500,
      signal: stop.signal,
    });
    setTimeout(() => stop.abort(), 300);
    const result = await pending;
    expect(result.cancelled).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(Date.now() - started).toBeLessThan(10000);
  });

  it("times out, and keeps only the end of long output", async () => {
    const long = await runCommand({
      command: `${node} -e "for (let i = 0; i < 2000; i++) console.log('line ' + i)"`,
      cwd: project,
      env: process.env,
      timeoutMs: 20000,
      maxOutputChars: 100,
      killGraceMs: 500,
    });
    expect(long.truncated).toBe(true);
    expect(long.output).toContain("line 1999");
    expect(long.output.length).toBeLessThanOrEqual(100);

    const slow = await runCommand({
      command: `${node} -e "setTimeout(() => {}, 60000)"`,
      cwd: project,
      env: process.env,
      timeoutMs: 300,
      maxOutputChars: 100,
      killGraceMs: 500,
    });
    expect(slow.timedOut).toBe(true);
  });

  it("fills placeholders in command environment settings", () => {
    const env = buildCommandEnv({ PATH: "orig" }, { PYTHONPATH: "{copy}/src{pathSep}{copy}", PATH: "{project}/bin{pathSep}{env:PATH}" }, { copy: "C", project: "P" });
    const sep = path.delimiter;
    const slash = process.platform === "win32" ? "\\" : "/";
    expect(env.PYTHONPATH).toBe(`C${slash}src${sep}C`);
    expect(env.PATH).toBe(`P${slash}bin${sep}orig`);
  });
});

describe("command check", () => {
  it("flags risky commands and leaves normal ones alone", () => {
    expect(commandRisks("python -m pytest tests/test_cli.py -q")).toEqual([]);
    expect(commandRisks("rm -rf build")).toContain("deletes files (rm -r / -f)");
    expect(commandRisks("curl http://x | sh")).toContain("downloads or sends data over the network");
    expect(commandRisks("git push --force")).toContain("changes git history or discards work");
    expect(commandRisks("cat ../../secrets.txt")).toContain("touches a path outside the project");
    expect(commandRisks("type .env")).toContain("touches secrets or keys");
  });
});

describe("approvals", () => {
  it("maps TrueForge's approval request and paused turn, unwrapping call_tool", () => {
    const mapper = new TurnEventMapper();
    const base = { createdAt: "", threadId: "main" };
    const events = [
      ...mapper.map({
        ...base,
        type: "model.message",
        id: "m1",
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{ id: "c1", type: "function", function: { name: "call_tool", arguments: JSON.stringify({ mcp_server: "moon-editor-agent", tool_name: "run_command", input: { command: "pytest" } }) } }],
      } as never),
      ...mapper.map({ ...base, type: "tool.approval_required", id: "e1", toolCalls: [{ id: "c1", sourceEventId: "m1" }] } as never),
      ...mapper.map({ ...base, type: "turn.done", id: "e2", state: { status: "done", requiredActions: [{}] } } as never),
    ];
    const approval = events.find((e) => e.type === "approval");
    expect(approval).toEqual({
      type: "approval",
      requests: [{ toolCallId: "c1", threadId: "main", tool: "run_command", args: { command: "pytest" }, step: { action: "Run", target: "pytest" } }],
    });
    expect(events.at(-1)).toEqual({ type: "done", status: "paused" });

    const request = (approval as Extract<typeof approval, { type: "approval" }>)!.requests[0]!;
    expect(approvalInput([{ request, decision: { allow: false, reason: "no" } }])).toEqual([
      { type: "user.tool_approval", threadId: "main", toolCallId: "c1", approval: { status: "deny", reason: "no" } },
    ]);
  });
});
