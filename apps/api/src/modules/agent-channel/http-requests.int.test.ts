import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFakeMcpOAuth } from "../../../../../infra/fake-model/fake-mcp-oauth.mjs";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";

/**
 * 07.4-11 (D-04, D-06, D-07; CONN-05, SC3): the keychain proxy `POST /agent-channel/v1/http-requests`. A bot sends a
 * request with a key named by its handle; the API resolves the key for the turn's bot acting for the turn's human (never
 * a body field), injects it towards an allowed host only through the egress guard, redacts it from the answer and audits
 * `secret.used` without the value, the path or the query. The /kc targets of the fake OAuth server (07.4-04) run
 * in-process on loopback as the test host `fake-kc`. Real PostgreSQL + Redis; no real provider.
 */

const CELL_TOKEN = "ocw-test-cell-token-http-requests-0123456789ab";
const KC_TOKEN = "fake-kc-token";

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
type Json = Record<string, any>;
type Res = { status: number; body: Json | null };

let stack: TestStack;
let su: pg.Client;
let fake: Server;
let kcHost = "";
/** Every request the fake received: method and path (the query is kept for the canary checks). */
const hits: Array<{ method: string; path: string }> = [];

let victor: TestClient;
let orgId = "";
let victorId = "";
let victorBot = "";
let victorDm = "";

async function ok(res: Promise<Res>, status = 200): Promise<Json> {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as Json;
}

