import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CONFIG_DIR,
  EXAMPLE_CONFIG_FILE_NAME,
  MOON_TOOLS,
  ToolContext,
  ToolError,
  applyHunks,
  applyTextEdits,
  buildInlinePrompt,
  diffLines,
  hunkTextEdit,
  layoutPreview,
  linesToEdits,
  loadMoonConfig,
  rejectHunk,
  splitLines,
  type EditorDiagnostic,
} from "../src/index.js";

const config = loadMoonConfig(fileURLToPath(new URL(`../../../${CONFIG_DIR}/${EXAMPLE_CONFIG_FILE_NAME}`, import.meta.url)));
const L = (text: string) => text.split("\n");

describe("diffLines", () => {
  it("finds nothing for equal texts", () => {
    expect(diffLines(L("a\nb"), L("a\nb"))).toEqual([]);
  });

  it("splits changes separated by unchanged lines into separate hunks", () => {
    const hunks = diffLines(L("import os\nx\ny\nz\nend"), L("import os\nimport re\nx\nY\nz\nend"));
    expect(hunks).toEqual([
      { oldStart: 1, oldLines: [], newStart: 1, newLines: ["import re"] },
      { oldStart: 2, oldLines: ["y"], newStart: 3, newLines: ["Y"] },
    ]);
  });

  it("keeps neighbouring changed lines in one hunk", () => {
    const hunks = diffLines(L("a\nb\nc\nd"), L("a\nB\nC\nd"));
    expect(hunks).toEqual([{ oldStart: 1, oldLines: ["b", "c"], newStart: 1, newLines: ["B", "C"] }]);
  });

  it("handles deletions at the end and insertions at the start", () => {
    expect(diffLines(L("a\nb\nc"), L("a"))).toEqual([{ oldStart: 1, oldLines: ["b", "c"], newStart: 1, newLines: [] }]);
    expect(diffLines(L("b"), L("a\nb"))).toEqual([{ oldStart: 0, oldLines: [], newStart: 0, newLines: ["a"] }]);
  });

  it("applying every hunk gives the new text", () => {
    const oldLines = L("one\ntwo\nthree\nfour\nfive\nsix");
    const newLines = L("zero\none\nTWO\nthree\nfive\nsix\nseven");
    expect(applyHunks(oldLines, diffLines(oldLines, newLines))).toEqual(newLines);
  });
});

describe("hunk review (accept / reject and recalculation)", () => {
  const current = L("import os\n\ndef f():\n    return 1\n\ndef g():\n    return 2");
  const target = L("import os\nimport re\n\ndef f():\n    return 10\n\ndef g():\n    return 20");

  it("accepting one hunk changes only those lines; the rest are recalculated", () => {
    const hunks = diffLines(current, target);
    expect(hunks).toHaveLength(3);
    const afterAccept = applyHunks(current, [hunks[1]!]);
    expect(afterAccept).toContain("    return 10");
    expect(afterAccept).not.toContain("import re");
    // Lines did not move here, but recalculation must still find exactly the two other hunks.
    const remaining = diffLines(afterAccept, target);
    expect(remaining.map((h) => h.newLines)).toEqual([["import re"], ["    return 20"]]);
  });

  it("rejecting a hunk leaves the original lines and keeps the other hunks", () => {
    const hunks = diffLines(current, target);
    const newTarget = rejectHunk(current, hunks, 0); // reject the import
    expect(newTarget).not.toContain("import re");
    const remaining = diffLines(current, newTarget);
    expect(remaining.map((h) => h.newLines)).toEqual([["    return 10"], ["    return 20"]]);
  });

  it("accept after an earlier insertion moved the lines still targets the right hunk", () => {
    let cur = [...current];
    let hunks = diffLines(cur, target);
    cur = applyHunks(cur, [hunks[0]!]); // accept the import: everything below moves down a line
    hunks = diffLines(cur, target);
    expect(hunks[0]!.oldStart).toBe(4);
    cur = applyHunks(cur, [hunks[1]!]);
    expect(diffLines(cur, target).map((h) => h.newLines)).toEqual([["    return 10"]]);
  });

  it("review ends when every hunk is accepted or rejected", () => {
    const hunks = diffLines(current, target);
    let cur = applyHunks(current, [hunks[0]!]);
    let tgt = rejectHunk(cur, diffLines(cur, target), 0);
    let left = diffLines(cur, tgt);
    cur = applyHunks(cur, left);
    left = diffLines(cur, tgt);
    expect(left).toEqual([]);
    expect(cur).toContain("import re");
    expect(cur).toContain("    return 1");
    expect(cur).toContain("    return 20");
  });
});

