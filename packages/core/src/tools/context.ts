// What every tool needs: the project folder (behind the path guard), the secret guard,
// and the limits from config. Plus a safe file walker shared by the tools.

import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import * as path from "node:path";
import { PathGuard } from "../safety/path-guard.js";
import { SecretGuard } from "../safety/secret-guard.js";
import type { MoonConfig } from "../shared/config.js";
import { BINARY_SNIFF_BYTES } from "../shared/constants.js";

export class ToolError extends Error {
  override readonly name = "ToolError";
}

export class ToolContext {
  readonly paths: PathGuard;
  readonly secrets: SecretGuard;
  readonly limits: MoonConfig["tools"];
  private readonly ignoredDirs: Set<string>;

  constructor(root: string, config: Pick<MoonConfig, "tools" | "safety">) {
    this.paths = new PathGuard(root);
    this.secrets = new SecretGuard(config.safety);
    this.limits = config.tools;
    this.ignoredDirs = new Set(config.tools.ignoredDirs);
  }

  /** Resolves a path for reading and refuses secret files. */
  resolveReadable(input: string): { abs: string; rel: string } {
    const resolved = this.paths.resolve(input);
    if (this.secrets.isSecret(resolved.rel)) {
      throw new ToolError(`"${resolved.rel}" may contain secrets (keys, passwords), so Moon's tools do not read it.`);
    }
    return resolved;
  }

  /**
   * Yields project-relative file paths under `startRel`, skipping ignored folders,
   * secret files and symlinks (never followed, so the walk can't leave the project).
   */
  *walkFiles(startRel = ""): Generator<string> {
    const start = this.paths.resolve(startRel);
    const stack: string[] = [start.abs];
    while (stack.length > 0) {
      const dir = stack.pop()!;
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue; // unreadable folder: skip
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      const subdirs: string[] = [];
      for (const entry of entries) {
        const abs = path.join(dir, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          if (!this.ignoredDirs.has(entry.name)) subdirs.push(abs);
          continue;
        }
        if (!entry.isFile()) continue;
        const rel = this.paths.toRel(abs);
        if (!this.secrets.isSecret(rel)) yield rel;
      }
      // Reverse so folders come out in alphabetical order from the stack.
      for (const sub of subdirs.reverse()) stack.push(sub);
    }
  }

  /** True when the file is small enough and not binary, so it is worth searching. */
  isSearchableText(abs: string): boolean {
    try {
      if (statSync(abs).size > this.limits.maxFileBytes) return false;
      return !looksBinary(abs);
    } catch {
      return false;
    }
  }

  /** Caps a tool result at tools.maxOutputChars, saying so when it cut. */
  capOutput(text: string): string {
    const max = this.limits.maxOutputChars;
    if (text.length <= max) return text;
    return `${text.slice(0, max)}\n[... output cut at ${max} characters. Narrow the request to see more.]`;
  }
}

function looksBinary(abs: string): boolean {
  const fd = openSync(abs, "r");
  try {
    const buffer = Buffer.alloc(BINARY_SNIFF_BYTES);
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, read).includes(0);
  } finally {
    closeSync(fd);
  }
}
