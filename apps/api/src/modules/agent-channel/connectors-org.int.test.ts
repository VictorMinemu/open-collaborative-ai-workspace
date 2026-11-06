import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  assertNoGlobalFetch,
  auditRows,
  type ConnectorsStack,
  connectOrgOAuth,
  fakeStats,
  type Json,
  ok,
  orgBundleOf,
  orgConnectionRow,
  type Res,
  registerOrgConnector,
  startConnectorsStack,
} from "../../testing-connectors";

/**
 * 07.14-08 (D-04, D-05, D-07, D-08, D-13; COA-01, COA-03, COA-05): the connector proxy with the organization's account.
 * An admin connects an `org_oauth` server once (07's real route); every member's bot then calls its tools through
 * `POST /agent-channel/v1/connectors/call` with the ORGANIZATION's token, chosen from the server's stored mode (never a
 * body field, never a member's own credential), audited `credential: "organization"`, and the token never reaches the
 * cell. Real PostgreSQL + Redis; the fake OAuth-protected MCP server in-process, reached only through the egress guard
 * (the global fetch is a tripwire, WINDOWS #175).
 */

const CELL_TOKEN = "ocw-test-cell-token-connectors-org-0123456789abcd";

let s: ConnectorsStack;
let server: Json;
let safe = "";
let scoutId = "";
let opsId = "";
let alexDm = "";