describe("hunkTextEdit", () => {
  // Texts are written with "|" for line breaks.
  const cases: [string, string][] = [
    ["a|b|c", "a|B|c"],
    ["a|b|c", "x|a|b|c"],
    ["a|b|c", "a|b"],
    ["a|b|c", "a|b|c|d"],
    ["a", "b"],
    ["", "x|y"],
    ["a|b|c|", "a|c|"],
    ["one|two|three|four", "ONE|two|four|five"],
  ];
  const P = (text: string) => text.split("|");
  for (const eol of ["\n", "\r\n"]) {
    it(`applying one hunk's edit equals applying that hunk (eol ${JSON.stringify(eol)})`, () => {
      for (const [before, after] of cases) {
        const oldLines = P(before);
        const hunks = diffLines(oldLines, P(after));
        const text = oldLines.join(eol);
        for (const hunk of hunks) {
          const e = hunkTextEdit(oldLines, hunk, eol);
          expect(text.slice(0, e.start) + e.text + text.slice(e.end)).toBe(applyHunks(oldLines, [hunk]).join(eol));
        }
        // All edits at once (applied from the end so offsets stay valid) give the full new text.
        let all = text;
        for (const e of hunks.map((h) => hunkTextEdit(oldLines, h, eol)).sort((x, y) => y.start - x.start)) {
          all = all.slice(0, e.start) + e.text + all.slice(e.end);
        }
        expect(all).toBe(P(after).join(eol));
      }
    });
  }
});

describe("applyTextEdits", () => {
  it("replaces exact text once", () => {
    expect(applyTextEdits("a\nb\nc\n", [{ old_text: "b\n", new_text: "B\nB2\n" }])).toBe("a\nB\nB2\nc\n");
  });

  it("keeps CRLF line endings", () => {
    expect(applyTextEdits("a\r\nb\r\n", [{ old_text: "a\nb", new_text: "x\ny" }])).toBe("x\r\ny\r\n");
  });

  it("refuses missing, repeated and empty old_text", () => {
    expect(() => applyTextEdits("a\nb", [{ old_text: "zzz", new_text: "" }])).toThrow(/not found/);
    expect(() => applyTextEdits("x\nx", [{ old_text: "x", new_text: "y" }])).toThrow(/more than once/);
    expect(() => applyTextEdits("x", [{ old_text: "", new_text: "y" }])).toThrow(/empty/);
  });
});

