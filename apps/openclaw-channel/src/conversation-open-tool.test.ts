/**
 * `ocw_conversation_open` (07.17 D-02, D-03, D-05, PD-07). The tracer drives our REAL entry the way OpenClaw registers
 * it (testing/openclaw-host.ts), through the real call-time gate, against the fake Agent Channel API over HTTP; the
 * renderings and the local refusals use a recording client.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AgentChannelConversationOpen,
  type AgentChannelConversationOpenResponse,
  CONVERSATION_OPEN_SENTENCES,
  CONVERSATION_OPEN_TOOL,
  FAN_OUT_LIMITS,
  type TurnContext,
} from "./agent-channel-protocol.js";
import { type AgentChannelClient, AgentChannelHttpError, createAgentChannelClient } from "./api-client.js";
import {
  CONVERSATION_OPEN_TOOL_SENTENCES,
  type ConversationOpenToolContext,
  registerConversationOpenTool,
  renderConversationOpen,
} from "./conversation-open-tool.js";
import { openClawAgentIdFor } from "./mention-mapper.js";
import {
  FAKE_ERROR_CANARY,
  FAKE_OPENED_CONVERSATION,
  FAKE_OPENED_ROOTS,
  type FakeAgentChannelApi,
  startFakeAgentChannelApi,
} from "./testing/fake-agent-channel-api.js";
import { loadRegistry, type PluginEntry } from "./testing/openclaw-host.js";
import { createToolGuard, setToolGuardClient, toolGuard } from "./tool-guard.js";
import { withTurnScopedTools } from "./turn-scoped-tools.js";

vi.mock(
  "openclaw/plugin-sdk/channel-core",
  async () => (await import("./testing/openclaw-host.js")).channelCoreModule,
);

const { default: entry } = (await import("./index.js")) as unknown as { default: PluginEntry };
const manifest = JSON.parse(
  readFileSync(path.join(import.meta.dirname, "..", "openclaw.plugin.json"), "utf8"),
) as { id: string; contracts?: { tools?: string[] } };

const BOT = "0199a6f0-0000-7000-8000-00000000a001";
const RUN_LOG = "0199a6f0-0000-7000-8000-00000000c017";
const SESSION = `agent:${openClawAgentIdFor(BOT)}:ocw:channel:${RUN_LOG}`;
const EVENT = "0199a6f0-0000-7000-8000-00000000e017";
const CONV = "0199a6f0-0000-7000-8000-00000000c0b1";
const ROOT_1 = "0199a6f0-0000-7000-8000-00000000d101";
const ROOT_2 = "0199a6f0-0000-7000-8000-00000000d102";
const SIDE = { untrustedOutput: false, sideEffecting: true };
const MCP_READ = { untrustedOutput: true, sideEffecting: false };
const NO_TURN = "There is no active conversation turn, so I can't use this tool now.";

const ITEM_1 = { externalKey: "1042", title: "Order 1042: 3 pallets", body: "Ship to Madrid" };
const ITEM_2 = { externalKey: "1043", title: "Order 1043: 1 pallet", body: "" };

/** A fan-out run turn: the open tool and a read-only MCP tool (whose output taints the turn). */
function runTurn(over: Partial<TurnContext> = {}): TurnContext {
  return {
    tools: ["ocw_agent_card", "ocw_connector_call", CONVERSATION_OPEN_TOOL],
    toolFlags: { ocw_agent_card: SIDE, [CONVERSATION_OPEN_TOOL]: SIDE, m1a2b3c4d__list_orders: MCP_READ },
    memory: [],
    now: null,
    maxToolCalls: 8,
    maxWebCalls: 5,
    ...over,
  };
}

type ToolResult = { content: Array<{ type: string; text: string }>; details: Record<string, unknown> };
type Tool = {
  name: string;
  description: string;
  parameters: {
    type: string;
    additionalProperties: boolean;
    required?: string[];
    properties: Record<
      string,
      {
        type?: string;
        maxItems?: number;
        items?: {
          additionalProperties?: boolean;
          required?: string[];
          properties: Record<string, { maxLength?: number; minLength?: number }>;
        };
      }
    >;
  };
  execute: (id: string, params: unknown, signal?: AbortSignal) => Promise<ToolResult>;
};
type Factory = (ctx: ConversationOpenToolContext) => Tool;

const text = (r: ToolResult) => r.content.map((c) => c.text).join("");

