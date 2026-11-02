import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { PassThrough } from "node:stream";
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
/** When set, the next `update_record` request waits for it BEFORE the ERP applies it (a write in flight). */
let writeGate: { release: Promise<void>; reached: () => void } | null = null;

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
    const serve = (r: typeof req) => {
      if (!erp.handle(r, res, url)) {
        res.writeHead(404);
        res.end();
      }
    };
    if (!writeGate || req.method !== "POST") return serve(req);
    // A gate is armed: read the body first, hold an `update_record` call until released, then hand the ERP a copy.
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      const replay = () => {
        const copy = Object.assign(new PassThrough(), { headers: req.headers, method: req.method });
        copy.end(raw);
        serve(copy as unknown as typeof req);
      };
      const gate = writeGate;
      if (!gate || !raw.includes('"update_record"')) return replay();
      writeGate = null;
      gate.reached();
      void gate.release.then(replay);
    });
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

  it("HI-01: two updates of one record at once: one is written, the other refused write_in_progress, never both", async () => {
    const { card, watched } = await freshWatch("EXP-0060 Two people ask at once");
    const setSchema = (value: Json) =>
      s.su.query(
        "update app.mcp_server_tools set input_schema = $2 where server_id = $1 and name = 'update_record'",
        [erpConnector.id, value],
      );
    const schema = (
      await s.su.query(
        "select input_schema from app.mcp_server_tools where server_id = $1 and name = 'update_record'",
        [erpConnector.id],
      )
    ).rows[0]?.input_schema as Json;
    // Without the ERP's own version guard (`expectedUpdatedAt`): only OCW's compare-and-set protects the record.
    await setSchema({ type: "object", properties: { id: { type: "string" }, status: { type: "string" } } });
    try {
      const ana = await mention(s.victor, card.messageId);
      const luis = await mention(s.sam, card.messageId, { text: "@opshelper put the order on hold" });
      let release = () => {};
      let reached = () => {};
      const atWrite = new Promise<void>((r) => {
        reached = r;
      });
      writeGate = {
        release: new Promise<void>((r) => {
          release = r;
        }),
        reached,
      };
      // Víctor's update reaches the ERP's write and is held there; Sam's arrives while it is in flight.
      const first = update(ana.eventId, { "/status": "Shipped" });
      await atWrite;
      const second = await update(luis.eventId, { "/status": "On hold" });
      release();
      const one = await first;

      expect(one.status, JSON.stringify(one.body)).toBe(200);
      expect(second.status, JSON.stringify(second.body)).toBe(409);
      expect(second.body.code).toBe("write_in_progress");
      expect(second.body.sentence).toMatch(/^Another update of SO-10442 is being saved right now/u);
      expect(callsOf("update_record")).toHaveLength(1);
      expect(record().status).toBe("Shipped");
      const after = await row(watched.id);
      expect(after.snapshot).toMatchObject({ "/status": "Shipped" });
      // The lease ends with the write.
      expect(after.write_lease_until).toBeNull();
      const busy = (await auditRows(s, s.orgA, ["watched_record.write_refused"])).filter(
        (a) => a.resource_id === watched.id,
      );
      expect(busy.map((a) => a.metadata.code)).toContain("write_in_progress");
    } finally {
      writeGate = null;
      await setSchema(schema ?? null);
    }
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

// ---------------------------------------------------------------- Task 3: offered only where it works, governed

describe("offered only in a watched card's thread, to the watch's bot", () => {
  let scoutId = "";
  let card: Json;

  beforeAll(async () => {
    scoutId = (
      await ok(
        s.victor.request("POST", "/api/v1/agents", {
          name: "Scout",
          username: "scout",
          instructions: "You scout.",
          modelProvider: "mock",
          modelId: "mock-1",
        }),
      )
    ).id;
    await ok(
      s.victor.request("POST", `/api/v1/channels/${ordersId}/members`, { kind: "agent", id: scoutId }),
    );
    ({ card } = await freshWatch("EXP-0048 Offered here"));
  });

  it("not offered in an unwatched card's thread, on the board itself, in a text channel, or for a watch without an update tool", async () => {
    const plain = await humanCard("EXP-0049 Not watched");
    expect((await mention(s.victor, plain.messageId)).turn.tools).not.toContain(TOOL);
    expect((await mention(s.victor, null)).turn.tools).not.toContain(TOOL);

    const general = (
      await ok(s.victor.request("POST", "/api/v1/channels", { name: "ops-general", visibility: "public" }))
    ).id as string;
    await ok(s.victor.request("POST", `/api/v1/channels/${general}/members`, { kind: "agent", id: opsId }));
    expect((await mention(s.victor, null, { conversationId: general })).turn.tools).not.toContain(TOOL);

    const { card: readOnly } = await freshWatch("EXP-0050 Watched, read only", {
      writeTool: undefined,
      noteTool: undefined,
    });
    const t = await mention(s.victor, readOnly.messageId);
    expect(t.turn.tools).not.toContain(TOOL);
    // Even a forged call there finds no tool on the turn.
    const r = await update(t.eventId, { "/status": "Shipped" });
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ ok: false, code: "not_in_turn" });
  });

  it("another bot in the watched thread is not offered it; its event used as Ops helper's is 403 no_trigger", async () => {
    const t = await mention(s.victor, card.messageId, { agentId: scoutId, text: "@scout any news?" });
    expect(t.turn.tools).not.toContain(TOOL);
    const r = await update(t.eventId, { "/status": "Shipped" });
    expect(r.status).toBe(403);
    expect(r.body.error?.code).toBe("no_trigger");
    expect(callsOf("update_record")).toEqual([]);
  });

  it("a forged eventId of organization B is 404 unknown_turn", async () => {
    const eveBot = (
      await ok(
        s.eve.request("POST", "/api/v1/agents", {
          name: "Evil helper",
          username: "evilhelper",
          instructions: "x",
          modelProvider: "mock",
          modelId: "mock-1",
        }),
      )
    ).id as string;
    const forged = randomUUID();
    await s.su.query(
      `insert into app.agent_turns (event_id, organization_id, agent_id, user_id, conversation_id, conversation_kind,
         message_id, tools) values ($1, $2, $3, $4, $5, 'channel', $6, $7)`,
      [forged, s.orgB, eveBot, s.eveId, randomUUID(), randomUUID(), [TOOL]],
    );
    for (const agentId of [eveBot, opsId]) {
      const r = await update(forged, { "/status": "Shipped" }, agentId);
      expect(r.status).toBe(404);
      expect(r.body.error?.code).toBe("unknown_turn");
    }
    expect(callsOf("update_record")).toEqual([]);
  });
});