describe("propose_edit and get_errors", () => {
  let root: string;
  let ctx: ToolContext;
  const run = (name: string, args: Record<string, unknown>) =>
    MOON_TOOLS.find((t) => t.name === name)!.run(ctx, args as never) as string;
  const problems: EditorDiagnostic[] = [
    { path: "app.py", line: 2, column: 5, severity: "error", message: "undefined name 'x'", source: "pyright" },
  ];

  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), "moon-inline-"));
    writeFileSync(path.join(root, "app.py"), "def f():\n    return x\n");
    writeFileSync(path.join(root, "other.py"), "y = 1\n");
    ctx = new ToolContext(root, config);
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("refuses when no inline edit is running", () => {
    expect(() => run("propose_edit", { path: "app.py", edits: [{ old_text: "x", new_text: "1" }] })).toThrow(ToolError);
  });

  it("hands the proposal back without writing the file, and refuses other files", () => {
    let proposed: string | undefined;
    ctx.inlineTarget = { rel: "app.py", onProposal: (text) => (proposed = text) };
    try {
      expect(() => run("propose_edit", { path: "other.py", edits: [{ old_text: "y", new_text: "z" }] })).toThrow(
        /only change "app.py"/,
      );
      const result = run("propose_edit", { path: "app.py", edits: [{ old_text: "    return x", new_text: "    return 1" }] });
      expect(result).toMatch(/1 change/);
      expect(proposed).toBe("def f():\n    return 1\n");
      expect(readFileSync(path.join(root, "app.py"), "utf8")).toBe("def f():\n    return x\n");
    } finally {
      ctx.inlineTarget = undefined;
    }
  });

  it("works on the editor's unsaved text", () => {
    let proposed: string | undefined;
    ctx.editor = { openText: (abs) => (abs.endsWith("app.py") ? "def f():\n    return y\n" : undefined), diagnostics: () => problems };
    ctx.inlineTarget = { rel: "app.py", onProposal: (text) => (proposed = text) };
    try {
      run("propose_edit", { path: "app.py", edits: [{ old_text: "return y", new_text: "return 2" }] });
      expect(proposed).toBe("def f():\n    return 2\n");
      expect(run("read_file", { path: "app.py" })).toContain("return y");
      expect(run("get_errors", { path: "app.py" })).toContain("app.py:2:5 error (pyright): undefined name 'x'");
    } finally {
      ctx.editor = undefined;
      ctx.inlineTarget = undefined;
    }
  });

  it("get_errors says so when the editor is not there", () => {
    expect(run("get_errors", {})).toMatch(/not available/);
  });
});

describe("buildInlinePrompt", () => {
  const text = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");

  it("marks the selection, shows nearby lines and notes the hidden ones", () => {
    const prompt = buildInlinePrompt(
      { instruction: "  Do it ", rel: "a.py", languageId: "python", text, startLine: 9, endLine: 10, problems: [] },
      { contextLines: 3, maxProblems: 5 },
    );
    expect(prompt).toContain("lines 10-11 selected");
    expect(prompt).toContain("## Instruction\nDo it\n");
    expect(prompt).toContain("> 10  line 10");
    expect(prompt).toContain("   7  line 7");
    expect(prompt).not.toContain("line 6\n");
    expect(prompt).toContain("[Lines 1-6 and 15-30 of 30 not shown.");
    expect(prompt).toContain("untrusted_project_content");
    expect(prompt).toContain("## Problems the editor reports in this file\nNone.");
  });
});

describe("layoutPreview", () => {
  const P = (text: string) => text.split("|");

  it("puts each change's new lines right under its old lines", () => {
    const layout = layoutPreview(P("import os|x|y|z"), P("import os|import re|x|Y|z"));
    expect(layout.lines).toEqual(P("import os|import re|x|y|Y|z"));
    expect(layout.hunks).toEqual([
      { removedStart: 1, removedCount: 0, addedStart: 1, addedCount: 1 },
      { removedStart: 3, removedCount: 1, addedStart: 4, addedCount: 1 },
    ]);
  });

  it("is just the original when nothing changes", () => {
    expect(layoutPreview(P("a|b"), P("a|b"))).toEqual({ lines: P("a|b"), hunks: [] });
  });

  it("linesToEdits turns the original into the preview and back", () => {
    const original = P("a|b|c|d");
    const preview = layoutPreview(original, P("a|B|c|d|e")).lines;
    const apply = (from: string[], to: string[]) => {
      let text = from.join("\n");
      for (const e of linesToEdits(from, to, "\n").sort((x, y) => y.start - x.start)) {
        text = text.slice(0, e.start) + e.text + text.slice(e.end);
      }
      return text;
    };
    expect(apply(original, preview)).toBe(preview.join("\n"));
    expect(apply(preview, original)).toBe(original.join("\n"));
  });
});