async function cell(method: "GET" | "POST", path: string, body?: unknown): Promise<Res> {
  const res = await fetch(`${s.stack.baseUrl}/agent-channel/v1${path}`, {
    method,
    headers: {
      authorization: `Bearer ${CELL_TOKEN}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Json) : null };
}

/** `who` writes in `conversationId` (mentioning Scout when asked); returns Scout's delivered event (its turn). */
async function turnOf(
  who: { request: ConnectorsStack["victor"]["request"] },
  conversationId: string,
  mention = false,
  text = "who are we on the drive?",
): Promise<Json> {
  const msg = await ok(
    who.request("POST", `/api/v1/conversations/${conversationId}/messages`, {
      body: mention ? `@scout ${text}` : text,
      ...(mention ? { mentions: [{ kind: "agent", id: scoutId }] } : {}),
    }),
  );
  const rows = (
    await s.su.query(
      "select payload from app.stream_events where stream_id = $1 and type = 'agent.mention.v1' and payload->'message'->>'id' = $2 and payload->'agent'->>'id' = $3",
      [`cell:${s.orgA}`, msg.id, scoutId],
    )
  ).rows;
  expect(rows).toHaveLength(1);
  return rows[0].payload as Json;
}

const call = (ev: Json, tool = "whoami", args: Json = {}, connector = safe) =>
  cell("POST", "/connectors/call", {
    eventId: ev.eventId,
    agentId: scoutId,
    connector,
    tool,
    arguments: args,
  });

const codeOf = (r: Res) => (r.body?.error as Json | undefined)?.code;

/** The subject the fake issued to the organization's grant: its account label is `<subject>@fake-mcp.test`. */
async function orgSubjectOf(serverId: string): Promise<string> {
  const row = await orgConnectionRow(s, s.orgA, serverId);
  return String(row?.account_label ?? "").replace(/@fake-mcp\.test$/u, "");
}

const memberConnectionsOf = async (serverId: string) =>
  (
    await s.su.query("select count(*)::int as n from app.connector_connections where server_id = $1", [
      serverId,
    ])
  ).rows[0].n as number;

/** The granted tools of Scout, plus `extra` (a PATCH replaces the whole set). */
async function grant(extra: { sourceId: string; tool: string }[]): Promise<void> {
  const caps = await ok(s.victor.request("GET", `/api/v1/agents/${scoutId}/capabilities`));
  await ok(
    s.victor.request("PATCH", `/api/v1/agents/${scoutId}/capabilities`, {
      tools: [
        ...caps.tools
          .filter((t: Json) => t.granted)
          .map((t: Json) => ({ sourceKind: t.sourceKind, sourceId: t.sourceId, tool: t.tool })),
        ...extra.map((t) => ({ sourceKind: "mcp", ...t })),
      ],
    }),
  );
}

beforeAll(async () => {
  s = await startConnectorsStack({ env: { OCW_CELL_TOKEN: CELL_TOKEN } });
  scoutId = (
    await ok(
      s.victor.request("POST", "/api/v1/agents", {
        name: "Scout",
        username: "scout",
        instructions: "You are Scout.",
        modelProvider: "mock",
        modelId: "mock-1",
      }),
    )
  ).id;
  // Víctor (admin) registers the organization's sign-in server and connects it once: the probe fills the catalog
  // with the organization's token.
  server = await registerOrgConnector(s, { name: "Acme Drive" });
  safe = server.safeName;
  expect((await connectOrgOAuth(s, s.victor, server.id)).status).toBe(302);
  await grant(
    ["whoami", "create_record", "echo_auth"].map((t) => ({ sourceId: server.id, tool: `${safe}__${t}` })),
  );

  opsId = (await ok(s.victor.request("POST", "/api/v1/channels", { name: "ops", visibility: "private" }))).id;
  for (const id of [s.samId, s.alexId]) {
    await ok(s.victor.request("POST", `/api/v1/channels/${opsId}/members`, { kind: "user", id }));
  }
  await ok(s.victor.request("POST", `/api/v1/channels/${opsId}/members`, { kind: "agent", id: scoutId }));
  alexDm = (
    await ok(s.alex.request("POST", "/api/v1/dms", { participants: [{ kind: "agent", id: scoutId }] }))
  ).id;
}, 240_000);

afterEach(() => {
  assertNoGlobalFetch(s);
  s.fake.setScenario({});
});

afterAll(async () => {
  await s?.stop();
});

// ---------------------------------------------------------------- Task 1 (tracer)

describe("tracer: every member's bot uses the organization's account", () => {
  let samEv: Json;
  let alexEv: Json;

  it("Sam asks Scout in #ops (three readers): the turn carries the logical tool and ocw_connector_call", async () => {
    samEv = await turnOf(s.sam, opsId, true);
    expect(samEv.turn.tools).toEqual(expect.arrayContaining([`${safe}__whoami`, "ocw_connector_call"]));
    expect(JSON.stringify(samEv.turn.withheld ?? [])).not.toContain("member_account");
  });

  it("the call runs with the organization's grant, for Sam in #ops and for Alex in his DM", async () => {
    const before = await fakeStats(s);
    const samAnswer = await call(samEv);
    expect(samAnswer.status, JSON.stringify(samAnswer.body)).toBe(200);
    expect(samAnswer.body).toMatchObject({ isError: false, truncated: false });
    const orgSubject = await orgSubjectOf(server.id);
    expect(orgSubject).not.toBe("");
    expect(JSON.parse(samAnswer.body?.content as string).subject).toBe(orgSubject);

    alexEv = await turnOf(s.alex, alexDm);
    const alexAnswer = await call(alexEv);
    expect(alexAnswer.status, JSON.stringify(alexAnswer.body)).toBe(200);
    expect(JSON.parse(alexAnswer.body?.content as string).subject).toBe(orgSubject);
    expect((await fakeStats(s)).mcpCalls).toBe(before.mcpCalls + 2);
    // No member's own credential exists for, or was made for, an org-mode server.
    expect(await memberConnectionsOf(server.id)).toBe(0);
  });

  it("records one allowed mcp call per turn, for the member who asked", async () => {
    for (const [ev, userId] of [
      [samEv, s.samId],
      [alexEv, s.alexId],
    ] as const) {
      const rows = (await s.su.query("select * from app.agent_tool_calls where event_id = $1", [ev.eventId]))
        .rows as Json[];
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        tool: `${safe}__whoami`,
        source_kind: "mcp",
        source_id: server.id,
        decision: "allowed",
        status: "ok",
        user_id: userId,
      });
    }
  });

  it("audits bot.tool_call and bot.tool_call.completed with credential organization, no arguments or results", async () => {
    const calls = (await auditRows(s, s.orgA, ["bot.tool_call"])).filter(
      (r) => r.metadata.tool === `${safe}__whoami`,
    );
    expect(calls.map((r) => r.user_id).sort()).toEqual([s.samId, s.alexId].sort());
    for (const r of calls) {
      expect(r.metadata).toMatchObject({
        credential: "organization",
        sourceKind: "mcp",
        sourceId: server.id,
      });
    }
    const done = (await auditRows(s, s.orgA, ["bot.tool_call.completed"])).filter(
      (r) => r.metadata.tool === `${safe}__whoami`,
    );
    expect(done).toHaveLength(2);
    for (const r of done) expect(r.metadata).toMatchObject({ status: "ok", credential: "organization" });
    const text = JSON.stringify([...calls, ...done]);
    expect(text).not.toContain(await orgSubjectOf(server.id));
    expect(text).not.toContain("arguments");
    expect(text).not.toMatch(/fakeat_|fakert_|Bearer/u);
  });

  it("stamps the organization connection as used", async () => {
    expect((await orgConnectionRow(s, s.orgA, server.id))?.last_used_at).not.toBeNull();
  });

  it("the cell never sees the organization's server or token", async () => {
    const snapshot = await cell("GET", "/cell");
    expect(snapshot.status).toBe(200);
    expect(((snapshot.body?.mcpServers ?? []) as Json[]).map((m) => m.id)).not.toContain(server.id);
    const scout = ((snapshot.body?.agents ?? []) as Json[]).find((a) => a.id === scoutId);
    const tools = scout?.capabilities.tools as string[];
    expect(tools).toEqual(expect.arrayContaining(["ocw_connector_call", "ocw_connector_list"]));
    expect(tools.filter((t) => t.startsWith(`${safe}__`))).toEqual([]);
    const bundle = await orgBundleOf(s, s.orgA, server.id);
    expect(bundle?.accessToken).toEqual(expect.any(String));
    const text = JSON.stringify(snapshot.body);
    expect(text).not.toContain(bundle?.accessToken);
    if (bundle?.refreshToken) expect(text).not.toContain(bundle.refreshToken);
    expect(text).not.toMatch(/fakeat_|fakert_/u);
  });
});
