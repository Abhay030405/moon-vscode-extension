// Agent definitions (agents/*.json) and TrueForge sessions built from them.
//
// The definition files are TrueForge AgentSpecs with a few placeholders that Moon fills in,
// so the model always comes from config (never hard-coded) and prompts live in .md files:
//   {{model}}       -> "provider/model" chosen for this session (main or backup)
//   {{mcpServer}}   -> mcp.serverName from config
//   {{file:path}}   -> text of that file, relative to the definition's folder

import { readFileSync } from "node:fs";
import * as path from "node:path";
import type { TrueForgeApi } from "@truefoundry/trueforge-sdk";
import type { TrueForgeClient } from "./client.js";

type AgentSpec = TrueForgeApi.AgentSpec;

export interface DefinitionValues {
  model: string;
  mcpServer: string;
}

export class AgentDefinitionError extends Error {
  override readonly name = "AgentDefinitionError";
}

/** Reads an agent definition file and fills in its placeholders. */
export function loadAgentDefinition(file: string, values: DefinitionValues): AgentSpec {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new AgentDefinitionError(`Cannot read agent definition ${file}: ${(err as Error).message}`);
  }
  if (raw && typeof raw === "object") delete (raw as Record<string, unknown>).$comment; // documentation only
  const filled = fillPlaceholders(raw, values, path.dirname(file)) as Record<string, unknown>;
  if (typeof (filled.model as { name?: unknown } | undefined)?.name !== "string") {
    throw new AgentDefinitionError(`Agent definition ${file} has no model.name.`);
  }
  return filled as unknown as AgentSpec;
}

function fillPlaceholders(value: unknown, values: DefinitionValues, baseDir: string): unknown {
  if (typeof value === "string") {
    return value.replace(/\{\{([^}]+)\}\}/g, (_match, key: string) => {
      if (key === "model") return values.model;
      if (key === "mcpServer") return values.mcpServer;
      if (key.startsWith("file:")) return readFileSync(path.join(baseDir, key.slice("file:".length)), "utf8").trim();
      throw new AgentDefinitionError(`Unknown placeholder {{${key}}} in agent definition.`);
    });
  }
  if (Array.isArray(value)) return value.map((v) => fillPlaceholders(v, values, baseDir));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillPlaceholders(v, values, baseDir)]));
  }
  return value;
}

/** Creates a TrueForge session that runs `spec` inline. Returns the session id. */
export async function createSession(client: TrueForgeClient, spec: AgentSpec, title?: string): Promise<string> {
  const response = await client.sdk.sessions.create({ agent: { spec }, ...(title ? { metadata: { title } } : {}) });
  return response.data.id;
}

/** Link to the session in TrueForge's own UI, from trueforge.sessionUrlTemplate. */
export function sessionUrl(template: string, baseUrl: string, sessionId: string): string {
  return template.replaceAll("{baseUrl}", baseUrl.replace(/\/+$/, "")).replaceAll("{sessionId}", sessionId);
}
