// Retrieval eval (docs/architecture.md section 5): does Moon find the right files when the
// user names none?
//
// For each request in scenarios/retrieval.json, on a fresh Flask checkout:
// 1. Map: where the project map (tree-sitter + ranking, no model) puts the "must" files.
// 2. Agent: a real TrueForge session with the real agent definition (map, rules, scout). The
//    run stops as soon as the agent reports its chosen files (report_context), before any edit.
//    Approvals asked before that are denied, so nothing runs and nothing is applied.
// Scored: how many "must" files were chosen, which were missed, and which extras were added.
//
// Usage (from packages/evals): pnpm retrieval [--set v2] [--model main|backup] [--map-only] [--only <scenario id>] [--trace]
// --trace prints every event of the agent runs (to see what the agent and its scout did).

import { readFileSync } from "node:fs";
import * as path from "node:path";
import {
  AgentRun,
  MapCache,
  SecretGuard,
  TagReader,
  TrueForgeClient,
  buildProjectMap,
  mapBudget,
  modelRef,
  type ApprovalAnswer,
  type MoonConfig,
  type MoonEvent,
} from "@moon/core";
import { EVALS_DIR, evalModel, flag, freshCheckout, loadConfig, saveResults, startLive, treeSitterPaths, type Live } from "./runner";
import { ranksOf, recallAt, scoreRetrieval, type RetrievalScore } from "./scorers";

interface Scenario {
  id: string;
  request: string;
  must: string[];
  ok: string[];
}

interface ScenarioFile {
  repo: string;
  turnTimeoutMs: number;
  scenarios: Scenario[];
}

interface AgentResult {
  chosen: { path: string; reason: string }[];
  score: RetrievalScore;
  /** Why the run ended: reported (report_context), or what happened instead. */
  outcome: "reported" | "no-report" | "timeout" | "error";
  error?: string;
  seconds: number;
  steps: number;
  scoutSteps: number;
  /** Subagents the agent started (TrueForge subagent.started). */
  subagents: number;
  /** edit_file calls before report_context (Moon refuses them; should be rare). */
  editsBeforeReport: number;
  sessionUrl?: string;
}

interface ScenarioResult {
  id: string;
  request: string;
  must: string[];
  mapRanks: Record<string, number | undefined>;
  agent?: AgentResult;
}

const MAP_TOP_K = [5, 10] as const;
const trace = flag("trace") === true;
const DENY_REASON = "Evaluation run: only choosing files is being checked, nothing is run or applied.";

async function main(): Promise<void> {
  const file = JSON.parse(readFileSync(path.join(EVALS_DIR, "scenarios", typeof flag("set") === "string" ? `retrieval-${flag("set")}.json` : "retrieval.json"), "utf8")) as ScenarioFile;
  const only = flag("only");
  const scenarios = file.scenarios.filter((s) => typeof only !== "string" || s.id === only);
  const mapOnly = flag("map-only") === true;
  const config = loadConfig();
  const checkout = freshCheckout(file.repo);
  console.log(`Fresh ${file.repo} at ${checkout.commit}: ${checkout.root}`);

  const client = new TrueForgeClient(config.trueforge);
  const model = evalModel(config);
  const windowTokens = (await client.listModels()).find((m) => m.ref === model)?.contextLength ?? config.context.fallbackContextLength;
  const reader = await TagReader.create(treeSitterPaths());

  const live = mapOnly ? undefined : await startLive(config, client);
  const results: ScenarioResult[] = [];
  try {
    for (const scenario of scenarios) {
      const ranked = await rankedFiles(checkout.root, scenario.request, reader, config, windowTokens);
      const result: ScenarioResult = { id: scenario.id, request: scenario.request, must: scenario.must, mapRanks: ranksOf(ranked, scenario.must) };
      if (live) {
        result.agent = await runAgent(live, checkout.root, scenario, windowTokens, file.turnTimeoutMs);
        if (result.agent.outcome === "error") {
          // A dropped connection to TrueForge is not a retrieval result: try once more.
          console.log(`${scenario.id}: error (${result.agent.error}), trying once more`);
          result.agent = await runAgent(live, checkout.root, scenario, windowTokens, file.turnTimeoutMs);
        }
        const a = result.agent;
        console.log(`${scenario.id}: ${a.outcome}, ${a.score.found.length}/${scenario.must.length} found, ${a.score.extra.length} extra, ${a.seconds}s`);
      } else {
        console.log(`${scenario.id}: map ranks ${JSON.stringify(result.mapRanks)}`);
      }
      results.push(result);
    }
  } finally {
    await live?.close();
    checkout.dispose();
  }

  const meta = { date: new Date().toISOString(), repo: file.repo, commit: checkout.commit, model, windowTokens, mapOnly };
  const saved = saveResults("retrieval", { ...meta, results }, report(meta, results));
  console.log(`\nReport: ${saved.md}\nData:   ${saved.json}`);
}

