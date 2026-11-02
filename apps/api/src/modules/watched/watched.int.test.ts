import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createFakeErpMcp,
  FAKE_ERP_TOOLS,
  type FakeErpMcp,
} from "../../../../../infra/fake-model/fake-erp-mcp.mjs";
import {
  assertNoGlobalFetch,
  auditRows,
  type ConnectorsStack,
  fails,
  type Json,
  ok,
  startConnectorsStack,
} from "../../testing-connectors";
import { callTool, markNeedsReconnect } from "../connectors";
import { replaceServerTools } from "../mcp";

/**
 * 07.6-07 (AUTO-04, D-04, D-07, P-13; Pattern 8, Pitfalls 8 and 9): watched records. A board card is linked to a record
 * in an outside system read through an MCP connector; the API hashes the watched fields (RFC 8785 canonical JSON),
 * checks on access and on schedule (`watched.check` jobs) and reports a change made elsewhere as before → after in the
 * card's thread, as a platform-owned report card by the watch's bot. Real PostgreSQL + Redis; the fake ERP MCP server
 * (07.6-04) runs in-process on loopback and is reached only through the egress guard as the test host `fake-mcp`.
 */

const ERP_TOKEN = `erp-token-${randomUUID()}`;

let s: ConnectorsStack;
let erp: FakeErpMcp;
let erpServer: Server;
let erpUrl = "";
let opsId = "";
let ordersId = "";
let erpConnector: Json;
let card: Json;

const core = () => s.stack.built.core;

const drain = (queue: "watched.check" | "watched.tick") => core().jobs.drain(queue);

/** A change made "elsewhere": the ERP's own test hook over MCP, through a guarded client like any outside caller. */
async function mutate(id: string, fields: Json): Promise<void> {
  const r = await callTool(
    s.browser,
    { url: erpUrl, transport: "streamable-http" },
    { headerName: "Authorization", headerValue: `Bearer ${ERP_TOKEN}` },
    { name: "__mutate", arguments: { id, fields } },
    { redact: [] },
  );
  expect(r.isError, r.content).toBe(false);
}

/** The global tick, as pg-boss's cron would send it (workers are off in tests). */
async function tick(): Promise<void> {
  await core().db.withTenant({ organizationId: s.orgA }, (tx) =>
    core().jobs.sendInTx(tx, "watched.tick", {}),
  );
  await drain("watched.tick");
}

const thread = async (rootId: string) => ok(s.victor.request("GET", `/api/v1/messages/${rootId}/thread`));

const row = async (id: string) =>
  (await s.su.query("select * from app.watched_records where id = $1", [id])).rows[0] as Json;

const humanCard = async (boardId: string, description: string) =>
  ok(
    s.victor.request("POST", `/api/v1/boards/${boardId}/cards`, {
      description,
      clientMessageId: randomUUID(),
    }),
  );