describe("governed like any side effect: taint and 07.5 approvals", () => {
  let card: Json;

  it("a turn that read outside content is refused 403 tainted, nothing read or written", async () => {
    ({ card } = await freshWatch("EXP-0051 Tainted turn"));
    const { eventId } = await mention(s.victor, card.messageId);
    await s.su.query("update app.agent_turns set tainted = true where event_id = $1", [eventId]);
    const before = erp.state.calls.length;
    const r = await update(eventId, { "/status": "Shipped" });
    expect(r.status).toBe(403);
    expect(r.body).toEqual({
      ok: false,
      code: "tainted",
      sentence:
        "I can't update the record after reading outside content in this turn. Tell Víctor Ruiz to ask again in a new message.",
    });
    expect(erp.state.calls.length).toBe(before);
    expect(record().status).toBe("Confirmed");
    const denied = (
      await s.su.query(
        "select decision, reason from app.agent_tool_calls where event_id = $1 and tool = $2",
        [eventId, TOOL],
      )
    ).rows;
    expect(denied).toEqual([{ decision: "denied", reason: "tainted" }]);
  });

  it("with an `always` rule: an approval card and nothing written; once Víctor approves, the re-run's call writes once", async () => {
    ({ card } = await freshWatch("EXP-0052 Needs approval"));
    await s.su.query(
      `insert into app.tool_approval_policies
         (organization_id, scope_unit_id, tool_pattern, mode, approver_kind, approver_user_ids, created_by, updated_by)
       values ($1, null, $2, 'always', 'requester', '{}', $3, $3)`,
      [s.orgA, TOOL, s.victorId],
    );
    try {
      const { eventId, turn } = await mention(s.victor, card.messageId);
      expect(turn.toolFlags[TOOL]).toMatchObject({ sideEffecting: true, approval: "always" });

      const r = await update(eventId, { "/status": "Shipped" });
      expect(r.status).toBe(409);
      expect(r.body.code).toBe("approval_required");
      expect(r.body.sentence).toMatch(/^This update needs approval\./u);
      expect(callsOf("update_record")).toEqual([]);
      const [request] = (
        await s.su.query(
          "select id, action_hash, card_message_id, status from app.approval_requests where kind = 'tool.call' and organization_id = $1 order by created_at desc limit 1",
          [s.orgA],
        )
      ).rows as Json[];
      expect(request?.status).toBe("pending");
      // The same call again waits on the same request.
      const pending = await update(eventId, { "/status": "Shipped" });
      expect(pending.body.code).toBe("approval_pending");

      await ok(
        s.victor.request("POST", `/api/v1/approvals/${request?.id}/decision`, {
          outcome: "approved",
          actionHash: request?.action_hash,
        }),
      );
      const rerun = await eventually(async () => {
        const rows = (
          await s.su.query(
            "select payload from app.stream_events where type = 'agent.card_action.v1' and payload->'cardAction'->>'messageId' = $1",
            [request?.card_message_id],
          )
        ).rows;
        return rows.length > 0 ? (rows[0].payload as Json) : undefined;
      });
      expect(rerun.cardAction.grant).toMatchObject({ tool: TOOL });
      expect(rerun.turn.tools).toContain(TOOL);

      // A different change is not what was approved.
      const other = await update(rerun.eventId, { "/status": "Cancelled" });
      expect(other.status).toBe(409);
      expect(other.body.code).toBe("approval_required");
      expect(callsOf("update_record")).toEqual([]);

      const done = await update(rerun.eventId, { "/status": "Shipped" });
      expect(done.status, JSON.stringify(done.body)).toBe(200);
      expect(done.body.sentence).toBe("Updated SO-10442 in ERP.");
      expect(callsOf("update_record")).toHaveLength(1);
      expect(record().status).toBe("Shipped");
      const granted = (
        await s.su.query(
          "select decision, approval_id from app.agent_tool_calls where event_id = $1 and tool = $2 and decision = 'allowed'",
          [rerun.eventId, TOOL],
        )
      ).rows;
      expect(granted).toEqual([{ decision: "allowed", approval_id: request?.id }]);
    } finally {
      await s.su.query("delete from app.tool_approval_policies where organization_id = $1", [s.orgA]);
    }
  });

  it("LO-01: the approved action names the connector by id; a rename keeps the grant, the review shows the name", async () => {
    ({ card } = await freshWatch("EXP-0062 Connector renamed while waiting"));
    await s.su.query(
      `insert into app.tool_approval_policies
         (organization_id, scope_unit_id, tool_pattern, mode, approver_kind, approver_user_ids, created_by, updated_by)
       values ($1, null, $2, 'always', 'requester', '{}', $3, $3)`,
      [s.orgA, TOOL, s.victorId],
    );
    try {
      const { eventId } = await mention(s.victor, card.messageId);
      expect((await update(eventId, { "/status": "Shipped" })).body.code).toBe("approval_required");
      const [request] = (
        await s.su.query(
          "select id, action_hash, card_message_id, resource_id from app.approval_requests where kind = 'tool.call' and organization_id = $1 order by created_at desc limit 1",
          [s.orgA],
        )
      ).rows as Json[];
      const stored = (
        await s.su.query("select arguments_canonical from app.tool_call_approvals where id = $1", [
          request?.resource_id,
        ])
      ).rows[0] as Json;
      const args = JSON.parse(stored.arguments_canonical as string) as Json;
      expect(args).toMatchObject({ connector: erpConnector.id, record: "SO-10442" });
      expect(Object.values(args)).not.toContain("ERP");

      // The review reads as people read it: the record, the connector's name and the changes (ids stay in All
      // arguments).
      const review = await ok(s.victor.request("GET", `/api/v1/approvals/${request?.id}`));
      expect((review.view.preview as Json[]).map((f) => [f.label, f.value])).toEqual([
        ["Changes", '{"/status":"Shipped"}'],
        ["Connector", "ERP"],
        ["Record", "SO-10442"],
      ]);

      // The admin renames the connector while the request waits: the same connector, so the grant still serves.
      await ok(
        s.victor.request("PATCH", `/api/v1/mcp-servers/${erpConnector.id}`, { name: "ERP production" }),
      );
      await ok(
        s.victor.request("POST", `/api/v1/approvals/${request?.id}/decision`, {
          outcome: "approved",
          actionHash: request?.action_hash,
        }),
      );
      const rerun = await eventually(async () => {
        const rows = (
          await s.su.query(
            "select payload from app.stream_events where type = 'agent.card_action.v1' and payload->'cardAction'->>'messageId' = $1",
            [request?.card_message_id],
          )
        ).rows;
        return rows.length > 0 ? (rows[0].payload as Json) : undefined;
      });
      const done = await update(rerun.eventId, { "/status": "Shipped" });
      expect(done.status, JSON.stringify(done.body)).toBe(200);
      expect(record().status).toBe("Shipped");
    } finally {
      await ok(s.victor.request("PATCH", `/api/v1/mcp-servers/${erpConnector.id}`, { name: "ERP" }));
      await s.su.query("delete from app.tool_approval_policies where organization_id = $1", [s.orgA]);
    }
  });

  it("HI-02: approved after a reported outside change: the grant does not serve the call, nothing is written", async () => {
    let watched: Json;
    ({ card, watched } = await freshWatch("EXP-0061 Approved too late"));
    await s.su.query(
      `insert into app.tool_approval_policies
         (organization_id, scope_unit_id, tool_pattern, mode, approver_kind, approver_user_ids, created_by, updated_by)
       values ($1, null, $2, 'always', 'requester', '{}', $3, $3)`,
      [s.orgA, TOOL, s.victorId],
    );
    try {
      const { eventId } = await mention(s.victor, card.messageId, {
        text: "@opshelper move delivery to the 10th",
      });
      const asked = await update(eventId, { "/delivery_date": "2026-11-10" });
      expect(asked.body.code).toBe("approval_required");
      const [request] = (
        await s.su.query(
          "select id, action_hash, card_message_id from app.approval_requests where kind = 'tool.call' and organization_id = $1 order by created_at desc limit 1",
          [s.orgA],
        )
      ).rows as Json[];
      // The ERP owner moves the date; the next check reports it in the thread and moves the snapshot.
      const r = record();
      r.delivery_date = "2026-11-20";
      r.updated_at = "2026-10-07T08:00:00.000Z";
      await scheduledCheck(watched.id);
      expect((await row(watched.id)).snapshot).toMatchObject({ "/delivery_date": "2026-11-20" });

      // A lead approves from the inbox, without the thread in view; the re-run asks for the same change.
      await ok(
        s.victor.request("POST", `/api/v1/approvals/${request?.id}/decision`, {
          outcome: "approved",
          actionHash: request?.action_hash,
        }),
      );
      const rerun = await eventually(async () => {
        const rows = (
          await s.su.query(
            "select payload from app.stream_events where type = 'agent.card_action.v1' and payload->'cardAction'->>'messageId' = $1",
            [request?.card_message_id],
          )
        ).rows;
        return rows.length > 0 ? (rows[0].payload as Json) : undefined;
      });
      const late = await update(rerun.eventId, { "/delivery_date": "2026-11-10" });
      expect(late.status).toBe(409);
      // The approval was for the record as it was: this is a new action, asked for again on the new values.
      expect(late.body.code).toBe("approval_required");
      expect(callsOf("update_record")).toEqual([]);
      expect(record().delivery_date).toBe("2026-11-20");
      const consumed = (
        await s.su.query("select consumed_at from app.approval_requests where id = $1", [request?.id])
      ).rows[0] as Json;
      expect(consumed.consumed_at).toBeNull();
    } finally {
      await s.su.query("delete from app.tool_approval_policies where organization_id = $1", [s.orgA]);
    }
  });
});