async function cell(path: string, body: unknown, token = CELL_TOKEN): Promise<Res> {
  const res = await fetch(`${stack.baseUrl}/agent-channel/v1${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Json };
}

/** `who` writes in `conversationId`; returns the delivered event of `agentId` (its turn). */
async function turnOf(who: TestClient, conversationId: string, agentId: string, text: string): Promise<Json> {
  const msg = await ok(
    who.request("POST", `/api/v1/conversations/${conversationId}/messages`, { body: text }),
  );
  const rows = (
    await su.query(
      "select payload from app.stream_events where stream_id = $1 and type = 'agent.mention.v1' and payload->'message'->>'id' = $2 and payload->'agent'->>'id' = $3",
      [`cell:${orgId}`, msg.id, agentId],
    )
  ).rows;
  expect(rows).toHaveLength(1);
  return rows[0].payload as Json;
}

const audits = async (action: string) =>
  (
    await su.query(
      "select actor_kind, actor_id, agent_id, user_id, resource_type, resource_id, result, metadata from app.audit_events where action = $1 and organization_id = $2 order by occurred_at",
      [action, orgId],
    )
  ).rows as Json[];

beforeAll(async () => {
  const oauth = createFakeMcpOAuth({ kcToken: KC_TOKEN });
  fake = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://fake-kc");
    hits.push({ method: req.method ?? "GET", path: `${url.pathname}${url.search}` });
    if (!oauth.handle(req, res, url)) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
  kcHost = `fake-kc:${(fake.address() as AddressInfo).port}`;

  stack = await startTestStack({
    env: {
      OCW_CELL_TOKEN: CELL_TOKEN,
      OCW_MODEL_PROVIDER: "mock",
      OCW_EGRESS_TEST_HOSTS: "fake-kc=127.0.0.1",
    },
  });
  su = new pg.Client({ connectionString: stack.db.superuserUrl });
  await su.connect();
  victor = new TestClient(stack.baseUrl);
  const setup = await ok(
    victor.request("POST", "/api/v1/setup", {
      token: TEST_SETUP_TOKEN,
      name: "Víctor Ruiz",
      email: "victor@example.test",
      password: "correct-horse-battery",
      orgName: "Autofy Labs",
    }),
  );
  orgId = setup.organization.id;
  victorId = setup.user.id;
  const personal = await ok(victor.request("POST", "/api/v1/agents/personal", {}));
  victorBot = personal.agent.id;
  victorDm = personal.dmId;
}, 240_000);

afterAll(async () => {
  await su?.end();
  await stack?.stop();
  await new Promise<void>((resolve) => (fake ? fake.close(() => resolve()) : resolve()));
});

// ---------------------------------------------------------------- Task 1 (tracer)

describe("tracer: Víctor's bot uses his key by handle in their DM, without ever seeing it", () => {
  let key: Json;
  let ev: Json;
  let answer: Res;

  it("a DM turn offers ocw_http_request once the owner grants his personal key to his bot", async () => {
    key = await ok(
      victor.request("POST", "/api/v1/keychain", {
        scope: "personal",
        kind: "api_key",
        name: "KC whoami",
        value: KC_TOKEN,
        allowedHosts: [kcHost],
      }),
      201,
    );
    await ok(victor.request("PUT", `/api/v1/keychain/${key.id}/agents`, { agentIds: [victorBot] }));
    ev = await turnOf(victor, victorDm, victorBot, "who am I on the CRM?");
    expect(ev.turn.tools).toEqual(expect.arrayContaining(["ocw_http_request", "ocw_connector_list"]));
    expect(ev.turn.toolFlags.ocw_http_request).toEqual({ untrustedOutput: true, sideEffecting: true });
    expect(JSON.stringify(ev)).not.toContain(KC_TOKEN);
  });

  it("POST /http-requests resolves the key for the turn's human, injects it through the guard and answers", async () => {
    answer = await cell("/http-requests", {
      eventId: ev.eventId,
      agentId: victorBot,
      handle: key.handle,
      method: "GET",
      url: `http://${kcHost}/kc/whoami`,
    });
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    expect(answer.body).toMatchObject({ status: 200, redirectHost: null, truncated: false });
    expect(JSON.parse(answer.body?.body as string)).toEqual({ authorized: true, method: "bearer" });
    expect(JSON.stringify(answer.body)).not.toContain(KC_TOKEN);
  });

  it("records one allowed vault call and audits secret.used with ids, host and sizes, never value, path or query", async () => {
    const calls = (
      await su.query("select * from app.agent_tool_calls where event_id = $1 order by created_at", [
        ev.eventId,
      ])
    ).rows as Json[];
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      tool: "ocw_http_request",
      source_kind: "vault",
      source_id: key.id,
      target: kcHost,
      decision: "allowed",
      reason: null,
      status: "ok",
      user_id: victorId,
      agent_id: victorBot,
    });
    const used = (await audits("secret.used")).at(-1);
    expect(used).toMatchObject({
      actor_kind: "agent",
      actor_id: victorBot,
      agent_id: victorBot,
      user_id: victorId,
      resource_type: "vault_item",
      resource_id: key.id,
      result: "success",
      metadata: {
        vaultItemId: key.id,
        handle: key.handle,
        eventId: ev.eventId,
        host: kcHost,
        method: "GET",
        status: 200,
        bytes: expect.any(Number),
        durationMs: expect.any(Number),
      },
    });
    const text = JSON.stringify(await audits("secret.used")) + JSON.stringify(await audits("bot.tool_call"));
    expect(text).not.toContain(KC_TOKEN);
    expect(text).not.toContain("/kc/whoami");
    const completed = (await audits("bot.tool_call.completed")).at(-1);
    expect(completed).toMatchObject({
      result: "success",
      metadata: { tool: "ocw_http_request", status: "ok" },
    });
    expect(JSON.stringify(completed)).not.toContain("/kc/");
  });

  it("the turn is tainted afterwards (the answer is third-party content)", async () => {
    const turn = (
      await su.query("select tainted, tool_calls from app.agent_turns where event_id = $1", [ev.eventId])
    ).rows[0];
    expect(turn).toEqual({ tainted: true, tool_calls: 1 });
  });

  it("the authz registry declares the route as a cell route", () => {
    expect(stack.built.authz.routes.get("POST /agent-channel/v1/http-requests")).toBe("cell");
  });
});
