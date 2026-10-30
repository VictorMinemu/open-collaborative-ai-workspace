/**
 * `ocw_record_update` (07.6 AUTO-04, D-04, C-01): the bot changes fields of the watched record of the turn's card only
 * through the API's compare-and-set. Driven through the tool's registration with a recording client (the HTTP shape is
 * api-client.test.ts's; the gate's taint block is tool-guard.test.ts's).
 */
import { describe, expect, it } from "vitest";
import type {
  AgentChannelRecordUpdate,
  AgentChannelRecordUpdateResponse,
  TurnContext,
} from "./agent-channel-protocol.js";
import { type AgentChannelClient, AgentChannelHttpError } from "./api-client.js";
import { openClawAgentIdFor } from "./mention-mapper.js";
import {
  RECORD_UPDATE_SENTENCES,
  RECORD_UPDATE_TOOL,
  type RecordToolContext,
  registerRecordTool,
} from "./record-tool.js";
import { createToolGuard } from "./tool-guard.js";

const BOT = "0199a6f0-0000-7000-8000-00000000a001";
const CONV = "0199a6f0-0000-7000-8000-00000000c002";
const SESSION = `agent:${openClawAgentIdFor(BOT)}:ocw:channel:${CONV}:thread:card-1`;
const FLAGS = { untrustedOutput: true, sideEffecting: true };
const UPDATED = "Updated SO-10442 in ERP.";
const CHANGED =
  "The record changed in ERP since the last check, so nothing was written. A card with the new values is in the thread. Tell Víctor Ruiz and ask whether to apply the update to the new values.";

function turn(over: Partial<TurnContext> = {}): TurnContext {
  return {
    tools: [RECORD_UPDATE_TOOL],
    toolFlags: { [RECORD_UPDATE_TOOL]: FLAGS },
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
  parameters: {
    type: string;
    additionalProperties: boolean;
    required?: string[];
    properties: Record<string, unknown>;
  };
  execute: (id: string, params: unknown, signal?: AbortSignal) => Promise<ToolResult>;
};
type Factory = (ctx: RecordToolContext) => Tool;
const text = (r: ToolResult) => r.content.map((c) => c.text).join("");

function setup(
  respond: (body: AgentChannelRecordUpdate) => Promise<AgentChannelRecordUpdateResponse> = async () => ({
    ok: true,
    code: null,
    sentence: UPDATED,
  }),
) {
  const calls: AgentChannelRecordUpdate[] = [];
  const client = {
    updateRecord: async (body: AgentChannelRecordUpdate) => {
      calls.push(structuredClone(body));
      return respond(body);
    },
  } as unknown as AgentChannelClient;
  const guard = createToolGuard({ client: () => client });
  const registered: Array<{ factory: Factory; opts: { name: string } }> = [];
  const logs: string[] = [];
  registerRecordTool(
    {
      registerTool: (factory: Factory, opts: { name: string }) => registered.push({ factory, opts }),
    } as never,
    { guard, client: () => client, logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m) } },
  );
  const tool = () => {
    const r = registered.find((x) => x.opts.name === RECORD_UPDATE_TOOL);
    if (!r) throw new Error("not registered");
    return r.factory({ sessionKey: SESSION, agentId: openClawAgentIdFor(BOT) });
  };
  const begin = (t: TurnContext = turn()) =>
    guard.beginTurn(SESSION, {
      eventId: "evt-1",
      agentId: BOT,
      turn: t,
      conversationId: CONV,
      threadRootId: "card-1",
      requesterName: "Víctor Ruiz",
    });
  return { calls, guard, registered, tool, begin, logs };
}

