import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AGENT_TOOLS,
  CONFIG_DIR,
  ContextAssembler,
  EXAMPLE_CONFIG_FILE_NAME,
  MapCache,
  TagReader,
  ToolContext,
  TurnEventMapper,
  buildProjectMap,
  cutToTokens,
  expandMentions,
  loadMoonConfig,
  mapBudget,
  rankFiles,
  readProjectRules,
  searchMentions,
  type MoonConfig,
  type FileTags,
  type TagReaderPaths,
} from "../src/index.js";

const config: MoonConfig = loadMoonConfig(
  fileURLToPath(new URL(`../../../${CONFIG_DIR}/${EXAMPLE_CONFIG_FILE_NAME}`, import.meta.url)),
);
const require = createRequire(import.meta.url);
const paths: TagReaderPaths = {
  grammarDir: path.join(path.dirname(require.resolve("tree-sitter-wasms/package.json")), "out"),
  queryDir: fileURLToPath(new URL("../queries", import.meta.url)),
  runtimeWasm: path.join(path.dirname(require.resolve("web-tree-sitter")), "tree-sitter.wasm"),
};

let reader: TagReader;
let project: string;
const write = (rel: string, text: string) => {
  mkdirSync(path.dirname(path.join(project, rel)), { recursive: true });
  writeFileSync(path.join(project, rel), text);
};

beforeAll(async () => {
  reader = await TagReader.create(paths);
  project = mkdtempSync(path.join(tmpdir(), "moon-context-"));
  write("src/shop/cli.py", "from .core import load_cart\n\ndef checkout_command():\n    cart = load_cart()\n    return cart\n");
  write(
    "src/shop/core.py",
    "class Cart:\n    def total(self):\n        return 0\n\ndef load_cart():\n    return Cart()\n\ndef other():\n    return load_cart()\n",
  );
  write("tests/test_cli.py", "from shop.cli import checkout_command\n\ndef test_checkout():\n    checkout_command()\n");
  write("web/app.ts", "export function renderPage(): string {\n  return helper();\n}\nexport class Store {\n  run() {}\n}\n");
  write("docs/cli.rst", "CLI\n===\n");
  write("AGENTS.md", "Use tabs.\n");
  write(".env", "SECRET=1\n");
  write("node_modules/x/index.js", "function hidden() {}\n");
});

afterAll(() => rmSync(project, { recursive: true, force: true }));

const map = (request: string, budgetTokens = 4000, files: string[] = []) =>
  buildProjectMap({
    root: project,
    reader,
    cache: new MapCache(),
    ignoredDirs: new Set(config.tools.ignoredDirs),
    isSecret: (rel) => rel === ".env",
    maxFiles: 100,
    maxFileBytes: 100000,
    budgetTokens,
    focus: { request, files },
  });

describe("tags (tree-sitter)", () => {
  it("reads Python and TypeScript definitions and references", () => {
    const py = reader.read("a.py", "class A:\n    def run(self):\n        helper()\n")!;
    expect(py.defs.map((d) => [d.kind, d.name, d.line])).toEqual([
      ["class", "A", 0],
      ["function", "run", 1],
    ]);
    expect(py.refs.helper).toBe(1);
    const ts = reader.read("a.ts", "export function go(): void { stop(); }\ninterface Shape { x: number }\n")!;
    expect(ts.defs.map((d) => d.name)).toEqual(["go", "Shape"]);
    expect(ts.refs.stop).toBe(1);
  });

  it("skips unsupported and minified files", () => {
    expect(reader.read("a.rs", "fn main() {}")).toBeUndefined();
    expect(reader.read("a.js", `var a=1;${"x".repeat(5000)}`)).toBeUndefined();
  });
});

describe("project map", () => {
  it("lists files (not ignored folders or secrets), ranked for the request, inside the budget", () => {
    const m = map("change the checkout command in the CLI");
    expect(m.files).not.toContain(".env");
    expect(m.files.some((f) => f.startsWith("node_modules"))).toBe(false);
    expect(m.shown[0]).toBe("src/shop/cli.py");
    expect(m.text).toContain("function checkout_command :3");
    expect(m.tokens).toBeLessThanOrEqual(m.budgetTokens);
  });

  it("ranks a file that many others use above an unused one, and stops at the budget", () => {
    const ranked = rankFiles(
      ["a.py", "b.py", "c.py"],
      new Map<string, FileTags>([
        ["a.py", { defs: [{ name: "shared", kind: "function", line: 0 }], refs: {} }],
        ["b.py", { defs: [], refs: { shared: 3 } }],
        ["c.py", { defs: [], refs: { shared: 1 } }],
      ]),
      { request: "", files: [] },
    );
    expect(ranked[0]!.rel).toBe("a.py");
    const small = map("", 40);
    expect(small.shown.length).toBeLessThan(small.totalFiles);
    expect(small.text).toContain("more files not shown");
  });

  it("an exact name from the request or an @-named file wins", () => {
    expect(map("why does load_cart fail?").shown[0]).toBe("src/shop/core.py");
    expect(map("", 4000, ["web/app.ts"]).shown[0]).toBe("web/app.ts");
  });

  it("caches tags by size and modification time", () => {
    const cacheFile = path.join(project, "..", `moon-map-cache-${process.pid}.json`);
    const cache = new MapCache(cacheFile);
    cache.set("x.py", 10, 5, { defs: [], refs: {} });
    cache.save();
    const again = new MapCache(cacheFile);
    expect(again.get("x.py", 10, 5)).toEqual({ defs: [], refs: {} });
    expect(again.get("x.py", 11, 5)).toBeUndefined();
    rmSync(cacheFile, { force: true });
  });
});

