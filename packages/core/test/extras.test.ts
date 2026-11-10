import { describe, expect, it } from "vitest";
import { checkExtras, withExtras, type TrueForgeClient } from "../src/index.js";

const notFound = Object.assign(new Error("Not found"), { statusCode: 404 });

function fakeClient(has: { webSearch: boolean; servers: string[] }) {
  const calls: string[] = [];
  const client = {
    sdk: {
      settings: {
        webSearchProviders: {
          get: async () => {
            calls.push("web");
            if (!has.webSearch) throw notFound;
            return { data: { name: "parallel", manifest: { type: "parallel", auth: { apiKey: "***" } } } };
          },
        },
        mcpServers: {
          get: async (name: string) => {
            calls.push(`mcp:${name}`);
            if (!has.servers.includes(name)) throw notFound;
            return { data: { name } };
          },
        },
      },
    },
  } as unknown as TrueForgeClient;
  return { client, calls };
}

const tools = ["get_issue", "search_code", "create_pull_request"];
const off = { webSearch: false, github: { enabled: false, serverName: "github", enableTools: tools } };
const on = { webSearch: true, github: { enabled: true, serverName: "github", enableTools: tools } };
const spec = { model: { name: "p/m" }, mcpServers: [{ name: "moon-agent" }], config: { iterationLimit: 60 } } as never;

describe("extras (web search, GitHub)", () => {
  it("asks TrueForge nothing and changes nothing when both are off", async () => {
    const { client, calls } = fakeClient({ webSearch: true, servers: ["github"] });
    const check = await checkExtras(client, off);
    expect(calls).toEqual([]);
    expect(withExtras(spec, check, off)).toBe(spec);
  });

  it("adds web search and the GitHub server (only the listed tools; writes need approval, also by name) when TrueForge has them", async () => {
    const { client } = fakeClient({ webSearch: true, servers: ["github"] });
    const check = await checkExtras(client, on);
    expect(check).toEqual({ webSearch: true, github: true, problems: [] });
    const result = withExtras(spec, check, on) as { config: unknown; mcpServers: unknown[] };
    expect(result.config).toEqual({ iterationLimit: 60, webSearch: { enabled: true } });
    expect(result.mcpServers).toEqual([
      { name: "moon-agent" },
      { name: "github", enableTools: tools, requireApprovalForTools: ["@write", "@destructive", "create_pull_request"] },
    ]);
  });

  it("leaves out what TrueForge does not have, and says why", async () => {
    const { client } = fakeClient({ webSearch: false, servers: [] });
    const check = await checkExtras(client, on);
    expect(check.webSearch).toBe(false);
    expect(check.github).toBe(false);
    expect(check.problems.join(" ")).toMatch(/no web search provider.*no MCP server named "github"/);
    expect(withExtras(spec, check, on)).toBe(spec);
  });
});
