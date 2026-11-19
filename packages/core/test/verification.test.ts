// Moon's check result (docs/design-decisions.md section 12): decided from Moon's own records.
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CONFIG_DIR,
  EXAMPLE_CONFIG_FILE_NAME,
  VerificationTracker,
  changedLines,
  loadMoonConfig,
  verificationText,
  type RunResult,
} from "../src/index.js";

const config = loadMoonConfig(fileURLToPath(new URL(`../../../${CONFIG_DIR}/${EXAMPLE_CONFIG_FILE_NAME}`, import.meta.url)));

const result = (command: string, exitCode: number | null, output = ""): RunResult => ({
  command,
  exitCode,
  output,
  truncated: false,
  timedOut: false,
  cancelled: false,
  durationMs: 1,
});

const TEST = "python -m pytest tests/test_cli.py -q";

describe("VerificationTracker", () => {
  it("knows check commands and test files from config", () => {
    const t = new VerificationTracker(config.verification);
    expect(t.isCheckCommand(TEST)).toBe(true);
    expect(t.isCheckCommand("npm test")).toBe(true);
    expect(t.isCheckCommand("ls -la")).toBe(false);
    expect(t.isTestFile("tests/test_cli.py")).toBe(true);
    expect(t.isTestFile("src/flask/cli.py")).toBe(false);
  });

  it("is Verified only when a check passed after the last change", () => {
    const t = new VerificationTracker(config.verification);
    t.recordEdit("src/app.py", "a", "b");
    expect(t.result(["src/app.py"]).state).toBe("not-verified");
    t.recordCommand(result(TEST, 0));
    const v = t.result(["src/app.py"]);
    expect(v.state).toBe("verified");
    expect(v.command).toBe(TEST);
    // An edit after the check makes it stale.
    t.recordEdit("src/app.py", "b", "c");
    expect(t.result(["src/app.py"]).state).toBe("not-verified");
  });

  it("ignores commands that are not checks", () => {
    const t = new VerificationTracker(config.verification);
    t.recordEdit("src/app.py", "a", "b");
    expect(t.recordCommand(result("ls", 0))).toBeUndefined();
    expect(t.result(["src/app.py"]).reason).toMatch(/no tests/);
  });

  it("says Failed when the check fails after the change, and counts the attempt", () => {
    const t = new VerificationTracker(config.verification);
    t.recordEdit("src/app.py", "a", "b");
    const note = t.recordCommand(result(TEST, 1, "1 failed"));
    expect(note).toMatch(/attempt 1 failed/);
    expect(t.attempt).toBe(2);
    expect(t.result(["src/app.py"]).state).toBe("failed");
    t.recordEdit("src/app.py", "a", "c");
    expect(t.recordCommand(result(TEST, 1, "1 failed"))).toMatch(/ask the user/);
  });

  it("treats an environment problem as 'could not run', never as a failed attempt", () => {
    const t = new VerificationTracker(config.verification);
    t.recordEdit("src/app.py", "a", "b");
    const note = t.recordCommand(result("docker compose run tests pytest", 1, "Cannot connect to the Docker daemon at unix:///var/run/docker.sock"));
    expect(note).toMatch(/environment/);
    expect(t.failedAttempts).toEqual([]);
    const v = t.result(["src/app.py"]);
    expect(v.state).toBe("not-verified");
    expect(v.reason).toMatch(/Docker daemon/);
    // "command not found" exit codes too.
    expect(t.recordCommand(result("pytest", 127))).toMatch(/environment/);
  });

  it("records a failing run on the original code as the 'before' and proves the fix", () => {
    const t = new VerificationTracker(config.verification);
    // A new regression test only (no code change yet): failing is expected, not an attempt.
    t.recordEdit("tests/test_app.py", null, "def test_bug(): assert False");
    expect(t.recordCommand(result(TEST, 1))).toMatch(/original code/);
    expect(t.failedAttempts).toEqual([]);
    t.recordEdit("src/app.py", "a", "b");
    t.recordCommand(result(TEST, 0));
    const v = t.result(["src/app.py", "tests/test_app.py"]);
    expect(v.state).toBe("verified");
    expect(v.evidence.join(" ")).toMatch(/failed on the original code and passes after/i);
  });

  it("is Partly verified when a hunk was rejected or another check could not run", () => {
    const t = new VerificationTracker(config.verification);
    t.recordEdit("src/app.py", "a", "b");
    t.recordCommand(result(TEST, 0));
    expect(t.result(["src/app.py"], 2).state).toBe("partly-verified");
    t.recordCommand(result("npm test", 1, "sh: jest: command not found"));
    t.recordCommand(result(TEST, 0));
    expect(t.result(["src/app.py"]).state).toBe("partly-verified");
  });

  it("says why when the user denied the check, and when there is nothing to test", () => {
    const t = new VerificationTracker(config.verification);
    t.recordEdit("src/app.py", "a", "b");
    t.recordDenied(TEST);
    const v = t.result(["src/app.py"]);
    expect(v.reason).toMatch(/denied/);
    expect(v.command).toBe(TEST);
    expect(t.result(["docs/cli.rst", "README.md"]).reason).toMatch(/Nothing to test/);
  });

  it("flags test files that lose checks", () => {
    const t = new VerificationTracker(config.verification);
    const base = "def test_a():\n    assert f() == 1\n    assert g() == 2\n";
    const warnings = t.weakenedTests([
      { rel: "tests/test_a.py", baseText: base, newText: "def test_a():\n    assert f() == 1\n" },
      { rel: "tests/test_b.py", baseText: base, newText: null },
      { rel: "src/a.py", baseText: "assert x\n", newText: "" },
      { rel: "tests/test_c.py", baseText: base, newText: base + "    assert h() == 3\n" },
    ]);
    expect(warnings.map((w) => w.rel)).toEqual(["tests/test_a.py", "tests/test_b.py"]);
  });

  it("tells the agent not to claim success unless Verified", () => {
    expect(verificationText({ state: "verified", reason: "ok", evidence: [] })).not.toMatch(/Do not say/);
    expect(verificationText({ state: "failed", reason: "x", command: TEST, evidence: [] })).toMatch(/Do not say.*fixed/);
  });
});

describe("edit_file result", () => {
  it("shows the changed lines with context, numbered like read_file", () => {
    const before = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"].join("\n");
    const after = before.replace("b", "B").replace("i", "I");
    const view = changedLines(before, after, 1, 40);
    expect(view.split("\n")).toEqual([" 1  a", " 2  B", " 3  c", "...", " 8  h", " 9  I", "10  j"]);
    expect(changedLines(before, after, 1, 2)).toMatch(/more lines/);
  });
});