/** Adds grants of ERP tools to a bot (keeping the ones it has). */
async function grantErp(agentId: string, tools: string[]): Promise<void> {
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
          sourceId: erpConnector.id,
          tool: `${erpConnector.safeName}__${t}`,
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

beforeAll(async () => {
  s = await startConnectorsStack();
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

  // The admin registers the ERP with the workspace's own access (07.4 org secret); its tools are recorded as a probe
  // would record them.
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
  // The admin grants Ops helper the ERP's read, update and note tools (the per-bot side of the cell's tool filter).
  await grantErp(opsId, ["get_record", "update_record", "add_note"]);
  card = await humanCard(ordersId, "EXP-0042 Pump order for Globex");
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

describe("tracer: SO-10442 changes in the ERP and the card's thread says Status Confirmed → Shipped", () => {
  let watched: Json;

  it("Víctor links EXP-0042 to SO-10442: 201 with the DTO, audited with ids only", async () => {
    watched = await ok(s.victor.request("POST", "/api/v1/watched-records", linkBody(card.messageId)), 201);
    expect(watched).toMatchObject({
      cardMessageId: card.messageId,
      conversationId: ordersId,
      agent: { id: opsId, displayName: "Ops helper" },
      connector: { id: erpConnector.id, name: "ERP", authMode: "org_secret" },
      externalRef: "SO-10442",
      readTool: "get_record",
      writeTool: null,
      noteTool: null,
      idArg: "id",
      checkIntervalMinutes: 60,
      lastStatus: "ok",
      checkedAt: null,
      lastChangedAt: null,
      linkedBy: { id: s.victorId, displayName: expect.any(String) },
      version: 1,
    });
    expect(watched.viewerCan).toEqual(expect.arrayContaining(["edit", "check", "unlink"]));
    const audits = await auditRows(s, s.orgA, ["watched_record.linked"]);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ resource_id: watched.id, user_id: s.victorId });
    expect(audits[0]?.metadata).toMatchObject({
      conversationId: ordersId,
      cardMessageId: card.messageId,
      mcpServerId: erpConnector.id,
      agentId: opsId,
      fieldCount: 3,
    });
    expect(JSON.stringify(audits)).not.toMatch(/SO-10442|Confirmed|1250/u);
  });

  it("the first check stores the baseline and posts nothing", async () => {
    expect(await drain("watched.check")).toBeGreaterThanOrEqual(1);
    const r = await row(watched.id);
    expect(r.snapshot_hash).toMatch(/^[0-9a-f]{64}$/u);
    expect(r.snapshot).toEqual({
      "/status": "Confirmed",
      "/delivery_date": "2026-10-14",
      "/total": "1250.00",
    });
    expect(r.last_status).toBe("ok");
    expect(r.checked_at).not.toBeNull();
    expect(r.last_changed_at).toBeNull();
    expect((await thread(card.messageId)).replies).toEqual([]);
    expect(erp.state.calls.at(-1)).toEqual({ name: "get_record", arguments: { id: "SO-10442" } });
  });

  it("a change in the ERP is reported on schedule as one platform-owned report card in the thread", async () => {
    const before = (
      await s.su.query("select coalesce(max(seq), 0) as s from app.stream_events where stream_id = $1", [
        `conv:${ordersId}`,
      ])
    ).rows[0].s as string;
    await mutate("SO-10442", { status: "Shipped", delivery_date: "2026-10-16" });
    await s.su.query(
      "update app.watched_records set next_check_at = now() - interval '1 minute' where id = $1",
      [watched.id],
    );
    await tick();
    expect(await drain("watched.check")).toBe(1);

    const replies = (await thread(card.messageId)).replies as Json[];
    expect(replies).toHaveLength(1);
    const reply = replies[0] as Json;
    expect(reply).toMatchObject({ authorKind: "agent", authorId: opsId, threadId: card.messageId });
    expect(reply.body).toBe("SO-10442 changed in ERP: Status, Delivery date.");
    expect(reply.card).toMatchObject({
      kind: "report",
      status: "info",
      statusLabel: "Changed",
      platformOwned: true,
      title: "SO-10442 changed in ERP",
      actions: [{ kind: "open", label: "Open card", target: `/chat/${ordersId}?thread=${card.messageId}` }],
    });
    const fields = reply.card.fields as Json[];
    expect(fields.slice(0, 2)).toEqual([
      { label: "Status", value: "Confirmed → Shipped" },
      { label: "Delivery date", value: "2026-10-14 → 2026-10-16" },
    ]);
    expect(fields).toHaveLength(3);
    expect(fields[2]).toMatchObject({ label: "Detected" });
    expect(fields[2]?.value).toMatch(/ · on schedule$/u);

    const changes = (
      await s.su.query("select * from app.watched_record_changes where watched_record_id = $1", [watched.id])
    ).rows as Json[];
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ source: "schedule", message_id: reply.id });
    expect(changes[0]?.before).toMatchObject({ "/status": "Confirmed" });
    expect(changes[0]?.after).toMatchObject({ "/status": "Shipped" });

    const r = await row(watched.id);
    expect(r.last_status).toBe("changed");
    expect(r.last_changed_at).not.toBeNull();
    expect(r.snapshot).toMatchObject({ "/status": "Shipped", "/delivery_date": "2026-10-16" });
    expect(new Date(r.next_check_at).getTime()).toBeGreaterThan(Date.now() + 50 * 60_000);

    const dto = (await ok(s.victor.request("GET", `/api/v1/watched-records?conversationId=${ordersId}`)))
      .records as Json[];
    expect(dto.find((d) => d.id === watched.id)).toMatchObject({
      lastStatus: "changed",
      lastChangedAt: expect.any(String),
    });

    const events = (
      await s.su.query(
        "select payload from app.stream_events where stream_id = $1 and type = 'watched_record.updated' and seq > $2",
        [`conv:${ordersId}`, before],
      )
    ).rows.map((x) => x.payload as Json);
    expect(events.length).toBeGreaterThanOrEqual(1);
    for (const e of events) expect(e).toEqual({ watchedRecordId: watched.id, cardMessageId: card.messageId });

    const changed = await auditRows(s, s.orgA, ["watched_record.changed"]);
    expect(changed).toHaveLength(1);
    expect(changed[0]?.metadata).toEqual({
      conversationId: ordersId,
      cardMessageId: card.messageId,
      source: "schedule",
      fieldCount: 2,
    });
  });

  it("a check with no change posts nothing", async () => {
    await s.su.query(
      "update app.watched_records set next_check_at = now() - interval '1 minute' where id = $1",
      [watched.id],
    );
    await tick();
    expect(await drain("watched.check")).toBe(1);
    expect((await thread(card.messageId)).replies).toHaveLength(1);
    expect((await row(watched.id)).last_status).toBe("ok");
  });

  it("a second link of the same card is 409 already_watched", async () => {
    await fails(
      s.victor.request("POST", "/api/v1/watched-records", linkBody(card.messageId)),
      409,
      "already_watched",
    );
  });
});

