// Moon's MCP server: a small HTTP server on localhost that TrueForge connects to.
// Stateless streamable HTTP: every request gets a fresh MCP server + transport, which is the
// MCP SDK's recommended pattern when no per-client state is needed.
//
// It serves two endpoints, registered in TrueForge as two MCP servers, because TrueForge does
// not tell a tool which session called it:
// - the editor endpoint (inline edit): tools work on the real project;
// - the agent endpoint (agent mode): tools work in the current run's hidden copy.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { MoonConfig } from "../shared/config.js";
import { AGENT_ENDPOINT_SUFFIX, MCP_SERVER_VERSION } from "../shared/constants.js";
import type { ToolContext } from "./context.js";
import { registerMoonTools, type ToolCallListener } from "./registry.js";
import type { MoonTool } from "./tool.js";

export interface McpEndpoint {
  /** Name TrueForge knows this endpoint by. */
  name: string;
  /** URL path, e.g. "/mcp". */
  path: string;
  tools: readonly MoonTool[];
  /** The tools' context for each call (undefined = refuse: nothing to work on). */
  context(): ToolContext | undefined;
}

export interface RunningMcpServer {
  /** Full URL of each endpoint, by endpoint name, e.g. http://127.0.0.1:53211/mcp */
  urls: Record<string, string>;
  close(): Promise<void>;
}

/** The two endpoints' names and paths, from config (agent = editor + "-agent"). */
export function endpointNames(settings: MoonConfig["mcp"]): { editor: string; agent: string; editorPath: string; agentPath: string } {
  return {
    editor: settings.serverName,
    agent: settings.serverName + AGENT_ENDPOINT_SUFFIX,
    editorPath: settings.path,
    agentPath: settings.path + AGENT_ENDPOINT_SUFFIX,
  };
}

export async function startMcpServer(
  settings: MoonConfig["mcp"],
  endpoints: readonly McpEndpoint[],
  onCall?: ToolCallListener,
): Promise<RunningMcpServer> {
  let allowedHosts: string[] = [];

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const endpoint = endpoints.find((e) => e.path === url.pathname);
    if (!endpoint) {
      res.writeHead(404).end();
      return;
    }
    const mcp = new McpServer({ name: endpoint.name, version: MCP_SERVER_VERSION });
    registerMoonTools(mcp, () => endpoint.context(), endpoint.tools, onCall);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      // Only local clients that address us as localhost (blocks DNS-rebinding from web pages).
      enableDnsRebindingProtection: true,
      allowedHosts,
    });
    res.on("close", () => {
      void transport.close();
      void mcp.close();
    });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: String(err) }, id: null }));
      }
    }
  };

  const server: Server = createServer((req, res) => void handle(req, res));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(settings.port, settings.host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const { port } = server.address() as AddressInfo;
  allowedHosts = [`${settings.host}:${port}`, `localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`];

  return {
    urls: Object.fromEntries(endpoints.map((e) => [e.name, `http://${settings.host}:${port}${e.path}`])),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
