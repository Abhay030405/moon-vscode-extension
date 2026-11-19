// Impact check (docs/design-decisions.md section 13.1): uses the agent did not update.
import { describe, expect, it } from "vitest";
import { findMissedUses, missedUsesText, type FileTags, type ImpactChange } from "../src/index.js";

// A tiny Python-ish tag reader (the real one is tree-sitter; the check only needs defs and refs).
function readTags(_rel: string, text: string): FileTags {
  const defs: FileTags["defs"] = [];
  const refs: Record<string, number> = {};
  text.split("\n").forEach((line, i) => {
    const def = /^\s*(def|class)\s+(\w+)/.exec(line);
    if (def) defs.push({ name: def[2]!, kind: def[1] === "def" ? "function" : "class", line: i });
    else for (const m of line.matchAll(/(\w+)\(/g)) refs[m[1]!] = (refs[m[1]!] ?? 0) + 1;
  });
  return { defs, refs };
}

const HELPERS = "def get_flag(name):\n    return name\n";
const APP = "from helpers import get_flag\n\nx = get_flag('a')\n";
const CLI = "y = get_flag('b')\n";

function check(changes: ImpactChange[], copy: Record<string, string>) {
  const project = { "helpers.py": HELPERS, "app.py": APP, "cli.py": CLI };
  const projectTags = new Map(Object.entries(project).map(([rel, text]) => [rel, readTags(rel, text)]));
  return findMissedUses({ changes, projectTags, readTags, readText: (rel) => copy[rel] ?? null, maxUses: 20 });
}

describe("findMissedUses", () => {
  it("lists calls not updated after a function's inputs changed", () => {
    const helpers = "def get_flag(name, env):\n    return name\n";
    const app = "from helpers import get_flag\n\nx = get_flag('a', 'prod')\n";
    const missed = check(
      [
        { rel: "helpers.py", baseText: HELPERS, newText: helpers },
        { rel: "app.py", baseText: APP, newText: app },
      ],
      { "helpers.py": helpers, "app.py": app, "cli.py": CLI },
    );
    // app.py was updated (its call line changed); cli.py was not. The import line is no call.
    expect(missed.map((m) => `${m.rel}:${m.line}`)).toEqual(["cli.py:1"]);
    expect(missedUsesText(missed)).toMatch(/`get_flag` has different inputs now.*cli\.py line 1/);
  });

  it("ignores new inputs with a default (old calls still work)", () => {
    const helpers = "def get_flag(name, env=None):\n    return name\n";
    expect(check([{ rel: "helpers.py", baseText: HELPERS, newText: helpers }], { "helpers.py": helpers, "app.py": APP, "cli.py": CLI })).toEqual([]);
  });

  it("lists every remaining use of a renamed function, imports too", () => {
    const helpers = "def read_flag(name):\n    return name\n";
    const missed = check([{ rel: "helpers.py", baseText: HELPERS, newText: helpers }], { "helpers.py": helpers, "app.py": APP, "cli.py": CLI });
    expect(missed.map((m) => `${m.rel}:${m.line}`)).toEqual(["app.py:1", "app.py:3", "cli.py:1"]);
    expect(missed[0]!.why).toBe("removed");
  });

  it("skips overloaded names (defined more than once), like flask's locate_app", () => {
    const base = "def locate(a):\n    ...\ndef locate(a, b):\n    ...\ndef locate(a, b=1):\n    return a\n";
    const after = base + "\ndef config_command():\n    return 1\n";
    const projectTags = new Map([["cli.py", readTags("cli.py", base)], ["app.py", readTags("app.py", "x = locate(1)\n")]]);
    const missed = findMissedUses({
      changes: [{ rel: "cli.py", baseText: base, newText: after }],
      projectTags,
      readTags,
      readText: (rel) => (rel === "cli.py" ? after : "x = locate(1)\n"),
      maxUses: 20,
    });
    expect(missed).toEqual([]);
  });

  it("says nothing when only a body changed", () => {
    const helpers = "def get_flag(name):\n    return name.upper()\n";
    expect(check([{ rel: "helpers.py", baseText: HELPERS, newText: helpers }], { "helpers.py": helpers, "app.py": APP, "cli.py": CLI })).toEqual([]);
  });
});