/** The project map's order of files for this request (what the agent sees first). */
async function rankedFiles(root: string, request: string, reader: TagReader, config: MoonConfig, windowTokens: number): Promise<string[]> {
  const secrets = new SecretGuard(config.safety);
  const map = await buildProjectMap({
    root,
    reader,
    cache: new MapCache(),
    ignoredDirs: new Set(config.tools.ignoredDirs),
    isSecret: (rel) => secrets.isSecret(rel),
    maxFiles: config.context.mapMaxFiles,
    maxFileBytes: config.tools.maxFileBytes,
    budgetTokens: mapBudget(windowTokens, config.context),
    focus: { request, files: [] },
  });
  return map.shown;
}

async function runAgent(live: Live, root: string, scenario: Scenario, windowTokens: number, timeoutMs: number): Promise<AgentResult> {
  const { config } = live;
  const run = await AgentRun.create({ projectRoot: root, config, applyApproved: async () => DENY_REASON });
  live.setRun(run);
  const chat = live.newChat(evalModel(config));
  const readText = (rel: string) => {
    try {
      return readFileSync(path.join(root, rel), "utf8");
    } catch {
      return null;
    }
  };
  const pack = await live.assembler.prepare({ root, request: scenario.request, mentions: [], windowTokens, readText });
  chat.setSessionContext({ openingMessages: [pack.openingMessage], compactAtTokens: pack.compactAtTokens });

  const started = Date.now();
  let chosen: AgentResult["chosen"] | undefined;
  let steps = 0;
  let scoutSteps = 0;
  let subagents = 0;
  let editsBeforeReport = 0;
  let sessionUrl: string | undefined;
  let error: string | undefined;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    chat.stop();
  }, timeoutMs);
  const emit = (event: MoonEvent) => {
    if (event.type === "session") sessionUrl = event.url;
    if (event.type === "notice" && event.text.startsWith("subagent started")) subagents++;
    if (trace && event.type !== "text") console.log("  ", JSON.stringify(event).slice(0, 160));
    if (event.type === "tool-call") {
      steps++;
      if (event.subagent) scoutSteps++;
      if (event.tool === "edit_file" && !chosen) editsBeforeReport++;
    }
    if (event.type === "context-choice" && !chosen) {
      chosen = event.files;
      chat.stop(); // The choice is what is measured; stop before any edit.
    }
    if (event.type === "done" && event.status === "error") error = event.message;
  };

  try {
    await chat.send(scenario.request, emit);
    while (!chosen && !timedOut && chat.waitingFor.length > 0) {
      const answers: ApprovalAnswer[] = chat.waitingFor.map((request) => ({ request, decision: { allow: false, reason: DENY_REASON } }));
      await chat.answer(answers, emit);
    }
  } catch (err) {
    error = (err as Error).message;
  } finally {
    clearTimeout(timer);
    chat.stop();
    live.setRun(undefined);
    await run.dispose();
  }

  const picked = chosen ?? [];
  return {
    chosen: picked,
    score: scoreRetrieval(picked.map((f) => f.path), scenario.must, scenario.ok),
    outcome: chosen ? "reported" : timedOut ? "timeout" : error ? "error" : "no-report",
    error,
    seconds: Math.round((Date.now() - started) / 1000),
    steps,
    scoutSteps,
    subagents,
    editsBeforeReport,
    sessionUrl,
  };
}

