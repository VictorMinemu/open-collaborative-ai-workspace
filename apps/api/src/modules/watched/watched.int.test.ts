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
import { callTool } from "../connectors";
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
