import { randomUUID } from "node:crypto";
import { WS_AUTH_PROTOCOL_PREFIX, WS_PROTOCOL } from "@ocw/contracts";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { sha256Hex } from "../../lib/crypto";
import { type TestClient, WEB_ORIGIN } from "../../testing";
import {
  assertNoGlobalFetch,
  type ConnectorsStack,
  connectOAuth,
  fakeStats,
  type Json,
  ok,
  type Res,
  registerConnector,
  startConnectorsStack,
} from "../../testing-connectors";
import { invite } from "../../testing-workzone";

/**
 * 07.5-16 Task 2 (D-01, P-09, Pitfall 6, C-02; APPROVE-01; T-07.5-16-03/04): the arguments of an agent action stay
 * exactly where the design allows, and organizations stay apart, through the real agent-action routes.
 *
 *   - A tool without a rule (LEAK-SENTINEL-1): arguments a misbehaving cell sends anyway are dropped unread; the
 *     sentinel is in no text, varchar, array or jsonb column of the `app` and `auth` schemas, no audit row, no stream
 *     event, no Redis key or value, no HTTP response, no WebSocket frame and no log line (LOG_LEVEL debug).
 *   - A ruled tool (LEAK-SENTINEL-2): the arguments live only in `tool_call_approvals.arguments_canonical`, the
 *     decider's and the requester's `GET /api/v1/approvals/:id` view, the requester's exact DM card (its
 *     `message_cards` row, the DM's own stream and the DM's messages read by its member) and the
 *     `agent.card_action.v1` grant of the re-run.
 *   - A summary audience (a channel, LEAK-SENTINEL-3): the arguments are in none of the channel's cards, messages or
 *     stream events.
 *   - Cross-tenant: organization B's cell cannot use organization A's turns on the three routes, never consumes A's
 *     grant with its own turn, and organization B's people never list or open A's approvals.
 *
 * The sweep walker is the 07.4-12 one (`connectors/security.int.test.ts`), with row-level locations for the places a
 * value is allowed.
 */

const CELL_TOKEN = "ocw-test-cell-token-tool-args-leak-0123456789abcdef";
const NOTES = "m9a8b7c6d";
const WRITE = `${NOTES}__write_note`;
const ECHO = `${NOTES}__echo`;

const S1 = "LEAK-SENTINEL-1-unruled-echo";
const S2 = "LEAK-SENTINEL-2-ruled-dm";
const S3 = "LEAK-SENTINEL-3-summary-channel";

let s: ConnectorsStack;
let marta: TestClient;
let martaId = "";
let dana: TestClient;
let sales = "";
let keeperId = "";
let notesId = "";
let crm: Json;
let crmSafe = "";
let samDm = "";
let danaDm = "";
let ops = "";

/** Every response of the API under test: method, path, status and body. */
const responses: Array<{ path: string; status: number; text: string }> = [];
let sockets: Array<{ who: string; ws: WebSocket; frames: string[] }> = [];