describe("per-member connector: written with the requester's own account, only where they allowed it", () => {
  let personal: Json;
  let card: Json;

  beforeAll(async () => {
    erp.reset();
    personal = await ok(
      s.victor.request("POST", "/api/v1/mcp-servers", {
        name: "ERP personal",
        transport: "streamable-http",
        url: erpUrl,
        authMode: "per_member_secret",
        memberHeaderName: "Authorization",
        memberHeaderPrefix: "Bearer ",
      }),
    );
    // Víctor connects his key (the first connection probes the tools API-side) and allows it in #orders.
    await ok(s.victor.request("PUT", `/api/v1/connectors/${personal.id}/secret`, { value: ERP_TOKEN }));
    await grant(opsId, personal, ["get_record", "update_record", "add_note"]);
    await ok(
      s.victor.request("POST", "/api/v1/member-account-shares", {
        conversationId: ordersId,
        resourceKind: "connector",
        resourceId: personal.id,
      }),
      201,
    );
    ({ card } = await freshWatch("EXP-0053 Order in Víctor's ERP account", { mcpServerId: personal.id }));
  });

  it("Sam has not connected ERP personal: 409 not_connected, nothing read", async () => {
    const { eventId } = await mention(s.sam, card.messageId);
    const before = erp.state.calls.length;
    const r = await update(eventId, { "/status": "Shipped" });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("not_connected");
    expect(r.body.sentence).toMatch(/^ERP personal uses Sam Lee's own account/u);
    expect(erp.state.calls.length).toBe(before);
  });

  it("Sam connected but did not allow it in #orders: 409 member_account; once allowed, written with Sam's account", async () => {
    await ok(s.sam.request("PUT", `/api/v1/connectors/${personal.id}/secret`, { value: ERP_TOKEN }));
    await drain("watched.check");
    const first = await mention(s.sam, card.messageId);
    const before = erp.state.calls.length;
    const refused = await update(first.eventId, { "/status": "Shipped" });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("member_account");
    expect(erp.state.calls.length).toBe(before);

    await ok(
      s.sam.request("POST", "/api/v1/member-account-shares", {
        conversationId: ordersId,
        resourceKind: "connector",
        resourceId: personal.id,
      }),
      201,
    );
    await s.su.query(
      "update app.connector_connections set last_used_at = null where user_id = $1 and server_id = $2",
      [s.samId, personal.id],
    );
    const second = await mention(s.sam, card.messageId);
    const r = await update(second.eventId, { "/status": "Shipped" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(record().status).toBe("Shipped");
    expect(notes()).toEqual(["Updated from OCW by Ops helper for Sam Lee: Status"]);
    const used = (
      await s.su.query(
        "select last_used_at from app.connector_connections where user_id = $1 and server_id = $2",
        [s.samId, personal.id],
      )
    ).rows[0] as Json;
    expect(used.last_used_at).not.toBeNull();
  });
});
