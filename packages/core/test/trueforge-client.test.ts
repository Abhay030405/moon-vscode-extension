import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { CONFIG_DIR, EXAMPLE_CONFIG_FILE_NAME, loadMoonConfig, TrueForgeClient } from "../src/index.js";

const example = loadMoonConfig(
  fileURLToPath(new URL(`../../../${CONFIG_DIR}/${EXAMPLE_CONFIG_FILE_NAME}`, import.meta.url)),
);

// What TrueForge returns from GET /api/v1/settings/model-providers (keys are redacted by TrueForge).
const providersBody = {
  data: [
    {
      name: example.models.main.provider,
      manifest: {
        type: "anthropic",
        auth: { api_key: "***REDACTED***" },
        models: [
          {
            model_id: example.models.main.model,
            name: example.models.main.model,
            properties: { context_length: 1000000, max_output_tokens: 128000 },
          },
        ],
      },
    },
  ],
};

let server: Server | undefined;
afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

/** Starts a fake TrueForge; `handler` decides how each request is answered. */
async function fakeTrueForge(handler: Parameters<typeof createServer>[1]): Promise<string> {
  server = createServer(handler);
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

/** A URL where nothing is listening. */
async function deadUrl(): Promise<string> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}

const client = (baseUrl: string, requestTimeoutMs = example.trueforge.requestTimeoutMs) =>
  new TrueForgeClient({ ...example.trueforge, baseUrl, requestTimeoutMs });

describe("TrueForgeClient", () => {
  it("lists models with their window sizes", async () => {
    const url = await fakeTrueForge((req, res) => {
      expect(req.url).toBe("/api/v1/settings/model-providers");
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(providersBody));
    });
    const status = await client(url).checkConnection();
    expect(status).toEqual({
      state: "connected",
      models: [
        {
          provider: example.models.main.provider,
          name: example.models.main.model,
          ref: `${example.models.main.provider}/${example.models.main.model}`,
          modelId: example.models.main.model,
          contextLength: 1000000,
          maxOutputTokens: 128000,
        },
      ],
    });
  });

  it("reports which configured models TrueForge has", async () => {
    const url = await fakeTrueForge((_req, res) =>
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(providersBody)),
    );
    const report = await client(url).checkSetup(example.models);
    expect(report.configuredModels.map((m) => [m.role, Boolean(m.found)])).toEqual([
      ["main", true],
      ["backup", false],
    ]);
  });

  it("says unreachable when nothing is listening", async () => {
    const status = await client(await deadUrl()).checkConnection();
    expect(status.state).toBe("unreachable");
  });

  it("says unreachable when TrueForge never answers", async () => {
    const url = await fakeTrueForge(() => {
      /* accept the request and never reply */
    });
    const status = await client(url, 200).checkConnection();
    expect(status.state).toBe("unreachable");
  });

  it("reports an HTTP error from TrueForge with its status code", async () => {
    const url = await fakeTrueForge((_req, res) =>
      res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ message: "boom" })),
    );
    const status = await client(url).checkConnection();
    expect(status).toMatchObject({ state: "error", statusCode: 500 });
  });
});
