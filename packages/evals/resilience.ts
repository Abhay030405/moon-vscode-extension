// Resilience eval (Task C): break the main model in TrueForge, repeat Task A (inline edit of
// get_debug_flag), and check that the backup model takes over by itself.
//
// Each scenario adds throwaway `moon-test-*` providers to TrueForge (deleted at the end, even on
// failure) and runs Task A through ResilientChat, the same code the extension uses:
// - bad-key:  the main model is the backup's endpoint with an invalid key (401);
// - dead:     the main model's address has nothing listening;
// - hang:     the main model accepts the request and never answers (the watchdog catches it);
// - both:     main and backup both broken: one clear message, nothing changed, no switch loop;
// - back:     after a fallback the main provider is fixed in TrueForge; Moon notices the settings
//             change, checks the main model, and the next task switches back to it.
// For every scenario: `git status` of a fresh Flask checkout stays empty (an inline edit only
// proposes; nothing is written before review).
//
// The eval never reads or sends a real API key: the broken providers get a dummy key, and the
// working model is the backup exactly as configured in TrueForge.
//
// Usage (from packages/evals): pnpm resilience [--only <scenario>] [--trace]

import * as path from "node:path";
import {
  AgentChat,
  EDITOR_TOOLS,
  MOON_MCP_DESCRIPTION,
  ModelRouter,
  ResilientChat,
  ToolContext,
  TrueForgeClient,
  buildInlinePrompt,
  endpointNames,
  modelRef,
  probeModel,
  registerMcpServer,
  startMcpServer,
  type MoonConfig,
  type MoonEvent,
} from "@moon/core";
import { readFileSync } from "node:fs";
import { startFakeModel, type FakeModel } from "./fake-model";
import { REPO_ROOT, flag, freshCheckout, gitBaseline, gitStatus, loadConfig, saveResults } from "./runner";

type Scenario = "bad-key" | "dead" | "hang" | "both" | "back";
const SCENARIOS: Scenario[] = ["bad-key", "dead", "hang", "both", "back"];

const TASK_A = {
  file: "src/flask/helpers.py",
  symbol: "get_debug_flag",
  instruction: "Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false.",
};

/** Pass marks (ms): a fast failure must hand over this quickly; a hang within the watchdog plus this. */
const LIMITS = { fastSwitchMs: 15000, hangGraceMs: 5000, recoverMs: 60000 };

const TEST_PREFIX = "moon-test-";
const DUMMY_KEY = "moon-test-invalid-key";

interface ScenarioResult {
  scenario: Scenario;
  switched: boolean;
  /** Request sent -> model-switch event (ms). */
  switchMs?: number;
  proposal: boolean;
  finalStatus: string;
  finalMessage?: string;
  gitClean: boolean;
  /** "back" only: the next task switched back to the main model. */
  switchedBack?: boolean;
  pass: boolean;
  notes: string[];
}

const trace = flag("trace") === true;

async function main(): Promise<void> {
  const config = loadConfig();
  const client = new TrueForgeClient(config.trueforge);
  const only = flag("only");
  const scenarios = typeof only === "string" ? SCENARIOS.filter((s) => s === only) : SCENARIOS;
  if (scenarios.length === 0) throw new Error(`Unknown scenario "${String(only)}". One of: ${SCENARIOS.join(", ")}`);

  const providers = new Providers(config);
  const backupInfo = await providers.backupModel();
  const fakes: FakeModel[] = [];
  const checkout = freshCheckout("flask");
  gitBaseline(checkout.root);
  const tools = new ToolContext(checkout.root, config);
  const names = endpointNames(config.mcp);
  const mcp = await startMcpServer(config.mcp, [{ name: names.editor, path: names.editorPath, tools: EDITOR_TOOLS, context: () => tools }]);
  await registerMcpServer(client, { name: names.editor, url: mcp.urls[names.editor]!, description: MOON_MCP_DESCRIPTION });

  const results: ScenarioResult[] = [];
  try {
    for (const scenario of scenarios) {
      console.log(`\n== ${scenario}`);
      const result = await runScenario(scenario, { config, client, tools, checkoutRoot: checkout.root, providers, backupInfo, fakes });
      results.push(result);
      console.log(`${result.pass ? "PASS" : "FAIL"} ${scenario}: switched=${result.switched}${result.switchMs !== undefined ? ` in ${result.switchMs} ms` : ""}, proposal=${result.proposal}, status=${result.finalStatus}, git clean=${result.gitClean}${result.switchedBack !== undefined ? `, switched back=${result.switchedBack}` : ""}`);
      for (const note of result.notes) console.log(`   ${note}`);
    }
  } finally {
    await providers.deleteAll();
    for (const fake of fakes) await fake.close();
    await mcp.close();
    checkout.dispose();
  }

  const passed = results.filter((r) => r.pass).length;
  const report = [
    `# Resilience eval (Task C)`,
    ``,
    `Main model broken in TrueForge, Task A repeated. Backup: \`${modelRef(config.models.backup)}\`. Watchdog ${config.resilience.watchdogMs} ms.`,
    ``,
    `| Scenario | Switched | Switch time | Proposal | Final | git clean | Pass |`,
    `|---|---|---|---|---|---|---|`,
    ...results.map((r) => `| ${r.scenario} | ${r.switched ? "yes" : "no"}${r.switchedBack !== undefined ? ` (back: ${r.switchedBack ? "yes" : "no"})` : ""} | ${r.switchMs !== undefined ? `${(r.switchMs / 1000).toFixed(1)} s` : "-"} | ${r.proposal ? "yes" : "no"} | ${r.finalStatus}${r.finalMessage ? `: ${r.finalMessage.replaceAll("|", "/")}` : ""} | ${r.gitClean ? "yes" : "no"} | ${r.pass ? "PASS" : "FAIL"} |`),
    ``,
    `**${passed}/${results.length} passed.**`,
  ].join("\n");
  const saved = saveResults("resilience", results, report);
  console.log(`\n${passed}/${results.length} passed. Report: ${saved.md}`);
  if (passed !== results.length) process.exitCode = 1;
}

