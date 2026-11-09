// Stand-in model servers for the resilience eval (OpenAI-compatible, on 127.0.0.1, test only).
// TrueForge calls them like any custom provider; Moon itself never does.
// - "hang": accepts the request and never answers (a model that stopped responding);
// - "ok":   answers every request with the text "OK" (a model that works again).

import { createServer, type Server } from "node:http";

export type FakeMode = "hang" | "ok";

export interface FakeModel {
  /** Base URL to give TrueForge, e.g. http://127.0.0.1:51234/v1 */
  baseUrl: string;
  close(): Promise<void>;
}

export async function startFakeModel(mode: FakeMode): Promise<FakeModel> {
  const open = new Set<import("node:http").ServerResponse>();
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => {
      if (mode === "hang") {
        open.add(res);
        res.on("close", () => open.delete(res));
        return; // never answer
      }
      const stream = safeJson(body)?.stream === true;
      const base = { id: "fake", created: Math.floor(Date.now() / 1000), model: "fake" };
      if (!stream) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ...base, object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const chunk = (delta: object, finish: string | null, extra: object = {}) =>
        res.write(`data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`);
      chunk({ role: "assistant", content: "OK" }, null);
      chunk({}, "stop", { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: () =>
      new Promise((resolve) => {
        for (const res of open) res.destroy();
        server.close(() => resolve());
      }),
  };
}

function safeJson(text: string): { stream?: unknown } | undefined {
  try {
    return JSON.parse(text) as { stream?: unknown };
  } catch {
    return undefined;
  }
}