async function cell(path: string, body: unknown, token = CELL_TOKEN): Promise<Res> {
  const res = await fetch(`${s.stack.baseUrl}/agent-channel/v1${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Json) : null };
}

const codeOf = (r: Res) => (r.body?.error as Json | undefined)?.code;

async function turnOf(
  who: TestClient,
  conversationId: string,
  opts: { mention?: string; agentId?: string; org?: string } = {},
): Promise<Json> {
  const agentId = opts.agentId ?? keeperId;
  const msg = await ok(
    who.request("POST", `/api/v1/conversations/${conversationId}/messages`, {
      body: `${opts.mention ? `@${opts.mention} ` : ""}please do it ${randomUUID().slice(0, 6)}`,
      ...(opts.mention ? { mentions: [{ kind: "agent", id: agentId }] } : {}),
    }),
  );
  const rows = (
    await s.su.query(
      "select payload from app.stream_events where stream_id = $1 and type = 'agent.mention.v1' and payload->'message'->>'id' = $2 and payload->'agent'->>'id' = $3",
      [`cell:${opts.org ?? s.orgA}`, msg.id, agentId],
    )
  ).rows;
  expect(rows).toHaveLength(1);
  return rows[0].payload as Json;
}

async function socketOf(client: TestClient, topics: string[]) {
  const ws = new WebSocket(
    `${s.stack.baseUrl.replace("http", "ws")}/ws`,
    [WS_PROTOCOL, `${WS_AUTH_PROTOCOL_PREFIX}${await client.token()}`],
    { headers: { origin: WEB_ORIGIN } },
  );
  const frames: string[] = [];
  ws.on("message", (m) => frames.push(String(m)));
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  for (const topic of topics) {
    ws.send(JSON.stringify({ op: "sub", topic }));
    const until = Date.now() + 5000;
    while (!frames.some((f) => f.includes('"subscribed"') && f.includes(`"${topic}"`))) {
      if (Date.now() > until) throw new Error(`no subscribed frame for ${topic}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }
  return { ws, frames };
}

async function rule(p: {
  pattern: string;
  approverKind: "requester" | "users" | "unit_leads";
  scopeUnitId?: string | null;
  users?: string[];
}): Promise<void> {
  await s.su.query(
    `insert into app.tool_approval_policies
       (organization_id, scope_unit_id, tool_pattern, mode, approver_kind, approver_user_ids, created_by, updated_by)
     values ($1, $2, $3, 'always', $4, $5::uuid[], $6, $6)`,
    [s.orgA, p.scopeUnitId ?? null, p.pattern, p.approverKind, p.users ?? [], s.victorId],
  );
}

const clearRules = () =>
  s.su.query("delete from app.tool_approval_policies where organization_id = $1", [s.orgA]);

const approvalRow = async (id: string) =>
  (await s.su.query("select * from app.approval_requests where id = $1", [id])).rows[0] as Json;

async function decide(who: TestClient, id: string, outcome: "approved" | "denied") {
  const row = await approvalRow(id);
  const r = await who.request("POST", `/api/v1/approvals/${id}/decision`, {
    outcome,
    actionHash: row.action_hash,
  });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}

async function rerunOf(approvalId: string, org = s.orgA): Promise<Json> {
  const row = await approvalRow(approvalId);
  const rows = (
    await s.su.query(
      "select payload from app.stream_events where stream_id = $1 and type = 'agent.card_action.v1' and payload->'cardAction'->>'messageId' = $2 order by seq",
      [`cell:${org}`, row.card_message_id],
    )
  ).rows;
  expect(rows).toHaveLength(1);
  return rows[0].payload as Json;
}

// ---------------------------------------------------------------- the 07.4-12 walker, with row locations

/** Every place of a text, varchar, array, json or jsonb value of the app and auth schemas holding `needle`. */
async function dbHits(needle: string): Promise<string[]> {
  const cols = (
    await s.su.query(
      `select table_schema, table_name, column_name from information_schema.columns
        where table_schema in ('app','auth')
          and data_type in ('text','character varying','jsonb','json','ARRAY')
          and table_name in (select table_name from information_schema.tables
                              where table_schema = columns.table_schema and table_type = 'BASE TABLE')`,
    )
  ).rows as Array<{ table_schema: string; table_name: string; column_name: string }>;
  expect(cols.length).toBeGreaterThan(100);
  const out: string[] = [];
  for (const c of cols) {
    const n = (
      await s.su.query(
        `select count(*)::int as n from "${c.table_schema}"."${c.table_name}"
          where "${c.column_name}" is not null and strpos("${c.column_name}"::text, $1) > 0`,
        [needle],
      )
    ).rows[0].n as number;
    if (n > 0) out.push(`${c.table_schema}.${c.table_name}.${c.column_name}`);
  }
  return out.sort();
}