interface Env {
  config: MoonConfig;
  client: TrueForgeClient;
  tools: ToolContext;
  checkoutRoot: string;
  providers: Providers;
  backupInfo: BackupModel;
  fakes: FakeModel[];
}

async function runScenario(scenario: Scenario, env: Env): Promise<ScenarioResult> {
  const { config, providers, backupInfo } = env;
  const realBackup = modelRef(config.models.backup);
  const notes: string[] = [];
  let main: string;
  let backup = realBackup;

  if (scenario === "bad-key") {
    main = await providers.put("bad-key", backupInfo.baseUrl, backupInfo);
  } else if (scenario === "dead") {
    main = await providers.put("dead", "http://127.0.0.1:1/v1", backupInfo);
  } else if (scenario === "hang") {
    const fake = await startFakeModel("hang");
    env.fakes.push(fake);
    main = await providers.put("hang", fake.baseUrl, backupInfo);
  } else if (scenario === "both") {
    main = await providers.put("bad-key", backupInfo.baseUrl, backupInfo);
    backup = await providers.put("dead", "http://127.0.0.1:1/v1", backupInfo);
  } else {
    main = await providers.put("back", "http://127.0.0.1:1/v1", backupInfo);
  }

  const makeChat = (model: string) =>
    new AgentChat({
      client: env.client,
      definitionFile: path.join(REPO_ROOT, config.agent.inlineDefinitionFile),
      model,
      mcpServer: endpointNames(config.mcp).editor,
      baseUrl: config.trueforge.baseUrl,
      sessionUrlTemplate: config.trueforge.sessionUrlTemplate,
      watchdog: { firstReplyMs: config.resilience.watchdogMs, stallMs: config.resilience.stallMs },
    });
  const router = new ModelRouter({ main, backup }, config.resilience.circuitBreaker, (model) => probeModel(makeChat(model)));
  try {
    const first = await runTaskA(env, router, makeChat, notes);
    const gitClean = gitStatus(env.checkoutRoot) === "";
    const result: ScenarioResult = { scenario, ...first, gitClean, pass: false, notes };

    if (scenario === "both") {
      result.pass = !first.proposal && first.finalStatus === "error" && /Every model failed/.test(first.finalMessage ?? "") && first.attempts === 2 && gitClean;
      return result;
    }
    const switchLimit = scenario === "hang" ? config.resilience.watchdogMs + LIMITS.hangGraceMs : LIMITS.fastSwitchMs;
    result.pass = first.switched && (first.switchMs ?? Infinity) <= switchLimit && first.proposal && first.finalStatus === "done" && gitClean;
    if (scenario !== "back") return result;

    // "Fix" the main provider in TrueForge: point it at a model that answers.
    const ok = await startFakeModel("ok");
    env.fakes.push(ok);
    await providers.put("back", ok.baseUrl, backupInfo);
    const fixedAt = Date.now();
    router.settingsChanged(); // what the extension does when the provider's fingerprint changes
    while (router.state !== "recovered" && Date.now() - fixedAt < LIMITS.recoverMs) await sleep(250);
    notes.push(`main model ${router.state} ${Date.now() - fixedAt} ms after the fix`);
    const second = await runTaskA(env, router, makeChat, notes);
    result.switchedBack = second.backEvent && second.firstModel === main && second.finalStatus === "done";
    result.gitClean = result.gitClean && gitStatus(env.checkoutRoot) === "";
    result.pass = result.pass && result.switchedBack && result.gitClean;
    return result;
  } finally {
    router.dispose();
  }
}

interface TaskOutcome {
  switched: boolean;
  switchMs?: number;
  backEvent: boolean;
  firstModel: string;
  attempts: number;
  proposal: boolean;
  finalStatus: string;
  finalMessage?: string;
}