// ---------------------------------------------------------------- tools a watch may name (security fix)

describe("a watch names only read-only, non-dangerous tools the admin granted to its bot", () => {
  let other: Json;

  beforeAll(async () => {
    other = await humanCard(ordersId, "EXP-0043 Draft order for Initech");
  });

  const link = (extra: Json) =>
    s.victor.request(
      "POST",
      "/api/v1/watched-records",
      linkBody(other.messageId, { externalRef: "SO-10443", ...extra }),
    );

  it("a destructive tool as the read tool is 400 read_tool_not_read_only", async () => {
    await fails(link({ readTool: "update_record" }), 400, "read_tool_not_read_only");
  });

  it("a read tool not granted to the bot is 400 tool_not_allowed", async () => {
    await fails(link({ readTool: "list_records" }), 400, "tool_not_allowed");
    await fails(link({ readTool: "__mutate" }), 400, "tool_not_allowed");
  });

  it("a dangerous-named read-only tool is refused even when granted", async () => {
    await s.su.query(
      `insert into app.mcp_server_tools (organization_id, server_id, name, openclaw_name, read_only, destructive)
       values ($1, $2, 'run_shell', $3, true, false)`,
      [s.orgA, erpConnector.id, `${erpConnector.safeName}__run_shell`],
    );
    await s.su.query(
      `insert into app.bot_tool_grants (organization_id, agent_id, source_kind, source_id, tool_name)
       values ($1, $2, 'mcp', $3, $4)`,
      [s.orgA, opsId, erpConnector.id, `${erpConnector.safeName}__run_shell`],
    );
    await fails(link({ readTool: "run_shell" }), 400, "tool_not_allowed");
    // The capabilities route would never accept that grant; remove the forged rows so later grants stay valid.
    await s.su.query("delete from app.bot_tool_grants where tool_name = $1", [
      `${erpConnector.safeName}__run_shell`,
    ]);
    await s.su.query("delete from app.mcp_server_tools where server_id = $1 and name = 'run_shell'", [
      erpConnector.id,
    ]);
  });

  it("a write or note tool not granted to the bot is 400 tool_not_allowed; granted ones pass", async () => {
    await fails(link({ writeTool: "__mutate" }), 400, "tool_not_allowed");
    await fails(link({ noteTool: "list_records" }), 400, "tool_not_allowed");
    await fails(link({ writeTool: "nope" }), 400, "tool_not_found");
    const w = await ok(link({ writeTool: "update_record", noteTool: "add_note" }), 201);
    expect(w).toMatchObject({ writeTool: "update_record", noteTool: "add_note" });
    expect(await drain("watched.check")).toBe(1);
    expect((await row(w.id)).snapshot_hash).toMatch(/^[0-9a-f]{64}$/u);
    other.watchedId = w.id;
    other.version = w.version;
  });

  it("PATCH to a write tool not granted is 400 tool_not_allowed", async () => {
    await fails(
      s.victor.request("PATCH", `/api/v1/watched-records/${other.watchedId}`, {
        expectedVersion: other.version,
        writeTool: "__mutate",
      }),
      400,
      "tool_not_allowed",
    );
  });

  it("a re-probe that makes the read tool non-read-only fails the next check closed: no call, audited denied", async () => {
    const calls = erp.state.calls.length;
    await s.su.query(
      "update app.mcp_server_tools set read_only = false where server_id = $1 and name = 'get_record'",
      [erpConnector.id],
    );
    try {
      await s.su.query(
        "update app.watched_records set next_check_at = now() - interval '1 minute' where id = $1",
        [other.watchedId],
      );
      await tick();
      expect(await drain("watched.check")).toBe(1);
      expect(erp.state.calls.length).toBe(calls);
      expect((await row(other.watchedId)).last_status).toBe("error");
      const denied = (await auditRows(s, s.orgA, ["watched_record.check_failed"])).filter(
        (a) => a.resource_id === other.watchedId,
      );
      expect(denied.at(-1)?.metadata).toMatchObject({ status: "error", code: "tool_not_allowed" });
      // Audited at every refused check, not only on the transition.
      await s.su.query(
        "update app.watched_records set next_check_at = now() - interval '1 minute' where id = $1",
        [other.watchedId],
      );
      await tick();
      expect(await drain("watched.check")).toBe(1);
      expect(
        (await auditRows(s, s.orgA, ["watched_record.check_failed"])).filter(
          (a) => a.resource_id === other.watchedId,
        ),
      ).toHaveLength(denied.length + 1);
      expect(erp.state.calls.length).toBe(calls);
    } finally {
      await s.su.query(
        "update app.mcp_server_tools set read_only = true where server_id = $1 and name = 'get_record'",
        [erpConnector.id],
      );
    }
    await s.su.query(
      "update app.watched_records set next_check_at = now() - interval '1 minute' where id = $1",
      [other.watchedId],
    );
    await tick();
    expect(await drain("watched.check")).toBe(1);
    expect((await row(other.watchedId)).last_status).toBe("ok");
    expect(erp.state.calls.length).toBe(calls + 1);
  });
});

