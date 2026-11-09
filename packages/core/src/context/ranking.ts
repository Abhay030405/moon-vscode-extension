// Which files matter most, for the project map. The idea is Aider's repo map (PageRank over
// "file A uses a name that file B defines"), written from scratch and kept small:
// - every file starts with a little rank; files that match the request start with more
//   (their path or a name they define contains a word from the request, or the user @-named it);
// - rank then flows along references: a file used by many important files becomes important.
// Inside a file, names used by other files come first.

import {
  RANK_DAMPING,
  RANK_EXACT_NAME_WEIGHT,
  RANK_FOCUS_BOOST,
  RANK_FOCUS_SHARE,
  RANK_ITERATIONS,
  RANK_MAX_SUFFIX_LENGTH,
  RANK_MIN_PREFIX_LENGTH,
  RANK_MIN_WORD_LENGTH,
  RANK_NAME_WORD_WEIGHT,
  RANK_STOP_WORDS,
} from "../shared/constants.js";
import { TimeSlicer } from "../shared/time-slice.js";
import type { Definition, FileTags } from "./tags.js";

export interface RankFocus {
  /** The user's request (its words tilt the ranking). */
  request: string;
  /** Files the user @-named. */
  files: readonly string[];
}

export interface RankedFile {
  rel: string;
  score: number;
  /** The file's definitions, most used by other files first. */
  defs: Definition[];
}

/**
 * Ranks every file; `tags` holds the files that could be parsed. Async only to pause in short
 * slices: a project with thousands of files takes a few hundred ms in total.
 */
export async function rankFiles(
  allFiles: readonly string[],
  tags: ReadonlyMap<string, FileTags>,
  focus: RankFocus,
  slicer: TimeSlicer = new TimeSlicer(),
): Promise<RankedFile[]> {
  const index = new Map(allFiles.map((rel, i) => [rel, i]));
  const n = allFiles.length;
  if (n === 0) return [];

  // Who defines each name.
  const definers = new Map<string, string[]>();
  for (const [rel, fileTags] of tags) {
    await slicer.pause();
    for (const name of new Set(fileTags.defs.map((d) => d.name))) {
      const list = definers.get(name) ?? [];
      list.push(rel);
      definers.set(name, list);
    }
  }

  // Edges: from the file that uses a name to the files that define it.
  const edges: { from: number; to: number; weight: number }[] = [];
  const usedBy = new Map<string, Set<string>>(); // "rel:name" -> files using it
  for (const [rel, fileTags] of tags) {
    await slicer.pause();
    for (const [name, count] of Object.entries(fileTags.refs)) {
      const targets = (definers.get(name) ?? []).filter((t) => t !== rel);
      for (const target of targets) {
        edges.push({ from: index.get(rel)!, to: index.get(target)!, weight: Math.sqrt(count) / targets.length });
        const key = `${target}:${name}`;
        if (!usedBy.has(key)) usedBy.set(key, new Set());
        usedBy.get(key)!.add(rel);
      }
    }
  }

  // Starting rank: a little for every file, more for files that match the request.
  const weights = wordWeights(requestWords(focus.request), allFiles, tags);
  const mentioned = new Set(focus.files);
  // Most of the starting rank goes to files that match the request (or were @-named); the rest
  // is spread evenly, so files with no match can still rise through references.
  const identifiers = requestIdentifiers(focus.request);
  const match: number[] = [];
  for (const rel of allFiles) {
    await slicer.pause();
    match.push(matchStrength(rel, tags.get(rel), weights, identifiers) + (mentioned.has(rel) ? RANK_EXACT_NAME_WEIGHT : 0));
  }
  const matchSum = match.reduce((a, b) => a + b, 0);
  const focusShare = matchSum > 0 ? RANK_FOCUS_SHARE : 0;
  const personal = match.map((m) => (1 - focusShare) / n + (matchSum > 0 ? (focusShare * m) / matchSum : 0));

  const outWeight = new Array<number>(n).fill(0);
  for (const e of edges) outWeight[e.from]! += e.weight;

  let rank = [...personal];
  for (let round = 0; round < RANK_ITERATIONS; round++) {
    await slicer.pause();
    const next = personal.map((p) => (1 - RANK_DAMPING) * p);
    let dangling = 0;
    rank.forEach((r, i) => {
      if (outWeight[i] === 0) dangling += r;
    });
    for (let i = 0; i < n; i++) next[i]! += RANK_DAMPING * dangling * personal[i]!;
    for (const e of edges) next[e.to]! += (RANK_DAMPING * rank[e.from]! * e.weight) / outWeight[e.from]!;
    rank = next;
  }

  // The request decides the order among related files: a file's rank is multiplied by how
  // well it matches (the best match gets RANK_FOCUS_BOOST times its rank, others less).
  const bestMatch = Math.max(0, ...match);
  const boosted = rank.map((r, i) => (bestMatch > 0 ? r * (1 + (RANK_FOCUS_BOOST * match[i]!) / bestMatch) : r));

  return allFiles
    .map((rel, i) => {
      const defs = [...(tags.get(rel)?.defs ?? [])].sort(
        (a, b) => (usedBy.get(`${rel}:${b.name}`)?.size ?? 0) - (usedBy.get(`${rel}:${a.name}`)?.size ?? 0) || a.line - b.line,
      );
      return { rel, score: boosted[i]!, defs };
    })
    .sort((a, b) => b.score - a.score || a.rel.localeCompare(b.rel));
}

