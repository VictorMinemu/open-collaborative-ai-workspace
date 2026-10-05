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
