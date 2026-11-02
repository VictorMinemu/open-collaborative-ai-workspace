import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createFakeErpMcp,
  FAKE_ERP_TOOLS,
  type FakeErpMcp,
} from "../../../../../infra/fake-model/fake-erp-mcp.mjs";
import type { TestClient } from "../../testing";
import {
  assertNoGlobalFetch,
  auditRows,
  type ConnectorsStack,
  type Json,
  ok,
  startConnectorsStack,
} from "../../testing-connectors";
import { eventually } from "../../testing-device";
import { replaceServerTools } from "../mcp";

/**
 * 07.6-14 (AUTO-04; D-04, D-07, P-13): `ocw_record_update`. A bot changes the watched record of the card thread it was
 * asked in, only through `POST /agent-channel/v1/records/update`: the API binds the record to the turn's thread, applies
 * the 07.5 approval rules and the taint rule, re-reads the record with the requester's connection, compares its hash
 * with the stored snapshot, writes only when nothing changed elsewhere (409 `record_changed` and a Not saved card
 * otherwise), re-reads, stores the new snapshot and `last_written_hash` (the next check stays silent) and notes the
 * change back in the ERP. Real PostgreSQL + Redis; the fake ERP MCP server runs in-process and is reached only through
 * the egress guard as the test host `fake-mcp`; the fake cell is this file's `fetch` to the Agent Channel API.
 */

const CELL_TOKEN = "ocw-test-cell-token-records-update-0123456789abcdef";
const ERP_TOKEN = `erp-token-${randomUUID()}`;
const TOOL = "ocw_record_update";

let s: ConnectorsStack;
let erp: FakeErpMcp;
let erpServer: Server;
let erpUrl = "";
let opsId = "";
let ordersId = "";
let erpConnector: Json;

const core = () => s.stack.built.core;
const drain = (queue: "watched.check" | "watched.tick") => core().jobs.drain(queue);

