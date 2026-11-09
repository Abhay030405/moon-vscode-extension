// Which files from the work record changed on disk after the agent read them or the user
// applied them (the user edited them, or another tool did). The agent is told to read them
// again before editing, so it never works from an old copy in its context.
//
// One async stat per file, at most `maxFiles` (newest first), in short slices so the editor
// never waits. Moon's own apply writes the file just before the record notes it, so a small
// tolerance keeps those from counting as changes.

import { stat } from "node:fs/promises";
import * as path from "node:path";
import { STALE_TOLERANCE_MS } from "../shared/constants.js";
import { TimeSlicer } from "../shared/time-slice.js";

export async function staleFiles(root: string, tracked: ReadonlyMap<string, number>, maxFiles: number): Promise<string[]> {
  const newestFirst = [...tracked].sort((a, b) => b[1] - a[1]).slice(0, maxFiles);
  const slicer = new TimeSlicer();
  const stale: string[] = [];
  for (const [rel, at] of newestFirst) {
    await slicer.pause();
    try {
      const info = await stat(path.join(root, rel));
      if (info.mtimeMs > at + STALE_TOLERANCE_MS) stale.push(rel);
    } catch {
      stale.push(`${rel} (deleted)`);
    }
  }
  return stale;
}
