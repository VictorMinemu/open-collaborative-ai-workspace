import { describe, expect, it } from "vitest";
import type { AgentChannelMemorySave, TurnContext } from "./agent-channel-protocol.js";
import { type AgentChannelClient, AgentChannelHttpError } from "./api-client.js";
import { MEMORY_TOOL_NAME, type MemoryToolContext, registerMemoryTool } from "./memory-tool.js";
import { openClawAgentIdFor } from "./mention-mapper.js";
import { createToolGuard } from "./tool-guard.js";

const MEMORY = { untrustedOutput: false, sideEffecting: true };
const WEB = { untrustedOutput: true, sideEffecting: false };
const BOT = "0199a6f0-0000-7000-8000-00000000a001";
const DM = "0199a6f0-0000-7000-8000-00000000c002";
const SESSION = `agent:${openClawAgentIdFor(BOT)}:ocw:channel:${DM}`;

function turn(over: Partial<TurnContext> = {}): TurnContext {
  return {
    tools: ["web_search", "ocw_memory_save"],
    toolFlags: { web_search: WEB, ocw_memory_save: MEMORY },
    memory: [],
    now: null,
    maxToolCalls: 8,
    maxWebCalls: 5,
    ...over,
  };
}

type Registered = { factory: (ctx: MemoryToolContext) => unknown; opts: unknown };
type Tool = {
  name: string;
  description: string;
  parameters: { properties: { text: { maxLength: number } }; required: string[] };
  execute: (
    id: string,
    params: unknown,
    signal?: AbortSignal,
  ) => Promise<{ content: Array<{ text: string }> }>;
};

function setup(respond: (req: AgentChannelMemorySave) => Promise<{ memoryId: string; created: boolean }>) {
  const saved: AgentChannelMemorySave[] = [];
  const client = {
    saveMemory: async (req: AgentChannelMemorySave) => {
      saved.push(req);
      return respond(req);
    },
    authorizeToolCall: async () => ({ callId: "call-1", allowed: true, reason: null }),
    reportToolCallResult: async () => {},
  } as unknown as AgentChannelClient;
  const guard = createToolGuard({ client: () => client });
  const registered: Registered[] = [];
  const api = {
    registerTool: (factory: Registered["factory"], opts: unknown) => registered.push({ factory, opts }),
  };
  const logs: string[] = [];
  registerMemoryTool(api as never, {
    guard,
    client: () => client,
    log: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
  });
  const tool = (ctx: MemoryToolContext) => registered[0]?.factory(ctx) as Tool;
  return { saved, guard, registered, tool, logs };
}

const text = (r: { content: Array<{ text: string }> }) => r.content.map((c) => c.text).join("");

