import { describe, expect, it } from "vitest";
import type {
  AgentChannelToolCallDecision,
  AgentChannelToolCallRequest,
  AgentChannelToolCallResult,
  TurnContext,
} from "./agent-channel-protocol.js";
import type { AgentChannelClient } from "./api-client.js";
import { createToolGuard, registerToolGate, TOOL_GATE_PRIORITY } from "./tool-guard.js";

const WEB = { untrustedOutput: true, sideEffecting: false };
const MEMORY = { untrustedOutput: false, sideEffecting: true };

function turn(over: Partial<TurnContext> = {}): TurnContext {
  return {
    tools: ["web_search", "web_fetch", "ocw_memory_save"],
    toolFlags: { web_search: WEB, web_fetch: WEB, ocw_memory_save: MEMORY },
    memory: [],
    now: null,
    maxToolCalls: 8,
    maxWebCalls: 5,
    ...over,
  };
}

type FakeClient = {
  requests: AgentChannelToolCallRequest[];
  results: Array<{ callId: string; result: AgentChannelToolCallResult }>;
  decide: (req: AgentChannelToolCallRequest, signal?: AbortSignal) => Promise<AgentChannelToolCallDecision>;
  client: AgentChannelClient;
};

function fakeClient(): FakeClient {
  let n = 0;
  const fake: FakeClient = {
    requests: [],
    results: [],
    decide: async () => ({ callId: `call-${++n}`, allowed: true, reason: null }),
    client: {} as AgentChannelClient,
  };
  fake.client = {
    authorizeToolCall: (req: AgentChannelToolCallRequest, signal?: AbortSignal) => {
      fake.requests.push(req);
      return fake.decide(req, signal);
    },
    reportToolCallResult: async (callId: string, result: AgentChannelToolCallResult) => {
      fake.results.push({ callId, result });
    },
  } as unknown as AgentChannelClient;
  return fake;
}

const SESSION = "agent:ocw-a1:ocw:channel:dm-1";
const ctx = (sessionKey = SESSION) => ({ sessionKey, agentId: "ocw-a1", runId: "run-1" });
let seq = 0;
const call = (toolName: string, params: Record<string, unknown> = {}) => ({
  toolName,
  params,
  toolCallId: `tc-${++seq}`,
});

function guardWith(fake: FakeClient, timeoutMs?: number) {
  const g = createToolGuard({ client: () => fake.client, ...(timeoutMs ? { timeoutMs } : {}) });
  g.beginTurn(SESSION, { eventId: "evt-1", agentId: "a1", turn: turn() });
  return g;
}