describe("budget and rules", () => {
  it("map budget is a share of the window between a minimum and a maximum", () => {
    const c = { ...config.context, mapBudgetRatio: 0.1, mapBudgetMinTokens: 1000, mapBudgetMaxTokens: 8000 };
    expect(mapBudget(5000, c)).toBe(1000);
    expect(mapBudget(50000, c)).toBe(5000);
    expect(mapBudget(1000000, c)).toBe(8000);
    expect(cutToTokens("line one\nline two\nline three", 4)).toEqual({ text: "line one", cut: true });
  });

  it("reads AGENTS.md", () => {
    expect(readProjectRules(project, 100)).toMatchObject({ file: "AGENTS.md", text: "Use tabs.", cut: false });
  });
});

describe("@-mentions", () => {
  const read = (rel: string) => {
    try {
      return require("node:fs").readFileSync(path.join(project, rel), "utf8") as string;
    } catch {
      return null;
    }
  };

  it("@file gives the whole file, or its outline when too large; @symbol gives one definition", () => {
    const tags = map("").tags;
    const options = { readText: read, tags: (rel: string) => tags.get(rel), maxTokens: 1000, symbolMaxLines: 50 };
    const full = expandMentions([{ kind: "file", rel: "src/shop/core.py" }], options);
    expect(full.items[0]!.mode).toBe("full");
    expect(full.text).toContain("def load_cart");
    expect(full.text).toContain("untrusted_project_content");

    const outline = expandMentions([{ kind: "file", rel: "src/shop/core.py" }], { ...options, maxTokens: 5 });
    expect(outline.items[0]!.mode).toBe("outline");
    expect(outline.text).toContain("function load_cart :5");
    expect(outline.text).not.toContain("return Cart()");

    const symbol = expandMentions([{ kind: "symbol", name: "load_cart", rel: "src/shop/core.py", line: 4 }], options);
    expect(symbol.text).toContain("def load_cart():\n    return Cart()");
    expect(symbol.text).not.toContain("def other");

    expect(expandMentions([{ kind: "file", rel: "nope.py" }], options).items[0]!.mode).toBe("missing");
  });

  it("the picker finds files and names, best matches first", () => {
    const m = map("");
    const found = searchMentions("load", m.files, m.tags, 10);
    expect(found[0]).toMatchObject({ label: "load_cart", mention: { kind: "symbol", rel: "src/shop/core.py", line: 4 } });
    expect(searchMentions("cli", m.files, m.tags, 10).map((c) => c.detail)).toContain("src/shop/cli.py");
  });
});

describe("assembler", () => {
  it("prepares the opening message (rules + map), the mention text and the summary", async () => {
    const assembler = new ContextAssembler(paths, undefined, config);
    const pack = await assembler.prepare({
      root: project,
      request: "fix the checkout command",
      mentions: [{ kind: "file", rel: "docs/cli.rst" }],
      windowTokens: 100000,
      readText: (rel) => (rel === "docs/cli.rst" ? "CLI\n===\n" : null),
    });
    expect(pack.openingMessage).toContain("## Project rules from AGENTS.md");
    expect(pack.openingMessage).toContain("## Project map");
    expect(pack.mentionText).toContain("@docs/cli.rst (whole file)");
    expect(pack.compactAtTokens).toBe(Math.round(100000 * config.context.compactionRatio));
    expect(pack.summary.map.budgetTokens).toBe(mapBudget(100000, config.context));
    expect(pack.summary.rules?.file).toBe("AGENTS.md");
    expect(pack.summary.mentions[0]).toMatchObject({ label: "@docs/cli.rst", mode: "full" });
    expect((await assembler.search(project, "check"))[0]!.label).toBe("checkout_command");
  });
});

describe("report_context", () => {
  it("accepts real files, refuses made-up ones, and becomes the panel's context-choice event", async () => {
    const tool = AGENT_TOOLS.find((t) => t.name === "report_context")!;
    const ctx = new ToolContext(project, config);
    expect(await tool.run(ctx, { files: [{ path: "src/shop/cli.py", reason: "the command lives here" }] } as never)).toMatch(/Shown/);
    await expect(async () => tool.run(ctx, { files: [{ path: "src/ghost.py", reason: "x" }] } as never)).rejects.toThrow(/do not exist/);

    const events = new TurnEventMapper().map({
      type: "model.message",
      id: "m1",
      createdAt: "",
      threadId: "main",
      content: "",
      finishReason: "tool_calls",
      toolCalls: [
        { id: "c1", type: "function", function: { name: "report_context", arguments: JSON.stringify({ files: [{ path: "a.py", reason: "why" }] }) } },
      ],
    } as never);
    expect(events.map((e) => e.type)).toEqual(["tool-call", "context-choice"]);
    expect(events[1]).toEqual({ type: "context-choice", files: [{ path: "a.py", reason: "why" }] });
  });
});