/** Every Redis key and value (strings, hashes, lists, sets, sorted sets, streams), as text. */
async function redisText(): Promise<string> {
  const redis = s.stack.built.core.bus.pub;
  const out: string[] = [];
  for await (const batch of redis.scanIterator({ COUNT: 500 })) {
    for (const key of Array.isArray(batch) ? batch : [batch]) {
      const type = await redis.type(key);
      let value: unknown = null;
      if (type === "string") value = await redis.get(key);
      else if (type === "hash") value = await redis.hGetAll(key);
      else if (type === "list") value = await redis.lRange(key, 0, -1);
      else if (type === "set") value = await redis.sMembers(key);
      else if (type === "zset") value = await redis.zRange(key, 0, -1);
      else if (type === "stream") value = await redis.xRange(key, "-", "+");
      out.push(`${key} (${type}): ${JSON.stringify(value)}`);
    }
  }
  return out.join("\n");
}

/** The stream events holding `needle`: stream, type and the card message they are about. */
const eventHits = async (needle: string) =>
  (
    await s.su.query(
      `select stream_id, type, coalesce(payload->'cardAction'->>'messageId', payload->'message'->>'id', payload->>'id') as about
         from app.stream_events where strpos(payload::text, $1) > 0 order by stream_id, seq`,
      [needle],
    )
  ).rows as Array<{ stream_id: string; type: string; about: string | null }>;

const responsesWith = (needle: string) =>
  responses.filter((r) => r.text.includes(needle)).map((r) => `${r.status} ${r.path}`);

const framesWith = (needle: string) =>
  sockets.flatMap((sock) =>
    sock.frames
      .filter((f) => f.includes(needle))
      .map((f) => `${sock.who} ${(JSON.parse(f) as Json).topic ?? "?"}`),
  );

const logsWith = (needle: string) => s.logs.filter((l) => l.includes(needle));