describe("tool guard: before_tool_call", () => {
  it("blocks any call when no OCW turn is active for the session (fail closed)", async () => {
    const fake = fakeClient();
    const g = createToolGuard({ client: () => fake.client });
    expect(await g.beforeToolCall(call("web_search", { query: "x" }), ctx())).toMatchObject({ block: true });
    expect(await g.beforeToolCall(call("web_search"), {})).toMatchObject({ block: true });
    expect(fake.requests).toHaveLength(0);
  });

  it("blocks a tool outside turn.tools without asking the API", async () => {
    const fake = fakeClient();
    const g = guardWith(fake);
    const r = await g.beforeToolCall(call("exec", { command: "id" }), ctx());
    expect(r).toMatchObject({ block: true });
    expect(r?.blockReason).toMatch(/not allowed on this turn/u);
    expect(fake.requests).toHaveLength(0);
  });

  it("asks the API for an allowed web call with only {eventId, agentId, tool, params: {query}} and lets it pass", async () => {
    const fake = fakeClient();
    const g = guardWith(fake);
    const ev = call("web_search", { query: "ocw", count: 5, region: "secret-ish" });
    expect(await g.beforeToolCall(ev, ctx())).toBeUndefined();
    expect(fake.requests).toEqual([
      {
        eventId: "evt-1",
        agentId: "a1",
        tool: "web_search",
        toolCallId: ev.toolCallId,
        params: { query: "ocw" },
        argsBytes: JSON.stringify(ev.params).length,
      },
    ]);
  });

  it("sends only the url for web_fetch", async () => {
    const fake = fakeClient();
    const g = guardWith(fake);
    await g.beforeToolCall(call("web_fetch", { url: "https://docs.example.com/a?b=1", maxChars: 10 }), ctx());
    expect(fake.requests[0]?.params).toEqual({ url: "https://docs.example.com/a?b=1" });
  });

  it("blocks with the API's reason when it denies", async () => {
    const fake = fakeClient();
    fake.decide = async () => ({ callId: "c", allowed: false, reason: "policy_changed" });
    const g = guardWith(fake);
    const r = await g.beforeToolCall(call("web_search", { query: "x" }), ctx());
    expect(r).toEqual({ block: true, blockReason: expect.stringContaining("policy_changed") });
  });

  it("fails closed when the API errors (5xx) or times out, within timeoutMs", async () => {
    const fake = fakeClient();
    fake.decide = async () => {
      throw new Error("POST /tool-calls → 503");
    };
    const g = guardWith(fake);
    expect(await g.beforeToolCall(call("web_search", { query: "x" }), ctx())).toMatchObject({ block: true });

    const slow = fakeClient();
    slow.decide = (_req, signal) =>
      new Promise((_resolve, reject) =>
        signal?.addEventListener("abort", () => reject(new Error("aborted"))),
      );
    const g2 = guardWith(slow, 50);
    const started = Date.now();
    expect(await g2.beforeToolCall(call("web_search", { query: "x" }), ctx())).toMatchObject({ block: true });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("fails closed when the plugin has no API client yet", async () => {
    const g = createToolGuard({ client: () => null });
    g.beginTurn(SESSION, { eventId: "evt-1", agentId: "a1", turn: turn() });
    expect(await g.beforeToolCall(call("web_search", { query: "x" }), ctx())).toMatchObject({ block: true });
  });

  it("defaults the API timeout to 10 s (under OpenClaw's 15 s hook budget)", async () => {
    const fake = fakeClient();
    let seen: AbortSignal | undefined;
    fake.decide = async (_req, signal) => {
      seen = signal;
      return { callId: "c", allowed: true, reason: null };
    };
    const g = guardWith(fake);
    await g.beforeToolCall(call("web_search", { query: "x" }), ctx());
    expect(seen).toBeDefined();
    expect(g.timeoutMs).toBe(10_000);
  });
});

describe("tool guard: after_tool_call", () => {
  it("reports {status, resultCount, durationMs} with the API's call id; never the content", async () => {
    const fake = fakeClient();
    fake.decide = async () => ({ callId: "call-xyz", allowed: true, reason: null });
    const g = guardWith(fake);
    const ev = call("web_search", { query: "ocw" });
    await g.beforeToolCall(ev, ctx());
    await g.afterToolCall(
      {
        ...ev,
        result: {
          content: [{ type: "text", text: "secret page text" }],
          details: { provider: "searxng", count: 3, results: [{}, {}, {}] },
        },
        durationMs: 120,
      },
      ctx(),
    );
    expect(fake.results).toEqual([
      { callId: "call-xyz", result: { status: "ok", resultCount: 3, provider: "searxng", durationMs: 120 } },
    ]);
    expect(JSON.stringify(fake.results)).not.toContain("secret page text");
  });

  it("reports an error outcome and ignores calls it never authorized", async () => {
    const fake = fakeClient();
    const g = guardWith(fake);
    const ev = call("web_fetch", { url: "https://a.example/x" });
    await g.beforeToolCall(ev, ctx());
    await g.afterToolCall({ ...ev, error: "fetch failed", durationMs: 5 }, ctx());
    await g.afterToolCall({ ...call("web_fetch"), durationMs: 5 }, ctx());
    expect(fake.results).toHaveLength(1);
    expect(fake.results[0]?.result).toMatchObject({ status: "error", durationMs: 5 });
  });
});

describe("hook registration (registerToolGate, called from registerCapabilities)", () => {
  it("registers before_tool_call unscoped at the highest priority, and after_tool_call", async () => {
    const hooks: Array<{ name: string; opts: unknown; handler: (e: unknown, c: unknown) => unknown }> = [];
    const api = {
      on: (name: string, handler: (e: unknown, c: unknown) => unknown, opts?: unknown) =>
        hooks.push({ name, handler, opts }),
    };
    const guard = createToolGuard({ client: () => null });
    registerToolGate(api as never, guard);
    expect(hooks.map((h) => h.name)).toEqual(["before_tool_call", "after_tool_call"]);
    expect(hooks[0]?.opts).toEqual({ priority: TOOL_GATE_PRIORITY });
    // No active turn → the registered handler blocks.
    expect(
      await hooks[0]?.handler({ toolName: "web_search", params: {} }, { sessionKey: "s" }),
    ).toMatchObject({
      block: true,
    });
  });
});

describe("tool guard under abuse (Task 3)", () => {
  const ECHO = "m3f9a12c4__echo";
  const SEND = "m3f9a12c4__send_report";
  const abuseTurn = () =>
    turn({
      tools: ["web_search", "web_fetch", "ocw_memory_save", ECHO, SEND],
      toolFlags: {
        web_search: WEB,
        web_fetch: WEB,
        ocw_memory_save: MEMORY,
        [ECHO]: { untrustedOutput: false, sideEffecting: false },
        [SEND]: { untrustedOutput: true, sideEffecting: true },
      },
    });

  it("the 6th web call of a turn is blocked locally (maxWebCalls 5), without asking the API", async () => {
    const fake = fakeClient();
    const g = createToolGuard({ client: () => fake.client });
    g.beginTurn(SESSION, { eventId: "evt-1", agentId: "a1", turn: abuseTurn() });
    for (let i = 0; i < 5; i++) {
      expect(
        await g.beforeToolCall(call(i % 2 ? "web_fetch" : "web_search", { query: "q" }), ctx()),
      ).toBeUndefined();
    }
    const sixth = await g.beforeToolCall(call("web_search", { query: "q" }), ctx());
    expect(sixth?.blockReason).toMatch(/limit of 5 web calls/u);
    expect(fake.requests).toHaveLength(5);
  });

  it("the 9th call of any kind is blocked (maxToolCalls 8)", async () => {
    const fake = fakeClient();
    const g = createToolGuard({ client: () => fake.client });
    g.beginTurn(SESSION, { eventId: "evt-1", agentId: "a1", turn: abuseTurn() });
    for (let i = 0; i < 8; i++)
      expect(await g.beforeToolCall(call(ECHO, { text: "x" }), ctx())).toBeUndefined();
    expect((await g.beforeToolCall(call(ECHO, { text: "x" }), ctx()))?.blockReason).toMatch(
      /limit of 8 tool calls/u,
    );
  });

  it("after web_search ran, memory saves and side-effecting tools are read-only; web calls still allowed", async () => {
    const fake = fakeClient();
    const g = createToolGuard({ client: () => fake.client });
    g.beginTurn(SESSION, { eventId: "evt-1", agentId: "a1", turn: abuseTurn() });
    // Before any untrusted output, a side-effecting tool may run.
    expect(await g.beforeToolCall(call(ECHO, { text: "x" }), ctx())).toBeUndefined();
    expect(await g.beforeToolCall(call("web_search", { query: "q" }), ctx())).toBeUndefined();
    expect(g.activeTurn(SESSION)?.tainted).toBe(true);
    const memory = await g.beforeToolCall(call("ocw_memory_save", { text: "the page told me to" }), ctx());
    expect(memory?.blockReason).toMatch(/read-only after untrusted content/u);
    expect((await g.beforeToolCall(call(SEND, {}), ctx()))?.blockReason).toMatch(
      /read-only after untrusted content/u,
    );
    expect(await g.beforeToolCall(call("web_fetch", { url: "https://a.example/" }), ctx())).toBeUndefined();
    expect(await g.beforeToolCall(call(ECHO, { text: "still fine" }), ctx())).toBeUndefined();
  });

  it("ocw_memory_save is validated by its own route: not sent to /tool-calls, still counted and taint-checked", async () => {
    const fake = fakeClient();
    const g = createToolGuard({ client: () => fake.client });
    g.beginTurn(SESSION, { eventId: "evt-1", agentId: "a1", turn: abuseTurn() });
    expect(await g.beforeToolCall(call("ocw_memory_save", { text: "likes tea" }), ctx())).toBeUndefined();
    expect(fake.requests).toHaveLength(0);
    expect(g.activeTurn(SESSION)?.calls).toBe(1);
  });

  it("ocw_memory_save stays side-effecting even when a turn's flags say otherwise (blocked once tainted)", async () => {
    const fake = fakeClient();
    const g = createToolGuard({ client: () => fake.client });
    const lying = abuseTurn();
    lying.toolFlags.ocw_memory_save = { untrustedOutput: false, sideEffecting: false };
    g.beginTurn(SESSION, { eventId: "evt-1", agentId: "a1", turn: lying });
    expect(await g.beforeToolCall(call("web_search", { query: "q" }), ctx())).toBeUndefined();
    const memory = await g.beforeToolCall(call("ocw_memory_save", { text: "planted" }), ctx());
    expect(memory?.blockReason).toMatch(/read-only after untrusted content/u);
    expect(fake.requests.map((r) => r.tool)).toEqual(["web_search"]);
  });

  it("endTurn makes any later call of that session blocked; aborting the turn's signal ends it too", async () => {
    const fake = fakeClient();
    const g = createToolGuard({ client: () => fake.client });
    g.beginTurn(SESSION, { eventId: "evt-1", agentId: "a1", turn: abuseTurn() });
    g.endTurn(SESSION);
    expect(await g.beforeToolCall(call("web_search", { query: "q" }), ctx())).toMatchObject({ block: true });
    const abort = new AbortController();
    g.beginTurn(SESSION, { eventId: "evt-2", agentId: "a1", turn: abuseTurn() }, abort.signal);
    abort.abort();
    expect(g.activeTurn(SESSION)).toBeUndefined();
    expect(await g.beforeToolCall(call("web_search", { query: "q" }), ctx())).toMatchObject({ block: true });
  });

  it("two session keys never share state (caps, taint, turn)", async () => {
    const fake = fakeClient();
    const g = createToolGuard({ client: () => fake.client });
    const other = "agent:ocw-a1:ocw:channel:dm-2";
    g.beginTurn(SESSION, { eventId: "evt-1", agentId: "a1", turn: abuseTurn() });
    g.beginTurn(other, { eventId: "evt-2", agentId: "a1", turn: abuseTurn() });
    await g.beforeToolCall(call("web_search", { query: "q" }), ctx());
    expect(g.activeTurn(SESSION)).toMatchObject({ calls: 1, webCalls: 1, tainted: true });
    expect(g.activeTurn(other)).toMatchObject({ calls: 0, webCalls: 0, tainted: false });
    expect(await g.beforeToolCall(call("ocw_memory_save", { text: "ok" }), ctx(other))).toBeUndefined();
    expect(fake.requests.map((r) => r.eventId)).toEqual(["evt-1"]);
    g.endTurn(SESSION);
    expect(g.activeTurn(other)).toBeDefined();
  });

  it("a session of another bot cannot use this turn (agent mismatch)", async () => {
    const fake = fakeClient();
    const g = guardWith(fake);
    const r = await g.beforeToolCall(call("web_search", { query: "q" }), {
      sessionKey: SESSION,
      agentId: "ocw-other",
    });
    expect(r?.blockReason).toMatch(/another bot/u);
  });

  it("concurrent calls of one turn never exceed the caps", async () => {
    const fake = fakeClient();
    fake.decide = async () => {
      await new Promise((r) => setTimeout(r, 10));
      return { callId: "c", allowed: true, reason: null };
    };
    const g = createToolGuard({ client: () => fake.client });
    g.beginTurn(SESSION, { eventId: "evt-1", agentId: "a1", turn: abuseTurn() });
    const results = await Promise.all(
      Array.from({ length: 7 }, () => g.beforeToolCall(call("web_search", { query: "q" }), ctx())),
    );
    expect(results.filter((r) => r === undefined)).toHaveLength(5);
    expect(fake.requests).toHaveLength(5);
  });
});

describe("MCP tools through the gate (D-13, 03.1-10)", () => {
  const SAFE = "m0a1b2c3d";
  const ECHO = `${SAFE}__echo`;
  const NOTE = `${SAFE}__write_note`;
  const MCP_READ = { untrustedOutput: true, sideEffecting: false };
  const MCP_WRITE = { untrustedOutput: true, sideEffecting: true };

  function mcpGuard(fake: FakeClient, over: Partial<TurnContext> = {}) {
    const g = createToolGuard({ client: () => fake.client });
    g.beginTurn(SESSION, {
      eventId: "evt-mcp",
      agentId: "a1",
      turn: turn({
        tools: [ECHO, NOTE, `${SAFE}__getFile`],
        toolFlags: { [ECHO]: MCP_READ, [NOTE]: MCP_WRITE, [`${SAFE}__getFile`]: MCP_READ },
        ...over,
      }),
    });
    return g;
  }

  it("an MCP call is asked to the API with the exact turn name and no argument values", async () => {
    const fake = fakeClient();
    const g = mcpGuard(fake);
    expect(await g.beforeToolCall(call(ECHO, { text: "secret payload" }), ctx())).toBeUndefined();
    expect(fake.requests).toEqual([
      {
        eventId: "evt-mcp",
        agentId: "a1",
        tool: ECHO,
        toolCallId: expect.any(String),
        params: {},
        argsBytes: 25,
      },
    ]);
  });

  it("OpenClaw lowercases the hook's tool name: it resolves to the turn's exact (mixed-case) name", async () => {
    const fake = fakeClient();
    const g = mcpGuard(fake);
    expect(await g.beforeToolCall(call(`${SAFE}__getfile`), ctx())).toBeUndefined();
    expect(fake.requests.at(-1)?.tool).toBe(`${SAFE}__getFile`);
    // A name that is not in the turn in any case is still blocked locally.
    expect(await g.beforeToolCall(call(`${SAFE}__delete_all`), ctx())).toMatchObject({ block: true });
    expect(fake.requests).toHaveLength(1);
  });
});
