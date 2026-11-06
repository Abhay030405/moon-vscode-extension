// Moon's MCP server: a small HTTP server on localhost that TrueForge connects to.
// Stateless streamable HTTP: every request gets a fresh MCP server + transport, which is the
// MCP SDK's recommended pattern when no per-client state is needed.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { MoonConfig } from "../shared/config.js";
import { MCP_SERVER_VERSION } from "../shared/constants.js";
import type { ToolContext } from "./context.js";
import { registerMoonTools, type ToolCallListener } from "./registry.js";

export interface RunningMcpServer {
  /** URL TrueForge should connect to, e.g. http://127.0.0.1:53211/mcp */
  url: string;
  close(): Promise<void>;
}

export async function startMcpServer(
  settings: MoonConfig["mcp"],
  ctx: ToolContext,
  onCall?: ToolCallListener,
): Promise<RunningMcpServer> {
  let allowedHosts: string[] = [];

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== settings.path) {
      res.writeHead(404).end();
      return;
    }
    const mcp = new McpServer({ name: settings.serverName, version: MCP_SERVER_VERSION });
    registerMoonTools(mcp, ctx, onCall);
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
    url: `http://${settings.host}:${port}${settings.path}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
