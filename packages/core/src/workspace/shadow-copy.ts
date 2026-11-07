// The hidden copy: one full copy of the project per agent run, in the system temp folder.
// The agent reads, edits and runs commands only here; the real project is untouched until
// the user applies reviewed changes.
//
// - Same file names and folders as the project (imports keep working).
// - Made from the editor's text where a file is open (unsaved changes included).
// - Skips ignored folders (.git, .venv, node_modules, ...), symlinks and secret files.
// - Remembers a hash of every file it copied, so it can tell what the agent changed and
//   whether the user edited a real file by hand after the copy was made.

import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { RUN_DIR_REMOVE_RETRIES, RUN_DIR_REMOVE_RETRY_MS, RUNS_TEMP_DIR } from "../shared/constants.js";

export interface ShadowCopyOptions {
  /** The real project folder. */
  projectRoot: string;
  /** Folder names never copied (anywhere in the tree). */
  ignoredDirs: readonly string[];
  /** True for project-relative paths that must not be copied (secrets). */
  isSecret(rel: string): boolean;
  /** Text of a file as open in the editor (unsaved changes included), or undefined. */
  openText?(abs: string): string | undefined;
  maxFiles: number;
  maxBytes: number;
  /** Where copies go. Default: <system temp>/moon-runs. */
  tempRoot?: string;
}

export class ShadowCopyError extends Error {
  override readonly name = "ShadowCopyError";
}

/** sha1 of a file's bytes, used to spot changes. */
export function hashBytes(data: Buffer | string): string {
  return createHash("sha1").update(data).digest("hex");
}

/** Project-relative paths (with "/") of every file to consider, skipping ignored folders and symlinks. */
export function* walkProjectFiles(root: string, ignoredDirs: ReadonlySet<string>): Generator<string> {
  const stack = [""];
  while (stack.length > 0) {
    const relDir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(path.join(root, relDir), { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    const subdirs: string[] = [];
    for (const entry of entries) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!ignoredDirs.has(entry.name)) subdirs.push(rel);
      } else if (entry.isFile()) {
        yield rel;
      }
    }
    for (const sub of subdirs.reverse()) stack.push(sub);
  }
}

export class ShadowCopy {
  private constructor(
    /** The copy's root folder (named like the project). */
    readonly dir: string,
    readonly projectRoot: string,
    /** Hash of each copied file at copy time, by project-relative path. */
    readonly baseline: ReadonlyMap<string, string>,
    private readonly runDir: string,
    readonly ignoredDirs: ReadonlySet<string>,
    readonly isSecret: (rel: string) => boolean,
  ) {}

  static create(options: ShadowCopyOptions): ShadowCopy {
    const ignored = new Set(options.ignoredDirs);
    const files: string[] = [];
    let bytes = 0;
    for (const rel of walkProjectFiles(options.projectRoot, ignored)) {
      if (options.isSecret(rel)) continue;
      files.push(rel);
      if (files.length > options.maxFiles) {
        throw new ShadowCopyError(`The project has more than ${options.maxFiles} files (agentRun.maxCopyFiles), too many to copy.`);
      }
      try {
        bytes += statSync(path.join(options.projectRoot, rel)).size;
      } catch {
        // vanished while walking: copied below or skipped
      }
      if (bytes > options.maxBytes) {
        throw new ShadowCopyError(`The project is larger than ${options.maxBytes} bytes (agentRun.maxCopyBytes), too large to copy.`);
      }
    }

    const runDir = path.join(options.tempRoot ?? path.join(tmpdir(), RUNS_TEMP_DIR), `${Date.now()}-${randomBytes(4).toString("hex")}`);
    const dir = path.join(runDir, path.basename(options.projectRoot));
    const baseline = new Map<string, string>();
    try {
      mkdirSync(dir, { recursive: true });
      for (const rel of files) {
        const from = path.join(options.projectRoot, rel);
        const to = path.join(dir, rel);
        mkdirSync(path.dirname(to), { recursive: true });
        const open = options.openText?.(from);
        try {
          if (open !== undefined) {
            writeFileSync(to, open);
            baseline.set(rel, hashBytes(open));
          } else {
            copyFileSync(from, to);
            baseline.set(rel, hashBytes(readFileSync(to)));
          }
        } catch {
          // unreadable file (locked, vanished): leave it out of the copy
        }
      }
    } catch (err) {
      rmSync(runDir, { recursive: true, force: true });
      throw new ShadowCopyError(`Could not make the hidden copy: ${(err as Error).message}`);
    }
    return new ShadowCopy(dir, options.projectRoot, baseline, runDir, ignored, options.isSecret);
  }

  /** Absolute path inside the copy. */
  copyPath(rel: string): string {
    return path.join(this.dir, rel);
  }

  /** Absolute path inside the real project. */
  projectPath(rel: string): string {
    return path.join(this.projectRoot, rel);
  }

  /** Deletes the copy. Safe to call twice. */
  /** Deletes the copy. Retries while a just-killed command still holds files (Windows). */
  dispose(): void {
    try {
      rmSync(this.runDir, { recursive: true, force: true, maxRetries: RUN_DIR_REMOVE_RETRIES, retryDelay: RUN_DIR_REMOVE_RETRY_MS });
    } catch {
      // Left in the temp folder; the OS cleans it up. Never fail Stop over it.
    }
  }
}