describe("ocw_conversation_open through the real entry, the gate and the Agent Channel API (tracer)", () => {
  let api: FakeAgentChannelApi;
  const ctx = { sessionKey: SESSION, agentId: openClawAgentIdFor(BOT) };

  beforeEach(async () => {
    api = await startFakeAgentChannelApi({ agents: [], providers: [] });
    setToolGuardClient(createAgentChannelClient({ apiUrl: api.url, token: () => api.token }));
  });

  afterEach(async () => {
    toolGuard.endTurn(SESSION);
    setToolGuardClient(null);
    await api.close();
  });

  const ownedTool = () => {
    const owned = loadRegistry(entry, manifest, { mode: "full" }).tools.find((t) =>
      t.names.includes(CONVERSATION_OPEN_TOOL),
    );
    if (!owned) throw new Error(`${CONVERSATION_OPEN_TOOL} is not registered`);
    return (owned.factory as Factory)(ctx);
  };
  const begin = (t: TurnContext = runTurn(), tainted = false) =>
    toolGuard.beginTurn(SESSION, {
      eventId: EVENT,
      agentId: BOT,
      turn: t,
      conversationId: RUN_LOG,
      connectorTools: ["m1a2b3c4d__list_orders"],
      tainted,
    });

  it("after an MCP read taints the run turn, the gate still lets the call through and the tool posts exactly {eventId, agentId, items} to /conversations/open", async () => {
    begin();
    // The run reads the orders MCP (validated by its own route): the turn is tainted from here on (D-05).
    const read = { toolName: "ocw_connector_call", toolCallId: "tc-1" };
    const readParams = { connector: "m1a2b3c4d", tool: "list_orders", arguments: {} };
    expect(await toolGuard.beforeToolCall({ ...read, params: readParams }, ctx)).toBeUndefined();
    expect(toolGuard.activeTurn(SESSION)?.tainted).toBe(true);
    // The open call reaches the route: the route decides taint (D-05), never `/tool-calls` (self-validated).
    const params = { items: [ITEM_1, ITEM_2] };
    expect(
      await toolGuard.beforeToolCall({ toolName: CONVERSATION_OPEN_TOOL, toolCallId: "tc-2", params }, ctx),
    ).toBeUndefined();
    expect(api.toolCalls).toEqual([]);
    const r = await ownedTool().execute("tc-2", params);
    expect(api.conversationOpens).toEqual([{ eventId: EVENT, agentId: BOT, items: [ITEM_1, ITEM_2] }]);
    const body = api.conversationOpens[0] as AgentChannelConversationOpen;
    expect(Object.keys(body).sort()).toEqual(["agentId", "eventId", "items"]);
    for (const item of body.items) expect(Object.keys(item).sort()).toEqual(["body", "externalKey", "title"]);
    expect(text(r)).toBe(
      [
        `opened 1042 → ${FAKE_OPENED_ROOTS[0]}`,
        `opened 1043 → ${FAKE_OPENED_ROOTS[1]}`,
        `${FAN_OUT_LIMITS.perRunDefault - 2} left this run, ${FAN_OUT_LIMITS.perDayDefault - 2} today`,
      ].join("\n"),
    );
    expect(r.details).toEqual({ ok: true, opened: 2 });
  });

  it("the /__test/conversations answer replaces the default; a 5xx and an ended turn are fixed sentences, never the API's body", async () => {
    begin(runTurn(), true);
    const set = await fetch(`${api.url}/__test/conversations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ answer: { ok: false, code: "fan_out_off", sentence: "ignored" } }),
    });
    expect(set.status).toBe(200);
    const off = await ownedTool().execute("tc-1", { items: [ITEM_1] });
    expect(text(off)).toBe(CONVERSATION_OPEN_SENTENCES.fan_out_off);
    expect(off.details).toEqual({ ok: false, code: "fan_out_off" });
    await fetch(`${api.url}/__test/conversations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: 503 }),
    });
    const down = await ownedTool().execute("tc-2", { items: [ITEM_1] });
    expect(text(down)).toBe(CONVERSATION_OPEN_TOOL_SENTENCES.unreachable);
    expect(JSON.stringify(down)).not.toContain(FAKE_ERROR_CANARY);
    await fetch(`${api.url}/__test/conversations`, { method: "POST", body: "{}" });
    api.endTurn(EVENT);
    const gone = await ownedTool().execute("tc-3", { items: [ITEM_1] });
    expect(text(gone)).toBe(CONVERSATION_OPEN_TOOL_SENTENCES.unknown_turn);
    expect(JSON.stringify(gone)).not.toContain(FAKE_ERROR_CANARY);
    expect(api.conversationOpens).toHaveLength(3);
  });

  it("the fake route is strict like the real one: a conversation id is a 400", async () => {
    const res = await fetch(`${api.url}/agent-channel/v1/conversations/open`, {
      method: "POST",
      headers: { authorization: `Bearer ${api.token}`, "content-type": "application/json" },
      body: JSON.stringify({ eventId: EVENT, agentId: BOT, items: [], conversationId: CONV }),
    });
    expect(res.status).toBe(400);
  });

  it("the default answer opens every item in the fixed conversation", async () => {
    begin();
    await ownedTool().execute("tc-1", { items: [ITEM_1] });
    const res = await fetch(`${api.url}/agent-channel/v1/conversations/open`, {
      method: "POST",
      headers: { authorization: `Bearer ${api.token}`, "content-type": "application/json" },
      body: JSON.stringify({ eventId: EVENT, agentId: BOT, items: [ITEM_2] }),
    });
    expect(await res.json()).toEqual({
      ok: true,
      results: [
        {
          externalKey: "1043",
          opened: true,
          conversationId: FAKE_OPENED_CONVERSATION,
          threadRootMessageId: FAKE_OPENED_ROOTS[0],
          refused: null,
        },
      ],
      remainingRun: FAN_OUT_LIMITS.perRunDefault - 1,
      remainingDay: FAN_OUT_LIMITS.perDayDefault - 1,
    });
  });
});

