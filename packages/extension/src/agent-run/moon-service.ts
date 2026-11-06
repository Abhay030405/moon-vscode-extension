// Owns Moon's MCP server for the open folder and creates agent chats on TrueForge.
//
// - The MCP server starts on the first chat (not at VS Code start-up), on a free local port.
// - Before every new TrueForge session Moon re-registers the server's URL with TrueForge
//   (create-or-update, cheap), so a restarted TrueForge or a new port is always picked up.
// - The config is read fresh for each new chat, so edits apply without reloading VS Code.

import * as path from "node:path";
import * as vscode from "vscode";
import {
  AgentChat,
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
import { resolveConfigPath } from "../status/moon-setup.js";

export class MoonService implements vscode.Disposable {
  private server: { root: string; mcp: RunningMcpServer } | undefined;

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

  /** Starts a new chat: loads config, makes sure the MCP server runs and is registered. */
  async createChat(): Promise<AgentChat> {
    const root = this.projectRoot();
    if (!root) throw new Error("Open a folder first: Moon's tools work on the open project.");
    const configPath = resolveConfigPath(this.context);
    const config = loadMoonConfig(configPath);
    const mcp = await this.ensureServer(root, config);

    const client = new TrueForgeClient(config.trueforge);
    await registerMcpServer(client, { name: config.mcp.serverName, url: mcp.url, description: MOON_MCP_DESCRIPTION });

    return new AgentChat({
      client,
      // The definition path in config is relative to the Moon repo root (the folder above config/).
      definitionFile: path.resolve(path.dirname(configPath), "..", config.agent.definitionFile),
      model: modelRef(config.models.main),
      mcpServer: config.mcp.serverName,
      baseUrl: config.trueforge.baseUrl,
      sessionUrlTemplate: config.trueforge.sessionUrlTemplate,
    });
  }

  private async ensureServer(root: string, config: MoonConfig): Promise<RunningMcpServer> {
    if (this.server?.root === root) return this.server.mcp;
    await this.server?.mcp.close();
    const ctx = new ToolContext(root, config);
    const mcp = await startMcpServer(config.mcp, ctx, (call) => {
      const status = call.ok ? "ok" : `refused: ${call.error}`;
      this.output.appendLine(`[tool] ${call.summary} (${call.durationMs} ms) ${status}`);
    });
    this.output.appendLine(`[${new Date().toLocaleTimeString()}] Moon MCP server for ${root} at ${mcp.url}`);
    this.server = { root, mcp };
    return mcp;
  }

  dispose(): void {
    void this.server?.mcp.close();
    this.server = undefined;
  }
}
