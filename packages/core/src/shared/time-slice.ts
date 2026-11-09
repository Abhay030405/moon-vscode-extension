// Long work on VS Code's extension host (copying the project, parsing it for the map) must
// not hold the thread: other extensions, Moon's panel and Stop all run on it too. The work
// calls pause() often; every WORK_SLICE_MS it gives the thread back for one turn.

import { WORK_SLICE_MS } from "./constants.js";

export class TimeSlicer {
  private sliceStart = Date.now();

  constructor(private readonly sliceMs: number = WORK_SLICE_MS) {}

  /** Returns at once inside a slice; after it, waits one event-loop turn. */
  async pause(): Promise<void> {
    if (Date.now() - this.sliceStart < this.sliceMs) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
    this.sliceStart = Date.now();
  }
}

/** Runs `work` on every item, at most `limit` at a time (for file I/O). */
export async function forEachLimited<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await work(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
