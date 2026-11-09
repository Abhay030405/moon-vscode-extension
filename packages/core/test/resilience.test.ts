import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CircuitBreaker,
  ModelRouter,
  NO_REPLY_PREFIX,
  ReplyWatchdog,
  ResilientChat,
  classifyFailure,
  type AgentChat,
  type MoonEvent,
} from "../src/index.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("error classifier (texts from real TrueForge)", () => {
  it("switches on key, address, unknown model, server errors, no reply and unknown text", () => {
    const cases: [string, string, boolean][] = [
      ["[Model Error] Request failed (401): Access denied due to invalid subscription key or wrong API endpoint.", "auth", true],
      ["[Model Error] Request failed (401): invalid x-api-key", "auth", true],
      ["[Model Error] Cannot connect to API: bad port", "unreachable", true],
      ['Status code: 422\nBody: {"error":{"message":"Unknown model \\"x/y\\" — provider not configured"}}', "not-found", true],
      ["[Model Error] Request failed (503): overloaded", "server", true],
      [`${NO_REPLY_PREFIX} within 12 s.`, "no-reply", true],
      ["something odd happened", "unknown", true],
    ];
    for (const [text, kind, switchModel] of cases) {
      expect(classifyFailure(text)).toMatchObject({ kind, switchModel });
    }
  });

  it("waits on 429, and never switches for problems every model would hit", () => {
    expect(classifyFailure("[Model Error] Request failed (429): rate limited")).toMatchObject({ kind: "rate-limit", retryFirst: true, switchModel: true });
    expect(classifyFailure("[MCP Error] Failed to connect to remote MCP server 'moon-editor'")).toMatchObject({ kind: "tools", switchModel: false });
    expect(classifyFailure("fetch failed: connect ECONNREFUSED 127.0.0.1:8790")).toMatchObject({ kind: "trueforge", switchModel: false });
  });
});

describe("reply watchdog", () => {
  it("fires when only TrueForge's own start events arrive (a hanging model)", () => {
    vi.useFakeTimers();
    const fired: number[] = [];
    const dog = new ReplyWatchdog({ firstReplyMs: 12000, stallMs: 45000 }, (ms) => fired.push(ms));
    dog.start("message");
    dog.observe({ type: "turn.created" });
    dog.observe({ type: "mcp.initialize" });
    dog.observe({ type: "model.message", content: "", toolCalls: [] }); // the empty placeholder
    vi.advanceTimersByTime(11999);
    expect(fired).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(fired).toEqual([12000]);
  });

  it("does not fire while a tool runs; uses the longer stall time after the first reply", () => {
    vi.useFakeTimers();
    const fired: number[] = [];
    const dog = new ReplyWatchdog({ firstReplyMs: 12000, stallMs: 45000 }, (ms) => fired.push(ms));
    dog.start("message");
    vi.advanceTimersByTime(5000);
    dog.observe({ type: "model.message", content: "", toolCalls: [{}] }); // the model asked for a tool
    vi.advanceTimersByTime(300000); // a long pytest
    expect(fired).toEqual([]);
    dog.observe({ type: "tool.response" });
    vi.advanceTimersByTime(44999);
    expect(fired).toEqual([]);
    dog.observe({ type: "model.message.delta" }); // output resets the timer
    vi.advanceTimersByTime(44999);
    dog.observe({ type: "turn.done" });
    vi.advanceTimersByTime(100000);
    expect(fired).toEqual([]);
  });

  it("an approval answer starts with tools running (no timer until their results)", () => {
    vi.useFakeTimers();
    const fired: number[] = [];
    const dog = new ReplyWatchdog({ firstReplyMs: 12000, stallMs: 45000 }, (ms) => fired.push(ms));
    dog.start("answer");
    vi.advanceTimersByTime(120000);
    expect(fired).toEqual([]);
    dog.observe({ type: "tool.response" });
    vi.advanceTimersByTime(45000);
    expect(fired).toEqual([45000]);
  });
});