function report(meta: { date: string; repo: string; commit: string; model: string; windowTokens: number; mapOnly: boolean }, results: ScenarioResult[]): string {
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  const mean = (values: number[]) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);
  const lines = [
    "# Retrieval eval",
    "",
    `${meta.date} · ${meta.repo} @ ${meta.commit} · model ${meta.model} (window ${meta.windowTokens} tokens)`,
    "",
    "## Summary",
    "",
  ];
  const mapRecall = MAP_TOP_K.map((k) => `recall@${k} ${pct(mean(results.map((r) => recallAt(r.mapRanks, k))))}`);
  lines.push(`- **Project map alone** (no model): ${mapRecall.join(", ")} of the must files.`);
  const agents = results.flatMap((r) => (r.agent ? [r.agent] : []));
  if (agents.length) {
    const found = agents.reduce((n, a) => n + a.score.found.length, 0);
    const must = results.reduce((n, r) => n + (r.agent ? r.must.length : 0), 0);
    const chosenCount = agents.reduce((n, a) => n + a.chosen.length, 0);
    const extras = agents.reduce((n, a) => n + a.score.extra.length, 0);
    lines.push(
      `- **Agent** (map + rules + scout, report_context): ${agents.filter((a) => a.score.pass).length}/${agents.length} requests passed (every must file chosen).`,
      `- Must files found: ${found}/${must} (${pct(must ? found / must : 1)}). Files chosen: ${chosenCount}, of which extras (neither must nor ok): ${extras}.`,
      `- Reported its choice: ${agents.filter((a) => a.outcome === "reported").length}/${agents.length}. Scout used: ${agents.filter((a) => a.subagents > 0 || a.scoutSteps > 0).length}/${agents.length}. Median time to choice: ${median(agents.map((a) => a.seconds))} s.`,
      `- Edits tried before reporting (refused by Moon): ${agents.reduce((n, a) => n + a.editsBeforeReport, 0)}.`,
    );
  }
  lines.push("", "## Per request", "");
  lines.push(
    agents.length
      ? "| Request | Map ranks of must files | Agent found | Missed | Extras | Steps (scout) | Time | Result |"
      : "| Request | Map ranks of must files |",
    agents.length ? "|---|---|---|---|---|---|---|---|" : "|---|---|",
  );
  for (const r of results) {
    const ranks = Object.entries(r.mapRanks).map(([f, n]) => `${short(f)} #${n ?? "-"}`).join(", ");
    if (!r.agent) {
      lines.push(`| ${r.id} | ${ranks} |`);
      continue;
    }
    const a = r.agent;
    const result = a.outcome !== "reported" ? `FAIL (${a.outcome})` : a.score.pass ? "PASS" : "FAIL";
    lines.push(
      `| ${r.id} | ${ranks} | ${a.score.found.length}/${r.must.length} | ${a.score.missed.map(short).join(", ") || "-"} | ${a.score.extra.map(short).join(", ") || "-"} | ${a.steps} (${a.scoutSteps}) | ${a.seconds} s | ${result} |`,
    );
  }
  if (agents.length) {
    lines.push("", "## What the agent chose, with its reasons", "");
    for (const r of results) {
      if (!r.agent) continue;
      lines.push(`### ${r.id}`, "", `> ${r.request}`, "");
      if (r.agent.error) lines.push(`Error: ${r.agent.error}`, "");
      for (const f of r.agent.chosen) lines.push(`- \`${f.path}\`: ${f.reason}`);
      if (r.agent.sessionUrl) lines.push("", `TrueForge session: ${r.agent.sessionUrl}`);
      lines.push("");
    }
  }
  return `${lines.join("\n")}\n`;
}

function short(rel: string): string {
  return rel.replace(/^src\/flask\//, "");
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)]! : 0;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