beforeAll(async () => {
  s = await startConnectorsStack({ env: { OCW_CELL_TOKEN: CELL_TOKEN }, logLevel: "debug" });
  // Record every response of the API under test (the fixture's own fetch stub stays underneath).
  const inner = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const res = await inner(input, init);
    const href = input instanceof Request ? input.url : String(input);
    if (href.startsWith(s.stack.baseUrl)) {
      const url = new URL(href);
      responses.push({
        path: `${init?.method ?? "GET"} ${url.pathname}${url.search}`,
        status: res.status,
        text: `${JSON.stringify([...res.headers])}\n${await res.clone().text()}`,
      });
    }
    return res;
  });

  ({ client: marta, userId: martaId } = await invite(
    s.stack,
    s.victor,
    "marta@example.test",
    "Marta Gil",
    "lead",
  ));
  ({ client: dana } = await invite(s.stack, s.victor, "dana@example.test", "Dana Cole", "standard"));
  sales = (
    await ok(s.victor.request("POST", "/api/v1/units", { kind: "department", name: "Sales", parentId: null }))
  ).id as string;
  await ok(s.victor.request("POST", `/api/v1/units/${sales}/members`, { userId: martaId, role: "lead" }));
  await ok(s.victor.request("POST", `/api/v1/units/${sales}/members`, { userId: s.samId }));

  keeperId = (
    await ok(
      s.victor.request("POST", "/api/v1/agents", {
        name: "Keeper",
        username: "keeper",
        instructions: "You are Keeper.",
        modelProvider: "mock",
        modelId: "mock-1",
      }),
    )
  ).id as string;
  notesId = randomUUID();
  await s.su.query(
    `insert into app.mcp_servers (id, organization_id, name, safe_name, transport, url, status, auth_mode)
     values ($1, $2, 'Notes', $3, 'streamable-http', 'https://notes.example.test/mcp', 'ready', 'org_secret')`,
    [notesId, s.orgA, NOTES],
  );
  for (const [name, readOnly] of [
    ["write_note", false],
    ["echo", true],
  ] as const) {
    await s.su.query(
      `insert into app.mcp_server_tools (organization_id, server_id, name, openclaw_name, read_only)
       values ($1, $2, $3, $4, $5)`,
      [s.orgA, notesId, name, `${NOTES}__${name}`, readOnly],
    );
  }
  crm = await registerConnector(s, { name: "Acme CRM" });
  crmSafe = crm.safeName as string;
  expect((await connectOAuth(s, s.sam, crm.id)).status).toBe(302);
  await ok(
    s.victor.request("PATCH", `/api/v1/agents/${keeperId}/capabilities`, {
      internet: true,
      tools: [
        ...[WRITE, ECHO].map((tool) => ({ sourceKind: "mcp", sourceId: notesId, tool })),
        { sourceKind: "mcp", sourceId: crm.id, tool: `${crmSafe}__create_record` },
      ],
    }),
  );
  samDm = (
    await ok(s.sam.request("POST", "/api/v1/dms", { participants: [{ kind: "agent", id: keeperId }] }))
  ).id as string;
  danaDm = (
    await ok(dana.request("POST", "/api/v1/dms", { participants: [{ kind: "agent", id: keeperId }] }))
  ).id as string;
  ops = (await ok(s.victor.request("POST", "/api/v1/channels", { name: "ops", visibility: "private" }))).id;
  for (const member of [
    { kind: "user", id: s.samId },
    { kind: "user", id: martaId },
    { kind: "agent", id: keeperId },
  ]) {
    await ok(s.victor.request("POST", `/api/v1/channels/${ops}/members`, member));
  }
  // Sam lets Keeper use his CRM account in #ops (07.4-12 share).
  await ok(
    s.sam.request("POST", "/api/v1/member-account-shares", {
      conversationId: ops,
      resourceKind: "connector",
      resourceId: crm.id,
    }),
    201,
  );

  sockets = [
    {
      who: "Sam",
      ...(await socketOf(s.sam, [`user:${s.samId}`, `org:${s.orgA}`, `conv:${samDm}`, `conv:${ops}`])),
    },
    { who: "Marta", ...(await socketOf(marta, [`user:${martaId}`, `org:${s.orgA}`, `conv:${ops}`])) },
    { who: "Dana", ...(await socketOf(dana, [`org:${s.orgA}`, `conv:${danaDm}`])) },
  ];
}, 240_000);

afterEach(() => {
  assertNoGlobalFetch(s);
});

afterAll(async () => {
  for (const sock of sockets) sock.ws.close();
  // The stack's own stop() skips the containers when the app's close throws (WINDOWS #213): stop them here too.
  try {
    await s?.stop();
  } finally {
    if (s) await Promise.allSettled([s.stack.redis.stop(), s.stack.db.stop()]);
  }
});

// ---------------------------------------------------------------- the scenario

let ruledId = "";
let ruledCard = "";
let summaryId = "";

