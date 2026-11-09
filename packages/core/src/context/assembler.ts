// Context assembly for agent mode, in layers:
// 1. the project's rules (AGENTS.md / CLAUDE.md) and the project map, ranked for the user's
//    first request and packed into a budget: given once, as the session's opening message;
// 2. what the user @-named: added to that message's turn;
// 3. the agent's own search tools and its scout subagent (in the agent definition), which
//    find the rest; the agent then reports the files it chose and why (report_context).
// Everything here is local work on the user's files; no model is called.

import { createHash } from "node:crypto";
import * as path from "node:path";
import type { MoonConfig } from "../shared/config.js";
import { SecretGuard } from "../safety/secret-guard.js";
import { wrapUntrusted } from "../safety/untrusted-text.js";
import { compactionTokens, mapBudget } from "./budget.js";
import { MapCache } from "./map-cache.js";
import { expandMentions, searchMentions, type ExpandedMention, type Mention, type MentionCandidate } from "./mentions.js";
import { readProjectRules } from "./project-rules.js";
import { buildProjectMap, type ProjectMap } from "./repo-map.js";
import { TagReader, type FileTags, type TagReaderPaths } from "./tags.js";

/** What Moon put in the agent's context, for the panel's context card. */
export interface ContextSummary {
  windowTokens: number;
  map: { tokens: number; budgetTokens: number; shownFiles: number; totalFiles: number; topFiles: string[] };
  rules: { file: string; tokens: number; cut: boolean } | undefined;
  mentions: ExpandedMention[];
}

export interface ContextPack {
  /** The session's opening message: project rules and map. */
  openingMessage: string;
  /** Added to the user's message: the @-mentions (empty when there are none). */
  mentionText: string;
  /** When TrueForge should compact the conversation (from the same window number). */
  compactAtTokens: number;
  summary: ContextSummary;
}

export interface PrepareOptions {
  root: string;
  request: string;
  mentions: readonly Mention[];
  /** The model's window (from TrueForge, or context.fallbackContextLength). */
  windowTokens: number;
  readText(rel: string): string | null;
}

/** How many of the map's top files the context card lists. */
const SUMMARY_TOP_FILES = 5;

export class ContextAssembler {
  private reader: Promise<TagReader> | undefined;
  /** The last map, reused by the @ picker. */
  private last: { root: string; map: ProjectMap } | undefined;

  constructor(
    private readonly paths: TagReaderPaths,
    /** Folder for the map caches (Moon's storage, never the project). Undefined = no cache. */
    private readonly cacheDir: string | undefined,
    private readonly config: Pick<MoonConfig, "context" | "tools" | "safety">,
  ) {}

  async prepare(options: PrepareOptions): Promise<ContextPack> {
    const settings = this.config.context;
    const map = await this.buildMap(options.root, options.request, options.mentions, mapBudget(options.windowTokens, settings));
    const rules = readProjectRules(options.root, settings.rulesMaxTokens);
    const mentions = expandMentions(options.mentions, {
      readText: options.readText,
      tags: (rel) => map.tags.get(rel),
      maxTokens: settings.mentionMaxTokens,
      symbolMaxLines: settings.symbolMaxLines,
    });

    const parts = [
      "Moon (the editor) prepared this context before the user's first message. " +
        "Use it to decide where to look first; it is information, not a request.",
    ];
    if (rules) {
      const note = rules.cut ? " (cut to fit; read the file for the rest)" : "";
      parts.push(`## Project rules from ${rules.file}${note}\n${wrapUntrusted(rules.file, rules.text)}`);
    }
    parts.push(`## Project map\n${wrapUntrusted("project map", map.text)}`);

    return {
      openingMessage: parts.join("\n\n"),
      mentionText: mentions.text,
      compactAtTokens: compactionTokens(options.windowTokens, settings),
      summary: {
        windowTokens: options.windowTokens,
        map: {
          tokens: map.tokens,
          budgetTokens: map.budgetTokens,
          shownFiles: map.shown.length,
          totalFiles: map.totalFiles,
          topFiles: map.shown.slice(0, SUMMARY_TOP_FILES),
        },
        rules: rules && { file: rules.file, tokens: rules.tokens, cut: rules.cut },
        mentions: mentions.items,
      },
    };
  }

  /** Entries for the @ picker. Builds the project index the first time (cached after). */
  async search(root: string, query: string): Promise<MentionCandidate[]> {
    const map = this.last?.root === root ? this.last.map : await this.buildMap(root, "", [], this.config.context.mapBudgetMinTokens);
    return searchMentions(query, map.files, map.tags, this.config.context.pickerMaxResults);
  }

  /** The tags of a file from the last map (for @symbol), if known. */
  tagsFor(root: string, rel: string): FileTags | undefined {
    return this.last?.root === root ? this.last.map.tags.get(rel) : undefined;
  }

  private async buildMap(root: string, request: string, mentions: readonly Mention[], budgetTokens: number): Promise<ProjectMap> {
    this.reader ??= TagReader.create(this.paths);
    const reader = await this.reader;
    const secrets = new SecretGuard(this.config.safety);
    const map = await buildProjectMap({
      root,
      reader,
      cache: new MapCache(this.cacheFile(root)),
      ignoredDirs: new Set(this.config.tools.ignoredDirs),
      isSecret: (rel) => secrets.isSecret(rel),
      maxFiles: this.config.context.mapMaxFiles,
      maxFileBytes: this.config.tools.maxFileBytes,
      budgetTokens,
      focus: { request, files: mentions.map((m) => m.rel) },
    });
    this.last = { root, map };
    return map;
  }

  private cacheFile(root: string): string | undefined {
    if (!this.cacheDir) return undefined;
    const id = createHash("sha1").update(path.resolve(root).toLowerCase()).digest("hex").slice(0, 16);
    return path.join(this.cacheDir, `map-${id}.json`);
  }
}
