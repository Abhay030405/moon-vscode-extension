// Tells TrueForge where Moon's MCP server is. The server picks a free port on every start,
// so Moon re-registers (create-or-update by name) each time it starts or TrueForge comes back.

import type { TrueForgeClient } from "./client.js";

export interface McpRegistration {
  name: string;
  url: string;
  description: string;
  /** Headers TrueForge sends on every request (Moon's per-start token). */
  headers?: Record<string, string>;
}

export async function registerMcpServer(client: TrueForgeClient, registration: McpRegistration): Promise<void> {
  await client.sdk.settings.mcpServers.createOrUpdate({
    manifest: {
      type: "remote",
      name: registration.name,
      url: registration.url,
      description: registration.description,
      ...(registration.headers ? { auth: { type: "header" as const, headers: registration.headers } } : {}),
    },
  });
}
