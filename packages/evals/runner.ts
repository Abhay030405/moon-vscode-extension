// Shared pieces for the evals: where things are, a fresh checkout of a test repo, saving results.
// Evals run from the command line against the real TrueForge (no VS Code).

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  AGENT_TOOLS,
  AgentChat,
  CONFIG_DIR,
  CONFIG_FILE_NAME,
  ContextAssembler,
  EDITOR_TOOLS,
  MOON_MCP_DESCRIPTION,
  endpointNames,
  loadMoonConfig,
  modelRef,
  registerMcpServer,
  startMcpServer,
  type AgentRun,
  type MoonConfig,
  type TagReaderPaths,
  type TrueForgeClient,
} from "@moon/core";

/** The evals run from a bundle in packages/evals/dist. */
export const EVALS_DIR = path.resolve(__dirname, "..");
export const REPO_ROOT = path.resolve(EVALS_DIR, "..", "..");
export const RESULTS_DIR = path.join(EVALS_DIR, "results");

/**
 * Added to mcp.serverName for the evals' own MCP server. TrueForge finds an MCP server by its
 * name, so an eval registering under the extension's name would take over the user's open
 * VS Code chats (their tool calls would reach the eval's test checkout instead of their project).
 */
const EVAL_SERVER_SUFFIX = "-eval";

/** Moon's config, with the evals' own MCP server name (see EVAL_SERVER_SUFFIX). */
export function loadConfig(): MoonConfig {
  const config = loadMoonConfig(path.join(REPO_ROOT, CONFIG_DIR, CONFIG_FILE_NAME));
  return { ...config, mcp: { ...config.mcp, serverName: `${config.mcp.serverName}${EVAL_SERVER_SUFFIX}` } };
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

/**
 * Makes `root` a git repo with one commit of everything, so `gitStatus` can show what changed
 * (the evals check that a stopped or failed run leaves the project exactly as it was).
 */
export function gitBaseline(root: string): void {
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
  git("init", "--quiet");
  git("add", "--all");
  git("-c", "user.name=moon-eval", "-c", "user.email=moon-eval@localhost", "commit", "--quiet", "--no-gpg-sign", "-m", "baseline");
}

/** `git status --porcelain` of `root` (empty = unchanged). */
export function gitStatus(root: string): string {
  return execFileSync("git", ["-C", root, "status", "--porcelain"], { stdio: "pipe" }).toString().trim();
}

/** Process ids whose command line contains `marker` (to find commands left running). */
export function processesWith(marker: string): number[] {
  const out =
    process.platform === "win32"
      ? execFileSync("powershell", [
          "-NoProfile",
          "-Command",
          `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${marker}*' -and $_.CommandLine -notlike '*Get-CimInstance*' } | Select-Object -ExpandProperty ProcessId`,
        ])
      : execFileSync("ps", ["-A", "-o", "pid=,args="]);
  const lines = out.toString().split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (process.platform === "win32") return lines.map(Number).filter((n) => n > 0);
  return lines.filter((l) => l.includes(marker) && !l.includes("ps -A")).map((l) => Number(l.split(/\s+/)[0]));
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

/** Moon's side of a live eval: its MCP server registered in TrueForge, serving one run at a time. */
export interface Live {
  config: MoonConfig;
  client: TrueForgeClient;
  assembler: ContextAssembler;
  /** The run whose hidden copy the agent tools work in (undefined = refuse calls). */
  setRun(run: AgentRun | undefined): void;
  /** A new TrueForge chat with the committed agent definition and the main model. */
  newChat(model?: string): AgentChat;
  close(): Promise<void>;
}

export async function startLive(config: MoonConfig, client: TrueForgeClient): Promise<Live> {
  const names = endpointNames(config.mcp);
  let active: AgentRun | undefined;
  const mcp = await startMcpServer(config.mcp, [
    { name: names.editor, path: names.editorPath, tools: EDITOR_TOOLS, context: () => undefined },
    { name: names.agent, path: names.agentPath, tools: AGENT_TOOLS, context: () => active?.tools },
  ]);
  await registerMcpServer(client, { name: names.agent, url: mcp.urls[names.agent]!, description: MOON_MCP_DESCRIPTION });
  return {
    config,
    client,
    assembler: new ContextAssembler(treeSitterPaths(), undefined, config),
    setRun: (run) => (active = run),
    newChat: (model = modelRef(config.models.main)) =>
      new AgentChat({
        client,
        definitionFile: path.join(REPO_ROOT, config.agent.definitionFile),
        model,
        mcpServer: names.agent,
        baseUrl: config.trueforge.baseUrl,
        sessionUrlTemplate: config.trueforge.sessionUrlTemplate,
      }),
    close: () => mcp.close(),
  };
}