describe("ocw_memory_save (D-10)", () => {
  it("registers one required tool with a bounded text schema and a description for the model", () => {
    const { registered, tool } = setup(async () => ({ memoryId: "m1", created: true }));
    expect(registered).toHaveLength(1);
    expect(registered[0]?.opts).toEqual({ name: MEMORY_TOOL_NAME });
    const t = tool({ sessionKey: SESSION, agentId: openClawAgentIdFor(BOT) });
    expect(t.name).toBe("ocw_memory_save");
    expect(t.parameters.properties.text.maxLength).toBe(500);
    expect(t.parameters.required).toEqual(["text"]);
    expect(t.description).toMatch(/remember/i);
  });

  it("with an active DM turn posts {eventId, agentId, text} and answers Saved.", async () => {
    const { saved, guard, tool, logs } = setup(async () => ({ memoryId: "m1", created: true }));
    guard.beginTurn(SESSION, { eventId: "evt-1", agentId: BOT, turn: turn(), conversationId: DM });
    const r = await tool({ sessionKey: SESSION, agentId: openClawAgentIdFor(BOT) }).execute("tc-1", {
      text: "  Lives in Madrid ",
    });
    expect(saved).toEqual([{ eventId: "evt-1", agentId: BOT, text: "Lives in Madrid" }]);
    expect(text(r)).toBe("Saved.");
    // Logs carry ids only, never the note.
    expect(logs.join("\n")).not.toContain("Madrid");
  });

  it("a note it already had answers Already saved.", async () => {
    const { guard, tool } = setup(async () => ({ memoryId: "m1", created: false }));
    guard.beginTurn(SESSION, { eventId: "evt-1", agentId: BOT, turn: turn(), conversationId: DM });
    const r = await tool({ sessionKey: SESSION }).execute("tc-1", { text: "Lives in Madrid" });
    expect(text(r)).toBe("Already saved.");
  });

  it("without an active turn returns an error result and posts nothing", async () => {
    const { saved, tool } = setup(async () => ({ memoryId: "m1", created: true }));
    const r = await tool({ sessionKey: SESSION }).execute("tc-1", { text: "Lives in Madrid" });
    expect(saved).toEqual([]);
    expect(text(r)).toMatch(/^Not saved/);
  });

  it("falls back to the conversation (nativeChannelId) when the context has no session key", async () => {
    const { saved, guard, tool } = setup(async () => ({ memoryId: "m1", created: true }));
    guard.beginTurn(SESSION, { eventId: "evt-2", agentId: BOT, turn: turn(), conversationId: DM });
    const r = await tool({ nativeChannelId: DM, agentId: openClawAgentIdFor(BOT) }).execute("tc-1", {
      text: "Has a cat",
    });
    expect(text(r)).toBe("Saved.");
    expect(saved[0]?.eventId).toBe("evt-2");
    // Another bot's context never resolves this bot's turn.
    const other = await tool({ nativeChannelId: DM, agentId: "ocw-someone-else" }).execute("tc-2", {
      text: "Has a cat",
    });
    expect(text(other)).toMatch(/^Not saved/);
    expect(saved).toHaveLength(1);
  });

  it("refuses text over 500 characters (or empty) locally", async () => {
    const { saved, guard, tool } = setup(async () => ({ memoryId: "m1", created: true }));
    guard.beginTurn(SESSION, { eventId: "evt-1", agentId: BOT, turn: turn(), conversationId: DM });
    const t = tool({ sessionKey: SESSION });
    expect(text(await t.execute("tc-1", { text: "x".repeat(501) }))).toMatch(/^Not saved.*500/);
    expect(text(await t.execute("tc-2", { text: "   " }))).toMatch(/^Not saved/);
    expect(text(await t.execute("tc-3", { nope: 1 }))).toMatch(/^Not saved/);
    expect(saved).toEqual([]);
  });

  it("refuses when the turn does not offer the tool or is already tainted", async () => {
    const { saved, guard, tool } = setup(async () => ({ memoryId: "m1", created: true }));
    guard.beginTurn(SESSION, {
      eventId: "evt-1",
      agentId: BOT,
      turn: turn({ tools: ["web_search"] }),
      conversationId: DM,
    });
    expect(text(await tool({ sessionKey: SESSION }).execute("tc-1", { text: "a" }))).toMatch(/^Not saved/);
    guard.beginTurn(SESSION, { eventId: "evt-2", agentId: BOT, turn: turn(), conversationId: DM });
    // Untrusted output read first: the gate taints the turn, the save is blocked before any request.
    expect(
      await guard.beforeToolCall({ toolName: "web_search", params: { query: "x" } }, { sessionKey: SESSION }),
    ).toBeUndefined();
    const blocked = await guard.beforeToolCall(
      { toolName: "ocw_memory_save", params: {} },
      { sessionKey: SESSION },
    );
    expect(blocked?.blockReason).toMatch(/read-only after untrusted content/);
    expect(text(await tool({ sessionKey: SESSION }).execute("tc-2", { text: "b" }))).toMatch(/^Not saved/);
    expect(saved).toEqual([]);
  });

  it("an API refusal becomes a short result, never the API's error body", async () => {
    const { guard, tool } = setup(async () => {
      throw new AgentChannelHttpError(
        409,
        "/memories",
        'POST /memories → 409 {"error":{"code":"tainted","message":"secret detail"}}',
      );
    });
    guard.beginTurn(SESSION, { eventId: "evt-1", agentId: BOT, turn: turn(), conversationId: DM });
    const r = text(await tool({ sessionKey: SESSION }).execute("tc-1", { text: "x" }));
    expect(r).toMatch(/^Not saved/);
    expect(r).not.toContain("secret detail");
    expect(r).not.toContain("{");
  });
});
