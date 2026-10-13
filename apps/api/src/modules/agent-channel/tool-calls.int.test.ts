import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";

/**
 * 03.1-04 (BOT-06, D-08): the cell's tool gate asks `POST /agent-channel/v1/tool-calls` before every gated
 * call; the API re-decides against the delivered turn and the CURRENT policy, enforces the per-turn caps and
 * the taint rule atomically, and audits every call with bot, human, tool and host (never the query, URL path
 * or results). Real PostgreSQL + Redis.
 */

const CELL_TOKEN = "ocw-test-cell-token-tool-calls-0123456789abcd";
const QUERY = "zebra quarterly numbers 2026";

let stack: TestStack;
let su: pg.Client;
let admin: TestClient;
let sam: TestClient;
let orgId: string;
let samId: string;
let samBotId: string;
let samDmId: string;

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
type Json = Record<string, any>;

async function ok(res: Promise<{ status: number; body: Record<string, unknown> | null }>, status = 200) {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as Json;
}

async function cell(path: string, body: unknown): Promise<{ status: number; body: Json }> {
  const res = await fetch(`${stack.baseUrl}/agent-channel/v1${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${CELL_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Json };
}

/** Sam writes in the DM with his personal bot; returns the delivered event id (its turn). */
async function freshTurn(text = "look something up"): Promise<string> {
  const msg = await ok(sam.request("POST", `/api/v1/conversations/${samDmId}/messages`, { body: text }));
  const rows = (
    await su.query(
      "select payload from app.stream_events where stream_id = $1 and type = 'agent.mention.v1' and payload->'message'->>'id' = $2",
      [`cell:${orgId}`, msg.id],
    )
  ).rows;
  expect(rows).toHaveLength(1);
  return rows[0].payload.eventId as string;
}

const ask = (eventId: string, tool: string, params: Json = {}, agentId = samBotId) =>
  cell("/tool-calls", { eventId, agentId, tool, params });

/** Superuser-inserted permission rule; returns its removal. */
async function rule(
  effect: "allow" | "deny",
  subjectKind: "user" | "agent",
  subjectId: string,
  permission: string,
) {
  const id = randomUUID();
  await su.query(
    `insert into app.permission_rules (id, organization_id, subject_kind, subject_id, permission, effect)
     values ($1, $2, $3, $4, $5, $6)`,
    [id, orgId, subjectKind, subjectId, permission, effect],
  );
  return async () => {
    await su.query("delete from app.permission_rules where id = $1", [id]);
  };
}

const audits = async (action: string) =>
  (
    await su.query(
      "select actor_kind, actor_id, agent_id, user_id, resource_type, resource_id, result, metadata from app.audit_events where action = $1 and organization_id = $2 order by occurred_at",
      [action, orgId],
    )
  ).rows as Json[];

beforeAll(async () => {
  stack = await startTestStack({ env: { OCW_CELL_TOKEN: CELL_TOKEN, OCW_MODEL_PROVIDER: "mock" } });
  su = new pg.Client({ connectionString: stack.db.superuserUrl });
  await su.connect();
  admin = new TestClient(stack.baseUrl);
  const setup = await ok(
    admin.request("POST", "/api/v1/setup", {
      token: TEST_SETUP_TOKEN,
      name: "Víctor Ruiz",
      email: "victor@example.test",
      password: "correct-horse-battery",
      orgName: "Autofy Labs",
    }),
  );
  orgId = setup.organization.id;
  const inv = await ok(
    admin.request("POST", "/api/v1/invitations", { email: "sam@example.test", role: "developer" }),
  );
  sam = new TestClient(stack.baseUrl);
  const acc = await ok(
    sam.request("POST", `/api/v1/invitations/${inv.id}/accept`, {
      name: "Sam Lee",
      password: "another-long-password",
    }),
  );
  samId = acc.user.id;
  const personal = await ok(sam.request("POST", "/api/v1/agents/personal", {}));
  samBotId = personal.agent.id;
  samDmId = personal.dmId;
  await ok(sam.request("PATCH", `/api/v1/agents/${samBotId}/capabilities`, { internet: true }));
}, 180_000);

afterAll(async () => {
  await su?.end();
  await stack?.stop();
});

describe("POST /agent-channel/v1/tool-calls (D-08)", () => {
  it("allows an internet call on a delivered DM turn, records it and audits bot, human, tool and provider host", async () => {
    const eventId = await freshTurn();
    const r = await ask(eventId, "web_search", { query: QUERY });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ callId: expect.any(String), allowed: true, reason: null });

    const row = (await su.query("select * from app.agent_tool_calls where id = $1", [r.body.callId])).rows[0];
    expect(row).toMatchObject({
      organization_id: orgId,
      event_id: eventId,
      agent_id: samBotId,
      user_id: samId,
      tool: "web_search",
      source_kind: "builtin",
      target: "duckduckgo.com",
      decision: "allowed",
      reason: null,
    });
    const turn = (await su.query("select * from app.agent_turns where event_id = $1", [eventId])).rows[0];
    expect(turn).toMatchObject({ tool_calls: 1, web_calls: 1, tainted: true });

    const audit = (await audits("bot.tool_call")).at(-1);
    expect(audit).toMatchObject({
      actor_kind: "agent",
      actor_id: samBotId,
      agent_id: samBotId,
      user_id: samId,
      resource_type: "tool",
      resource_id: "web_search",
      result: "success",
    });
    expect(audit?.metadata).toMatchObject({
      tool: "web_search",
      sourceKind: "builtin",
      target: "duckduckgo.com",
      queryChars: QUERY.length,
    });
  });

  it("the reported outcome is stored and audited as bot.tool_call.completed (no content)", async () => {
    const eventId = await freshTurn();
    const { body } = await ask(eventId, "web_search", { query: QUERY });
    const done = await cell(`/tool-calls/${body.callId}/result`, {
      status: "ok",
      resultCount: 3,
      provider: "duckduckgo",
      durationMs: 120,
    });
    expect(done.status).toBe(200);
    const row = (await su.query("select * from app.agent_tool_calls where id = $1", [body.callId])).rows[0];
    expect(row).toMatchObject({ status: "ok", result_count: 3, duration_ms: 120 });
    expect(row.completed_at).not.toBeNull();
    const audit = (await audits("bot.tool_call.completed")).at(-1);
    expect(audit).toMatchObject({
      actor_kind: "agent",
      agent_id: samBotId,
      user_id: samId,
      result: "success",
    });
    expect(audit?.metadata).toEqual({
      tool: "web_search",
      status: "ok",
      resultCount: 3,
      provider: "duckduckgo",
      finalHost: null,
      durationMs: 120,
    });
    // Unknown call ids are refused.
    expect((await cell(`/tool-calls/${randomUUID()}/result`, { status: "ok", durationMs: 1 })).status).toBe(
      404,
    );
  });

  it("refuses a tool that is not in the delivered turn", async () => {
    const eventId = await freshTurn();
    const r = await ask(eventId, "exec", {});
    expect(r.body).toMatchObject({ allowed: false, reason: "not_in_turn" });
    const audit = (await audits("bot.tool_call")).at(-1);
    expect(audit).toMatchObject({ result: "denied", agent_id: samBotId, user_id: samId });
    expect(audit?.metadata).toMatchObject({ tool: "exec", reason: "not_in_turn" });
  });

  it("refuses an unknown event id, or an event of another bot", async () => {
    expect((await ask(randomUUID(), "web_search", { query: "x" })).body).toMatchObject({
      allowed: false,
      reason: "unknown_turn",
    });
    const eventId = await freshTurn();
    expect((await ask(eventId, "web_search", { query: "x" }, randomUUID())).body).toMatchObject({
      allowed: false,
      reason: "unknown_turn",
    });
  });

  it("web_fetch audits only the host, never the path or the query string", async () => {
    const eventId = await freshTurn();
    const r = await ask(eventId, "web_fetch", { url: "https://docs.example.com/a?b=secret-token" });
    expect(r.body).toMatchObject({ allowed: true });
    const row = (await su.query("select target from app.agent_tool_calls where id = $1", [r.body.callId]))
      .rows[0];
    expect(row.target).toBe("docs.example.com");
    const audit = (await audits("bot.tool_call")).at(-1);
    expect(audit?.metadata.target).toBe("docs.example.com");
    expect(JSON.stringify(audit)).not.toContain("secret-token");
    expect(JSON.stringify(audit)).not.toContain("/a");

    expect((await ask(eventId, "web_fetch", { url: "file:///etc/passwd" })).body).toMatchObject({
      allowed: false,
      reason: "bad_url",
    });
  });

  it("requires the cell token", async () => {
    const res = await fetch(`${stack.baseUrl}/agent-channel/v1/tool-calls`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ eventId: randomUUID(), agentId: samBotId, tool: "web_search", params: {} }),
    });
    expect(res.status).toBe(401);
  });
});

describe("the gate holds under abuse (Task 3)", () => {
  it("a deny rule created after delivery bites on the next call: policy_changed (re-decided at call time)", async () => {
    const eventId = await freshTurn();
    expect((await ask(eventId, "web_search", { query: "x" })).body.allowed).toBe(true);
    const drop = await rule("deny", "user", samId, "bot.internet");
    try {
      expect((await ask(eventId, "web_search", { query: "x" })).body).toMatchObject({
        allowed: false,
        reason: "policy_changed",
      });
    } finally {
      await drop();
    }
    // The rule is gone: the same turn may search again.
    expect((await ask(eventId, "web_search", { query: "x" })).body.allowed).toBe(true);
  });

  it("an org policy that denies internet to personal bots after delivery: policy_changed", async () => {
    const eventId = await freshTurn();
    await ok(
      admin.request("PUT", "/api/v1/bot-policy", {
        capabilities: { internet: { orgWide: true, personal: false } },
      }),
    );
    try {
      expect((await ask(eventId, "web_fetch", { url: "https://a.example/" })).body).toMatchObject({
        allowed: false,
        reason: "policy_changed",
      });
    } finally {
      await ok(
        admin.request("PUT", "/api/v1/bot-policy", {
          capabilities: { internet: { orgWide: true, personal: true } },
        }),
      );
    }
  });

  it("6 concurrent web_search calls on one turn: exactly 5 allowed (atomic caps)", async () => {
    const eventId = await freshTurn();
    const results = await Promise.all(
      Array.from({ length: 6 }, () => ask(eventId, "web_search", { query: "x" })),
    );
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200, 200]);
    expect(results.filter((r) => r.body.allowed)).toHaveLength(5);
    expect(results.filter((r) => !r.body.allowed).map((r) => r.body.reason)).toEqual(["cap_reached"]);
    const turn = (
      await su.query("select tool_calls, web_calls from app.agent_turns where event_id = $1", [eventId])
    ).rows[0];
    expect(turn).toEqual({ tool_calls: 5, web_calls: 5 });
  });

  it("after an allowed web_search, a memory save on the same turn is refused: tainted", async () => {
    const eventId = await freshTurn();
    // Before any untrusted content, the memory tool is fine.
    expect((await ask(eventId, "ocw_memory_save")).body.allowed).toBe(true);
    expect((await ask(eventId, "web_search", { query: "x" })).body.allowed).toBe(true);
    expect((await ask(eventId, "ocw_memory_save")).body).toMatchObject({ allowed: false, reason: "tainted" });
  });

  it("after a taint, ocw_memory_read and ocw_memory_propose stay allowed and ocw_memory_write is refused (07.2-11)", async () => {
    const eventId = await freshTurn();
    expect((await ask(eventId, "web_search", { query: "x" })).body.allowed).toBe(true);
    // Reads change nothing and a proposal is approved by a person (flagged as tainted): both stay usable.
    expect((await ask(eventId, "ocw_memory_read")).body).toMatchObject({ allowed: true, reason: null });
    expect((await ask(eventId, "ocw_memory_list")).body).toMatchObject({ allowed: true, reason: null });
    expect((await ask(eventId, "ocw_memory_propose")).body).toMatchObject({ allowed: true, reason: null });
    expect((await ask(eventId, "ocw_memory_write")).body).toMatchObject({
      allowed: false,
      reason: "tainted",
    });
  });

  it("an event id of another organization's turn is unknown here (RLS): unknown_turn", async () => {
    const otherOrg = randomUUID();
    const otherEvent = randomUUID();
    await su.query("insert into auth.organization (id, name, slug) values ($1, 'Other Org', $2)", [
      otherOrg,
      `other-${otherOrg.slice(0, 8)}`,
    ]);
    await su.query(
      `insert into app.agent_turns (event_id, organization_id, agent_id, user_id, conversation_id, conversation_kind, message_id, tools)
       values ($1, $2, $3, $4, $5, 'dm', $6, $7)`,
      [otherEvent, otherOrg, samBotId, samId, randomUUID(), randomUUID(), ["web_search"]],
    );
    expect((await ask(otherEvent, "web_search", { query: "x" })).body).toMatchObject({
      allowed: false,
      reason: "unknown_turn",
    });
    const row = (await su.query("select tool_calls from app.agent_turns where event_id = $1", [otherEvent]))
      .rows[0];
    expect(row.tool_calls).toBe(0);
  });

  it("no audit row ever contains the query text or a fetched URL path", async () => {
    const rows = (
      await su.query("select metadata::text as m from app.audit_events where organization_id = $1", [orgId])
    ).rows as Array<{ m: string }>;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.m).not.toContain(QUERY);
      expect(r.m).not.toContain("secret-token");
    }
  });
});
