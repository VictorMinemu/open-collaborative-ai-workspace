/**
 * Contract: our real plugin entry (index.ts) registered the way OpenClaw 2026.9.7 registers it
 * (testing/openclaw-host.ts mirrors the shipped dist), in every registration mode. Regression for the real-cell
 * bypass found by the CI cell-smoke: the gate lived in `registerFull`, which OpenClaw skips when it loads the
 * non-activated ("discovery") registry it runs agent turns with, so `web_search` ran with no gate and no audit.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentChannelClient } from "./api-client.js";
import { openClawAgentIdFor } from "./mention-mapper.js";
import { type FakeAgentChannelApi, startFakeAgentChannelApi } from "./testing/fake-agent-channel-api.js";
import {
  ALL_REGISTRATION_MODES,
  createTurnHookRunner,
  loadRegistry,
  type PluginEntry,
  type RegistrationMode,
} from "./testing/openclaw-host.js";
import { setToolGuardClient, TOOL_GATE_PRIORITY, TOOL_PIN_PRIORITY, toolGuard } from "./tool-guard.js";

vi.mock(
  "openclaw/plugin-sdk/channel-core",
  async () => (await import("./testing/openclaw-host.js")).channelCoreModule,
);

const { default: entry } = (await import("./index.js")) as unknown as { default: PluginEntry };
const manifest = JSON.parse(
  readFileSync(path.join(import.meta.dirname, "..", "openclaw.plugin.json"), "utf8"),
) as {
  id: string;
  contracts?: { tools?: string[] };
};

const BOT = "0199a6f0-0000-7000-8000-00000000a001";
const SESSION = `agent:${openClawAgentIdFor(BOT)}:ocw:channel:c3:thread:d21`;
const WEB = { untrustedOutput: true, sideEffecting: false };
const WEB_TURN = {
  tools: ["web_search", "web_fetch"],
  toolFlags: { web_search: WEB, web_fetch: WEB },
  memory: [],
  now: null,
  maxToolCalls: 8,
  maxWebCalls: 5,
};

const ocwHooks = (mode: RegistrationMode, kind: "tool" | "gateway" = "tool") =>
  loadRegistry(entry, manifest, { mode })
    .typedHooks.filter(
      (h) => h.pluginId === "ocw" && h.hookName.startsWith("gateway_") === (kind === "gateway"),
    )
    .map(({ hookName, matcher, priority }) => ({ hookName, matcher, priority }));

describe("OpenClaw 2026.9.7 registration of the real entry", () => {
  it.each(["full", "discovery", "tool-discovery"] as const)(
    "a %s registry carries the gate exactly once: before_tool_call unscoped at top priority, the 07.5 param pin at the lowest, + after_tool_call",
    (mode) => {
      expect(ocwHooks(mode)).toEqual([
        { hookName: "before_tool_call", matcher: undefined, priority: TOOL_GATE_PRIORITY },
        { hookName: "before_tool_call", matcher: undefined, priority: TOOL_PIN_PRIORITY },
        { hookName: "after_tool_call", matcher: undefined, priority: undefined },
      ]);
    },
  );

  it.each(["setup-only", "setup-runtime", "cli-metadata"] as const)(
    "a %s load (no capability handlers, no agent turns) registers no hook and does not throw",
    (mode) => {
      expect(ocwHooks(mode)).toEqual([]);
      expect(ocwHooks(mode, "gateway")).toEqual([]);
    },
  );

  it("the restart-loop breaker guard is armed by gateway_start of the boot registry (full), never a turn registry", () => {
    expect(ocwHooks("full", "gateway")).toEqual([
      { hookName: "gateway_start", matcher: undefined, priority: undefined },
    ]);
    expect(ocwHooks("discovery", "gateway")).toEqual([]);
  });

  it("the memory, memory file, card, board, connector, Work Zone and confined tools are registered where OpenClaw resolves plugin tools (boot registry and tool discovery)", () => {
    const tools = (mode: RegistrationMode) =>
      loadRegistry(entry, manifest, { mode }).tools.flatMap((t) => t.names);
    const owned = [
      "ocw_memory_save",
      "ocw_memory_list",
      "ocw_memory_read",
      "ocw_memory_write",
      "ocw_memory_propose",
      "ocw_agent_card",
      "ocw_board_card",
      "ocw_connector_list",
      "ocw_connector_call",
      "ocw_http_request",
      "ocw_work_zone_projects",
      "ocw_start_work_zone",
      "ocw_sandbox_exec",
      "ocw_sandbox_process",
      "ocw_sandbox_read",
      "ocw_sandbox_write",
      "ocw_sandbox_list",
      "ocw_sandbox_delete",
      "ocw_sandbox_share",
      "ocw_sandbox_import",
      "ocw_browser_open",
      "ocw_browser_snapshot",
      "ocw_browser_act",
      "ocw_browser_screenshot",
      "ocw_browser_wait",
      "ocw_browser_signin",
      "ocw_browser_close",
    ];
    expect(tools("full")).toEqual(owned);
    expect(tools("tool-discovery")).toEqual(owned);
  });

  it("no registration diagnostics in any mode", () => {
    for (const mode of ALL_REGISTRATION_MODES) {
      expect(loadRegistry(entry, manifest, { mode }).diagnostics, mode).toEqual([]);
    }
  });
});

describe("a tool call inside a prepared turn (non-activated registry, read exclusively by the hook runner)", () => {
  let api: FakeAgentChannelApi;

  beforeEach(async () => {
    api = await startFakeAgentChannelApi({ agents: [], providers: [] });
    // What channel.ts does at account start, in the boot ("full") instance.
    loadRegistry(entry, manifest, { activate: true });
    setToolGuardClient(createAgentChannelClient({ apiUrl: api.url, token: () => api.token }));
  });

  afterEach(async () => {
    toolGuard.endTurn(SESSION);
    setToolGuardClient(null);
    await api.close();
  });

  const runner = () => createTurnHookRunner(loadRegistry(entry, manifest, { activate: false }));
  const ctx = { sessionKey: SESSION, agentId: openClawAgentIdFor(BOT), runId: "run-1" };

  it("has the gate at all (the bug: hasHooks('before_tool_call') was false, so every call ran ungated)", () => {
    expect(runner().hasHooks("before_tool_call")).toBe(true);
    expect(runner().hasHooks("after_tool_call")).toBe(true);
  });

  it("blocks web_search when no OCW turn is active, without asking the API", async () => {
    const r = await runner().runBeforeToolCall(
      { toolName: "web_search", params: { query: "ocw smoke" }, toolCallId: "tc-0" },
      ctx,
    );
    expect(r).toMatchObject({ blocked: true });
    expect(api.toolCalls).toEqual([]);
  });

  it("asks POST /tool-calls for a turn's web_search, lets it run, then reports the outcome", async () => {
    // What openclaw-port.ts does right before dispatch (boot instance); the turn registry's hook must see it.
    toolGuard.beginTurn(SESSION, { eventId: "evt-web", agentId: BOT, turn: WEB_TURN });
    const r = runner();
    const event = { toolName: "web_search", params: { query: "ocw smoke" }, toolCallId: "tc-1" };
    expect(await r.runBeforeToolCall(event, ctx)).toEqual({ blocked: false });
    await r.runAfterToolCall(
      { ...event, result: { details: { count: 1, provider: "searxng" } }, durationMs: 9 },
      ctx,
    );
    expect(
      api.toolCalls.map(({ eventId, agentId, tool, params, allowed }) => ({
        eventId,
        agentId,
        tool,
        params,
        allowed,
      })),
    ).toEqual([
      { eventId: "evt-web", agentId: BOT, tool: "web_search", params: { query: "ocw smoke" }, allowed: true },
    ]);
    expect(api.toolResults).toEqual([
      { callId: api.toolCalls[0]?.callId, status: "ok", resultCount: 1, provider: "searxng", durationMs: 9 },
    ]);
  });

  it("blocks a tool the turn does not offer, and a denial from the API", async () => {
    toolGuard.beginTurn(SESSION, { eventId: "evt-web2", agentId: BOT, turn: WEB_TURN });
    api.denyTools.add("web_fetch");
    const r = runner();
    expect(
      await r.runBeforeToolCall({ toolName: "exec", params: { cmd: "id" }, toolCallId: "tc-2" }, ctx),
    ).toMatchObject({
      blocked: true,
    });
    const denied = await r.runBeforeToolCall(
      { toolName: "web_fetch", params: { url: "https://x.example/" }, toolCallId: "tc-3" },
      ctx,
    );
    expect(denied).toMatchObject({ blocked: true });
    expect(denied.reason).toContain("denied_by_test");
  });

  it("fails closed when the API never answers: blocked before OpenClaw's 15 s budget expires", async () => {
    toolGuard.beginTurn(SESSION, { eventId: "evt-web3", agentId: BOT, turn: WEB_TURN });
    setToolGuardClient({
      ...createAgentChannelClient({ apiUrl: api.url, token: () => api.token }),
      authorizeToolCall: () => new Promise(() => undefined),
    });
    vi.useFakeTimers();
    try {
      const pending = runner().runBeforeToolCall(
        { toolName: "web_search", params: { query: "q" }, toolCallId: "tc-4" },
        ctx,
      );
      await vi.advanceTimersByTimeAsync(toolGuard.timeoutMs + 100);
      expect(await pending).toMatchObject({ blocked: true, reason: expect.stringContaining("fail closed") });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("MCP tools inside a prepared turn (03.1-10): same gate, exact names, taint", () => {
  let api: FakeAgentChannelApi;
  const SAFE = "m5e0c0de1";
  const READ = `${SAFE}__getFile`;
  const WRITE = `${SAFE}__write_note`;
  const MCP_TURN = {
    tools: [READ, WRITE],
    toolFlags: {
      [READ]: { untrustedOutput: true, sideEffecting: false },
      [WRITE]: { untrustedOutput: true, sideEffecting: true },
    },
    memory: [],
    now: null,
    maxToolCalls: 8,
    maxWebCalls: 5,
  };

  beforeEach(async () => {
    api = await startFakeAgentChannelApi({ agents: [], providers: [] });
    loadRegistry(entry, manifest, { activate: true });
    setToolGuardClient(createAgentChannelClient({ apiUrl: api.url, token: () => api.token }));
  });

  afterEach(async () => {
    toolGuard.endTurn(SESSION);
    setToolGuardClient(null);
    await api.close();
  });

  const ctx = { sessionKey: SESSION, agentId: openClawAgentIdFor(BOT), runId: "run-mcp" };

  it.each(["discovery", "full"] as const)(
    "%s registry: the MCP read is asked with its exact name (the hook sees it lower-cased), the write after it is blocked",
    async (mode) => {
      toolGuard.beginTurn(SESSION, { eventId: `evt-mcp-${mode}`, agentId: BOT, turn: MCP_TURN });
      const r = createTurnHookRunner(loadRegistry(entry, manifest, { mode }));
      const read = { toolName: READ, params: { path: "/notes.md" }, toolCallId: `tc-r-${mode}` };
      expect(await r.runBeforeToolCall(read, ctx)).toEqual({ blocked: false });
      await r.runAfterToolCall({ ...read, result: { content: [] }, durationMs: 4 }, ctx);
      const write = await r.runBeforeToolCall(
        { toolName: WRITE, params: { text: "y" }, toolCallId: `tc-w-${mode}` },
        ctx,
      );
      expect(write).toMatchObject({ blocked: true, reason: expect.stringContaining("read-only") });
      expect(api.toolCalls.map(({ tool, params, allowed }) => ({ tool, params, allowed }))).toEqual([
        { tool: READ, params: {}, allowed: true },
      ]);
      expect(api.toolResults).toEqual([{ callId: api.toolCalls[0]?.callId, status: "ok", durationMs: 4 }]);
    },
  );
});

describe("ocw_agent_card inside a prepared turn (06-14): gated like every tool, then posted through the Agent Channel API", () => {
  let api: FakeAgentChannelApi;
  const CHANNEL = "0199a6f0-0000-7000-8000-00000000c001";
  const ROOT = "0199a6f0-0000-7000-8000-00000000d001";
  const ASKED = "0199a6f0-0000-7000-8000-00000000d003";
  const CARD_TURN = {
    tools: ["ocw_agent_card"],
    toolFlags: { ocw_agent_card: { untrustedOutput: false, sideEffecting: false } },
    memory: [],
    now: null,
    maxToolCalls: 8,
    maxWebCalls: 5,
  };
  const card = {
    kind: "report",
    title: "Weekly report",
    fields: [{ label: "Week", value: "41" }],
    status: "succeeded",
    actions: [{ kind: "follow", label: "Follow" }],
    summary: "Weekly report is ready",
  };

  beforeEach(async () => {
    api = await startFakeAgentChannelApi({
      agents: [
        {
          id: BOT,
          handle: "archie",
          displayName: "Archie",
          instructions: "",
          status: "ready",
          modelRef: "fake/mock-1",
          model: { provider: "mock", providerId: "fake", id: "mock-1" },
          capabilities: { tools: ["ocw_agent_card"] },
        },
      ],
      providers: [],
    });
    setToolGuardClient(createAgentChannelClient({ apiUrl: api.url, token: () => api.token }));
  });

  afterEach(async () => {
    toolGuard.endTurn(SESSION);
    setToolGuardClient(null);
    await api.close();
  });

  const ctx = { sessionKey: SESSION, agentId: openClawAgentIdFor(BOT), runId: "run-card" };
  type Factory = (c: Record<string, unknown>) => {
    execute: (id: string, p: unknown) => Promise<{ content: Array<{ text: string }> }>;
  };
  const cardTool = (mode: RegistrationMode) => {
    const reg = loadRegistry(entry, manifest, { mode });
    const owned = reg.tools.find((t) => t.names.includes("ocw_agent_card"));
    if (!owned) throw new Error(`ocw_agent_card not registered in ${mode}`);
    return (owned.factory as Factory)(ctx);
  };

  it("discovery registry asks POST /tool-calls; the tool (boot registry) posts the card bound to the turn", async () => {
    toolGuard.beginTurn(SESSION, {
      eventId: "evt-card",
      agentId: BOT,
      turn: CARD_TURN,
      conversationId: CHANNEL,
      threadRootId: ROOT,
      messageId: ASKED,
    });
    const r = createTurnHookRunner(loadRegistry(entry, manifest, { activate: false }));
    // OpenClaw hands hooks lower-cased names; this one is already lower case.
    expect(
      await r.runBeforeToolCall(
        { toolName: "ocw_agent_card", params: { action: "create", card }, toolCallId: "tc-c1" },
        ctx,
      ),
    ).toEqual({ blocked: false });
    const out = await cardTool("full").execute("tc-c1", { action: "create", card });
    expect(out.content[0]?.text).toMatch(/^Card posted\./);
    expect(
      api.toolCalls.map(({ eventId, tool, params, allowed }) => ({ eventId, tool, params, allowed })),
    ).toEqual([{ eventId: "evt-card", tool: "ocw_agent_card", params: {}, allowed: true }]);
    expect(api.cards).toEqual([
      expect.objectContaining({
        agentId: BOT,
        conversationId: CHANNEL,
        threadRootId: ROOT,
        inReplyToMessageId: ASKED,
        idempotencyKey: "evt-card:card:0",
        card,
      }),
    ]);
  });

  it("a denial from the API blocks the call before the tool runs (fail closed, nothing posted)", async () => {
    toolGuard.beginTurn(SESSION, {
      eventId: "evt-card-2",
      agentId: BOT,
      turn: CARD_TURN,
      conversationId: CHANNEL,
      threadRootId: ROOT,
      messageId: ASKED,
    });
    api.denyTools.add("ocw_agent_card");
    const r = createTurnHookRunner(loadRegistry(entry, manifest, { activate: false }));
    const blocked = await r.runBeforeToolCall(
      { toolName: "ocw_agent_card", params: { action: "create", card }, toolCallId: "tc-c2" },
      ctx,
    );
    expect(blocked).toMatchObject({ blocked: true, reason: expect.stringContaining("denied_by_test") });
    expect(api.cards).toEqual([]);
  });

  it("no active turn: blocked by the gate without asking the API", async () => {
    const r = createTurnHookRunner(loadRegistry(entry, manifest, { activate: false }));
    expect(
      await r.runBeforeToolCall({ toolName: "ocw_agent_card", params: {}, toolCallId: "tc-c3" }, ctx),
    ).toMatchObject({ blocked: true });
    expect(api.toolCalls).toEqual([]);
  });
});