// ---------------------------------------------------------------- Task 3

/** Created `watched.check` jobs of one watch (ids and source only). */
const queued = async (watchedRecordId: string) =>
  (
    await s.su.query(
      "select data->>'source' as source from pgboss.job where name = 'watched.check' and state = 'created' and data->>'watchedRecordId' = $1",
      [watchedRecordId],
    )
  ).rows.map((r) => r.source as string);

/** pg-boss singletons are one-minute slots: keep a "within 60 s" pair away from a slot's edge. */
async function awayFromSlotEdge(): Promise<void> {
  const into = Date.now() % 60_000;
  if (into > 50_000) await new Promise((r) => setTimeout(r, 60_000 - into + 500));
}

const reply = (as: ConnectorsStack["victor"], rootId: string, body: string) =>
  ok(as.request("POST", `/api/v1/conversations/${ordersId}/messages`, { body, threadRootId: rootId }));

async function forceCheck(watchedRecordId: string): Promise<void> {
  await s.su.query(
    "update app.watched_records set next_check_at = now() - interval '1 minute' where id = $1",
    [watchedRecordId],
  );
  await tick();
  expect(await drain("watched.check")).toBe(1);
}

/** Links a fresh card and drains its silent baseline. */
async function watchFresh(description: string, extra: Json = {}): Promise<{ card: Json; watched: Json }> {
  const c = await humanCard(ordersId, description);
  const w = await ok(s.victor.request("POST", "/api/v1/watched-records", linkBody(c.messageId, extra)), 201);
  await drain("watched.check");
  expect((await row(w.id)).snapshot_hash).toMatch(/^[0-9a-f]{64}$/u);
  return { card: c, watched: w };
}

