// Shared pieces for the evals: where things are, a fresh checkout of a test repo, saving results.
// Evals run from the command line against the real TrueForge (no VS Code).

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { CONFIG_DIR, CONFIG_FILE_NAME, loadMoonConfig, type MoonConfig, type TagReaderPaths } from "@moon/core";

/** The evals run from a bundle in packages/evals/dist. */
export const EVALS_DIR = path.resolve(__dirname, "..");
export const REPO_ROOT = path.resolve(EVALS_DIR, "..", "..");
export const RESULTS_DIR = path.join(EVALS_DIR, "results");

export function loadConfig(): MoonConfig {
  return loadMoonConfig(path.join(REPO_ROOT, CONFIG_DIR, CONFIG_FILE_NAME));
}

/** tree-sitter's runtime, grammars and Moon's tag queries (as in core's tests). */
export function treeSitterPaths(): TagReaderPaths {
  const fromCore = createRequire(path.join(REPO_ROOT, "packages", "core", "package.json"));
  return {
    grammarDir: path.join(path.dirname(fromCore.resolve("tree-sitter-wasms/package.json")), "out"),
    queryDir: path.join(REPO_ROOT, "packages", "core", "queries"),
    runtimeWasm: path.join(path.dirname(fromCore.resolve("web-tree-sitter")), "tree-sitter.wasm"),
  };
}

interface TestRepo {
  name: string;
  commit: string;
  dir: string;
}

/**
 * A clean copy of a test repo at its pinned commit (config/test-repos.json), in a temp folder.
 * Made with `git archive`, so the user's checkout (and any changes in it) is never touched.
 */
export function freshCheckout(name: string): { root: string; commit: string; dispose(): void } {
  const list = JSON.parse(readFileSync(path.join(REPO_ROOT, CONFIG_DIR, "test-repos.json"), "utf8")) as { repos: TestRepo[] };
  const repo = list.repos.find((r) => r.name === name);
  if (!repo) throw new Error(`No test repo named "${name}" in ${CONFIG_DIR}/test-repos.json.`);
  const source = path.join(REPO_ROOT, repo.dir);
  const temp = mkdtempSync(path.join(tmpdir(), `moon-eval-${name}-`));
  const archive = path.join(temp, "checkout.tar");
  const root = path.join(temp, name);
  mkdirSync(root);
  try {
    execFileSync("git", ["-C", source, "archive", "--format=tar", "-o", archive, repo.commit], { stdio: "pipe" });
    // Relative paths: GNU tar (Git Bash on Windows) reads "C:" in a path as a remote host.
    execFileSync("tar", ["-xf", path.basename(archive), "-C", name], { cwd: temp, stdio: "pipe" });
  } catch (err) {
    rmSync(temp, { recursive: true, force: true });
    throw new Error(`Could not check out ${name} at ${repo.commit} from ${source} (clone it first; see README): ${(err as Error).message}`);
  }
  rmSync(archive, { force: true });
  return { root, commit: repo.commit, dispose: () => rmSync(temp, { recursive: true, force: true }) };
}

/** Saves <name>-<time>.json and .md in results/ and returns their paths. */
export function saveResults(name: string, data: unknown, report: string): { json: string; md: string } {
  mkdirSync(RESULTS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const json = path.join(RESULTS_DIR, `${name}-${stamp}.json`);
  const md = path.join(RESULTS_DIR, `${name}-${stamp}.md`);
  writeFileSync(json, JSON.stringify(data, null, 2));
  writeFileSync(md, report);
  return { json, md };
}

/** Command-line flags: --name value or --name. */
export function flag(name: string): string | true | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const next = process.argv[i + 1];
  return next && !next.startsWith("--") ? next : true;
}
