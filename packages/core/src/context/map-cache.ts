// Cache of each file's tags, so the project map only re-reads files that changed (by size and
// modification time). Kept in Moon's own storage folder, never inside the project.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { MAP_CACHE_VERSION } from "../shared/constants.js";
import type { FileTags } from "./tags.js";

interface Entry {
  size: number;
  mtimeMs: number;
  tags: FileTags | null;
}

export class MapCache {
  private entries = new Map<string, Entry>();
  private dirty = false;

  /** `file` = where the cache is stored (undefined = memory only). */
  constructor(private readonly file?: string) {
    if (!file) return;
    try {
      const data = JSON.parse(readFileSync(file, "utf8")) as { version?: number; files?: Record<string, Entry> };
      if (data.version === MAP_CACHE_VERSION && data.files) this.entries = new Map(Object.entries(data.files));
    } catch {
      // No cache yet (or unreadable): start empty.
    }
  }

  /** Cached tags if the file is unchanged; null = cached as "no tags"; undefined = not cached. */
  get(rel: string, size: number, mtimeMs: number): FileTags | null | undefined {
    const entry = this.entries.get(rel);
    return entry && entry.size === size && entry.mtimeMs === mtimeMs ? entry.tags : undefined;
  }

  set(rel: string, size: number, mtimeMs: number, tags: FileTags | null): void {
    this.entries.set(rel, { size, mtimeMs, tags });
    this.dirty = true;
  }

  /** Drops files that no longer exist. */
  keepOnly(rels: ReadonlySet<string>): void {
    for (const rel of this.entries.keys()) {
      if (!rels.has(rel)) {
        this.entries.delete(rel);
        this.dirty = true;
      }
    }
  }

  save(): void {
    if (!this.file || !this.dirty) return;
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify({ version: MAP_CACHE_VERSION, files: Object.fromEntries(this.entries) }));
      this.dirty = false;
    } catch {
      // The cache only saves time; the map works without it.
    }
  }
}