describe("circuit breaker", () => {
  it("checks the main model with growing waits; switches back only when the next task starts", async () => {
    vi.useFakeTimers();
    const answers = [false, true];
    const probe = vi.fn(async () => answers.shift() ?? true);
    const breaker = new CircuitBreaker({ firstProbeMs: 1000, backoffFactor: 2, maxProbeMs: 1500 }, probe);
    breaker.trip();
    expect(breaker.state).toBe("open");
    await vi.advanceTimersByTimeAsync(999);
    expect(probe).toHaveBeenCalledTimes(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(probe).toHaveBeenCalledTimes(1); // failed: next wait 2000, capped at 1500
    await vi.advanceTimersByTimeAsync(1500);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(breaker.state).toBe("recovered");
    expect(breaker.takeRecovery()).toBe(true);
    expect(breaker.state).toBe("closed");
    expect(breaker.takeRecovery()).toBe(false);
  });

  it("checkNow probes at once (settings changed)", async () => {
    const breaker = new CircuitBreaker({ firstProbeMs: 60000, backoffFactor: 2, maxProbeMs: 600000 }, async () => true);
    breaker.trip();
    breaker.checkNow();
    await Promise.resolve();
    await Promise.resolve();
    expect(breaker.state).toBe("recovered");
    breaker.dispose();
  });
});

/** A stand-in for AgentChat: each model answers from a script. */
function fakeChats(script: Record<string, (message: string) => MoonEvent[]>) {
  const sent: { model: string; message: string; opening: string[]; session: number }[] = [];
  let sessions = 0;
  const make = (first: string) => {
    let opening: string[] = [];
    let started = false;
    let model = first;
    const session = ++sessions;
    return {
      get model() {
        return model;
      },
      switchModel(to: string) {
        model = to;
      },
      get started() {
        return started;
      },
      waitingFor: [],
      setSessionContext(ctx: { openingMessages: string[] }) {
        opening = ctx.openingMessages;
      },
      async send(message: string, emit: (e: MoonEvent) => void) {
        started = true;
        sent.push({ model, message, opening, session });
        for (const event of script[model]!(message)) emit(event);
      },
      async answer() {},
      stop() {},
    } as unknown as AgentChat;
  };
  return { make, sent };
}

const MAIN = "anthropic/claude";
const BACKUP = "azure/deepseek";
const times = { firstProbeMs: 600000, backoffFactor: 2, maxProbeMs: 600000 };
const settings = { rateLimitRetries: 1, rateLimitWaitMs: 1 };

describe("resilient chat (fallback)", () => {
  it("main fails (invalid key): drops the half answer, the same request runs on the backup", async () => {
    const { make, sent } = fakeChats({
      [MAIN]: () => [{ type: "text", text: "half" }, { type: "done", status: "error", message: "[Model Error] Request failed (401): bad key" }],
      [BACKUP]: () => [{ type: "text", text: "whole answer" }, { type: "done", status: "done" }],
    });
    const router = new ModelRouter({ main: MAIN, backup: BACKUP }, times, async () => false);
    const restarts = vi.fn();
    const chat = new ResilientChat({ router, makeChat: make, settings, beforeRestart: restarts });
    chat.setSessionContext({ openingMessages: ["project map"] });
    const events: MoonEvent[] = [];
    await chat.send("fix get_debug_flag", (e) => events.push(e));

    expect(events.map((e) => e.type)).toEqual(["text", "model-switch", "text", "done"]);
    expect(events[1]).toMatchObject({ direction: "fallback", from: MAIN, to: BACKUP, reason: "invalid key" });
    expect(events.at(-1)).toEqual({ type: "done", status: "done" });
    expect(sent.map((s) => [s.model, s.message])).toEqual([
      [MAIN, "fix get_debug_flag"],
      [BACKUP, "fix get_debug_flag"],
    ]);
    expect(sent[1]!.opening).toEqual(["project map"]); // the new session gets the same context
    expect(restarts).toHaveBeenCalledTimes(1);
    expect(router.current).toBe(BACKUP); // later tasks start on the backup
    router.dispose();
  });

  it("both fail: one clear error naming each model, no switch loop", async () => {
    const { make, sent } = fakeChats({
      [MAIN]: () => [{ type: "done", status: "error", message: "[Model Error] Cannot connect to API: x" }],
      [BACKUP]: () => [{ type: "done", status: "error", message: "[Model Error] Request failed (401): no" }],
    });
    const router = new ModelRouter({ main: MAIN, backup: BACKUP }, times, async () => false);
    const chat = new ResilientChat({ router, makeChat: make, settings });
    const events: MoonEvent[] = [];
    await chat.send("hi", (e) => events.push(e));
    expect(sent).toHaveLength(2);
    const done = events.at(-1)!;
    expect(done).toMatchObject({ type: "done", status: "error" });
    expect((done as { message: string }).message).toMatch(/Every model failed .*main model anthropic\/claude: cannot connect; backup model azure\/deepseek: invalid key.*Nothing was changed/);
    router.dispose();
  });

  it("429: waits and tries the same model again before switching", async () => {
    let calls = 0;
    const { make, sent } = fakeChats({
      [MAIN]: () => (calls++ === 0 ? [{ type: "done", status: "error", message: "[Model Error] Request failed (429): slow down" }] : [{ type: "done", status: "done" }]),
      [BACKUP]: () => [{ type: "done", status: "done" }],
    });
    const router = new ModelRouter({ main: MAIN, backup: BACKUP }, times, async () => false);
    const chat = new ResilientChat({ router, makeChat: make, settings });
    const events: MoonEvent[] = [];
    await chat.send("hi", (e) => events.push(e));
    expect(sent.map((s) => s.model)).toEqual([MAIN, MAIN]);
    expect(events.some((e) => e.type === "model-switch")).toBe(false);
    expect(router.current).toBe(MAIN);
    router.dispose();
  });

  it("Moon's own tools down: reported as is, no switch (the backup would fail the same way)", async () => {
    const { make, sent } = fakeChats({
      [MAIN]: () => [{ type: "done", status: "error", message: "[MCP Error] Failed to connect to remote MCP server 'moon-editor'" }],
      [BACKUP]: () => [{ type: "done", status: "done" }],
    });
    const router = new ModelRouter({ main: MAIN, backup: BACKUP }, times, async () => false);
    const chat = new ResilientChat({ router, makeChat: make, settings });
    const events: MoonEvent[] = [];
    await chat.send("hi", (e) => events.push(e));
    expect(sent).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: "done", status: "error", message: expect.stringContaining("[MCP Error]") });
    router.dispose();
  });

  it("switches back to the main model at the start of the next task, saying so, in the same session (history kept)", async () => {
    let mainBroken = true;
    const { make, sent } = fakeChats({
      [MAIN]: () => (mainBroken ? [{ type: "done", status: "error", message: "[Model Error] Request failed (401): x" }] : [{ type: "done", status: "done" }]),
      [BACKUP]: () => [{ type: "text", text: "done on backup" }, { type: "done", status: "done" }],
    });
    const router = new ModelRouter({ main: MAIN, backup: BACKUP }, times, async () => !mainBroken);
    const chat = new ResilientChat({ router, makeChat: make, settings });
    await chat.send("first", () => {});
    expect(router.state).toBe("open");
    mainBroken = false; // the key was fixed in TrueForge
    router.settingsChanged();
    await vi.waitFor(() => expect(router.state).toBe("recovered"));
    const events: MoonEvent[] = [];
    await chat.send("second", (e) => events.push(e));
    expect(events[0]).toMatchObject({ type: "model-switch", direction: "back", from: BACKUP, to: MAIN });
    expect(sent.at(-1)!.model).toBe(MAIN);
    // The backup's session moves to the main model in place: it already holds "first".
    expect(sent.at(-1)!.session).toBe(sent.at(-2)!.session);
    expect(sent.at(-2)!.message).toBe("first");
    expect(router.state).toBe("closed");
    router.dispose();
  });

  it("a stopped request is still told to the model after a switch back (so 'continue' makes sense)", async () => {
    let mainBroken = true;
    const { make, sent } = fakeChats({
      [MAIN]: () => (mainBroken ? [{ type: "done", status: "error", message: "[Model Error] Request failed (401): x" }] : [{ type: "done", status: "done" }]),
      [BACKUP]: () => [{ type: "text", text: "searching" }],
    });
    const router = new ModelRouter({ main: MAIN, backup: BACKUP }, times, async () => !mainBroken);
    const chat = new ResilientChat({ router, makeChat: make, settings });
    await chat.send("fix get_debug_flag", () => {});
    chat.stop(); // the user pressed Stop while the backup worked
    mainBroken = false;
    router.settingsChanged();
    await vi.waitFor(() => expect(router.state).toBe("recovered"));
    await chat.send("continue", () => {});
    // Same session (it holds the stopped request), now on the main model.
    expect(sent.at(-1)!.model).toBe(MAIN);
    expect(sent.at(-1)!.session).toBe(sent.at(-2)!.session);
    expect(sent.at(-2)!.message).toBe("fix get_debug_flag");
    router.dispose();
  });
});