describe("ocw_record_update (07.6 AUTO-04, D-04, C-01): a thin caller of POST /records/update", () => {
  it("registers one tool under its fixed name, with a closed schema taking changes only", () => {
    const { registered, tool } = setup();
    expect(registered.map((r) => r.opts.name)).toEqual(["ocw_record_update"]);
    expect(tool().parameters.additionalProperties).toBe(false);
    expect(Object.keys(tool().parameters.properties)).toEqual(["changes"]);
    expect(tool().parameters.required).toEqual(["changes"]);
  });

  it("posts exactly {eventId, agentId, changes} (never a record id or a hash) and returns the server's sentence", async () => {
    const { calls, begin, tool, logs } = setup();
    begin();
    const r = await tool().execute("tc-1", {
      changes: { "/status": "Shipped", "/qty": 3, "/rush": false, "/note": null },
    });
    expect(calls).toEqual([
      {
        eventId: "evt-1",
        agentId: BOT,
        changes: { "/status": "Shipped", "/qty": 3, "/rush": false, "/note": null },
      },
    ]);
    expect(text(r)).toBe(UPDATED);
    expect(r.details).toEqual({ ok: true });
    expect(logs.join("\n")).not.toContain("Shipped");
  });

  it("record_changed: the server's sentence is returned verbatim, with its code", async () => {
    const { begin, tool } = setup(async () => ({ ok: false, code: "record_changed", sentence: CHANGED }));
    begin();
    const r = await tool().execute("tc-1", { changes: { "/status": "Shipped" } });
    expect(text(r)).toBe(CHANGED);
    expect(r.details).toEqual({ ok: false, code: "record_changed" });
  });

  it("21 changes are refused locally with a fixed answer; 20 are sent", async () => {
    const { calls, begin, tool } = setup();
    begin();
    const many = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`/f${i}`, i]));
    const r = await tool().execute("tc-1", { changes: many(21) });
    expect(text(r)).toBe(RECORD_UPDATE_SENTENCES.too_many());
    expect(r.details).toEqual({ ok: false, code: "too_many_changes" });
    expect(calls).toEqual([]);
    await tool().execute("tc-2", { changes: many(20) });
    expect(calls).toHaveLength(1);
  });

  it("invalid changes or extra keys are refused locally: never a record id, a hash or the whole record", async () => {
    const { calls, begin, tool } = setup();
    begin();
    for (const bad of [
      { changes: {} },
      { changes: { "": "x" } },
      { changes: { status: "x" } },
      { changes: { "/a~2b": "x" } },
      { changes: { [`/${"x".repeat(200)}`]: "x" } },
      { changes: { "/status": { nested: true } } },
      { changes: { "/tags": ["a"] } },
      { changes: { "/status": "x".repeat(501) } },
      { changes: { "/qty": Number.NaN } },
      { changes: "status=Shipped" },
      { changes: { "/status": "Shipped" }, recordId: "SO-10442" },
      { changes: { "/status": "Shipped" }, hash: "abc" },
      {},
    ]) {
      const r = await tool().execute("tc-x", bad);
      expect(r.details.ok).toBe(false);
    }
    expect(calls).toEqual([]);
  });

  it("a tainted turn is blocked before any request; with a 07.5 approval flag the API decides (it may ask a person)", async () => {
    const tainted = setup();
    tainted.begin();
    const t = tainted.guard.activeTurn(SESSION);
    if (!t) throw new Error("no turn");
    t.tainted = true;
    const r = await tainted.tool().execute("tc-1", { changes: { "/status": "Shipped" } });
    expect(tainted.calls).toEqual([]);
    expect(text(r)).toBe(
      "I can't update the record after reading outside content in this turn. Tell Víctor Ruiz to ask again in a new message.",
    );
    expect(r.details).toEqual({ ok: false, code: "tainted" });

    const approval = setup(async () => ({
      ok: false,
      code: "approval_required",
      sentence: "This update needs approval. I posted a card and asked a lead of Ops.",
    }));
    approval.begin(turn({ toolFlags: { [RECORD_UPDATE_TOOL]: { ...FLAGS, approval: "when_tainted" } } }));
    const at = approval.guard.activeTurn(SESSION);
    if (!at) throw new Error("no turn");
    at.tainted = true;
    const r2 = await approval.tool().execute("tc-1", { changes: { "/status": "Shipped" } });
    expect(approval.calls).toHaveLength(1);
    expect(text(r2)).toBe("This update needs approval. I posted a card and asked a lead of Ops.");
  });

  it("no active turn, a turn without the tool, an ended turn and an outage are fixed sentences", async () => {
    const none = setup();
    expect(text(await none.tool().execute("tc-1", { changes: { "/a": 1 } }))).toBe(
      RECORD_UPDATE_SENTENCES.no_turn(),
    );
    const off = setup();
    off.begin(turn({ tools: [] }));
    expect(text(await off.tool().execute("tc-1", { changes: { "/a": 1 } }))).toBe(
      RECORD_UPDATE_SENTENCES.not_in_turn(),
    );
    const ended = setup(async () => {
      throw new AgentChannelHttpError(404, "/records/update", "x", "unknown_turn");
    });
    ended.begin();
    expect(text(await ended.tool().execute("tc-1", { changes: { "/a": 1 } }))).toBe(
      RECORD_UPDATE_SENTENCES.unknown_turn(),
    );
    const conflict = setup(async () => {
      throw new AgentChannelHttpError(409, "/records/update", "x", undefined, undefined, undefined, {
        ok: false,
        code: "record_changed",
        sentence: CHANGED,
      });
    });
    conflict.begin();
    expect(text(await conflict.tool().execute("tc-1", { changes: { "/a": 1 } }))).toBe(CHANGED);
    const down = setup(async () => {
      throw new Error("ECONNRESET");
    });
    down.begin();
    const r = await down.tool().execute("tc-1", { changes: { "/a": 1 } });
    expect(text(r)).toBe(RECORD_UPDATE_SENTENCES.unreachable());
    expect(off.calls).toEqual([]);
    expect(none.calls).toEqual([]);
  });
});
