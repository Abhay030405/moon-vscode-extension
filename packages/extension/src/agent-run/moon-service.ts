// Owns Moon's MCP server for the open folder and creates agent chats and inline edits on TrueForge.
//
// - The MCP server starts on the first chat (not at VS Code start-up), on a free local port.
// - It has two endpoints, registered in TrueForge as two MCP servers: the editor endpoint
//   (inline edit, works on the real project) and the agent endpoint (agent mode, works in the
//   current agent run's hidden copy; refuses calls when no run is active).
// - Before every new TrueForge session Moon re-registers the server's URL with TrueForge
//   (create-or-update, cheap), so a restarted TrueForge or a new port is always picked up.
// - The config is read fresh for each new chat, so edits apply without reloading VS Code.

import * as path from "node:path";
import * as vscode from "vscode";
import {
  AgentChat,
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
  type MoonConfig,
  type RunningMcpServer,
} from "@moon/core";
import type { PanelSettings } from "@moon/webview-ui/protocol";
import { VsCodeEditorBridge } from "../editor-bridge/editor-bridge.js";
import { resolveConfigPath } from "../status/moon-setup.js";

export class MoonService implements vscode.Disposable {
  private server: { root: string; mcp: RunningMcpServer; tools: ToolContext } | undefined;
  /** The agent run the agent endpoint's tools work in (one at a time: the panel's chat). */
  private activeRun: AgentRun | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
  ) {}

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

  /** Starts a new chat in the Moon panel (agent mode). */
  async createChat(): Promise<{ chat: AgentChat; config: MoonConfig }> {
    return this.prepare("agent");
  }

  /** Points the agent endpoint's tools at this run (undefined = refuse calls). */
  setActiveRun(run: AgentRun | undefined): void {
    this.activeRun = run;
  }

  /**
   * Starts a new inline edit (Ctrl+I). Also returns the tool context, so the caller can say
   * which file propose_edit may change and receive the proposal.
   */
  async createInlineEdit(): Promise<{ chat: AgentChat; tools: ToolContext; config: MoonConfig }> {
    return this.prepare("inline");
  }

  /** Loads config, makes sure the MCP server runs and is registered, and creates the chat. */
  private async prepare(kind: "agent" | "inline"): Promise<{ chat: AgentChat; tools: ToolContext; config: MoonConfig }> {
    const root = this.projectRoot();
    if (!root) throw new Error("Open a folder first: Moon's tools work on the open project.");
    const configPath = resolveConfigPath(this.context);
    const config = loadMoonConfig(configPath);
    const server = await this.ensureServer(root, config);

    const client = new TrueForgeClient(config.trueforge);
    const names = endpointNames(config.mcp);
    for (const name of [names.editor, names.agent]) {
      await registerMcpServer(client, { name, url: server.mcp.urls[name]!, description: MOON_MCP_DESCRIPTION });
    }

    const definition = kind === "agent" ? config.agent.definitionFile : config.agent.inlineDefinitionFile;
    const chat = new AgentChat({
      client,
      // The definition path in config is relative to the Moon repo root (the folder above config/).
      definitionFile: path.resolve(path.dirname(configPath), "..", definition),
      model: modelRef(config.models.main),
      mcpServer: kind === "agent" ? names.agent : names.editor,
      baseUrl: config.trueforge.baseUrl,
      sessionUrlTemplate: config.trueforge.sessionUrlTemplate,
    });
    return { chat, tools: server.tools, config };
  }

  private async ensureServer(root: string, config: MoonConfig): Promise<{ mcp: RunningMcpServer; tools: ToolContext }> {
    if (this.server?.root === root) return this.server;
    await this.server?.mcp.close();
    const tools = new ToolContext(root, config);
    tools.editor = new VsCodeEditorBridge(root);
    const names = endpointNames(config.mcp);
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
    void this.server?.mcp.close();
    this.server = undefined;
  }
}