/** Task A as the inline edit sends it, through ResilientChat. */
async function runTaskA(
  env: Env,
  router: ModelRouter,
  makeChat: (model: string) => AgentChat,
  notes: string[],
): Promise<TaskOutcome> {
  const { config, tools } = env;
  const text = readFileSync(path.join(env.checkoutRoot, TASK_A.file), "utf8");
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith(`def ${TASK_A.symbol}`));
  let end = start + 1;
  while (end < lines.length && (lines[end] === "" || /^\s/.test(lines[end]!))) end++;
  const prompt = buildInlinePrompt(
    { instruction: TASK_A.instruction, rel: TASK_A.file, languageId: "python", text, startLine: start, endLine: end - 1, problems: [] },
    { contextLines: config.inline.contextLines, maxProblems: config.inline.maxProblems },
  );

  let proposal: string | undefined;
  tools.inlineTarget = { rel: TASK_A.file, onProposal: (p) => (proposal = p) };
  let attempts = 0;
  const models: string[] = [];
  const chat = new ResilientChat({
    router,
    makeChat: (model) => {
      attempts++;
      models.push(model);
      return makeChat(model);
    },
    settings: config.resilience,
    beforeRestart: () => {
      proposal = undefined;
    },
    log: (line) => notes.push(line),
  });
  // The chat is made on router.current; a task that switches back replaces it at send.
  attempts = 0;
  models.length = 0;

  const sentAt = Date.now();
  const outcome: TaskOutcome = { switched: false, backEvent: false, firstModel: chat.model, attempts: 0, proposal: false, finalStatus: "none" };
  try {
    await chat.send(prompt, (event: MoonEvent) => {
      if (trace) console.log(`   [${Date.now() - sentAt} ms] ${JSON.stringify(event).slice(0, 200)}`);
      if (event.type === "model-switch" && event.direction === "fallback" && !outcome.switched) {
        outcome.switched = true;
        outcome.switchMs = Date.now() - sentAt;
      }
      if (event.type === "model-switch" && event.direction === "back") outcome.backEvent = true;
      if (event.type === "done") {
        outcome.finalStatus = event.status;
        outcome.finalMessage = event.message;
      }
    });
  } finally {
    chat.stop();
    tools.inlineTarget = undefined;
  }
  // A switch back replaced the first chat at send: the task really started on that model.
  if (outcome.backEvent) outcome.firstModel = models[0]!;
  // The first chat counts as an attempt when no switch-back replaced it.
  outcome.attempts = attempts + (outcome.backEvent ? 0 : 1);
  outcome.proposal = proposal !== undefined;
  return outcome;
}

interface BackupModel {
  baseUrl: string;
  modelId: string;
  properties: { context_length?: number; max_output_tokens?: number };
}

/** Throwaway providers in TrueForge. Reads only addresses and model ids, never keys. */
class Providers {
  private readonly made = new Set<string>();
  private readonly api: string;

  constructor(private readonly config: MoonConfig) {
    this.api = `${config.trueforge.baseUrl}/api/v1/settings/model-providers`;
  }

  /** The backup model's endpoint and id (the broken providers copy them, with a dummy key). */
  async backupModel(): Promise<BackupModel> {
    const res = await fetch(this.api);
    if (!res.ok) throw new Error(`TrueForge provider list failed: HTTP ${res.status}`);
    const list = (await res.json()) as { data: { name: string; manifest: { base_url?: string; models: { name: string; model_id: string; properties: BackupModel["properties"] }[] } }[] };
    const { provider, model } = this.config.models.backup;
    const entry = list.data.find((p) => p.name === provider);
    const m = entry?.manifest.models.find((x) => x.name === model);
    if (!entry?.manifest.base_url || !m) throw new Error(`Backup model ${provider}/${model} is not an OpenAI-compatible provider in TrueForge.`);
    return { baseUrl: entry.manifest.base_url, modelId: m.model_id, properties: { context_length: m.properties.context_length, max_output_tokens: m.properties.max_output_tokens } };
  }

  /** Creates or replaces `moon-test-<name>`; returns its "provider/model" ref. */
  async put(name: string, baseUrl: string, model: BackupModel): Promise<string> {
    const provider = `${TEST_PREFIX}${name}`;
    const modelName = "test-model";
    const manifest = {
      type: "custom",
      name: provider,
      base_url: baseUrl,
      auth: { api_key: DUMMY_KEY },
      models: [{ model_id: model.modelId, name: modelName, properties: model.properties }],
    };
    const res = await fetch(this.api, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ manifest }) });
    if (!res.ok) throw new Error(`Could not create test provider ${provider}: HTTP ${res.status} ${await res.text()}`);
    this.made.add(provider);
    return `${provider}/${modelName}`;
  }

  async deleteAll(): Promise<void> {
    for (const provider of this.made) {
      const res = await fetch(`${this.api}/${encodeURIComponent(provider)}`, { method: "DELETE" }).catch(() => undefined);
      if (!res?.ok) console.log(`Could not delete test provider ${provider}; remove it in TrueForge's settings.`);
    }
    this.made.clear();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exitCode = 1;
});
