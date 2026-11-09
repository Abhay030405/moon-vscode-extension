import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentChat, type MoonEvent, type TrueForgeClient } from "../src/index.js";

const DEFINITION = path.resolve(__dirname, "../../../agents/moon-agent.json");

/**
 * A fake TrueForge: every turn gets a new id; a turn whose input says "hang" streams until it is
 * aborted. `refuse` lists previous-turn ids TrueForge refuses to continue from.
 */
function fakeTrueForge(refuse: string[] = []) {
  const opened: string[] = [];
  const labels: Record<string, string>[] = [];
  const updates: { model: string; servers: string[] }[] = [];
  let registered = 0;
  let next = 0;
  const sessions = {
    create: async (body: { metadata?: Record<string, string> }) => {
      labels.push(body.metadata ?? {});
      return { data: { id: "s1" } };
    },
    cancel: async () => ({}),
    get: async () => ({ data: { agent: { spec: { model: { name: "old/model" }, mcpServers: [{ name: "moon-editor-agent" }, { name: "github" }] } } } }),
    update: async (_id: string, body: { agent: { spec: { model: { name: string }; mcpServers: { name: string }[] } } }) => {
      updates.push({ model: body.agent.spec.model.name, servers: body.agent.spec.mcpServers.map((s) => s.name) });
      return {};
    },
    createTurnStream: async (_id: string, body: { input: { content?: string }[]; previousTurnId: string }, options: { abortSignal: AbortSignal }) => {
      opened.push(body.previousTurnId);
      if (refuse.includes(body.previousTurnId)) throw new Error("previous turn is not finished");
      const turnId = `t${++next}`;
      const hang = body.input.some((i) => i.content === "hang");
      return (async function* () {
        yield { type: "turn.created", turnId };
        if (hang) {
          await new Promise((_, reject) => options.abortSignal.addEventListener("abort", () => reject(new Error("aborted"))));
        }
        yield { type: "turn.done", id: "d", threadId: null, state: { status: "done", output: null, requiredActions: [] } };
      })();
    },
  };
  const client = { sdk: { sessions } } as unknown as TrueForgeClient;
  return { client, opened, labels, updates, registrations: () => registered, register: async () => void registered++ };
}

function chatOn(client: TrueForgeClient, beforeTurn?: () => Promise<void>) {
  return new AgentChat({
    beforeTurn,
    moonServerPrefix: "moon-editor",
    client,
    definitionFile: DEFINITION,
    model: "p/m",
    mcpServer: "moon-editor-abc-agent",
    baseUrl: "http://x",
    sessionUrlTemplate: "{baseUrl}/{sessionId}",
    labels: (title) => ({ "moon.title": title }),
  });
}

async function sendAndStop(chat: AgentChat, events: MoonEvent[]) {
  const sending = chat.send("hang", (e) => events.push(e));
  await new Promise((r) => setTimeout(r, 10));
  chat.stop();
  await sending;
}

describe("AgentChat", () => {
  it("labels the new session with the first message", async () => {
    const { client, labels } = fakeTrueForge();
    await chatOn(client).send("add a config command\nmore text", () => {});
    expect(labels).toEqual([{ "moon.title": "add a config command" }]);
  });

  it("continues from the stopped turn, so the agent keeps what it did before Stop", async () => {
    const { client, opened } = fakeTrueForge();
    const chat = chatOn(client);
    await chat.send("first", () => {}); // t1 finishes
    const events: MoonEvent[] = [];
    await sendAndStop(chat, events); // t2 stopped
    expect(events.at(-1)).toEqual({ type: "done", status: "cancelled" });
    await chat.send("continue", () => {});
    expect(opened).toEqual(["none", "t1", "t2"]);
  });

  it("falls back to the last finished turn when TrueForge refuses the stopped one", async () => {
    const { client, opened } = fakeTrueForge(["t2"]);
    const chat = chatOn(client);
    await chat.send("first", () => {});
    await sendAndStop(chat, []);
    const events: MoonEvent[] = [];
    await chat.send("continue", (e) => events.push(e));
    expect(opened).toEqual(["none", "t1", "t2", "t1"]);
    expect(events.at(-1)).toMatchObject({ type: "done", status: "done" });
  });

  it("continues an attached session from its last turn (or fresh if refused), on the current model and server name", async () => {
    const { client, opened, updates } = fakeTrueForge(["old"]);
    const chat = chatOn(client);
    chat.attach("s9", "old");
    await chat.send("again", () => {});
    expect(opened).toEqual(["old", "none"]);
    // Moon's server renamed, others (GitHub) kept; the model is the chat's.
    expect(updates).toEqual([{ model: "p/m", servers: ["moon-editor-abc-agent", "github"] }]);
  });

  it("re-registers Moon's server before every turn and changes model in place", async () => {
    const fake = fakeTrueForge();
    const chat = chatOn(fake.client, fake.register);
    await chat.send("first", () => {});
    chat.switchModel("p/other");
    await chat.send("second", () => {});
    expect(fake.registrations()).toBe(2);
    expect(fake.updates).toEqual([{ model: "p/other", servers: ["moon-editor-abc-agent", "github"] }]);
    expect(fake.opened).toEqual(["none", "t1"]);
    expect(chat.model).toBe("p/other");
  });
});