describe("the scenario: an unruled call, a ruled DM call approved and re-run, a ruled channel call", () => {
  it("unruled echo with arguments sent anyway (a misbehaving cell) → allowed exactly as today", async () => {
    await clearRules();
    const ev = await turnOf(dana, danaDm);
    expect(ev.turn.toolFlags[ECHO]).not.toHaveProperty("approval");
    const r = await cell("/tool-calls", {
      eventId: ev.eventId,
      agentId: keeperId,
      tool: ECHO,
      toolCallId: randomUUID(),
      params: {},
      arguments: { text: S1 },
    });
    expect(r.body).toEqual({ callId: expect.any(String), allowed: true, reason: null });
    // The cell reports its outcome: counts only.
    const done = await cell(`/tool-calls/${r.body?.callId}/result`, { status: "ok", durationMs: 12 });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
  });

  it("ruled write_note in Sam's DM, decided by Marta (a users rule), re-run once", async () => {
    await clearRules();
    await rule({ pattern: WRITE, approverKind: "users", users: [martaId] });
    const ev = await turnOf(s.sam, samDm);
    const asked = await cell("/tool-calls", {
      eventId: ev.eventId,
      agentId: keeperId,
      tool: WRITE,
      toolCallId: randomUUID(),
      params: {},
      arguments: { text: S2 },
    });
    expect(asked.body).toMatchObject({ allowed: false, reason: "approval_required" });
    ruledId = asked.body?.approval.id as string;
    ruledCard = (await approvalRow(ruledId)).card_message_id as string;

    // The views: the decider and the requester see the exact action; nobody else sees the request at all.
    expect(JSON.stringify(await ok(marta.request("GET", `/api/v1/approvals/${ruledId}`)))).toContain(S2);
    expect(JSON.stringify(await ok(s.sam.request("GET", `/api/v1/approvals/${ruledId}`)))).toContain(S2);
    expect((await dana.request("GET", `/api/v1/approvals/${ruledId}`)).status).toBe(404);
    expect((await s.victor.request("GET", `/api/v1/approvals/${ruledId}`)).status).toBe(404);
    // The lists and the card as its DM's member reads it.
    await ok(marta.request("GET", "/api/v1/approvals?role=decider&kinds=tool.call"));
    await ok(s.sam.request("GET", "/api/v1/approvals?role=requester&kinds=tool.call"));
    const dmMessages = await ok(s.sam.request("GET", `/api/v1/conversations/${samDm}/messages`));
    expect(JSON.stringify(dmMessages)).toContain(S2);

    await decide(marta, ruledId, "approved");
    const rerun = await rerunOf(ruledId);
    expect(rerun.cardAction.grant.arguments).toBe(JSON.stringify({ text: S2 }));
    const used = await cell("/tool-calls", {
      eventId: rerun.eventId,
      agentId: keeperId,
      tool: WRITE,
      toolCallId: randomUUID(),
      params: {},
      arguments: { text: S2 },
    });
    expect(used.body).toEqual({ callId: expect.any(String), allowed: true, reason: null });
    await cell(`/tool-calls/${used.body?.callId}/result`, { status: "ok", durationMs: 5 });
  });

  it("ruled CRM write in #ops for the Sales leads (a summary card) → approval_required, nothing in the channel", async () => {
    await clearRules();
    await rule({ pattern: `${crmSafe}__*`, approverKind: "unit_leads", scopeUnitId: sales });
    const ev = await turnOf(s.sam, ops, { mention: "keeper" });
    const before = await fakeStats(s);
    const asked = await cell("/connectors/call", {
      eventId: ev.eventId,
      agentId: keeperId,
      connector: crmSafe,
      tool: "create_record",
      arguments: { title: S3 },
    });
    expect(asked.status, JSON.stringify(asked.body)).toBe(409);
    expect(codeOf(asked)).toBe("approval_required");
    expect((await fakeStats(s)).mcpCalls).toBe(before.mcpCalls);
    summaryId = asked.body?.error.details.approval.id as string;
    expect(JSON.stringify(await ok(marta.request("GET", `/api/v1/approvals/${summaryId}`)))).toContain(S3);
    const card = await ok(
      marta.request("GET", `/api/v1/cards/${(await approvalRow(summaryId)).card_message_id}`),
    );
    expect(card.approval?.display).toBe("summary");
    expect(JSON.stringify(card)).not.toContain(S3);
    expect(
      JSON.stringify(await ok(marta.request("GET", `/api/v1/conversations/${ops}/messages`))),
    ).not.toContain(S3);
  });
});

// ---------------------------------------------------------------- the sweep

