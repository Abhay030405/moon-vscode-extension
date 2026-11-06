// Tools may only touch files inside the project folder. Every path an agent sends goes
// through here: "..", absolute paths elsewhere and symlinks that point outside are refused.

import { existsSync, realpathSync } from "node:fs";
import * as path from "node:path";

export class PathGuardError extends Error {
  override readonly name = "PathGuardError";
}

export interface ResolvedPath {
  /** Absolute path on disk. */
  abs: string;
  /** Path relative to the project root, with "/" separators ("" for the root itself). */
  rel: string;
}

export class PathGuard {
  /** Real (symlink-free) absolute path of the project root. */
  readonly root: string;

  constructor(root: string) {
    if (!existsSync(root)) throw new PathGuardError(`Project folder does not exist: ${root}`);
    this.root = realpathSync.native(root);
  }

  /** Resolves a path from the agent (relative to the root, or absolute inside it). */
  resolve(input: string): ResolvedPath {
    const requested = input.trim() === "" ? "." : input.trim();
    const abs = path.resolve(this.root, requested);
    this.assertInside(abs, input);
    // Follow symlinks for paths that exist, so a link can't lead outside the project.
    if (existsSync(abs)) this.assertInside(realpathSync.native(abs), input);
    return { abs, rel: this.toRel(abs) };
  }

  /** Project-relative path with "/" separators. */
  toRel(abs: string): string {
    return path.relative(this.root, abs).split(path.sep).join("/");
  }

  private assertInside(abs: string, original: string): void {
    const rel = path.relative(this.root, abs);
    const outside = rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
    if (outside) throw new PathGuardError(`"${original}" is outside the project folder. Tools can only use files inside it.`);
  }
}