describe("checks on access: a person's reply in the thread and the thread being opened", () => {
  let c: Json;
  let w: Json;

  beforeAll(async () => {
    ({ card: c, watched: w } = await watchFresh("EXP-0044 Rush order"));
  });

  it("Sam's reply enqueues one access check (two replies within 60 s → one job); drained → 'when the thread was opened'", async () => {
    await mutate("SO-10442", { status: "Delivered" });
    await awayFromSlotEdge();
    await reply(s.sam, c.messageId, "Any news on this one?");
    await reply(s.sam, c.messageId, "Pinging again");
    expect(await queued(w.id)).toEqual(["access"]);
    expect(await drain("watched.check")).toBe(1);
    const cards = ((await thread(c.messageId)).replies as Json[]).filter((m) => m.card);
    expect(cards).toHaveLength(1);
    expect(cards[0]?.card.fields[0]).toEqual({ label: "Status", value: "Shipped → Delivered" });
    expect(cards[0]?.card.fields.at(-1).value).toMatch(/ · when the thread was opened$/u);
    const changes = (
      await s.su.query("select source from app.watched_record_changes where watched_record_id = $1", [w.id])
    ).rows;
    expect(changes).toEqual([{ source: "access" }]);
  });

  it("a bot's message in the thread enqueues nothing", async () => {
    await core().chatAgent.postAgentMessage(
      { organizationId: s.orgA, userId: s.victorId },
      {
        agentId: opsId,
        conversationId: ordersId,
        threadRootId: c.messageId,
        body: "I'll look into it.",
        idempotencyKey: `bot-${randomUUID()}`,
      },
    );
    expect(await queued(w.id)).toEqual([]);
  });

  it("POST /:id/check {access} (the strip on open) → 202, again within 60 s → 429 check_rate_limited", async () => {
    await awayFromSlotEdge();
    expect(
      await ok(s.sam.request("POST", `/api/v1/watched-records/${w.id}/check`, { source: "access" }), 202),
    ).toEqual({ ok: true });
    await fails(
      s.sam.request("POST", `/api/v1/watched-records/${w.id}/check`, { source: "access" }),
      429,
      "check_rate_limited",
    );
    expect(await queued(w.id)).toEqual(["access"]);
    expect(await drain("watched.check")).toBe(1);
    // Nothing changed since: no second card.
    expect(((await thread(c.messageId)).replies as Json[]).filter((m) => m.card)).toHaveLength(1);
  });

  it("Check now (manual) needs post rights: Alex, who reads but is not in #orders, gets 403", async () => {
    await fails(s.alex.request("POST", `/api/v1/watched-records/${w.id}/check`, { source: "manual" }), 403);
    const list = await ok(s.alex.request("GET", `/api/v1/watched-records?conversationId=${ordersId}`));
    expect((list.records as Json[]).find((r) => r.id === w.id)?.viewerCan).toEqual([]);
  });
});

describe("preview (R9): read once, nothing stored", () => {
  const body = (extra: Json = {}) => ({
    conversationId: ordersId,
    mcpServerId: erpConnector.id,
    externalRef: "SO-10442",
    readTool: "get_record",
    idArg: "id",
    ...extra,
  });

  it("answers every top-level field with a suggested label; stores nothing; audited without values", async () => {
    const before = (await s.su.query("select count(*)::int as n from app.watched_records")).rows[0].n;
    const p = await ok(s.victor.request("POST", "/api/v1/watched-records/preview", body()));
    expect(p.values).toEqual(
      expect.arrayContaining([
        { pointer: "/status", value: "Delivered", suggestedLabel: "Status" },
        { pointer: "/delivery_date", value: "2026-10-16", suggestedLabel: "Delivery date" },
        { pointer: "/total", value: "1250.00", suggestedLabel: "Total" },
        { pointer: "/customer", value: "Globex S.L.", suggestedLabel: "Customer" },
      ]),
    );
    // The fake ERP types money as text, so nothing gets the number hint (Pitfall 9).
    expect(p.numberHints).toEqual([]);
    expect((await s.su.query("select count(*)::int as n from app.watched_records")).rows[0].n).toBe(before);
    const audit = (await auditRows(s, s.orgA, ["watched_record.previewed"])).at(-1);
    expect(audit?.metadata).toEqual({ conversationId: ordersId, mcpServerId: erpConnector.id, code: null });
    expect(JSON.stringify(audit)).not.toMatch(/Delivered|Globex/u);
  });

  it("an unknown id → 404 record_not_found; a destructive read tool → 400; Alex (no post rights) → 403", async () => {
    await fails(
      s.victor.request("POST", "/api/v1/watched-records/preview", body({ externalRef: "SO-99999" })),
      404,
      "record_not_found",
    );
    await fails(
      s.victor.request("POST", "/api/v1/watched-records/preview", body({ readTool: "update_record" })),
      400,
      "read_tool_not_read_only",
    );
    await fails(s.alex.request("POST", "/api/v1/watched-records/preview", body()), 403);
  });

  it("CR-01: a board with no bot granted the read tool is 400 tool_not_allowed and the ERP is never called", async () => {
    // A bot of the organization holds the grant (Ops helper), but it is not on #scratch: the preview may not use it.
    const scratch = (
      await ok(
        s.victor.request("POST", "/api/v1/channels", {
          name: "scratch",
          layout: "board",
          visibility: "public",
        }),
      )
    ).id as string;
    const calls = erp.state.calls.length;
    await fails(
      s.victor.request("POST", "/api/v1/watched-records/preview", body({ conversationId: scratch })),
      400,
      "tool_not_allowed",
    );
    // A bot on the board that was never granted the read tool does not open it either.
    const idle = (
      await ok(
        s.victor.request("POST", "/api/v1/agents", {
          name: "Idle helper",
          username: "idlehelper",
          instructions: "You idle.",
          modelProvider: "mock",
          modelId: "mock-1",
        }),
      )
    ).id as string;
    await ok(s.victor.request("POST", `/api/v1/channels/${scratch}/members`, { kind: "agent", id: idle }));
    await fails(
      s.victor.request("POST", "/api/v1/watched-records/preview", body({ conversationId: scratch })),
      400,
      "tool_not_allowed",
    );
    expect(erp.state.calls.length).toBe(calls);
    // Once the granted bot joins the board, the same preview reads the record.
    await ok(s.victor.request("POST", `/api/v1/channels/${scratch}/members`, { kind: "agent", id: opsId }));
    await ok(s.victor.request("POST", "/api/v1/watched-records/preview", body({ conversationId: scratch })));
  });
});