/** The fake cell's call (what the plugin's `updateRecord` sends: the turn's event, the agent and the changes only). */
async function update(
  eventId: string,
  changes: Json,
  agentId = opsId,
): Promise<{ status: number; body: Json }> {
  const res = await fetch(`${s.stack.baseUrl}/agent-channel/v1/records/update`, {
    method: "POST",
    headers: { authorization: `Bearer ${CELL_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ eventId, agentId, changes }),
  });
  return { status: res.status, body: (await res.json()) as Json };
}

/** `as` mentions `agentId` in the thread of `rootId` (a card); the delivered turn's event. */
async function mention(
  as: TestClient,
  rootId: string | null,
  p: { agentId?: string; conversationId?: string; text?: string } = {},
): Promise<{ eventId: string; turn: Json; messageId: string }> {
  // More turns than the bot's daily limit run in this file; that limit is not what is tested here.
  await s.su.query("delete from app.agent_usage_daily");
  const agentId = p.agentId ?? opsId;
  const msg = await ok(
    as.request("POST", `/api/v1/conversations/${p.conversationId ?? ordersId}/messages`, {
      body: p.text ?? "@opshelper mark the order as shipped",
      mentions: [{ kind: "agent", id: agentId }],
      ...(rootId ? { threadRootId: rootId } : {}),
    }),
  );
  const event = await eventually(async () => {
    const r = (
      await s.su.query(
        "select payload from app.stream_events where type = 'agent.mention.v1' and payload->'message'->>'id' = $1 and payload->'agent'->>'id' = $2",
        [msg.id, agentId],
      )
    ).rows;
    return r.length > 0 ? (r[0].payload as Json) : undefined;
  });
  return { eventId: event.eventId as string, turn: event.turn as Json, messageId: msg.id as string };
}

const thread = async (rootId: string) => ok(s.victor.request("GET", `/api/v1/messages/${rootId}/thread`));
const botReplies = async (rootId: string) =>
  ((await thread(rootId)).replies as Json[]).filter((r) => r.authorKind === "agent");

const row = async (id: string) =>
  (await s.su.query("select * from app.watched_records where id = $1", [id])).rows[0] as Json;

const record = (id = "SO-10442") => erp.state.records.get(id) as Json;
const notes = (id = "SO-10442") => erp.state.notes.get(id) ?? [];
const callsOf = (name: string) => erp.state.calls.filter((c) => c.name === name);

const humanCard = async (description: string) =>
  ok(
    s.victor.request("POST", `/api/v1/boards/${ordersId}/cards`, {
      description,
      clientMessageId: randomUUID(),
    }),
  );

/** Adds grants of a connector's tools to a bot (keeping the ones it has). */
async function grant(agentId: string, connector: Json, tools: string[]): Promise<void> {
  const caps = await ok(s.victor.request("GET", `/api/v1/agents/${agentId}/capabilities`));
  const kept = (caps.tools as Json[])
    .filter((t) => t.granted)
    .map((t) => ({ sourceKind: t.sourceKind, sourceId: t.sourceId, tool: t.tool }));
  await ok(
    s.victor.request("PATCH", `/api/v1/agents/${agentId}/capabilities`, {
      tools: [
        ...kept,
        ...tools.map((t) => ({
          sourceKind: "mcp",
          sourceId: connector.id,
          tool: `${connector.safeName}__${t}`,
        })),
      ],
    }),
  );
}

const linkBody = (cardMessageId: string, extra: Json = {}) => ({
  cardMessageId,
  mcpServerId: erpConnector.id,
  externalRef: "SO-10442",
  readTool: "get_record",
  writeTool: "update_record",
  noteTool: "add_note",
  idArg: "id",
  fields: [
    { pointer: "/status", label: "Status" },
    { pointer: "/delivery_date", label: "Delivery date" },
    { pointer: "/total", label: "Total" },
  ],
  checkIntervalMinutes: 60,
  agentId: opsId,
  ...extra,
});

/** A fresh ERP (the seed), a new card on #orders watching SO-10442, and its silent baseline. */
async function freshWatch(
  description: string,
  extra: Json = {},
  as: TestClient = s.victor,
): Promise<{ card: Json; watched: Json }> {
  erp.reset();
  const card = await humanCard(description);
  const watched = await ok(
    as.request("POST", "/api/v1/watched-records", linkBody(card.messageId, extra)),
    201,
  );
  await drain("watched.check");
  expect((await row(watched.id)).snapshot_hash).toMatch(/^[0-9a-f]{64}$/u);
  return { card, watched };
}

/** Every queued check first (access checks queued by mentions), then one scheduled check of this watch. */
async function scheduledCheck(watchedRecordId: string): Promise<void> {
  await drain("watched.check");
  await s.su.query(
    "update app.watched_records set next_check_at = now() - interval '1 minute' where id = $1",
    [watchedRecordId],
  );
  await core().db.withTenant({ organizationId: s.orgA }, (tx) =>
    core().jobs.sendInTx(tx, "watched.tick", {}),
  );
  await drain("watched.tick");
  await drain("watched.check");
}

beforeAll(async () => {
  s = await startConnectorsStack({ env: { OCW_CELL_TOKEN: CELL_TOKEN } });
  erp = createFakeErpMcp({ token: ERP_TOKEN });
  erpServer = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://fake-mcp");
    if (!erp.handle(req, res, url)) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => erpServer.listen(0, "127.0.0.1", resolve));
  erpUrl = `http://fake-mcp:${(erpServer.address() as AddressInfo).port}/erp-mcp`;

  opsId = (
    await ok(
      s.victor.request("POST", "/api/v1/agents", {
        name: "Ops helper",
        username: "opshelper",
        instructions: "You help with orders.",
        modelProvider: "mock",
        modelId: "mock-1",
      }),
    )
  ).id;
  ordersId = (
    await ok(
      s.victor.request("POST", "/api/v1/channels", { name: "orders", layout: "board", visibility: "public" }),
    )
  ).id;
  await ok(s.victor.request("POST", `/api/v1/channels/${ordersId}/members`, { kind: "agent", id: opsId }));
  await ok(s.victor.request("POST", `/api/v1/channels/${ordersId}/members`, { kind: "user", id: s.samId }));

  // The admin registers the ERP with the workspace's own access (07.4 org secret); its tools as a probe records them.
  erpConnector = await ok(
    s.victor.request("POST", "/api/v1/mcp-servers", {
      name: "ERP",
      transport: "streamable-http",
      url: erpUrl,
      headers: [{ name: "Authorization", value: `Bearer ${ERP_TOKEN}` }],
    }),
  );
  await core().db.withTenant({ organizationId: s.orgA }, (tx) =>
    replaceServerTools(
      core(),
      tx,
      erpConnector.id,
      FAKE_ERP_TOOLS.map((t) => ({
        name: t.name,
        readOnly: t.annotations.readOnlyHint,
        destructive: t.annotations.destructiveHint,
      })),
    ),
  );
  await grant(opsId, erpConnector, ["get_record", "update_record", "add_note"]);
}, 240_000);

afterEach(() => {
  assertNoGlobalFetch(s);
});

afterAll(async () => {
  erpServer?.closeAllConnections();
  await new Promise<void>((resolve) => (erpServer ? erpServer.close(() => resolve()) : resolve()));
  await s?.stop();
});

// ---------------------------------------------------------------- Task 1 (tracer)

describe("tracer: Ops helper sets SO-10442 to Shipped from the card thread and the ERP shows it with a note", () => {
  let card: Json;
  let watched: Json;

  beforeAll(async () => {
    ({ card, watched } = await freshWatch("EXP-0042 Pump order for Globex"));
  });

  it("Víctor asks in EXP-0042's thread: the turn offers ocw_record_update, the update is written, re-read and noted", async () => {
    const { eventId, turn } = await mention(s.victor, card.messageId);
    expect(turn.tools).toContain(TOOL);
    expect(turn.toolFlags[TOOL]).toEqual({ untrustedOutput: true, sideEffecting: true });

    const r = await update(eventId, { "/status": "Shipped" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toEqual({ ok: true, code: null, sentence: "Updated SO-10442 in ERP." });

    expect(record()).toMatchObject({ status: "Shipped", delivery_date: "2026-10-14" });
    expect(notes()).toEqual(["Updated from OCW by Ops helper for Víctor Ruiz: Status"]);
    const write = callsOf("update_record");
    expect(write).toHaveLength(1);
    // The record id is bound from the watch; the ERP's own version guard rides along.
    expect(write[0]?.arguments).toEqual({
      id: "SO-10442",
      status: "Shipped",
      expectedUpdatedAt: "2026-10-01T09:00:00.000Z",
    });

    const after = await row(watched.id);
    expect(after.snapshot).toMatchObject({ "/status": "Shipped", "/delivery_date": "2026-10-14" });
    expect(after.snapshot_hash).toMatch(/^[0-9a-f]{64}$/u);
    expect(after.last_written_hash).toBe(after.snapshot_hash);
    // A successful update posts no card: the bot's own message reports it.
    expect(await botReplies(card.messageId)).toEqual([]);

    const audits = (
      await auditRows(s, s.orgA, ["watched_record.written", "watched_record.note_written"])
    ).filter((a) => a.resource_id === watched.id);
    expect(audits.map((a) => a.action)).toEqual(["watched_record.written", "watched_record.note_written"]);
    expect(audits[0]?.metadata).toMatchObject({
      conversationId: ordersId,
      cardMessageId: card.messageId,
      agentId: opsId,
      eventId,
      fieldCount: 1,
    });
    expect(audits[0]?.user_id).toBe(s.victorId);
    expect(JSON.stringify(audits)).not.toMatch(/SO-10442|Shipped|Confirmed|Updated from OCW/u);

    const toolCall = (
      await s.su.query(
        "select decision, status from app.agent_tool_calls where event_id = $1 and tool = $2",
        [eventId, TOOL],
      )
    ).rows;
    expect(toolCall).toEqual([{ decision: "allowed", status: "ok" }]);
  });

  it("the next scheduled check does not report the bot's own write", async () => {
    await scheduledCheck(watched.id);
    expect(await botReplies(card.messageId)).toEqual([]);
    const r = await row(watched.id);
    expect(r.last_status).toBe("ok");
    expect(r.last_changed_at).toBeNull();
    const changes = await s.su.query(
      "select count(*)::int as n from app.watched_record_changes where watched_record_id = $1",
      [watched.id],
    );
    expect(changes.rows[0].n).toBe(0);
  });
});

// ---------------------------------------------------------------- Task 2: never overwrite

describe("never overwrite: a change made elsewhere is reported and kept, the bot's update refused", () => {
  /** Runs `hook` on every tool call the fake ERP receives, before it handles it (restored after the test). */
  function onErpCall(hook: (c: { name: string; arguments: Json }) => void): () => void {
    const calls = erp.state.calls as Array<{ name: string; arguments: Json }>;
    const push = calls.push;
    calls.push = (...items) => {
      for (const c of items) hook(c);
      return push.apply(calls, items);
    };
    return () => {
      calls.push = push;
    };
  }

  const notSaved = async (rootId: string) => {
    const replies = await botReplies(rootId);
    expect(replies).toHaveLength(1);
    const reply = replies[0] as Json;
    expect(reply).toMatchObject({ authorId: opsId, threadId: rootId });
    expect(reply.card).toMatchObject({
      kind: "report",
      status: "failed",
      statusLabel: "Not saved",
      platformOwned: true,
      title: "SO-10442 changed in ERP, so Ops helper's update wasn't saved",
    });
    return reply.card as Json;
  };

  it("SO-10442's delivery date changed in the ERP after the check: 409 record_changed, nothing written, a Not saved card, the snapshot moves", async () => {
    const { card, watched } = await freshWatch("EXP-0043 Pump order changed elsewhere");
    const mutated = record();
    mutated.delivery_date = "2026-10-20";
    mutated.updated_at = "2026-10-05T10:00:00.000Z";
    const { eventId } = await mention(s.victor, card.messageId);

    const r = await update(eventId, { "/status": "Shipped" });
    expect(r.status).toBe(409);
    expect(r.body).toEqual({
      ok: false,
      code: "record_changed",
      sentence:
        "The record changed in ERP since the last check, so nothing was written. A card with the new values is in the " +
        "thread. Tell Víctor Ruiz and ask whether to apply the update to the new values.",
    });
    expect(callsOf("update_record")).toEqual([]);
    expect(callsOf("add_note")).toEqual([]);
    expect(record()).toMatchObject({ status: "Confirmed", delivery_date: "2026-10-20" });

    const c = await notSaved(card.messageId);
    expect(c.notices).toEqual([
      { tone: "neutral", text: "Someone changed it in ERP after the last check. Nothing was overwritten." },
      { tone: "neutral", text: "Ask Ops helper again with the new values." },
    ]);
    expect(c.fields[0]).toEqual({ label: "Delivery date", value: "2026-10-14 → 2026-10-20" });
    expect(c.fields[1]).toMatchObject({ label: "Detected" });
    expect(c.fields[1].value).toMatch(/ · before an update$/u);
    expect(c.fields).toHaveLength(2);

    const after = await row(watched.id);
    expect(after.snapshot).toMatchObject({ "/status": "Confirmed", "/delivery_date": "2026-10-20" });
    expect(after.last_status).toBe("changed");
    expect(after.last_written_hash).toBeNull();
    const changes = (
      await s.su.query("select source from app.watched_record_changes where watched_record_id = $1", [
        watched.id,
      ])
    ).rows;
    expect(changes).toEqual([{ source: "write" }]);
    const refusedAudit = (await auditRows(s, s.orgA, ["watched_record.write_refused"])).filter(
      (a) => a.resource_id === watched.id,
    );
    expect(refusedAudit).toHaveLength(1);
    expect(refusedAudit[0]?.metadata).toMatchObject({
      code: "record_changed",
      by: "snapshot",
      fieldCount: 1,
    });
    expect(JSON.stringify(refusedAudit)).not.toMatch(/SO-10442|2026-10-20|Shipped/u);
    const toolCall = (
      await s.su.query("select status from app.agent_tool_calls where event_id = $1 and tool = $2", [
        eventId,
        TOOL,
      ])
    ).rows;
    expect(toolCall).toEqual([{ status: "blocked" }]);

    // Asked again, the bot's update applies to the new values (the snapshot is the new baseline).
    const again = await mention(s.victor, card.messageId);
    const ok2 = await update(again.eventId, { "/status": "Shipped" });
    expect(ok2.status, JSON.stringify(ok2.body)).toBe(200);
    expect(record()).toMatchObject({ status: "Shipped", delivery_date: "2026-10-20" });
  });

  it("the ERP changes between the re-read and the write (its expectedUpdatedAt guard refuses): the same 409 and Not saved card", async () => {
    const { card, watched } = await freshWatch("EXP-0044 Pump order raced in the ERP");
    const { eventId } = await mention(s.victor, card.messageId);
    const restore = onErpCall((c) => {
      if (c.name !== "update_record") return;
      const r = record();
      r.delivery_date = "2026-10-21";
      r.updated_at = "2026-10-06T08:00:00.000Z";
    });
    let r: { status: number; body: Json };
    try {
      r = await update(eventId, { "/status": "Shipped" });
    } finally {
      restore();
    }
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("record_changed");
    expect(callsOf("update_record")).toHaveLength(1);
    expect(record()).toMatchObject({ status: "Confirmed", delivery_date: "2026-10-21" });
    expect(notes()).toEqual([]);

    const c = await notSaved(card.messageId);
    expect(c.fields[0]).toEqual({ label: "Delivery date", value: "2026-10-14 → 2026-10-21" });
    const after = await row(watched.id);
    expect(after.snapshot).toMatchObject({ "/delivery_date": "2026-10-21" });
    // The write never happened: the in-progress marker is undone.
    expect(after.last_written_hash).toBeNull();
    const refusedAudit = (await auditRows(s, s.orgA, ["watched_record.write_refused"])).filter(
      (a) => a.resource_id === watched.id,
    );
    expect(refusedAudit.at(-1)?.metadata).toMatchObject({ code: "record_changed", by: "erp" });
  });

  it("the note-back fails: the write stays, the bot hears it was updated, audited note_failed", async () => {
    const { card, watched } = await freshWatch("EXP-0046 Pump order without notes");
    const { eventId } = await mention(s.victor, card.messageId);
    const restore = onErpCall((c) => {
      if (c.name === "add_note") throw new Error("the ERP's notes are down");
    });
    let r: { status: number; body: Json };
    try {
      r = await update(eventId, { "/status": "Shipped" });
    } finally {
      restore();
    }
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toEqual({ ok: true, code: null, sentence: "Updated SO-10442 in ERP." });
    expect(record().status).toBe("Shipped");
    expect(notes()).toEqual([]);
    const after = await row(watched.id);
    expect(after.last_written_hash).toBe(after.snapshot_hash);
    const audits = (
      await auditRows(s, s.orgA, [
        "watched_record.written",
        "watched_record.note_failed",
        "watched_record.note_written",
      ])
    ).filter((a) => a.resource_id === watched.id);
    expect(audits.map((a) => a.action)).toEqual(["watched_record.written", "watched_record.note_failed"]);
    expect(audits[1]?.metadata.code).toEqual(expect.any(String));
  });

  it("a field the watch does not watch, or a nested pointer: 409 field_not_watched, the ERP is never called", async () => {
    const { card } = await freshWatch("EXP-0047 Pump order, customer untouched");
    const { eventId } = await mention(s.victor, card.messageId);
    const before = erp.state.calls.length;
    for (const changes of [{ "/customer": "Initech" }, { "/status/code": "S" }]) {
      const r = await update(eventId, changes);
      expect(r.status).toBe(409);
      expect(r.body.code).toBe("field_not_watched");
    }
    expect(erp.state.calls.length).toBe(before);
    expect(record().customer).toBe("Globex S.L.");
  });
});
