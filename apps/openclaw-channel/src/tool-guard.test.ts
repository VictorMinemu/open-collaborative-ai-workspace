import { describe, expect, it } from "vitest";
import type {
  AgentChannelToolCallDecision,
  AgentChannelToolCallRequest,
  AgentChannelToolCallResult,
  TurnContext,
} from "./agent-channel-protocol.js";
import type { AgentChannelClient } from "./api-client.js";
import { createToolGuard, registerToolGate, TOOL_GATE_PRIORITY, TOOL_PIN_PRIORITY } from "./tool-guard.js";

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
  it("registers before_tool_call unscoped at the highest priority, the param pin at the lowest, and after_tool_call", async () => {
    const hooks: Array<{ name: string; opts: unknown; handler: (e: unknown, c: unknown) => unknown }> = [];
    const api = {
      on: (name: string, handler: (e: unknown, c: unknown) => unknown, opts?: unknown) =>
        hooks.push({ name, handler, opts }),
    };
    const guard = createToolGuard({ client: () => null });
    registerToolGate(api as never, guard);
    // 07.5-04: before_tool_call twice (the gate and the param pin), after_tool_call once.
    expect(hooks.map((h) => h.name)).toEqual(["before_tool_call", "before_tool_call", "after_tool_call"]);
    expect(hooks[0]?.opts).toEqual({ priority: TOOL_GATE_PRIORITY });
    expect(hooks[1]?.opts).toEqual({ priority: TOOL_PIN_PRIORITY });
    expect(TOOL_PIN_PRIORITY).toBeLessThan(0);
    // Nothing pinned → the pin handler changes nothing.
    expect(
      await hooks[1]?.handler({ toolName: "web_search", params: {}, toolCallId: "x" }, {}),
    ).toBeUndefined();
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

  it("ocw_board_card is validated by its own routes (07.1-13): never sent to /tool-calls (no policy_changed, no double count), still counted locally", async () => {
    const fake = fakeClient();
    const g = createToolGuard({ client: () => fake.client });
    const board = turn({
      tools: ["web_search", "ocw_board_card"],
      toolFlags: { web_search: WEB, ocw_board_card: { untrustedOutput: false, sideEffecting: true } },
    });
    g.beginTurn(SESSION, { eventId: "evt-1", agentId: "a1", turn: board });
    expect(await g.beforeToolCall(call("ocw_board_card", { action: "read" }), ctx())).toBeUndefined();
    expect(await g.beforeToolCall(call("OCW_BOARD_CARD", { action: "create" }), ctx())).toBeUndefined();
    expect(fake.requests).toHaveLength(0);
    expect(g.activeTurn(SESSION)?.calls).toBe(2);
    expect(g.activeTurn(SESSION)?.tainted).toBe(false);
  });

  it("ocw_board_card stays side-effecting even when a turn's flags say otherwise (blocked once tainted)", async () => {
    const fake = fakeClient();
    const g = createToolGuard({ client: () => fake.client });
    const lying = turn({
      tools: ["web_search", "ocw_board_card"],
      toolFlags: { web_search: WEB, ocw_board_card: { untrustedOutput: false, sideEffecting: false } },
    });
    g.beginTurn(SESSION, { eventId: "evt-1", agentId: "a1", turn: lying });
    expect(await g.beforeToolCall(call("web_search", { query: "q" }), ctx())).toBeUndefined();
    const board = await g.beforeToolCall(call("ocw_board_card", { action: "create" }), ctx());
    expect(board?.blockReason).toMatch(/read-only after untrusted content/u);
    expect(fake.requests.map((r) => r.tool)).toEqual(["web_search"]);
  });

  describe("connector and keychain tools (07.4 D-07)", () => {
    const LIST = { untrustedOutput: false, sideEffecting: false };
    const READ_ONLY = { untrustedOutput: true, sideEffecting: false };
    const connectorTurn = (over: Partial<TurnContext> = {}) =>
      turn({
        tools: ["web_search", "ocw_connector_list", "ocw_connector_call", "m1a2b3c4d__whoami"],
        toolFlags: {
          web_search: WEB,
          ocw_connector_list: LIST,
          ocw_connector_call: READ_ONLY,
          m1a2b3c4d__whoami: READ_ONLY,
        },
        ...over,
      });
    const CALL = { connector: "m1a2b3c4d", tool: "whoami", arguments: {} };

    it("ocw_connector_call is validated by its own route: never sent to /tool-calls, still counted locally", async () => {
      const fake = fakeClient();
      const g = createToolGuard({ client: () => fake.client });
      g.beginTurn(SESSION, {
        eventId: "evt-1",
        agentId: "a1",
        turn: connectorTurn(),
        connectorTools: ["m1a2b3c4d__whoami"],
      });
      expect(await g.beforeToolCall(call("ocw_connector_call", CALL), ctx())).toBeUndefined();
      expect(fake.requests).toHaveLength(0);
      expect(g.activeTurn(SESSION)?.calls).toBe(1);
      // A connector's output is untrusted: the turn is read-only from here on.
      expect(g.activeTurn(SESSION)?.tainted).toBe(true);
    });

    it("the three tools never reach /tool-calls", async () => {
      const fake = fakeClient();
      const g = createToolGuard({ client: () => fake.client });
      g.beginTurn(SESSION, {
        eventId: "evt-1",
        agentId: "a1",
        turn: connectorTurn({ tools: [...connectorTurn().tools, "ocw_http_request"] }),
        connectorTools: ["m1a2b3c4d__whoami"],
      });
      expect(await g.beforeToolCall(call("ocw_connector_list"), ctx())).toBeUndefined();
      expect(await g.beforeToolCall(call("ocw_connector_call", CALL), ctx())).toBeUndefined();
      expect(
        await g.beforeToolCall(
          call("ocw_http_request", {
            handle: "k_abcdefgh23",
            method: "GET",
            url: "https://api.example.com/",
          }),
          ctx(),
        ),
      ).toBeUndefined();
      expect(fake.requests).toHaveLength(0);
      expect(g.activeTurn(SESSION)?.calls).toBe(3);
    });

    it("ocw_connector_call takes the LOGICAL tool's flags: a side-effecting one is blocked once tainted, a read-only one is not", async () => {
      const fake = fakeClient();
      const g = createToolGuard({ client: () => fake.client });
      g.beginTurn(SESSION, {
        eventId: "evt-1",
        agentId: "a1",
        turn: connectorTurn({
          toolFlags: {
            ...connectorTurn().toolFlags,
            // The static tool's own flags never decide: the logical tool's do.
            ocw_connector_call: LIST,
            m1a2b3c4d__create_deal: { untrustedOutput: false, sideEffecting: true },
          },
        }),
        connectorTools: ["m1a2b3c4d__whoami", "m1a2b3c4d__create_deal"],
      });
      // Before any untrusted output, the side-effecting tool runs.
      expect(
        await g.beforeToolCall(call("ocw_connector_call", { ...CALL, tool: "create_deal" }), ctx()),
      ).toBeUndefined();
      expect(g.activeTurn(SESSION)?.tainted).toBe(false);
      // A read-only connector tool's output is untrusted: it taints the turn.
      expect(await g.beforeToolCall(call("ocw_connector_call", CALL), ctx())).toBeUndefined();
      expect(g.activeTurn(SESSION)?.tainted).toBe(true);
      const write = await g.beforeToolCall(
        call("ocw_connector_call", { ...CALL, tool: "create_deal" }),
        ctx(),
      );
      expect(write?.blockReason).toMatch(/read-only after untrusted content/u);
      // A read-only tool still runs on a tainted turn.
      expect(await g.beforeToolCall(call("ocw_connector_call", CALL), ctx())).toBeUndefined();
    });

    it("a logical tool the turn does not list is blocked; one without flags is UNKNOWN (blocked once tainted)", async () => {
      const fake = fakeClient();
      const g = createToolGuard({ client: () => fake.client });
      g.beginTurn(SESSION, {
        eventId: "evt-1",
        agentId: "a1",
        turn: connectorTurn(),
        connectorTools: ["m1a2b3c4d__whoami", "m1a2b3c4d__mystery"],
      });
      const absent = await g.beforeToolCall(
        call("ocw_connector_call", { ...CALL, tool: "delete_all" }),
        ctx(),
      );
      expect(absent?.blockReason).toMatch(/not allowed on this turn/u);
      const invalid = await g.beforeToolCall(
        call("ocw_connector_call", { connector: "../x", tool: "a" }),
        ctx(),
      );
      expect(invalid?.blockReason).toMatch(/not allowed on this turn/u);
      // A logical tool only in turn.tools (an OpenClaw tool) is not a connector tool.
      expect(
        (await g.beforeToolCall(call("ocw_connector_call", { connector: "m1a2b3c4d", tool: "nope" }), ctx()))
          ?.blockReason,
      ).toMatch(/not allowed on this turn/u);
      // Unknown flags: the most dangerous combination (untrusted + side-effecting) — runs on a clean turn, taints it.
      expect(
        await g.beforeToolCall(call("ocw_connector_call", { ...CALL, tool: "mystery" }), ctx()),
      ).toBeUndefined();
      expect(g.activeTurn(SESSION)?.tainted).toBe(true);
      const again = await g.beforeToolCall(call("ocw_connector_call", { ...CALL, tool: "mystery" }), ctx());
      expect(again?.blockReason).toMatch(/read-only after untrusted content/u);
    });

    it("ocw_http_request: GET/HEAD read (allowed on a tainted turn), any other method is side-effecting (blocked)", async () => {
      const fake = fakeClient();
      const g = createToolGuard({ client: () => fake.client });
      g.beginTurn(SESSION, {
        eventId: "evt-1",
        agentId: "a1",
        turn: connectorTurn({
          tools: [...connectorTurn().tools, "ocw_http_request"],
          // Even a turn that calls the static tool harmless cannot make a POST read-only.
          toolFlags: { ...connectorTurn().toolFlags, ocw_http_request: LIST },
        }),
        connectorTools: ["m1a2b3c4d__whoami"],
      });
      const req = (method: string) =>
        call("ocw_http_request", { handle: "k_abcdefgh23", method, url: "https://a.b/" });
      // A POST on a clean turn runs; its response is untrusted and taints the turn.
      expect(await g.beforeToolCall(req("POST"), ctx())).toBeUndefined();
      expect(g.activeTurn(SESSION)?.tainted).toBe(true);
      expect(await g.beforeToolCall(req("GET"), ctx())).toBeUndefined();
      expect(await g.beforeToolCall(req("head"), ctx())).toBeUndefined();
      for (const method of ["POST", "PUT", "PATCH", "DELETE", "BREW"]) {
        expect((await g.beforeToolCall(req(method), ctx()))?.blockReason, method).toMatch(
          /read-only after untrusted content/u,
        );
      }
    });

    it("a list that names per-member connectors taints the turn locally, as the API does (WINDOWS #192)", async () => {
      const fake = fakeClient();
      const g = createToolGuard({ client: () => fake.client });
      g.beginTurn(SESSION, {
        eventId: "evt-1",
        agentId: "a1",
        turn: connectorTurn({
          tools: [...connectorTurn().tools, "m1a2b3c4d__create_record"],
          toolFlags: {
            ...connectorTurn().toolFlags,
            ocw_connector_list: { untrustedOutput: true, sideEffecting: false },
            m1a2b3c4d__create_record: { untrustedOutput: true, sideEffecting: true },
          },
        }),
        connectorTools: ["m1a2b3c4d__whoami", "m1a2b3c4d__create_record"],
      });
      expect(await g.beforeToolCall(call("ocw_connector_list"), ctx())).toBeUndefined();
      expect(g.activeTurn(SESSION)?.tainted).toBe(true);
      const write = await g.beforeToolCall(
        call("ocw_connector_call", { connector: "m1a2b3c4d", tool: "create_record", arguments: {} }),
        ctx(),
      );
      expect(write?.blockReason).toMatch(/read-only after untrusted content/u);
      // The list itself stays allowed on the tainted turn.
      expect(await g.beforeToolCall(call("ocw_connector_list"), ctx())).toBeUndefined();
    });

    it("ocw_connector_list is always allowed when offered, also on a tainted turn; never when not offered", async () => {
      const fake = fakeClient();
      const g = createToolGuard({ client: () => fake.client });
      g.beginTurn(SESSION, {
        eventId: "evt-1",
        agentId: "a1",
        // No flags delivered for the list: still a read of the workspace's own catalog.
        turn: connectorTurn({ toolFlags: { web_search: WEB } }),
        connectorTools: ["m1a2b3c4d__whoami"],
      });
      expect(await g.beforeToolCall(call("web_search", { query: "q" }), ctx())).toBeUndefined();
      expect(g.activeTurn(SESSION)?.tainted).toBe(true);
      expect(await g.beforeToolCall(call("ocw_connector_list"), ctx())).toBeUndefined();
      g.beginTurn(SESSION, { eventId: "evt-2", agentId: "a1", turn: turn() });
      expect((await g.beforeToolCall(call("ocw_connector_list"), ctx()))?.blockReason).toMatch(
        /not allowed/u,
      );
    });
  });

  describe("memory file tools (07.2-07, D-08)", () => {
    const READ = { untrustedOutput: false, sideEffecting: false };
    const memoryTurn = (flags: Record<string, { untrustedOutput: boolean; sideEffecting: boolean }> = {}) =>
      turn({
        tools: ["web_search", "ocw_memory_list", "ocw_memory_read", "ocw_memory_write", "ocw_memory_propose"],
        toolFlags: {
          web_search: WEB,
          ocw_memory_list: READ,
          ocw_memory_read: READ,
          ocw_memory_write: { untrustedOutput: false, sideEffecting: true },
          ocw_memory_propose: { untrustedOutput: false, sideEffecting: false },
          ...flags,
        },
      });

    it("ocw_memory_list and ocw_memory_read go through /tool-calls with no argument values; they do not taint", async () => {
      const fake = fakeClient();
      const g = createToolGuard({ client: () => fake.client });
      g.beginTurn(SESSION, { eventId: "evt-1", agentId: "a1", turn: memoryTurn() });
      expect(await g.beforeToolCall(call("ocw_memory_list", {}), ctx())).toBeUndefined();
      expect(
        await g.beforeToolCall(call("ocw_memory_read", { scope: "personal", path: "MEMORY.md" }), ctx()),
      ).toBeUndefined();
      expect(fake.requests.map((r) => ({ tool: r.tool, params: r.params }))).toEqual([
        { tool: "ocw_memory_list", params: {} },
        { tool: "ocw_memory_read", params: {} },
      ]);
      expect(g.activeTurn(SESSION)?.tainted).toBe(false);
    });

    it("ocw_memory_write and ocw_memory_propose are validated by their own routes: never sent to /tool-calls, still counted", async () => {
      const fake = fakeClient();
      const g = createToolGuard({ client: () => fake.client });
      g.beginTurn(SESSION, { eventId: "evt-1", agentId: "a1", turn: memoryTurn() });
      expect(await g.beforeToolCall(call("ocw_memory_write", { content: "x" }), ctx())).toBeUndefined();
      expect(await g.beforeToolCall(call("OCW_MEMORY_PROPOSE", { content: "x" }), ctx())).toBeUndefined();
      expect(fake.requests).toHaveLength(0);
      expect(g.activeTurn(SESSION)?.calls).toBe(2);
    });

    it("after untrusted content ocw_memory_write is blocked, even when the turn's flags say it is harmless; propose is not", async () => {
      const fake = fakeClient();
      const g = createToolGuard({ client: () => fake.client });
      g.beginTurn(SESSION, {
        eventId: "evt-1",
        agentId: "a1",
        turn: memoryTurn({ ocw_memory_write: { untrustedOutput: false, sideEffecting: false } }),
      });
      expect(await g.beforeToolCall(call("web_search", { query: "q" }), ctx())).toBeUndefined();
      const write = await g.beforeToolCall(call("ocw_memory_write", { content: "planted" }), ctx());
      expect(write?.blockReason).toMatch(/read-only after untrusted content/u);
      expect(
        await g.beforeToolCall(call("ocw_memory_propose", { content: "flagged" }), ctx()),
      ).toBeUndefined();
      expect(await g.beforeToolCall(call("ocw_memory_read", {}), ctx())).toBeUndefined();
      expect(fake.requests.map((r) => r.tool)).toEqual(["web_search", "ocw_memory_read"]);
    });
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

  it("after an MCP read (untrusted output), a side-effecting MCP tool is blocked locally with the read-only reason", async () => {
    const fake = fakeClient();
    const g = mcpGuard(fake);
    expect(await g.beforeToolCall(call(ECHO, { text: "x" }), ctx())).toBeUndefined();
    const r = await g.beforeToolCall(call(NOTE, { text: "y" }), ctx());
    expect(r).toMatchObject({ block: true });
    expect(r?.blockReason).toContain("read-only after untrusted content");
    // Never asked: the API would have refused it as tainted anyway.
    expect(fake.requests.map((q) => q.tool)).toEqual([ECHO]);
  });

  it("a server trusted for chained calls (write_note delivered as not side-effecting) proceeds to the API", async () => {
    const fake = fakeClient();
    const g = mcpGuard(fake, {
      tools: [ECHO, NOTE],
      toolFlags: { [ECHO]: MCP_READ, [NOTE]: { untrustedOutput: true, sideEffecting: false } },
    });
    expect(await g.beforeToolCall(call(ECHO, { text: "x" }), ctx())).toBeUndefined();
    expect(await g.beforeToolCall(call(NOTE, { text: "y" }), ctx())).toBeUndefined();
    expect(fake.requests.map((q) => q.tool)).toEqual([ECHO, NOTE]);
  });

  it("an MCP tool without delivered flags is treated as untrusted and side-effecting", async () => {
    const fake = fakeClient();
    const g = mcpGuard(fake, { tools: [ECHO, NOTE], toolFlags: { [ECHO]: MCP_READ } });
    expect(await g.beforeToolCall(call(ECHO), ctx())).toBeUndefined();
    expect(await g.beforeToolCall(call(NOTE), ctx())).toMatchObject({ block: true });
  });

  it("a side-effecting MCP tool before any untrusted read runs; its own output then taints the turn", async () => {
    const fake = fakeClient();
    const g = mcpGuard(fake);
    expect(await g.beforeToolCall(call(NOTE, { text: "first" }), ctx())).toBeUndefined();
    expect(await g.beforeToolCall(call(NOTE, { text: "second" }), ctx())).toMatchObject({ block: true });
  });
});

describe("per-tool approvals (07.5-04, D-01, D-02, D-04, UI-SPEC R10)", () => {
  const SAFE = "m1a2b3c4d";
  const NOTE = `${SAFE}__write_note`;
  const ECHO = `${SAFE}__echo`;
  const DELETE = `${SAFE}__delete_note`;
  const FLAGGED = { untrustedOutput: true, sideEffecting: true, approval: "always" as const };
  const READ = { untrustedOutput: true, sideEffecting: false };
  const WRITE = { untrustedOutput: true, sideEffecting: true };
  const APPROVAL = {
    id: "0199a6f0-0000-7000-8000-0000000000a1",
    created: true,
    waitingFor: "a lead of Sales",
    requesterName: "Ana Pérez",
  };

  function approvalGuard(fake: FakeClient, requesterName: string | null = "Ana Pérez") {
    const g = createToolGuard({ client: () => fake.client });
    g.beginTurn(SESSION, {
      eventId: "evt-ap",
      agentId: "a1",
      ...(requesterName ? { requesterName } : {}),
      turn: turn({
        tools: [NOTE, ECHO, DELETE],
        toolFlags: { [NOTE]: FLAGGED, [ECHO]: READ, [DELETE]: WRITE },
      }),
    });
    return g;
  }
  const refuse =
    (reason: string, approval: typeof APPROVAL | null = null) =>
    async (): Promise<AgentChannelToolCallDecision> => ({
      callId: "c-ap",
      allowed: false,
      reason,
      ...(approval ? { approval } : {}),
    });

  it("a flagged tool's call carries its full arguments; the approval-required sentence is returned at once", async () => {
    const fake = fakeClient();
    fake.decide = refuse("approval_required", APPROVAL);
    const g = approvalGuard(fake);
    const params = { text: "SENTINEL-77", n: 1 };
    const ev = call(NOTE, params);
    const r = await g.beforeToolCall(ev, ctx());
    expect(fake.requests).toEqual([
      {
        eventId: "evt-ap",
        agentId: "a1",
        tool: NOTE,
        toolCallId: ev.toolCallId,
        params: {},
        argsBytes: JSON.stringify(params).length,
        arguments: params,
      },
    ]);
    expect(r).toEqual({
      block: true,
      blockReason:
        "This action needs approval. I posted a card and asked a lead of Sales. Tell Ana Pérez in one short sentence that you are waiting for that approval, without repeating the values. Don't call m1a2b3c4d__write_note again now: when it is approved you will get a new message with the exact arguments.",
    });
  });

  it.each([
    [
      "approval_pending",
      APPROVAL,
      "This exact action is already waiting for approval in a card. Don't ask again; tell Ana Pérez it is still waiting.",
    ],
    [
      "approval_denied",
      { ...APPROVAL, created: false },
      "A lead of Sales denied this exact action. Don't retry it. Tell Ana Pérez it was denied and ask what to change.",
    ],
    [
      "approval_used",
      null,
      "That approval was already used once. Ask Ana Pérez if they want to run it again.",
    ],
    [
      "arguments_invalid",
      null,
      "This action can't be approved because its values aren't valid JSON. Try again with plain values.",
    ],
    [
      "too_many_pending",
      null,
      "Ana Pérez already has 5 actions waiting for approval from you. Wait for those first.",
    ],
    [
      "arguments_too_large",
      null,
      "This action is too large to approve (over 32 KB). Ask Ana Pérez to split it.",
    ],
  ] as const)("%s → its fixed UI-SPEC sentence, never the API's text", async (reason, approval, sentence) => {
    const fake = fakeClient();
    fake.decide = refuse(reason, approval);
    const g = approvalGuard(fake);
    expect(await g.beforeToolCall(call(NOTE, { text: "x" }), ctx())).toEqual({
      block: true,
      blockReason: sentence,
    });
  });

  it("the requester's name comes from the decision first, then the turn, then a neutral fallback", async () => {
    const fake = fakeClient();
    fake.decide = refuse("approval_used", null);
    const anonymous = approvalGuard(fake, null);
    expect((await anonymous.beforeToolCall(call(NOTE, { text: "x" }), ctx()))?.blockReason).toBe(
      "That approval was already used once. Ask the person who asked if they want to run it again.",
    );
    fake.decide = refuse("too_many_pending", null);
    expect((await approvalGuard(fake, null).beforeToolCall(call(NOTE, {}), ctx()))?.blockReason).toBe(
      "The person who asked already has 5 actions waiting for approval from you. Wait for those first.",
    );
    fake.decide = refuse("approval_pending", { ...APPROVAL, requesterName: "Sam\nLee <x>" });
    expect((await approvalGuard(fake).beforeToolCall(call(NOTE, {}), ctx()))?.blockReason).toBe(
      "This exact action is already waiting for approval in a card. Don't ask again; tell Sam Lee x it is still waiting.",
    );
  });

  it("an unflagged tool's body has no arguments key at all, whatever its params contain", async () => {
    const fake = fakeClient();
    const g = approvalGuard(fake);
    expect(await g.beforeToolCall(call(ECHO, { text: "SENTINEL-88" }), ctx())).toBeUndefined();
    const body = fake.requests[0] as Record<string, unknown>;
    expect(Object.keys(body)).not.toContain("arguments");
    expect(JSON.stringify(body)).not.toContain("SENTINEL-88");
  });

  it("arguments over 32 KB are refused locally with the fixed sentence; nothing is posted", async () => {
    const fake = fakeClient();
    const g = approvalGuard(fake);
    // {"text":"…"} = 11 bytes of JSON around the value: 32,769 bytes in all.
    const big = { text: "x".repeat(32_769 - 11) };
    expect(new TextEncoder().encode(JSON.stringify(big)).length).toBe(32_769);
    expect(await g.beforeToolCall(call(NOTE, big), ctx())).toEqual({
      block: true,
      blockReason: "This action is too large to approve (over 32 KB). Ask Ana Pérez to split it.",
    });
    expect(fake.requests).toEqual([]);
    // Exactly 32 KB still goes to the API.
    expect(await g.beforeToolCall(call(NOTE, { text: "x".repeat(32_768 - 11) }), ctx())).toBeUndefined();
    expect(fake.requests).toHaveLength(1);
    const anonymous = approvalGuard(fakeClient(), null);
    expect((await anonymous.beforeToolCall(call(NOTE, big), ctx()))?.blockReason).toBe(
      "This action is too large to approve (over 32 KB). Ask the person who asked to split it.",
    );
  });

  it("after taint a flagged tool goes to the API (it decides); an unflagged side-effecting one keeps today's local block", async () => {
    const fake = fakeClient();
    const g = approvalGuard(fake);
    expect(await g.beforeToolCall(call(ECHO, { text: "read" }), ctx())).toBeUndefined();
    expect(g.activeTurn(SESSION)?.tainted).toBe(true);
    expect(await g.beforeToolCall(call(NOTE, { text: "after taint" }), ctx())).toBeUndefined();
    expect(fake.requests.map((q) => q.tool)).toEqual([ECHO, NOTE]);
    expect(fake.requests[1]?.arguments).toEqual({ text: "after taint" });
    const r = await g.beforeToolCall(call(DELETE, { id: 1 }), ctx());
    expect(r).toEqual({
      block: true,
      blockReason: `Tool ${DELETE} blocked: this turn is read-only after untrusted content (web or tool output) was read.`,
    });
    expect(fake.requests).toHaveLength(2);
  });

  it("the flag never lifts the local taint block of the memory and board tools (validated by their own routes)", async () => {
    const fake = fakeClient();
    const g = createToolGuard({ client: () => fake.client });
    g.beginTurn(SESSION, {
      eventId: "evt-ap",
      agentId: "a1",
      turn: turn({
        tools: ["web_search", "ocw_memory_save"],
        toolFlags: {
          web_search: WEB,
          ocw_memory_save: { untrustedOutput: false, sideEffecting: true, approval: "always" },
        },
      }),
    });
    await g.beforeToolCall(call("web_search", { query: "q" }), ctx());
    expect(await g.beforeToolCall(call("ocw_memory_save", { text: "x" }), ctx())).toMatchObject({
      block: true,
      blockReason: expect.stringContaining("read-only"),
    });
  });

  it("policy_changed keeps today's generic sentence; an allowed flagged call is counted and taints like any other", async () => {
    const fake = fakeClient();
    fake.decide = refuse("policy_changed");
    const g = approvalGuard(fake);
    expect(await g.beforeToolCall(call(NOTE, {}), ctx())).toEqual({
      block: true,
      blockReason: `Tool ${NOTE} blocked by the workspace policy (policy_changed).`,
    });
    fake.decide = async () => ({ callId: "c-ok", allowed: true, reason: null });
    expect(await g.beforeToolCall(call(NOTE, { text: "go" }), ctx())).toBeUndefined();
    expect(g.activeTurn(SESSION)).toMatchObject({ calls: 2, tainted: true });
  });
});

describe("the param pin (07.5-04, D-04, Pitfall 3): what the API checked is what runs", () => {
  const NOTE = "m1a2b3c4d__write_note";
  const ECHO = "m1a2b3c4d__echo";
  const FLAGGED = { untrustedOutput: true, sideEffecting: true, approval: "when_tainted" as const };

  function pinGuard(fake: FakeClient, session = SESSION) {
    const g = createToolGuard({ client: () => fake.client });
    g.beginTurn(session, {
      eventId: "evt-pin",
      agentId: "a1",
      turn: turn({
        tools: [NOTE, ECHO, "ocw_connector_call"],
        toolFlags: { [NOTE]: FLAGGED, [ECHO]: { untrustedOutput: true, sideEffecting: false } },
      }),
      connectorTools: ["m1a2b3c4d__create_invoice"],
    });
    return g;
  }

  it("an allowed flagged call is pinned under its call id: the pin returns a copy of exactly the checked params, once", async () => {
    const fake = fakeClient();
    const g = pinGuard(fake);
    const params = { amount: 10, to: "billing@globex.example", lines: [{ sku: "A", qty: 2 }] };
    expect(await g.beforeToolCall({ toolName: NOTE, params, toolCallId: "tc-p1" }, ctx())).toBeUndefined();
    // A later mutation of the event's object never reaches the pin.
    params.amount = 999;
    const pinned = g.pinParams({ toolName: NOTE, params: { amount: 1 }, toolCallId: "tc-p1" }, ctx());
    expect(pinned).toEqual({
      params: { amount: 10, to: "billing@globex.example", lines: [{ sku: "A", qty: 2 }] },
    });
    expect(g.pinParams({ toolName: NOTE, params: {}, toolCallId: "tc-p1" }, ctx())).toBeUndefined();
  });

  it("only flagged calls the API allowed are pinned; another session never reads a pin", async () => {
    const fake = fakeClient();
    const g = pinGuard(fake);
    await g.beforeToolCall({ toolName: ECHO, params: { text: "x" }, toolCallId: "tc-u" }, ctx());
    expect(g.pinParams({ toolName: ECHO, params: {}, toolCallId: "tc-u" }, ctx())).toBeUndefined();
    fake.decide = async () => ({ callId: "c", allowed: false, reason: "approval_pending" });
    await g.beforeToolCall({ toolName: NOTE, params: { a: 1 }, toolCallId: "tc-r" }, ctx());
    expect(g.pinParams({ toolName: NOTE, params: {}, toolCallId: "tc-r" }, ctx())).toBeUndefined();
    fake.decide = async () => ({ callId: "c", allowed: true, reason: null });
    await g.beforeToolCall({ toolName: NOTE, params: { a: 2 }, toolCallId: "tc-s" }, ctx());
    expect(
      g.pinParams({ toolName: NOTE, params: {}, toolCallId: "tc-s" }, ctx("agent:ocw-a1:ocw:channel:dm-9")),
    ).toBeUndefined();
    expect(g.pinParams({ toolName: NOTE, params: {}, toolCallId: "tc-s" }, ctx())).toEqual({
      params: { a: 2 },
    });
  });

  it("a flagged call without a tool call id is blocked with the fixed sentence and nothing is posted; the context's id counts", async () => {
    const fake = fakeClient();
    const g = pinGuard(fake);
    expect(await g.beforeToolCall({ toolName: NOTE, params: { a: 1 } }, ctx())).toEqual({
      block: true,
      blockReason: `Tool ${NOTE} blocked: this action needs approval, but the call has no id to bind the approval to (fail closed).`,
    });
    expect(fake.requests).toEqual([]);
    expect(g.activeTurn(SESSION)?.calls).toBe(0);
    expect(
      await g.beforeToolCall({ toolName: NOTE, params: { a: 1 } }, { ...ctx(), toolCallId: "tc-ctx" }),
    ).toBeUndefined();
    expect(fake.requests[0]?.toolCallId).toBe("tc-ctx");
    expect(g.pinParams({ toolName: NOTE, params: {} }, { ...ctx(), toolCallId: "tc-ctx" })).toEqual({
      params: { a: 1 },
    });
  });

  it("pins are dropped when the turn ends (endTurn or its signal), so a blocked call never leaves one behind", async () => {
    const fake = fakeClient();
    const g = pinGuard(fake);
    await g.beforeToolCall({ toolName: NOTE, params: { a: 1 }, toolCallId: "tc-e" }, ctx());
    g.endTurn(SESSION);
    expect(g.pinParams({ toolName: NOTE, params: {}, toolCallId: "tc-e" }, ctx())).toBeUndefined();
    const abort = new AbortController();
    const g2 = createToolGuard({ client: () => fake.client });
    g2.beginTurn(
      SESSION,
      { eventId: "evt-a", agentId: "a1", turn: turn({ tools: [NOTE], toolFlags: { [NOTE]: FLAGGED } }) },
      abort.signal,
    );
    await g2.beforeToolCall({ toolName: NOTE, params: { a: 1 }, toolCallId: "tc-a" }, ctx());
    abort.abort();
    expect(g2.pinParams({ toolName: NOTE, params: {}, toolCallId: "tc-a" }, ctx())).toBeUndefined();
  });

  it("self-validated tools are never pinned: their own route performs exactly what it decided on", async () => {
    const fake = fakeClient();
    const g = createToolGuard({ client: () => fake.client });
    g.beginTurn(SESSION, {
      eventId: "evt-sv",
      agentId: "a1",
      turn: turn({
        tools: ["ocw_connector_call"],
        toolFlags: { m1a2b3c4d__create_invoice: FLAGGED },
      }),
      connectorTools: ["m1a2b3c4d__create_invoice"],
    });
    const params = { connector: "m1a2b3c4d", tool: "create_invoice", arguments: { amount: 10 } };
    expect(await g.beforeToolCall({ toolName: "ocw_connector_call", params }, ctx())).toBeUndefined();
    expect(fake.requests).toEqual([]);
    expect(
      g.pinParams({ toolName: "ocw_connector_call", params: {}, toolCallId: "tc-x" }, ctx()),
    ).toBeUndefined();
  });

  it("ocw_connector_call and ocw_http_request skip the local taint block when the logical tool (or the keychain tool) is flagged", async () => {
    const fake = fakeClient();
    const g = createToolGuard({ client: () => fake.client });
    const begin = (approval: boolean) =>
      g.beginTurn(SESSION, {
        eventId: "evt-ct",
        agentId: "a1",
        turn: turn({
          tools: ["web_search", "ocw_connector_call", "ocw_http_request"],
          toolFlags: {
            web_search: WEB,
            m1a2b3c4d__create_invoice: {
              untrustedOutput: true,
              sideEffecting: true,
              ...(approval ? { approval: "when_tainted" as const } : {}),
            },
            ocw_http_request: {
              untrustedOutput: true,
              sideEffecting: true,
              ...(approval ? { approval: "always" as const } : {}),
            },
          },
        }),
        connectorTools: ["m1a2b3c4d__create_invoice"],
      });
    const invoice = { connector: "m1a2b3c4d", tool: "create_invoice", arguments: { amount: 10 } };
    const post = { handle: "k_abcdefgh23", method: "POST", url: "https://erp.example/x" };
    for (const approval of [true, false]) {
      begin(approval);
      await g.beforeToolCall(call("web_search", { query: "q" }), ctx());
      const c = await g.beforeToolCall(call("ocw_connector_call", invoice), ctx());
      const h = await g.beforeToolCall(call("ocw_http_request", post), ctx());
      if (approval) {
        expect(c).toBeUndefined();
        expect(h).toBeUndefined();
      } else {
        expect(c?.blockReason).toContain("read-only after untrusted content");
        expect(h?.blockReason).toContain("read-only after untrusted content");
      }
    }
  });
});