describe("audience: a per-member connector needs the linker's share in the board (Pitfall 8)", () => {
  let personal: Json;
  let c: Json;
  let w: Json;
  let shareId = "";

  const share = async () =>
    (
      await ok(
        s.victor.request("POST", "/api/v1/member-account-shares", {
          conversationId: ordersId,
          resourceKind: "connector",
          resourceId: personal.id,
        }),
        201,
      )
    ).id as string;

  const reconnectCards = async () =>
    (
      await s.su.query(
        `select m.conversation_id, c.kind, mc.title, mc.platform_owned from app.messages m
           join app.conversations c on c.id = m.conversation_id
           join app.message_cards mc on mc.message_id = m.id
          where m.author_kind = 'agent' and m.author_id = $1 and mc.title like 'Reconnect ERP personal%'`,
        [opsId],
      )
    ).rows as Json[];

  beforeAll(async () => {
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
    // Víctor connects his own key; the first connection probes the tools API-side.
    await ok(s.victor.request("PUT", `/api/v1/connectors/${personal.id}/secret`, { value: ERP_TOKEN }));
    const tools = (
      await s.su.query(
        "select name, read_only from app.mcp_server_tools where server_id = $1 order by name",
        [personal.id],
      )
    ).rows;
    expect(tools).toContainEqual({ name: "get_record", read_only: true });
    const caps = await ok(s.victor.request("GET", `/api/v1/agents/${opsId}/capabilities`));
    await ok(
      s.victor.request("PATCH", `/api/v1/agents/${opsId}/capabilities`, {
        tools: [
          ...(caps.tools as Json[])
            .filter((t) => t.granted)
            .map((t) => ({ sourceKind: t.sourceKind, sourceId: t.sourceId, tool: t.tool })),
          { sourceKind: "mcp", sourceId: personal.id, tool: `${personal.safeName}__get_record` },
        ],
      }),
    );
    c = await humanCard(ordersId, "EXP-0045 Order read with Víctor's account");
  });

  it("without a share for #orders: link 409 member_account, preview 409 member_account", async () => {
    await fails(
      s.victor.request(
        "POST",
        "/api/v1/watched-records",
        linkBody(c.messageId, { mcpServerId: personal.id }),
      ),
      409,
      "member_account",
    );
    await fails(
      s.victor.request("POST", "/api/v1/watched-records/preview", {
        conversationId: ordersId,
        mcpServerId: personal.id,
        externalRef: "SO-10442",
        readTool: "get_record",
        idArg: "id",
      }),
      409,
      "member_account",
    );
  });

  it("after allowing ERP personal in #orders: 201, per_member, the baseline is read with Víctor's key", async () => {
    shareId = await share();
    w = await ok(
      s.victor.request(
        "POST",
        "/api/v1/watched-records",
        linkBody(c.messageId, { mcpServerId: personal.id }),
      ),
      201,
    );
    expect(w.connector).toMatchObject({ id: personal.id, authMode: "per_member" });
    expect(await drain("watched.check")).toBe(1);
    const r = await row(w.id);
    expect(r).toMatchObject({ last_status: "ok", check_as_user_id: s.victorId });
    expect(r.snapshot_hash).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("revoking the share pauses the next check (not_connected, share_revoked): no read, nothing in the thread", async () => {
    expect((await s.victor.request("DELETE", `/api/v1/member-account-shares/${shareId}`)).status).toBe(204);
    await mutate("SO-10442", { status: "Returned" });
    const calls = erp.state.calls.length;
    await forceCheck(w.id);
    expect(erp.state.calls.length).toBe(calls);
    expect((await row(w.id)).last_status).toBe("not_connected");
    expect((await thread(c.messageId)).replies).toEqual([]);
    const paused = (await auditRows(s, s.orgA, ["watched_record.paused"])).filter(
      (a) => a.resource_id === w.id,
    );
    expect(paused.at(-1)?.metadata).toMatchObject({ status: "not_connected", code: "share_revoked" });
    expect(await reconnectCards()).toEqual([]);
  });

  it("allowed again: the next check resumes and reports the change", async () => {
    shareId = await share();
    await forceCheck(w.id);
    expect((await row(w.id)).last_status).toBe("changed");
    const replies = (await thread(c.messageId)).replies as Json[];
    expect(replies).toHaveLength(1);
    expect(replies[0]?.card.title).toBe("SO-10442 changed in ERP personal");
  });

  it("Víctor's connection needs reconnecting: paused, a Reconnect card only in his DM with the bot, none in the thread", async () => {
    await markNeedsReconnect(core(), {
      organizationId: s.orgA,
      userId: s.victorId,
      serverId: personal.id,
      code: "upstream_unauthorized",
    });
    await forceCheck(w.id);
    expect((await row(w.id)).last_status).toBe("not_connected");
    expect((await thread(c.messageId)).replies).toHaveLength(1);
    const notices = await reconnectCards();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      kind: "dm",
      platform_owned: true,
      title: "Reconnect ERP personal to keep watching SO-10442",
    });
    const members = (
      await s.su.query(
        "select member_kind, member_id from app.conversation_members where conversation_id = $1 order by member_kind",
        [notices[0]?.conversation_id],
      )
    ).rows;
    expect(members).toEqual([
      { member_kind: "agent", member_id: opsId },
      { member_kind: "user", member_id: s.victorId },
    ]);
    // A second paused check tells him nothing new.
    await forceCheck(w.id);
    expect(await reconnectCards()).toHaveLength(1);
  });

  it("after reconnecting, the next check resumes", async () => {
    await ok(s.victor.request("PUT", `/api/v1/connectors/${personal.id}/secret`, { value: ERP_TOKEN }));
    await forceCheck(w.id);
    expect((await row(w.id)).last_status).toBe("ok");
  });
});

