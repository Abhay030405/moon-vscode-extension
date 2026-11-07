// What each source file defines (functions, classes, methods...) and which names it uses,
// read with tree-sitter (WebAssembly build: no native code, works on every OS).
// The tag queries in packages/core/queries come from Aider (see NOTICE.md).
// Languages: see MAP_LANGUAGES in constants.ts. Other files have no tags; the map still
// lists them by path.

import { readFileSync } from "node:fs";
import * as path from "node:path";
import Parser from "web-tree-sitter";
import { MAP_LANGUAGES, MAP_MAX_LINE_LENGTH } from "../shared/constants.js";

export interface Definition {
  name: string;
  /** "function", "class", "method"... (from the query's capture name). */
  kind: string;
  /** 0-based line. */
  line: number;
}

export interface FileTags {
  defs: Definition[];
  /** Names the file uses, with how many times. */
  refs: Record<string, number>;
}

export interface TagReaderPaths {
  /** Folder with the grammar .wasm files (tree-sitter-python.wasm, ...). */
  grammarDir: string;
  /** Folder with the *-tags.scm query files. */
  queryDir: string;
  /** web-tree-sitter's own tree-sitter.wasm. */
  runtimeWasm: string;
}

let runtimeReady: Promise<void> | undefined;

export class TagReader {
  private constructor(private readonly languages: Map<string, { parser: Parser; query: Parser.Query }>) {}

  /** Loads the parser and the grammars of every language in MAP_LANGUAGES. */
  static async create(paths: TagReaderPaths): Promise<TagReader> {
    runtimeReady ??= Parser.init({ locateFile: () => paths.runtimeWasm });
    await runtimeReady;
    const byGrammar = new Map<string, { parser: Parser; query: Parser.Query }>();
    const languages = new Map<string, { parser: Parser; query: Parser.Query }>();
    for (const [ext, { grammar, query }] of Object.entries(MAP_LANGUAGES)) {
      let entry = byGrammar.get(grammar);
      if (!entry) {
        const language = await Parser.Language.load(path.join(paths.grammarDir, grammar));
        const parser = new Parser();
        parser.setLanguage(language);
        entry = { parser, query: language.query(readFileSync(path.join(paths.queryDir, query), "utf8")) };
        byGrammar.set(grammar, entry);
      }
      languages.set(ext, entry);
    }
    return new TagReader(languages);
  }

  supports(rel: string): boolean {
    return this.languages.has(path.extname(rel).toLowerCase());
  }

  /** The file's tags, or undefined for an unsupported or generated (minified) file. */
  read(rel: string, text: string): FileTags | undefined {
    const language = this.languages.get(path.extname(rel).toLowerCase());
    if (!language || looksGenerated(text)) return undefined;
    const tree = language.parser.parse(text);
    try {
      const defs: Definition[] = [];
      const seen = new Set<string>();
      const refs: Record<string, number> = {};
      for (const capture of language.query.captures(tree.rootNode)) {
        const [prefix, role, kind] = capture.name.split(".");
        if (prefix !== "name") continue;
        const name = capture.node.text;
        if (role === "definition") {
          const key = `${name}:${capture.node.startPosition.row}`;
          if (seen.has(key)) continue;
          seen.add(key);
          defs.push({ name, kind: kind ?? "definition", line: capture.node.startPosition.row });
        } else if (role === "reference") {
          refs[name] = (refs[name] ?? 0) + 1;
        }
      }
      defs.sort((a, b) => a.line - b.line);
      return { defs, refs };
    } finally {
      tree.delete();
    }
  }
}

function looksGenerated(text: string): boolean {
  let start = 0;
  while (start < text.length) {
    const end = text.indexOf("\n", start);
    const stop = end === -1 ? text.length : end;
    if (stop - start > MAP_MAX_LINE_LENGTH) return true;
    start = stop + 1;
  }
  return false;
}
