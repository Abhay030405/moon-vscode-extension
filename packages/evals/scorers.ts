// Scoring for the evals. Plain functions, no I/O, so they are easy to check by hand.

export interface RetrievalScore {
  /** "Must" files the agent chose. */
  found: string[];
  /** "Must" files it did not choose. */
  missed: string[];
  /** Chosen files that are neither "must" nor "ok". */
  extra: string[];
  /** found / must (1 = every right file chosen). */
  recall: number;
  /** Pass rule: every "must" file was chosen. */
  pass: boolean;
}

export function scoreRetrieval(chosen: readonly string[], must: readonly string[], ok: readonly string[]): RetrievalScore {
  const picked = new Set(chosen.map(normalise));
  const allowed = new Set([...must, ...ok].map(normalise));
  const found = must.filter((f) => picked.has(normalise(f)));
  const missed = must.filter((f) => !picked.has(normalise(f)));
  const extra = [...picked].filter((f) => !allowed.has(f));
  const recall = must.length === 0 ? 1 : found.length / must.length;
  return { found, missed, extra, recall, pass: missed.length === 0 };
}

/** Where each "must" file sits in a ranked list (1-based; undefined = not listed). */
export function ranksOf(ranked: readonly string[], must: readonly string[]): Record<string, number | undefined> {
  const index = new Map(ranked.map((f, i) => [normalise(f), i + 1]));
  return Object.fromEntries(must.map((f) => [f, index.get(normalise(f))]));
}

/** Share of "must" files ranked in the top k. */
export function recallAt(ranks: Record<string, number | undefined>, k: number): number {
  const values = Object.values(ranks);
  if (values.length === 0) return 1;
  return values.filter((r) => r !== undefined && r <= k).length / values.length;
}

/** The agent may write "./src/x.py" or "src\\x.py"; compare as "src/x.py". */
function normalise(rel: string): string {
  return rel.replace(/\\/g, "/").replace(/^\.\//, "");
}
