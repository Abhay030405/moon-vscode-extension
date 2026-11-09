// Moon's MCP server: a small HTTP server on localhost that TrueForge connects to.
// Stateless streamable HTTP: every request gets a fresh MCP server + transport, which is the
// MCP SDK's recommended pattern when no per-client state is needed.
//
// It serves two endpoints, registered in TrueForge as two MCP servers, because TrueForge does
// not tell a tool which session called it:
// - the editor endpoint (inline edit): tools work on the real project;
// - the agent endpoint (agent mode): tools work in the current run's hidden copy.
//
// TrueForge's own cancel (second stop path): when TrueForge cancels a turn it sends
// `notifications/cancelled {requestId}` as a NEW request. With a fresh server per request that
// notice would never reach the running call, so the server remembers each running tools/call
// (by endpoint and JSON-RPC id) and, on the notice, closes that call's transport: the MCP SDK
// then aborts the tool's signal (run_command kills its process tree).
// TrueForge sends no session header, so ids are only unique per endpoint; the agent endpoint
// serves one run at a time.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { MoonConfig } from "../shared/config.js";
import { AGENT_ENDPOINT_SUFFIX, MCP_MAX_BODY_BYTES, MCP_SERVER_VERSION } from "../shared/constants.js";
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
  /** Tool calls running now (for tests). */
  readonly runningCalls: number;
  close(): Promise<void>;
}

/**
 * The two endpoints' names and paths, from config (agent = editor + "-agent"). With a `scope`
 * (the extension passes the project's key) the names are "<serverName>-<scope>", so two VS Code
 * windows, or a window and an eval, never register the same name in TrueForge: TrueForge finds
 * an MCP server by name, and the last registration would win for everyone.
 */
export function endpointNames(settings: MoonConfig["mcp"], scope?: string): { editor: string; agent: string; editorPath: string; agentPath: string } {
  const editor = scope ? `${settings.serverName}-${scope}` : settings.serverName;
  return {
    editor,
    agent: editor + AGENT_ENDPOINT_SUFFIX,
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
  /** Running tools/call requests ("<path>#<id>") and how to cancel each. */
  const running = new Map<string, () => void>();

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const endpoint = endpoints.find((e) => e.path === url.pathname);
    if (!endpoint) {
      res.writeHead(404).end();
      return;
    }
    let body: unknown;
    if (req.method === "POST") {
      try {
        body = await readJsonBody(req);
      } catch (err) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: (err as Error).message }, id: null }));
        return;
      }
    }
    const messages = (Array.isArray(body) ? body : [body]).filter(isObject);
    for (const message of messages) {
      if (message.method === "notifications/cancelled" && isObject(message.params)) {
        running.get(`${endpoint.path}#${String(message.params.requestId)}`)?.();
      }
    }
    const calls = messages.filter((m) => m.method === "tools/call" && m.id !== undefined).map((m) => `${endpoint.path}#${String(m.id)}`);

    const mcp = new McpServer({ name: endpoint.name, version: MCP_SERVER_VERSION });
    registerMoonTools(mcp, () => endpoint.context(), endpoint.tools, onCall);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      // Only local clients that address us as localhost (blocks DNS-rebinding from web pages).
      enableDnsRebindingProtection: true,
      allowedHosts,
    });
    const forget = () => {
      for (const key of calls) if (running.get(key) === cancel) running.delete(key);
    };
    // Closing the transport aborts the tool's signal. A cancelled request gets no JSON-RPC
    // answer, so the HTTP response is just ended.
    const cancel = () => {
      forget();
      void transport.close();
      if (!res.headersSent) res.writeHead(204);
      res.end();
    };
    for (const key of calls) running.set(key, cancel);
    res.on("close", () => {
      forget();
      void transport.close();
      void mcp.close();
    });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
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
    get runningCalls() {
      return running.size;
    },
    urls: Object.fromEntries(endpoints.map((e) => [e.name, `http://${settings.host}:${port}${e.path}`])),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** Reads a POST body as JSON (the MCP SDK accepts it pre-parsed). */
function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MCP_MAX_BODY_BYTES) {
        reject(new Error(`Request body is larger than ${MCP_MAX_BODY_BYTES} bytes.`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("Request body is not valid JSON."));
      }
    });
    req.on("error", reject);
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
