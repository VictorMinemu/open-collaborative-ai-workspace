import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  assertNoGlobalFetch,
  auditRows,
  type ConnectorsStack,
  connectionRow,
  connectOAuth,
  fakeStats,
  type Json,
  ok,
  type Res,
  registerConnector,
  startConnectorsStack,
} from "../../testing-connectors";

/**
 * 07.4-12 (D-01, D-02, D-03, D-07; CONN-02 … CONN-04, SC2): the connector proxy `POST /agent-channel/v1/connectors/call`
 * and `/connectors/list`. A shared bot acts with the account of the person who asked: the API claims the call against
 * the turn, opens THAT member's token (never the bot owner's, another member's or an org secret) and calls the
 * member's MCP server through the egress guard. Real PostgreSQL + Redis; the fake OAuth-protected MCP server runs
 * in-process and is reached only through the guard (the global fetch is a tripwire, WINDOWS #175).
 */

const CELL_TOKEN = "ocw-test-cell-token-connectors-0123456789abcdef";

let s: ConnectorsStack;
let server: Json;
let safe = "";
let scoutId = "";
let victorDm = "";
let samDm = "";

async function cell(path: string, body: unknown, token = CELL_TOKEN): Promise<Res> {
  const res = await fetch(`${s.stack.baseUrl}/agent-channel/v1${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Json) : null };
}

/** `who` writes in `conversationId`; returns Scout's delivered event (its turn). */
async function turnOf(
  who: { request: ConnectorsStack["victor"]["request"] },
  conversationId: string,
  text = "who am I on the CRM?",
  mention = false,
): Promise<Json> {
  const msg = await ok(
    who.request("POST", `/api/v1/conversations/${conversationId}/messages`, {
      body: text,
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
  cell("/connectors/call", { eventId: ev.eventId, agentId: scoutId, connector, tool, arguments: args });

/** The subject the fake issued to a member's grant: their account label is `<subject>@fake-mcp.test`. */
async function subjectOf(userId: string): Promise<string> {
  const row = await connectionRow(s, userId, server.id);
  return String(row?.account_label ?? "").replace(/@fake-mcp\.test$/u, "");
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
  server = await registerConnector(s, { name: "Acme CRM" });
  safe = server.safeName;
  // Víctor connects first: the API-side probe fills the catalog (whoami, create_record, echo_auth).
  expect((await connectOAuth(s, s.victor, server.id)).status).toBe(302);
  expect((await connectOAuth(s, s.sam, server.id)).status).toBe(302);
  await ok(
    s.victor.request("PATCH", `/api/v1/agents/${scoutId}/capabilities`, {
      tools: ["whoami", "create_record", "echo_auth"].map((t) => ({
        sourceKind: "mcp",
        sourceId: server.id,
        tool: `${safe}__${t}`,
      })),
    }),
  );
  victorDm = (
    await ok(s.victor.request("POST", "/api/v1/dms", { participants: [{ kind: "agent", id: scoutId }] }))
  ).id;
  samDm = (await ok(s.sam.request("POST", "/api/v1/dms", { participants: [{ kind: "agent", id: scoutId }] })))
    .id;
}, 240_000);

afterEach(() => {
  assertNoGlobalFetch(s);
  s.fake.setScenario({});
});

afterAll(async () => {
  await s?.stop();
});

// ---------------------------------------------------------------- Task 1 (tracer)

describe("tracer: two members ask the same bot and each call uses their own account", () => {
  let victorEv: Json;
  let samEv: Json;
  let victorAnswer: Res;
  let samAnswer: Res;

  it("each member's DM turn offers the logical tool and ocw_connector_call", async () => {
    victorEv = await turnOf(s.victor, victorDm);
    samEv = await turnOf(s.sam, samDm);
    for (const ev of [victorEv, samEv]) {
      expect(ev.turn.tools).toEqual(expect.arrayContaining([`${safe}__whoami`, "ocw_connector_call"]));
    }
  });

  it("POST /connectors/call answers each member with the subject of their own grant", async () => {
    const before = await fakeStats(s);
    victorAnswer = await call(victorEv);
    samAnswer = await call(samEv);
    expect(victorAnswer.status, JSON.stringify(victorAnswer.body)).toBe(200);
    expect(samAnswer.status, JSON.stringify(samAnswer.body)).toBe(200);
    const v = JSON.parse(victorAnswer.body?.content as string);
    const m = JSON.parse(samAnswer.body?.content as string);
    expect(victorAnswer.body).toMatchObject({ isError: false, truncated: false });
    expect(v.subject).toBe(await subjectOf(s.victorId));
    expect(m.subject).toBe(await subjectOf(s.samId));
    expect(v.subject).not.toBe(m.subject);
    expect((await fakeStats(s)).mcpCalls).toBe(before.mcpCalls + 2);
  });

  it("records one allowed mcp call per member, for that member", async () => {
    for (const [ev, userId] of [
      [victorEv, s.victorId],
      [samEv, s.samId],
    ] as const) {
      const rows = (await s.su.query("select * from app.agent_tool_calls where event_id = $1", [ev.eventId]))
        .rows as Json[];
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        tool: `${safe}__whoami`,
        source_kind: "mcp",
        source_id: server.id,
        target: safe,
        decision: "allowed",
        reason: null,
        status: "ok",
        user_id: userId,
        agent_id: scoutId,
      });
    }
  });

  it("audits bot.tool_call (credential member) and bot.tool_call.completed, without arguments or results", async () => {
    const calls = (await auditRows(s, s.orgA, ["bot.tool_call"])).filter(
      (r) => r.metadata.tool === `${safe}__whoami`,
    );
    expect(calls.map((r) => r.user_id).sort()).toEqual([s.victorId, s.samId].sort());
    for (const r of calls) {
      expect(r.metadata).toMatchObject({ credential: "member", sourceKind: "mcp", sourceId: server.id });
    }
    const done = (await auditRows(s, s.orgA, ["bot.tool_call.completed"])).filter(
      (r) => r.metadata.tool === `${safe}__whoami`,
    );
    expect(done).toHaveLength(2);
    for (const r of done) {
      expect(r.metadata).toMatchObject({
        status: "ok",
        durationMs: expect.any(Number),
        credential: "member",
      });
    }
    const text = JSON.stringify([...calls, ...done]);
    expect(text).not.toContain(await subjectOf(s.victorId));
    expect(text).not.toContain(await subjectOf(s.samId));
    expect(text).not.toContain("arguments");
  });

  it("stamps each member's connection as used and taints each turn", async () => {
    expect((await connectionRow(s, s.victorId, server.id))?.last_used_at).not.toBeNull();
    expect((await connectionRow(s, s.samId, server.id))?.last_used_at).not.toBeNull();
    for (const ev of [victorEv, samEv]) {
      const turn = (
        await s.su.query("select tainted, tool_calls from app.agent_turns where event_id = $1", [ev.eventId])
      ).rows[0];
      expect(turn).toEqual({ tainted: true, tool_calls: 1 });
    }
  });

  it("the authz registry declares the route as a cell route", () => {
    expect(s.stack.built.authz.routes.get("POST /agent-channel/v1/connectors/call")).toBe("cell");
  });
});
