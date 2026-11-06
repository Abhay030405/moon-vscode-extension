import { describe, expect, it } from "vitest";
import { TurnEventMapper, describeToolCall, definitionRegExp, loadAgentDefinition, sessionUrl } from "../src/index.js";
import { fileURLToPath } from "node:url";

// Shapes recorded from TrueForge 0.184.1 (trimmed).
const id = "msg1";
const events: any[] = [
  { type: "model.message", id, threadId: "main", createdAt: "" },
  { type: "model.message.delta", id, threadId: "main", content: "Looking" },
  { type: "model.message.delta", id, threadId: "main", toolCalls: [{ index: 0, id: "t1", type: "function", toolInfo: { type: "mcp", name: "read_file" }, function: { name: "read_file", arguments: "" } }] },
  { type: "model.message.delta", id, threadId: "main", toolCalls: [{ index: 0, function: { arguments: '{"path": "src/a' } }] },
  { type: "model.message.delta", id, threadId: "main", toolCalls: [{ index: 0, function: { arguments: '.py", "start_line": 3}' } }] },
  { type: "model.message.delta", id, threadId: "main", finishReason: "tool_calls" },
  { type: "tool.response", id: "r1", threadId: "main", toolCallId: "t1", content: "..." },
  { type: "model.message.delta", id: "msg2", threadId: "sub-1", content: "subagent text" },
  { type: "turn.done", id: "d", threadId: null, state: { status: "done", output: null, requiredActions: [] } },
];

describe("TurnEventMapper", () => {
  it("streams main-thread text and reports finished tool calls with a summary", () => {
    const mapper = new TurnEventMapper();
    const out = events.flatMap((e) => mapper.map(e));
    expect(out).toEqual([
      { type: "text", text: "Looking" },
      { type: "tool-call", id: "t1", tool: "read_file", step: { action: "Read", target: "src/a.py:3" }, subagent: false },
      { type: "tool-result", id: "t1" },
      { type: "done", status: "done" },
    ]);
  });

  it("maps cancelled and error turns", () => {
    const mapper = new TurnEventMapper();
    expect(mapper.map({ type: "turn.done", state: { status: "cancelled", reason: "client-cancelled" } } as any)).toEqual([
      { type: "done", status: "cancelled", message: "client-cancelled" },
    ]);
    expect(mapper.map({ type: "turn.done", state: { status: "error", message: "boom" } } as any)).toEqual([
      { type: "done", status: "error", message: "boom" },
    ]);
  });
});

describe("definition patterns", () => {
  it("does not treat a call as a definition", () => {
    const re = definitionRegExp("get_flag");
    expect(re.test("    assert get_flag() == expect")).toBe(false);
    expect(re.test("x = get_flag()")).toBe(false);
    expect(re.test("    public static boolean get_flag() {")).toBe(true);
    expect(re.test("def get_flag():")).toBe(true);
  });
});

describe("agent definition", () => {
  it("fills model, MCP server and prompt files from the committed definition", () => {
    const file = fileURLToPath(new URL("../../../agents/moon-agent.json", import.meta.url));
    const spec = loadAgentDefinition(file, { model: "p/m", mcpServer: "srv" }) as any;
    expect(spec.model.name).toBe("p/m");
    expect(spec.mcpServers[0].name).toBe("srv");
    expect(spec.instructions).toContain("untrusted_project_content");
    expect(spec.$comment).toBeUndefined();
    expect(JSON.stringify(spec)).not.toContain("{{");
  });

  it("builds the TrueForge session link", () => {
    expect(sessionUrl("{baseUrl}/sessions/{sessionId}", "http://h:1/", "abc")).toBe("http://h:1/sessions/abc");
  });
});

describe("describeToolCall", () => {
  it("shows the wrapped tool's step when called through TrueForge's call_tool", () => {
    const args = JSON.stringify({ mcp_server: "moon-editor", tool_name: "propose_edit", input: { path: "src/a.py", edits: [] } });
    expect(describeToolCall("call_tool", args)).toEqual({ action: "Propose edit", target: "src/a.py" });
    expect(describeToolCall("list_tools", "{}")).toEqual({ action: "List tools", target: "" });
  });
});
