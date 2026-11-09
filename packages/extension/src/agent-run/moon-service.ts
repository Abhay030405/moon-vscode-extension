// Owns Moon's MCP server for the open folder and creates agent chats and inline edits on TrueForge.
//
// - The MCP server starts on the first chat (not at VS Code start-up), on a free local port.
// - It has two endpoints, registered in TrueForge as two MCP servers: the editor endpoint
//   (inline edit, works on the real project) and the agent endpoint (agent mode, works in the
//   current agent run's hidden copy; refuses calls when no run is active).
// - Before every new TrueForge session Moon re-registers the server's URL with TrueForge
//   (create-or-update, cheap), so a restarted TrueForge or a new port is always picked up.
// - The config is read fresh for each new chat, so edits apply without reloading VS Code.
// - Every chat is a ResilientChat: if the main model fails, the same request moves to the
//   backup model automatically. One ModelRouter per window (shared by inline edit and agent
//   mode) remembers a failing main model, checks it in the background, and re-checks at once
//   when its provider settings change in TrueForge (e.g. the key was fixed).

import * as path from "node:path";
import * as vscode from "vscode";
import {
  STATUS_MESSAGE_MS,
  AgentChat,
  ModelRouter,
  probeModel,
  ResilientChat,
  type BreakerState,
  ContextAssembler,
  AGENT_TOOLS,
  AgentRun,
  EDITOR_TOOLS,
  endpointNames,
  loadMoonConfig,
  modelRef,
  MOON_MCP_DESCRIPTION,
  registerMcpServer,
  startMcpServer,
  ToolContext,
  TrueForgeClient,
  checkExtras,
  withExtras,
  newConversationId,
  projectKey,
  sessionLabels,
  WORK_RECORDS_DIR,
  WorkRecordStore,
  type SessionKind,
  type MoonConfig,
  type RunningMcpServer,
} from "@moon/core";
import type { PanelSettings } from "@moon/webview-ui/protocol";
import { VsCodeEditorBridge } from "../editor-bridge/editor-bridge.js";
import { resolveConfigPath } from "../status/moon-setup.js";

/** Hooks a chat's owner gives for the automatic fallback. */
export interface ChatHooks {
  /** Before the same request restarts on the other model: throw away the failed attempt's work. */
  beforeRestart?(): Promise<void> | void;
  /** Moon's conversation id for the sessions' labels (agent mode; a new one when left out). */
  conversation?: string;
  /** The work record, for the new session after a model switch. */
  workNote?(): string | undefined;
}

/** The MCP server names carry this many characters of the project's key (see endpointNames). */
const PROJECT_SCOPE_CHARS = 8;

function projectScope(root: string): string {
  return projectKey(root).slice(0, PROJECT_SCOPE_CHARS);
}

/** Folder inside dist/ with the tree-sitter files (copied by scripts/copy-tree-sitter.mjs). */
const TREE_SITTER_DIR = "tree-sitter";