/** Lower-case words of the request, split also at snake_case and camelCase. */
export function requestWords(text: string): Set<string> {
  return new Set(splitWords(text).filter((w) => w.length >= RANK_MIN_WORD_LENGTH && !RANK_STOP_WORDS.has(w)));
}

/**
 * Each request word's weight: 1 / the number of files it matches. A word found in almost every
 * file (like the project's own name) tells nothing; a rare one (like "cli") tells a lot.
 */
export function wordWeights(words: ReadonlySet<string>, allFiles: readonly string[], tags: ReadonlyMap<string, FileTags>): Map<string, number> {
  const weights = new Map<string, number>();
  for (const word of words) {
    const single = new Set([word]);
    const hits = allFiles.filter((rel) => fileWords(rel, tags.get(rel)).some((w) => matches(w, single))).length;
    if (hits > 0) weights.set(word, 1 / hits);
  }
  return weights;
}

/**
 * How well a file matches the request: a name from the request that the file defines exactly
 * (like get_debug_flag) counts most, then request words in its path, then words in its names.
 */
export function matchStrength(rel: string, tags: FileTags | undefined, weights: ReadonlyMap<string, number>, identifiers: ReadonlySet<string>): number {
  let strength = 0;
  for (const def of tags?.defs ?? []) if (identifiers.has(def.name)) strength += RANK_EXACT_NAME_WEIGHT;
  for (const [word, weight] of weights) {
    const single = new Set([word]);
    if (pathWords(rel).some((w) => matches(w, single))) strength += weight;
    else if ((tags?.defs ?? []).some((d) => splitWords(d.name).some((w) => matches(w, single)))) strength += weight * RANK_NAME_WORD_WEIGHT;
  }
  return strength;
}

/** Code names written in the request (with "_" or camelCase, like get_debug_flag or runCommand). */
export function requestIdentifiers(text: string): Set<string> {
  return new Set((text.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []).filter((t) => t.length >= RANK_MIN_PREFIX_LENGTH && /_|[a-z][A-Z]/.test(t)));
}

function pathWords(rel: string): string[] {
  return splitWords(rel.replace(/\.[^./]+$/, ""));
}

function fileWords(rel: string, tags: FileTags | undefined): string[] {
  return [...pathWords(rel), ...(tags?.defs ?? []).flatMap((d) => splitWords(d.name))];
}

function matches(word: string, words: ReadonlySet<string>): boolean {
  if (word.length < RANK_MIN_WORD_LENGTH) return false;
  for (const w of words) {
    if (w === word) return true;
    // Same word with an ending ("test" / "tests", "command" / "commands"), not "cli" / "client".
    const [short, long] = w.length < word.length ? [w, word] : [word, w];
    if (short.length >= RANK_MIN_PREFIX_LENGTH && long.startsWith(short) && long.length - short.length <= RANK_MAX_SUFFIX_LENGTH) return true;
  }
  return false;
}

function splitWords(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}