describe("the sweep: every sink, for each sentinel", () => {
  beforeAll(async () => {
    // Let the last realtime frames and log lines arrive.
    await new Promise((r) => setTimeout(r, 300));
    expect(s.logs.length).toBeGreaterThan(50);
    for (const sock of sockets) expect(sock.frames.length, sock.who).toBeGreaterThan(3);
  });

  it(`unruled: LEAK-SENTINEL-1 is nowhere (database, audit, events, Redis, responses, frames, logs)`, async () => {
    expect(await dbHits(S1)).toEqual([]);
    expect(await eventHits(S1)).toEqual([]);
    expect(await redisText()).not.toContain(S1);
    expect(responsesWith(S1)).toEqual([]);
    expect(framesWith(S1)).toEqual([]);
    expect(logsWith(S1)).toEqual([]);
  });

  it(`ruled: LEAK-SENTINEL-2 only in the stored action, the exact DM card, the grant and the decider's and requester's views`, async () => {
    expect(await dbHits(S2)).toEqual([
      "app.message_cards.fields",
      "app.stream_events.payload",
      "app.tool_call_approvals.arguments_canonical",
    ]);
    // One stored action, one card (Sam's DM), and events only on Sam's DM stream (the card) and the cell's grant.
    expect(
      (
        await s.su.query("select id from app.tool_call_approvals where strpos(arguments_canonical, $1) > 0", [
          S2,
        ])
      ).rows,
    ).toHaveLength(1);
    expect(
      (
        await s.su.query(
          "select message_id, conversation_id from app.message_cards where strpos(fields::text, $1) > 0",
          [S2],
        )
      ).rows,
    ).toEqual([{ message_id: ruledCard, conversation_id: samDm }]);
    const events = await eventHits(S2);
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      const allowed =
        (e.stream_id === `conv:${samDm}` && e.about === ruledCard) ||
        (e.stream_id === `cell:${s.orgA}` && e.type === "agent.card_action.v1" && e.about === ruledCard);
      expect(allowed, `${e.stream_id} ${e.type}`).toBe(true);
    }
    expect(events.some((e) => e.type === "agent.card_action.v1")).toBe(true);
    // Never in audit rows or the ledger (covered by dbHits; asserted by name for the reader).
    expect(
      (await s.su.query("select 1 from app.audit_events where strpos(metadata::text, $1) > 0", [S2])).rows,
    ).toEqual([]);
    expect(
      (
        await s.su.query(
          "select 1 from app.agent_tool_calls where strpos(row_to_json(agent_tool_calls)::text, $1) > 0",
          [S2],
        )
      ).rows,
    ).toEqual([]);

    expect(await redisText()).not.toContain(S2);
    expect(logsWith(S2)).toEqual([]);
    // Responses: the two views and the DM's messages read by Sam; no cell answer, list, or other reader.
    expect(responsesWith(S2).sort()).toEqual(
      [
        `200 GET /api/v1/approvals/${ruledId}`,
        `200 GET /api/v1/approvals/${ruledId}`,
        `200 GET /api/v1/conversations/${samDm}/messages`,
      ].sort(),
    );
    // Frames: only Sam's DM topic.
    const frames = framesWith(S2);
    expect(frames.length).toBeGreaterThan(0);
    expect([...new Set(frames)]).toEqual([`Sam conv:${samDm}`]);
  });

  it(`summary audience: LEAK-SENTINEL-3 only in the stored action and the decider's view, never in #ops`, async () => {
    expect(await dbHits(S3)).toEqual(["app.tool_call_approvals.arguments_canonical"]);
    expect(await eventHits(S3)).toEqual([]);
    expect(await redisText()).not.toContain(S3);
    expect(logsWith(S3)).toEqual([]);
    expect(framesWith(S3)).toEqual([]);
    expect(responsesWith(S3)).toEqual([`200 GET /api/v1/approvals/${summaryId}`]);
    const opsCards = (
      await s.su.query(
        "select c.message_id from app.message_cards c join app.approval_requests a on a.card_message_id = c.message_id where a.id = $1 and c.conversation_id = $2",
        [summaryId, ops],
      )
    ).rows;
    expect(opsCards).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- tenants

describe("organization B never reaches organization A's turns or approvals", () => {
  let tokenB = "";
  let eveDm = "";
  let watcherId = "";
  let grantA = "";
  let rerunA: Json;
  const args = { text: "same action in two organizations" };

  const countAll = async (table: string) =>
    (await s.su.query(`select count(*)::int as n from app.${table}`)).rows[0].n as number;

  beforeAll(async () => {
    tokenB = `ocw_cell_${randomUUID()}${randomUUID()}`;
    await s.su.query(
      "insert into app.agent_credentials (organization_id, kind, token_hash) values ($1, 'channel_plugin', $2)",
      [s.orgB, sha256Hex(tokenB)],
    );
    // Organization A: an approved, unused grant for Sam's DM.
    await clearRules();
    await rule({ pattern: WRITE, approverKind: "requester" });
    const asked = await cell("/tool-calls", {
      eventId: (await turnOf(s.sam, samDm)).eventId,
      agentId: keeperId,
      tool: WRITE,
      toolCallId: randomUUID(),
      params: {},
      arguments: args,
    });
    grantA = asked.body?.approval.id as string;
    await decide(s.sam, grantA, "approved");
    rerunA = await rerunOf(grantA);

    // Organization B: Eve's bot Watcher, an MCP server with the same safe name and tool, the same kind of rule.
    watcherId = (
      await ok(
        s.eve.request("POST", "/api/v1/agents", {
          name: "Watcher",
          username: "watcher",
          instructions: "You are Watcher.",
          modelProvider: "mock",
          modelId: "mock-1",
        }),
      )
    ).id as string;
    const notesB = randomUUID();
    await s.su.query(
      `insert into app.mcp_servers (id, organization_id, name, safe_name, transport, url, status, auth_mode)
       values ($1, $2, 'Notes', $3, 'streamable-http', 'https://notes.example.test/mcp', 'ready', 'org_secret')`,
      [notesB, s.orgB, NOTES],
    );
    await s.su.query(
      `insert into app.mcp_server_tools (organization_id, server_id, name, openclaw_name, read_only)
       values ($1, $2, 'write_note', $3, false)`,
      [s.orgB, notesB, WRITE],
    );
    await ok(
      s.eve.request("PATCH", `/api/v1/agents/${watcherId}/capabilities`, {
        tools: [{ sourceKind: "mcp", sourceId: notesB, tool: WRITE }],
      }),
    );
    await s.su.query(
      `insert into app.tool_approval_policies
         (organization_id, scope_unit_id, tool_pattern, mode, approver_kind, approver_user_ids, created_by, updated_by)
       values ($1, null, $2, 'always', 'requester', '{}', $3, $3)`,
      [s.orgB, WRITE, s.eveId],
    );
    eveDm = (
      await ok(s.eve.request("POST", "/api/v1/dms", { participants: [{ kind: "agent", id: watcherId }] }))
    ).id as string;
  });

  it("org B's cell token with org A's eventId on /tool-calls, /connectors/call and /http-requests: refused, no approval stored", async () => {
    const [actions, requests] = [await countAll("tool_call_approvals"), await countAll("approval_requests")];
    const turn = { eventId: rerunA.eventId };
    for (const agentId of [keeperId, watcherId]) {
      const gate = await cell(
        "/tool-calls",
        { ...turn, agentId, tool: WRITE, toolCallId: randomUUID(), params: {}, arguments: args },
        tokenB,
      );
      expect(gate.status, JSON.stringify(gate.body)).toBe(200);
      expect(gate.body).toMatchObject({ allowed: false, reason: "unknown_turn" });

      const connector = await cell(
        "/connectors/call",
        { ...turn, agentId, connector: crmSafe, tool: "create_record", arguments: args },
        tokenB,
      );
      expect(connector.status, JSON.stringify(connector.body)).toBe(403);
      expect(codeOf(connector)).toBe("no_trigger");

      const http = await cell(
        "/http-requests",
        {
          ...turn,
          agentId,
          handle: "k_abcdefghij",
          method: "POST",
          url: `http://fake-mcp:${s.fakePort}/kc/whoami`,
          body: "x",
        },
        tokenB,
      );
      expect(http.status, JSON.stringify(http.body)).toBe(403);
      expect(codeOf(http)).toBe("no_trigger");
    }
    expect(await countAll("tool_call_approvals")).toBe(actions);
    expect(await countAll("approval_requests")).toBe(requests);
    expect(await approvalRow(grantA)).toMatchObject({ status: "approved", consumed_at: null });
    // Nothing recorded against A's turn; the refusals are audited in B only.
    expect(
      (await s.su.query("select 1 from app.agent_tool_calls where event_id = $1", [rerunA.eventId])).rows,
    ).toEqual([]);
  });

  it("org B's own turn with the same tool and arguments: a new approval in B, A's grant untouched", async () => {
    const ev = await turnOf(s.eve, eveDm, { agentId: watcherId, org: s.orgB });
    const r = await cell(
      "/tool-calls",
      {
        eventId: ev.eventId,
        agentId: watcherId,
        tool: WRITE,
        toolCallId: randomUUID(),
        params: {},
        arguments: args,
      },
      tokenB,
    );
    expect(r.body).toMatchObject({
      allowed: false,
      reason: "approval_required",
      approval: { created: true },
    });
    const idB = r.body?.approval.id as string;
    expect(idB).not.toBe(grantA);
    expect((await approvalRow(idB)).organization_id).toBe(s.orgB);
    expect(await approvalRow(grantA)).toMatchObject({ status: "approved", consumed_at: null });

    // Org A's token with org B's turn: unknown too.
    const crossed = await cell("/tool-calls", {
      eventId: ev.eventId,
      agentId: watcherId,
      tool: WRITE,
      toolCallId: randomUUID(),
      params: {},
      arguments: args,
    });
    expect(crossed.body).toMatchObject({ allowed: false, reason: "unknown_turn" });

    // A's grant is still Sam's, once.
    const used = await cell("/tool-calls", {
      eventId: rerunA.eventId,
      agentId: keeperId,
      tool: WRITE,
      toolCallId: randomUUID(),
      params: {},
      arguments: args,
    });
    expect(used.body).toMatchObject({ allowed: true, reason: null });
  });

  it("org B's people never list, open or decide org A's approvals", async () => {
    const idsA = (
      await s.su.query(
        "select id from app.approval_requests where organization_id = $1 and kind = 'tool.call'",
        [s.orgA],
      )
    ).rows.map((r) => r.id as string);
    expect(idsA.length).toBeGreaterThan(2);
    for (const role of ["decider", "requester"]) {
      const listed = await ok(s.eve.request("GET", `/api/v1/approvals?role=${role}&kinds=tool.call`));
      const ids = (listed.items as Json[]).map((i) => i.id as string);
      expect(
        ids.some((id) => idsA.includes(id)),
        role,
      ).toBe(false);
      for (const id of ids) expect((await approvalRow(id)).organization_id).toBe(s.orgB);
    }
    const pendingA = (
      await s.su.query(
        "select id, action_hash from app.approval_requests where organization_id = $1 and kind = 'tool.call' and status = 'pending' limit 1",
        [s.orgA],
      )
    ).rows[0] as Json;
    expect(pendingA).toBeDefined();
    expect((await s.eve.request("GET", `/api/v1/approvals/${pendingA.id}`)).status).toBe(404);
    const decided = await s.eve.request("POST", `/api/v1/approvals/${pendingA.id}/decision`, {
      outcome: "approved",
      actionHash: pendingA.action_hash,
    });
    expect(decided.status).toBe(404);
    expect((await approvalRow(pendingA.id)).status).toBe("pending");
  });
});