function setup(
  respond?: (body: AgentChannelConversationOpen) => Promise<AgentChannelConversationOpenResponse>,
) {
  const calls: AgentChannelConversationOpen[] = [];
  const client = {
    conversationOpen: async (body: AgentChannelConversationOpen) => {
      calls.push(structuredClone(body));
      if (respond) return respond(body);
      return {
        ok: true,
        results: body.items.map((i, n) => ({
          externalKey: i.externalKey,
          opened: true,
          conversationId: CONV,
          threadRootMessageId: n === 0 ? ROOT_1 : ROOT_2,
          refused: null,
        })),
        remainingRun: 10,
        remainingDay: 96,
      } satisfies AgentChannelConversationOpenResponse;
    },
  } as unknown as AgentChannelClient;
  const guard = createToolGuard({ client: () => client });
  const registered: Array<{ factory: Factory; opts: { name: string } }> = [];
  const logs: string[] = [];
  registerConversationOpenTool(
    {
      registerTool: (factory: Factory, opts: { name: string }) => registered.push({ factory, opts }),
    } as never,
    {
      guard,
      client: () => client,
      logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
    },
  );
  const tool = () => {
    const r = registered[0];
    if (!r) throw new Error("not registered");
    return r.factory({ sessionKey: SESSION, agentId: openClawAgentIdFor(BOT) });
  };
  const begin = (t: TurnContext = runTurn(), tainted = true) =>
    guard.beginTurn(SESSION, { eventId: EVENT, agentId: BOT, turn: t, conversationId: RUN_LOG, tainted });
  return { calls, guard, registered, tool, begin, logs };
}