describe("edit, unlink, refusals and cross-tenant", () => {
  let c: Json;
  let w: Json;

  beforeAll(async () => {
    ({ card: c, watched: w } = await watchFresh("EXP-0046 Order to edit", { externalRef: "SO-10443" }));
  });

  it("PATCH fields and interval at the version seen: 200, version + 1, a new silent baseline", async () => {
    const updated = await ok(
      s.victor.request("PATCH", `/api/v1/watched-records/${w.id}`, {
        expectedVersion: w.version,
        fields: [{ pointer: "/customer", label: "Customer" }],
        checkIntervalMinutes: 15,
      }),
    );
    expect(updated).toMatchObject({
      version: w.version + 1,
      checkIntervalMinutes: 15,
      fields: [{ pointer: "/customer", label: "Customer" }],
    });
    expect((await row(w.id)).snapshot_hash).toBeNull();
    expect(await drain("watched.check")).toBe(1);
    expect((await row(w.id)).snapshot).toEqual({ "/customer": "Initech S.A." });
    expect((await thread(c.messageId)).replies).toEqual([]);
    const audit = (await auditRows(s, s.orgA, ["watched_record.updated"])).at(-1);
    expect(audit?.metadata).toMatchObject({ changed: ["fields", "checkIntervalMinutes"], fieldCount: 1 });
    await fails(
      s.victor.request("PATCH", `/api/v1/watched-records/${w.id}`, {
        expectedVersion: w.version,
        checkIntervalMinutes: 60,
      }),
      409,
      "version_conflict",
    );
    w = updated;
  });

  it("a lone surrogate in the record marks the check error (lone_surrogate) and posts nothing", async () => {
    await mutate("SO-10443", { customer: "\ud800" });
    await forceCheck(w.id);
    expect((await row(w.id)).last_status).toBe("error");
    const failed = (await auditRows(s, s.orgA, ["watched_record.check_failed"])).filter(
      (a) => a.resource_id === w.id,
    );
    expect(failed.at(-1)?.metadata).toMatchObject({ status: "error", code: "lone_surrogate" });
    expect((await thread(c.messageId)).replies).toEqual([]);
    await mutate("SO-10443", { customer: "Initech S.A." });
    await forceCheck(w.id);
    expect((await row(w.id)).last_status).toBe("ok");
    expect((await thread(c.messageId)).replies).toEqual([]);
  });

  it("Alex reads #orders but cannot post there: link, PATCH and DELETE are 403", async () => {
    const mine = await humanCard(ordersId, "EXP-0047 Alex can't watch this");
    await fails(s.alex.request("POST", "/api/v1/watched-records", linkBody(mine.messageId)), 403);
    await fails(
      s.alex.request("PATCH", `/api/v1/watched-records/${w.id}`, {
        expectedVersion: w.version,
        checkIntervalMinutes: 60,
      }),
      403,
    );
    await fails(s.alex.request("DELETE", `/api/v1/watched-records/${w.id}`), 403);
  });

  it("a non-board message is 400 not_a_board_card; a bot outside #orders is 400 agent_not_member", async () => {
    const replyMsg = await reply(s.victor, c.messageId, "a reply, not a card");
    await fails(
      s.victor.request("POST", "/api/v1/watched-records", linkBody(replyMsg.id)),
      400,
      "not_a_board_card",
    );
    const text = await ok(s.victor.request("POST", "/api/v1/channels", { name: "orders-chat" }));
    const plain = await ok(
      s.victor.request("POST", `/api/v1/conversations/${text.id}/messages`, { body: "hello" }),
    );
    await fails(
      s.victor.request("POST", "/api/v1/watched-records", linkBody(plain.id)),
      400,
      "not_a_board_card",
    );
    const stranger = (
      await ok(
        s.victor.request("POST", "/api/v1/agents", {
          name: "Stranger",
          username: "stranger",
          instructions: "Not on the board.",
          modelProvider: "mock",
          modelId: "mock-1",
        }),
      )
    ).id as string;
    const fresh = await humanCard(ordersId, "EXP-0048 Card for a stranger bot");
    await fails(
      s.victor.request("POST", "/api/v1/watched-records", linkBody(fresh.messageId, { agentId: stranger })),
      400,
      "agent_not_member",
    );
  });

  it("organization B gets 404 on every route, and a forged job finds nothing", async () => {
    await fails(s.eve.request("GET", `/api/v1/watched-records?conversationId=${ordersId}`), 404);
    await fails(s.eve.request("POST", "/api/v1/watched-records", linkBody(c.messageId)), 404);
    await fails(
      s.eve.request("PATCH", `/api/v1/watched-records/${w.id}`, {
        expectedVersion: w.version,
        checkIntervalMinutes: 60,
      }),
      404,
    );
    await fails(s.eve.request("DELETE", `/api/v1/watched-records/${w.id}`), 404);
    await fails(s.eve.request("POST", `/api/v1/watched-records/${w.id}/check`, { source: "access" }), 404);
    await fails(
      s.eve.request("POST", "/api/v1/watched-records/preview", {
        conversationId: ordersId,
        mcpServerId: erpConnector.id,
        externalRef: "SO-10442",
        readTool: "get_record",
        idArg: "id",
      }),
      404,
    );
    // The reply posted in the previous test queued an access check of its own: run it first.
    await drain("watched.check");
    await core().db.withTenant({ organizationId: s.orgB }, (tx) =>
      core().jobs.sendInTx(tx, "watched.check", {
        organizationId: s.orgB,
        watchedRecordId: w.id,
        source: "manual",
      }),
    );
    const checkedAt = (await row(w.id)).checked_at;
    expect(await drain("watched.check")).toBe(1);
    expect((await row(w.id)).checked_at).toEqual(checkedAt);
  });

  it("DELETE unlinks (204, audited); past change cards stay in the thread", async () => {
    expect((await s.victor.request("DELETE", `/api/v1/watched-records/${w.id}`)).status).toBe(204);
    expect(await row(w.id)).toBeUndefined();
    const audit = (await auditRows(s, s.orgA, ["watched_record.unlinked"])).at(-1);
    expect(audit).toMatchObject({ resource_id: w.id });
    expect(audit?.metadata).toMatchObject({ conversationId: ordersId, cardMessageId: c.messageId });
    // The tracer's watch: unlinked, its change card stays.
    const list = await ok(s.victor.request("GET", `/api/v1/watched-records?conversationId=${ordersId}`));
    const tracer = (list.records as Json[]).find((r) => r.cardMessageId === card.messageId) as Json;
    expect((await s.victor.request("DELETE", `/api/v1/watched-records/${tracer.id}`)).status).toBe(204);
    expect(((await thread(card.messageId)).replies as Json[]).filter((m) => m.card)).toHaveLength(1);
  });
});