export class MoonService implements vscode.Disposable {
  private server: { root: string; mcp: RunningMcpServer; tools: ToolContext } | undefined;
  /** The agent run the agent endpoint's tools work in (one at a time: the panel's chat). */
  private activeRun: AgentRun | undefined;
  /** Builds the project map and @-mention context (one per window; its cache is in Moon's storage). */
  private assembler: ContextAssembler | undefined;
  /** Main/backup choice for this window; rebuilt when the models in config change. */
  private router: { key: string; router: ModelRouter } | undefined;
  /** While the main model is failing: watches its provider settings in TrueForge. */
  private settingsWatch: ReturnType<typeof setInterval> | undefined;
  /** Each conversation's work record, in Moon's storage folder. */
  readonly records: WorkRecordStore;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
  ) {
    this.records = new WorkRecordStore(path.join(context.globalStorageUri.fsPath, WORK_RECORDS_DIR));
  }

  /** TrueForge, the config and this project's key, for the chat history. */
  history(): { client: TrueForgeClient; config: MoonConfig; project: string } {
    const root = this.projectRoot();
    if (!root) throw new Error("Open a folder first: Moon's history belongs to the open project.");
    const config = loadMoonConfig(resolveConfigPath(this.context));
    return { client: new TrueForgeClient(config.trueforge), config, project: projectKey(root) };
  }

  /** The folder Moon's tools work on: the first workspace folder. */
  projectRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  /** What the panel shows before a chat starts. Empty values if the config can't be read. */
  panelSettings(): Omit<PanelSettings, "type" | "projectName"> {
    try {
      const { ui, models } = loadMoonConfig(resolveConfigPath(this.context));
      return {
        typing: { charsPerSecond: ui.typingCharsPerSecond, maxLagMs: ui.typingMaxLagMs },
        model: modelRef(models.main),
      };
    } catch {
      return { typing: undefined, model: undefined };
    }
  }

  /**
   * Starts a new chat in the Moon panel (agent mode), with the context assembler and the main
   * model's window size (from TrueForge, or context.fallbackContextLength).
   */
  async createChat(hooks: ChatHooks = {}): Promise<{ chat: ResilientChat; config: MoonConfig; assembler: ContextAssembler; windowTokens: number }> {
    const prepared = await this.prepare("agent", hooks);
    return { ...prepared, assembler: this.contextAssembler(prepared.config), windowTokens: await this.windowTokens(prepared.config) };
  }

  /** The context assembler (also used by the panel's @ picker before a chat starts). */
  contextAssembler(config: MoonConfig = loadMoonConfig(resolveConfigPath(this.context))): ContextAssembler {
    const dir = vscode.Uri.joinPath(this.context.extensionUri, "dist", TREE_SITTER_DIR).fsPath;
    this.assembler ??= new ContextAssembler(
      {
        grammarDir: dir,
        queryDir: path.join(dir, "queries"),
        runtimeWasm: path.join(dir, "tree-sitter.wasm"),
      },
      this.context.globalStorageUri.fsPath,
      config,
    );
    return this.assembler;
  }

  /** The main model's context window as TrueForge reports it, else the configured fallback. */
  private async windowTokens(config: MoonConfig): Promise<number> {
    try {
      const models = await new TrueForgeClient(config.trueforge).listModels();
      const main = models.find((m) => m.ref === modelRef(config.models.main));
      if (main?.contextLength) return main.contextLength;
    } catch {
      // TrueForge unreachable: the chat itself will report that.
    }
    return config.context.fallbackContextLength;
  }

  /** Points the agent endpoint's tools at this run (undefined = refuse calls). */
  setActiveRun(run: AgentRun | undefined): void {
    this.activeRun = run;
  }

  /**
   * Starts a new inline edit (Ctrl+I). Also returns the tool context, so the caller can say
   * which file propose_edit may change and receive the proposal.
   */
  async createInlineEdit(hooks: ChatHooks = {}): Promise<{ chat: ResilientChat; tools: ToolContext; config: MoonConfig }> {
    return this.prepare("inline", hooks);
  }

  /** Loads config, makes sure the MCP server runs and is registered, and creates the chat. */
  private async prepare(kind: "agent" | "inline", hooks: ChatHooks): Promise<{ chat: ResilientChat; tools: ToolContext; config: MoonConfig }> {
    const root = this.projectRoot();
    if (!root) throw new Error("Open a folder first: Moon's tools work on the open project.");
    const configPath = resolveConfigPath(this.context);
    const config = loadMoonConfig(configPath);
    const server = await this.ensureServer(root, config);

    const client = new TrueForgeClient(config.trueforge);
    const names = endpointNames(config.mcp, projectScope(root));
    // Create-or-update by name: cheap, and done again before every turn (beforeTurn below).
    const register = async () => {
      for (const name of [names.editor, names.agent]) {
        await registerMcpServer(client, { name, url: server.mcp.urls[name]!, description: MOON_MCP_DESCRIPTION });
      }
    };
    await register();

    // Agent mode only: web search and GitHub, if on in config and present in TrueForge.
    const extras = kind === "agent" ? await checkExtras(client, config.extras) : undefined;
    for (const problem of extras?.problems ?? []) {
      this.output.appendLine(`[${new Date().toLocaleTimeString()}] [extras] ${problem}`);
      vscode.window.setStatusBarMessage(`$(info) Moon: ${problem}`, STATUS_MESSAGE_MS);
    }

    const project = projectKey(root);
    const conversation = hooks.conversation ?? newConversationId();
    const makeChat = (chatKind: "agent" | "inline", model: string, labelKind: SessionKind = chatKind) => {
      const definition = chatKind === "agent" ? config.agent.definitionFile : config.agent.inlineDefinitionFile;
      return new AgentChat({
        client,
        // The definition path in config is relative to the Moon repo root (the folder above config/).
        definitionFile: path.resolve(path.dirname(configPath), "..", definition),
        model,
        mcpServer: chatKind === "agent" ? names.agent : names.editor,
        baseUrl: config.trueforge.baseUrl,
        sessionUrlTemplate: config.trueforge.sessionUrlTemplate,
        watchdog: { firstReplyMs: config.resilience.watchdogMs, stallMs: config.resilience.stallMs },
        // Probes get their own conversation id, so they never join a chat in the history.
        labels: (title) => sessionLabels({ project, conversation: labelKind === "probe" ? newConversationId() : conversation, kind: labelKind, model, title }),
        adjustSpec: chatKind === "agent" && extras ? (spec) => withExtras(spec, extras, config.extras) : undefined,
        beforeTurn: register,
        moonServerPrefix: config.mcp.serverName,
      });
    };
    const router = this.routerFor(config, (model) => probeModel(makeChat("inline", model, "probe")));
    const chat = new ResilientChat({
      router,
      makeChat: (model) => makeChat(kind, model),
      settings: config.resilience,
      beforeRestart: hooks.beforeRestart,
      workNote: hooks.workNote,
      log: (line) => this.output.appendLine(`[${new Date().toLocaleTimeString()}] ${line}`),
    });
    return { chat, tools: server.tools, config };
  }

  /** The window's model router, made again when the main or backup model in config changes. */
  private routerFor(config: MoonConfig, probe: (model: string) => Promise<boolean>): ModelRouter {
    const models = { main: modelRef(config.models.main), backup: modelRef(config.models.backup) };
    const key = `${models.main} ${models.backup}`;
    if (this.router?.key === key) return this.router.router;
    this.router?.router.dispose();
    this.stopSettingsWatch();
    const router = new ModelRouter(models, config.resilience.circuitBreaker, probe, (state) => this.onBreaker(state, config));
    this.router = { key, router };
    return router;
  }

  /**
   * While the main model is failing, watch its provider in TrueForge (cheap: no model call);
   * a change (key or address fixed) re-checks the main model at once.
   */
  private onBreaker(state: BreakerState, config: MoonConfig): void {
    const main = modelRef(config.models.main);
    const words = { open: `main model ${main} failing: using the backup, checking it in the background`, recovered: `main model ${main} answers again: next task uses it`, closed: `using the main model ${main}` };
    this.output.appendLine(`[${new Date().toLocaleTimeString()}] [models] ${words[state]}`);
    if (state === "open") vscode.window.setStatusBarMessage(`$(arrow-swap) Moon: main model failing, using the backup ${modelRef(config.models.backup)}`, STATUS_MESSAGE_MS);
    if (state === "recovered") vscode.window.setStatusBarMessage(`$(check) Moon: main model ${main} answers again`, STATUS_MESSAGE_MS);
    if (state !== "open") return this.stopSettingsWatch();
    const client = new TrueForgeClient(config.trueforge);
    let last: string | undefined;
    const check = async () => {
      try {
        const now = await client.providerFingerprint(config.models.main.provider);
        if (last !== undefined && now !== last) {
          this.output.appendLine(`[${new Date().toLocaleTimeString()}] [models] ${config.models.main.provider} settings changed in TrueForge: checking the main model now`);
          this.router?.router.settingsChanged();
        }
        last = now;
      } catch {
        // TrueForge not reachable right now: try again at the next check.
      }
    };
    this.stopSettingsWatch();
    void check();
    this.settingsWatch = setInterval(() => void check(), config.trueforge.statusCheckIntervalMs);
  }

  private stopSettingsWatch(): void {
    if (this.settingsWatch) clearInterval(this.settingsWatch);
    this.settingsWatch = undefined;
  }

  private async ensureServer(root: string, config: MoonConfig): Promise<{ mcp: RunningMcpServer; tools: ToolContext }> {
    if (this.server?.root === root) return this.server;
    await this.server?.mcp.close();
    const tools = new ToolContext(root, config);
    tools.editor = new VsCodeEditorBridge(root);
    const names = endpointNames(config.mcp, projectScope(root));
    const endpoints = [
      { name: names.editor, path: names.editorPath, tools: EDITOR_TOOLS, context: () => tools },
      { name: names.agent, path: names.agentPath, tools: AGENT_TOOLS, context: () => this.activeRun?.tools },
    ];
    const mcp = await startMcpServer(config.mcp, endpoints, (call) => {
      const status = call.ok ? "ok" : `refused: ${call.error}`;
      this.output.appendLine(`[tool] ${call.summary} (${call.durationMs} ms) ${status}`);
    });
    this.output.appendLine(`[${new Date().toLocaleTimeString()}] Moon MCP server for ${root} at ${Object.values(mcp.urls).join(", ")}`);
    this.server = { root, mcp, tools };
    return this.server;
  }

  dispose(): void {
    this.stopSettingsWatch();
    this.router?.router.dispose();
    void this.server?.mcp.close();
    this.server = undefined;
  }
}