describe("ocw_conversation_open: the schema, the renderings and the local refusals", () => {
  it("registers one tool whose schema takes only items (≤ 25 of {externalKey, title, body}), never a conversation, column, person, automation or run", () => {
    const { registered, tool } = setup();
    expect(registered.map((r) => r.opts)).toEqual([{ name: CONVERSATION_OPEN_TOOL }]);
    const t = tool();
    expect(t.name).toBe("ocw_conversation_open");
    expect(t.parameters.additionalProperties).toBe(false);
    expect(t.parameters.required).toEqual(["items"]);
    expect(Object.keys(t.parameters.properties)).toEqual(["items"]);
    const items = t.parameters.properties.items;
    expect(items?.maxItems).toBe(FAN_OUT_LIMITS.perRunMax);
    expect(items?.items?.additionalProperties).toBe(false);
    expect(Object.keys(items?.items?.properties ?? {}).sort()).toEqual(["body", "externalKey", "title"]);
    expect(items?.items?.required).toEqual(["externalKey", "title"]);
    expect(items?.items?.properties.externalKey?.maxLength).toBe(FAN_OUT_LIMITS.externalKeyMax);
    expect(items?.items?.properties.title?.maxLength).toBe(FAN_OUT_LIMITS.titleMax);
    expect(items?.items?.properties.body?.maxLength).toBe(FAN_OUT_LIMITS.bodyMax);
  });

  it("on a tainted run turn the call posts the turn's ids and the items, and renders one line per item plus the counts", async () => {
    const { calls, begin, tool, logs } = setup();
    begin();
    const r = await tool().execute("tc-1", { items: [ITEM_1, ITEM_2] });
    expect(calls).toEqual([{ eventId: EVENT, agentId: BOT, items: [ITEM_1, ITEM_2] }]);
    expect(text(r)).toBe(
      [`opened 1042 → ${ROOT_1}`, `opened 1043 → ${ROOT_2}`, "10 left this run, 96 today"].join("\n"),
    );
    // Logs carry ids and counts only, never a key, a title or a body.
    const all = logs.join("\n");
    expect(all).toContain(EVENT);
    for (const secret of ["1042", "Order", "Madrid"]) expect(all).not.toContain(secret);
  });

  it("an empty list (nothing new) still posts and says so", async () => {
    const { calls, begin, tool } = setup(async () => ({
      ok: true,
      results: [],
      remainingRun: 10,
      remainingDay: 100,
    }));
    begin();
    const r = await tool().execute("tc-1", { items: [] });
    expect(calls).toEqual([{ eventId: EVENT, agentId: BOT, items: [] }]);
    expect(text(r)).toBe(["Nothing new: no conversation opened.", "10 left this run, 100 today"].join("\n"));
  });

  it("already open, a run cap and a daily cap render their own lines; a body left out is sent as an empty body", async () => {
    const { calls, begin, tool } = setup(async (body) => ({
      ok: true,
      results: [
        {
          externalKey: "1042",
          opened: false,
          conversationId: CONV,
          threadRootMessageId: ROOT_1,
          refused: null,
        },
        {
          externalKey: "1043",
          opened: false,
          conversationId: null,
          threadRootMessageId: null,
          refused: "run_cap",
        },
        {
          externalKey: "1044",
          opened: false,
          conversationId: null,
          threadRootMessageId: null,
          refused: "day_cap",
        },
      ].slice(0, body.items.length),
      remainingRun: 0,
      remainingDay: 0,
    }));
    begin();
    const r = await tool().execute("tc-1", {
      items: [ITEM_1, ITEM_2, { externalKey: "1044", title: "Order 1044" }],
    });
    expect(calls[0]?.items[2]).toEqual({ externalKey: "1044", title: "Order 1044", body: "" });
    expect(text(r)).toBe(
      [
        "already open 1042",
        "not opened 1043 (run limit)",
        "not opened 1044 (daily limit)",
        "0 left this run, 0 today",
      ].join("\n"),
    );
    expect(r.details).toEqual({ ok: true, opened: 0 });
  });

  it("an ok: false answer renders exactly its fixed sentence; an unknown code from a newer API reads the API's one-line sentence", async () => {
    for (const code of Object.keys(CONVERSATION_OPEN_SENTENCES) as Array<
      keyof typeof CONVERSATION_OPEN_SENTENCES
    >) {
      const { begin, tool } = setup(async () => ({ ok: false, code, sentence: "the API's own words" }));
      begin();
      const r = await tool().execute("tc-1", { items: [ITEM_1] });
      expect(text(r), code).toBe(CONVERSATION_OPEN_SENTENCES[code]);
      expect(r.details).toEqual({ ok: false, code });
    }
    const newer = setup(async () => ({
      ok: false,
      code: "brand_new",
      sentence: "Not now.\nReally <b>not</b>.",
    }));
    newer.begin();
    expect(text(await newer.tool().execute("tc-1", { items: [ITEM_1] }))).toBe("Not now. Really bnot/b.");
  });

  it("a refusal thrown with the API's {ok: false, code, sentence} body renders the same fixed sentence", async () => {
    const { begin, tool } = setup(async () => {
      throw new AgentChannelHttpError(
        403,
        "/conversations/open",
        "403",
        "cap_reached",
        undefined,
        undefined,
        {
          ok: false,
          code: "cap_reached",
          sentence: "ignored",
        },
      );
    });
    begin();
    expect(text(await tool().execute("tc-1", { items: [ITEM_1] }))).toBe(
      CONVERSATION_OPEN_SENTENCES.cap_reached,
    );
  });

  it("refused locally without a post: no turn, the tool not on the turn, 26 items, an empty key, an extra key or a conversation id", async () => {
    const { calls, begin, tool } = setup();
    expect(text(await tool().execute("tc-1", { items: [ITEM_1] }))).toBe(NO_TURN);
    begin(runTurn({ tools: ["ocw_agent_card", "ocw_connector_call"] }));
    expect(text(await tool().execute("tc-2", { items: [ITEM_1] }))).toBe(
      CONVERSATION_OPEN_SENTENCES.not_in_turn,
    );
    begin();
    const many = Array.from({ length: FAN_OUT_LIMITS.perRunMax + 1 }, (_, n) => ({
      externalKey: String(n),
      title: `Order ${n}`,
    }));
    const cases: Array<[unknown, string]> = [
      [{ items: many }, CONVERSATION_OPEN_TOOL_SENTENCES.too_many],
      [{ items: [{ ...ITEM_1, externalKey: "  " }] }, CONVERSATION_OPEN_TOOL_SENTENCES.bad_item],
      [{ items: [{ ...ITEM_1, title: "" }] }, CONVERSATION_OPEN_TOOL_SENTENCES.bad_item],
      [
        { items: [{ ...ITEM_1, body: "x".repeat(FAN_OUT_LIMITS.bodyMax + 1) }] },
        CONVERSATION_OPEN_TOOL_SENTENCES.bad_item,
      ],
      [{ items: [{ ...ITEM_1, columnId: CONV }] }, CONVERSATION_OPEN_TOOL_SENTENCES.bad_item],
      [{ items: [ITEM_1], conversationId: CONV }, CONVERSATION_OPEN_TOOL_SENTENCES.extra_keys],
      [{ items: [ITEM_1], automationId: CONV, runId: CONV }, CONVERSATION_OPEN_TOOL_SENTENCES.extra_keys],
      [{ items: "1042" }, CONVERSATION_OPEN_TOOL_SENTENCES.bad_items],
      [{}, CONVERSATION_OPEN_TOOL_SENTENCES.bad_items],
    ];
    for (const [params, sentence] of cases) {
      expect(text(await tool().execute("tc-3", params)), JSON.stringify(params).slice(0, 80)).toBe(sentence);
    }
    expect(calls).toEqual([]);
  });

  it("a network failure is the unreachable sentence; an answer it cannot read is the unreadable sentence", async () => {
    const down = setup(async () => {
      throw new TypeError("fetch failed");
    });
    down.begin();
    expect(text(await down.tool().execute("tc-1", { items: [ITEM_1] }))).toBe(
      CONVERSATION_OPEN_TOOL_SENTENCES.unreachable,
    );
    const bad = setup(async () => {
      const { AgentChannelConversationOpenResponse } = await import("./agent-channel-protocol.js");
      return AgentChannelConversationOpenResponse.parse({ ok: true });
    });
    bad.begin();
    expect(text(await bad.tool().execute("tc-1", { items: [ITEM_1] }))).toBe(
      CONVERSATION_OPEN_TOOL_SENTENCES.unreadable,
    );
  });

  it("keys are shown as given but on one line, without markup characters", () => {
    const r = renderConversationOpen({
      ok: true,
      results: [
        {
          externalKey: "A\n<1>`x`",
          opened: true,
          conversationId: CONV,
          threadRootMessageId: null,
          refused: null,
        },
      ],
      remainingRun: 1,
      remainingDay: 2,
    });
    expect(text(r)).toBe([`opened A 1x → ${CONV}`, "1 left this run, 2 today"].join("\n"));
  });
});

describe("turn scoping and the manifest (07.17 PD-07)", () => {
  it("is configured for every bot served delivered-turn tools, never from GET /cell alone", () => {
    expect(withTurnScopedTools(["ocw_agent_card"])).toContain(CONVERSATION_OPEN_TOOL);
    expect(withTurnScopedTools(["web_search"])).toEqual(["web_search"]);
  });

  it("the manifest declares it and the real entry registers it", () => {
    expect(manifest.contracts?.tools).toContain(CONVERSATION_OPEN_TOOL);
    const registered = loadRegistry(entry, manifest, { mode: "full" }).tools.flatMap((t) => t.names);
    expect(registered).toContain(CONVERSATION_OPEN_TOOL);
  });
});
