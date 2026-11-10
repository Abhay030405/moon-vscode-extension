// Optional TrueForge features for agent mode (Phase 6B), both off by default in config/moon.json:
// - extras.webSearch: TrueForge's built-in web_search / web_fetch tools. They need a web search
//   provider (Parallel) set in TrueForge's settings, with a key the user enters there. Moon only
//   checks that a provider exists; it never reads or sends the key.
// - extras.github: GitHub's MCP server, registered in TrueForge by the user under
//   extras.github.serverName. Its write and destructive tools pause for approval (Moon's
//   generic approval card).
// Each is added to the agent definition only if TrueForge has it; otherwise Moon says why.

import type { TrueForgeApi } from "@truefoundry/trueforge-sdk";
import type { MoonConfig } from "../shared/config.js";
import type { TrueForgeClient } from "./client.js";

/** Tools of the GitHub server that pause for the user's approval (TrueForge's selectors). */
const GITHUB_APPROVAL_SELECTORS = ["@write", "@destructive"];
/**
 * GitHub tools that change something, named outright too: the selectors above depend on the
 * server's annotations, which Moon could not verify for a remote server.
 */
const GITHUB_WRITE_TOOL = /^(create|add|update|merge|delete|push|fork|close|assign|request|submit|dismiss|remove)_/;

export interface ExtrasCheck {
  webSearch: boolean;
  github: boolean;
  /** One line per extra that is on in config but missing in TrueForge. */
  problems: string[];
}

/** Which extras that are on in config TrueForge can actually serve. */
export async function checkExtras(client: TrueForgeClient, extras: MoonConfig["extras"]): Promise<ExtrasCheck> {
  const check: ExtrasCheck = { webSearch: false, github: false, problems: [] };
  if (extras.webSearch) {
    try {
      // The response carries the provider's settings with its key redacted; Moon only needs to know it exists.
      await client.sdk.settings.webSearchProviders.get();
      check.webSearch = true;
    } catch (err) {
      check.problems.push(
        isNotFound(err)
          ? "Web search is on in Moon's config, but no web search provider is set in TrueForge (Settings, Web search). The agent works without it."
          : `Web search is off for this chat: TrueForge's web search settings could not be read (${(err as Error).message}).`,
      );
    }
  }
  if (extras.github.enabled) {
    try {
      await client.sdk.settings.mcpServers.get(extras.github.serverName);
      check.github = true;
    } catch (err) {
      check.problems.push(
        isNotFound(err)
          ? `GitHub is on in Moon's config, but TrueForge has no MCP server named "${extras.github.serverName}". The agent works without it.`
          : `GitHub is off for this chat: TrueForge's MCP servers could not be read (${(err as Error).message}).`,
      );
    }
  }
  return check;
}

/** The agent definition with the extras TrueForge can serve. */
export function withExtras(spec: TrueForgeApi.AgentSpec, check: ExtrasCheck, extras: MoonConfig["extras"]): TrueForgeApi.AgentSpec {
  let result = spec;
  if (check.webSearch) result = { ...result, config: { ...result.config, webSearch: { enabled: true } } };
  if (check.github) {
    const github: TrueForgeApi.McpServer = {
      name: extras.github.serverName,
      // An explicit list (OWASP LLM03 #1, LLM04): a tool the server adds later is never on by itself.
      enableTools: extras.github.enableTools,
      requireApprovalForTools: [...GITHUB_APPROVAL_SELECTORS, ...extras.github.enableTools.filter((t) => GITHUB_WRITE_TOOL.test(t))],
    };
    result = { ...result, mcpServers: [...(result.mcpServers ?? []), github] };
  }
  return result;
}

function isNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { statusCode?: unknown }).statusCode === 404;
}
