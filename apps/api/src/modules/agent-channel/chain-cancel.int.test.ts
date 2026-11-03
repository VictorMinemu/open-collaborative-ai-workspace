import { randomUUID } from "node:crypto";
import { AgentChainCancelResponse } from "@ocw/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sha256Hex } from "../../lib/crypto";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";
import { invite } from "../../testing-workzone";

/**
 * 07.7-06 Task 3 (A2A-02, A2A-03; D-02, D-04, P-05, P-14): Stop. Víctor Ruiz (admin) asks Archie, Archie consults Bea;
 * Víctor stops the chain: the hop is cancelled, the chip updates, Bea's late answer still posts but wakes nobody, and a
 * new consult in the chain is `chain_closed`. Ada (a second admin, a moderator of #ops) may stop it too; Sam (a member)
 * may not; a reader of nothing gets 404, and so does organization B (Eve). Route-level visibility: Opsy, a unit persona
 * of Ops, is neither offered to nor consultable for Sam (not in Ops), and is for Pat (a member of Ops).
 */

const CELL_TOKEN = "ocw-test-cell-token-chain-cancel-0123456789";
const QUESTION = "Is the pump order confirmed?";

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
type Json = Record<string, any>;
type Res = { status: number; body: Record<string, unknown> | null };

let stack: TestStack;
let su: pg.Client;
let victor: TestClient;
let ada: TestClient;
let sam: TestClient;
let pat: TestClient;
let eve: TestClient;
let orgId: string;
let victorId: string;
let archieId: string;
let beaId: string;
let opsyId: string;
let opsId: string;
let floorId: string;
let tokenB: string;
let orgBEventId: string;

async function ok(res: Promise<Res> | Res, status = 200): Promise<Json> {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return (r.body ?? {}) as Json;
}

async function cell(
  path: string,
  body: unknown,
  token = CELL_TOKEN,
): Promise<{ status: number; body: Json }> {
  const res = await fetch(`${stack.baseUrl}/agent-channel/v1${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as Json };
}

const rows = async (sql: string, args: unknown[] = []) => (await su.query(sql, args)).rows as Json[];
const errorCode = (r: { body: Record<string, unknown> | null }) =>
  (r.body as { error?: { code?: string } } | null)?.error?.code;

const consult = (ev: Json, target: string, key = `${ev.eventId}:consult:0`) =>
  cell("/consultations", {
    eventId: ev.eventId,
    agentId: ev.agent.id,
    target,
    question: QUESTION,
    idempotencyKey: key,
  });

const post = (ev: Json, text: string) =>
  cell("/messages", {
    agentId: ev.agent.id,
    conversationId: ev.conversation.id,
    threadRootMessageId: ev.thread.rootMessageId,
    inReplyToMessageId: ev.message.id,
    eventId: ev.eventId,
    text,
    idempotencyKey: `evt:${ev.eventId}`,
  });

const done = (ev: Json, token = CELL_TOKEN) =>
  cell(`/turns/${ev.eventId}/done`, { agentId: ev.agent.id, outcome: "replied" }, token);

const cancel = (as: TestClient, chainId: string) =>
  as.request("POST", `/api/v1/agent-chains/${chainId}/cancel`);

async function deliveryOn(messageId: string, agentId: string): Promise<Json> {
  const [ev] = await rows(
    `select payload from app.stream_events where stream_id = $1 and type = 'agent.mention.v1'
       and payload->'message'->>'id' = $2 and payload->'agent'->>'id' = $3 order by seq`,
    [`cell:${orgId}`, messageId, agentId],
  );
  if (!ev) throw new Error(`no delivery for ${agentId} on ${messageId}`);
  return ev.payload as Json;
}

const repliesFor = async (hopId: string) =>
  rows(
    `select payload from app.stream_events where stream_id = $1 and type = 'agent.consult_reply.v1'
       and payload->'consultReply'->>'hopId' = $2`,
    [`cell:${orgId}`, hopId],
  );

const cancelledAudits = async (chainId: string) =>
  (
    await rows(
      "select actor_kind, actor_id, user_id, result, metadata from app.audit_events where action = 'agent.chain.cancelled' and organization_id = $1",
      [orgId],
    )
  ).filter((a) => a.metadata.chainId === chainId);

/** `as` asks Archie in a fresh thread of `conversationId`; Archie's turn. */
async function archieTurn(as: TestClient = victor, conversationId = opsId): Promise<Json> {
  await su.query("delete from app.agent_usage_daily");
  const root = await ok(
    as.request("POST", `/api/v1/conversations/${conversationId}/messages`, {
      body: `Pumps ${randomUUID().slice(0, 6)}`,
    }),
  );
  const msg = await ok(
    as.request("POST", `/api/v1/conversations/${conversationId}/messages`, {
      body: "@archie can you check the pump order?",
      mentions: [{ kind: "agent", id: archieId }],
      threadRootId: root.id,
    }),
  );
  return deliveryOn(msg.id as string, archieId);
}

/** Víctor asks Archie in #ops (or `conversationId`), Archie consults Bea: the hop and Bea's question turn. */
async function pending(conversationId = opsId) {
  const archie = await archieTurn(victor, conversationId);
  const hop = await ok(consult(archie, beaId));
  return { archie, hop, bea: await deliveryOn(hop.questionMessageId as string, beaId) };
}

async function insertBot(name: string, unitId: string | null = null): Promise<string> {
  return (
    await su.query(
      `insert into app.agents (organization_id, name, username, instructions, model_provider, model_id, status, unit_id)
       values ($1, $2, $3, $4, 'mock', 'mock-1', 'ready', $5) returning id`,
      [orgId, name, name.toLowerCase(), `You are ${name}.`, unitId],
    )
  ).rows[0].id as string;
}

async function channel(name: string, botIds: string[], visibility: "public" | "private" = "public") {
  const id = (await ok(victor.request("POST", "/api/v1/channels", { name, visibility }))).id as string;
  for (const botId of botIds) {
    await ok(victor.request("POST", `/api/v1/channels/${id}/members`, { kind: "agent", id: botId }));
  }
  return id;
}

beforeAll(async () => {
  stack = await startTestStack({ env: { OCW_CELL_TOKEN: CELL_TOKEN, OCW_MODEL_PROVIDER: "mock" } });
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
  ({ client: ada } = await invite(stack, victor, "ada@example.test", "Ada Admin", "admin"));
  ({ client: sam } = await invite(stack, victor, "sam@example.test", "Sam Lee", "standard"));
  let patId: string;
  ({ client: pat, userId: patId } = await invite(stack, victor, "pat@example.test", "Pat Ops", "standard"));
  let eveId: string;
  ({ client: eve, userId: eveId } = await invite(stack, victor, "eve@example.test", "Eve Black", "standard"));

  const unitId = (
    await ok(victor.request("POST", "/api/v1/units", { kind: "department", name: "Ops", parentId: null }))
  ).id as string;
  await ok(victor.request("POST", `/api/v1/units/${unitId}/members`, { userId: patId }));

  archieId = await insertBot("Archie");
  beaId = await insertBot("Bea");
  opsyId = await insertBot("Opsy", unitId);
  opsId = await channel("ops", [archieId, beaId]);
  floorId = await channel("floor", [archieId, beaId, opsyId]);
  for (const c of [ada, sam, pat]) {
    await ok(c.request("POST", `/api/v1/channels/${opsId}/join`));
    await ok(c.request("POST", `/api/v1/channels/${floorId}/join`));
  }
  await ok(victor.request("PUT", "/api/v1/agent-messaging", { enabled: true }));

  // Organization B: Eve moves into her own organization as its admin; its cell token and one delivered turn.
  const orgB = randomUUID();
  await su.query("insert into auth.organization (id, name, slug) values ($1, 'Evil', $2)", [
    orgB,
    `evil-${orgB}`,
  ]);
  await su.query("delete from auth.member where user_id = $1", [eveId]);
  await su.query("delete from app.org_members where user_id = $1", [eveId]);
  await su.query("insert into auth.member (organization_id, user_id, role) values ($1, $2, 'owner')", [
    orgB,
    eveId,
  ]);
  await su.query(
    "insert into app.org_members (organization_id, user_id, display_name, role) values ($1, $2, 'Eve', 'admin')",
    [orgB, eveId],
  );
  await su.query("update auth.session set active_organization_id = $1 where user_id = $2", [orgB, eveId]);
  expect((await ok(eve.request("GET", "/api/v1/me/permissions"))).role).toBe("admin");
  tokenB = `ocw_cell_${randomUUID()}${randomUUID()}`;
  await su.query(
    "insert into app.agent_credentials (organization_id, kind, token_hash) values ($1, 'channel_plugin', $2)",
    [orgB, sha256Hex(tokenB)],
  );
  const mallory = (
    await su.query(
      `insert into app.agents (organization_id, name, username, instructions, model_provider, model_id, status)
       values ($1, 'Mallory', 'mallory', 'x', 'mock', 'mock-1', 'ready') returning id`,
      [orgB],
    )
  ).rows[0].id as string;
  orgBEventId = randomUUID();
  await su.query(
    `insert into app.agent_turns (event_id, organization_id, agent_id, user_id, conversation_id, conversation_kind, message_id)
     values ($1, $2, $3, $4, $5, 'channel', $6)`,
    [orgBEventId, orgB, mallory, eveId, randomUUID(), randomUUID()],
  );
}, 240_000);

afterAll(async () => {
  await su?.end();
  await stack?.stop();
});

describe("Stop by the chain's human (P-14)", () => {
  let archie: Json;
  let hop: Json;
  let bea: Json;

  it("Víctor stops the chain: 200 cancelled, the hop cancelled, the chip updated, audited once", async () => {
    ({ archie, hop, bea } = await pending());
    const r = await cancel(victor, hop.chainId);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toEqual({ chainId: hop.chainId, status: "cancelled" });
    expect(AgentChainCancelResponse.safeParse(r.body).success).toBe(true);
    const [chain] = await rows("select * from app.agent_chains where id = $1", [hop.chainId]);
    expect(chain).toMatchObject({
      status: "cancelled",
      cancel_reason: "user",
      cancelled_by_user_id: victorId,
      closed_at: expect.any(Date),
    });
    expect((await rows("select status from app.agent_chain_hops where id = $1", [hop.hopId]))[0]).toEqual({
      status: "cancelled",
    });
    const [updated] = await rows(
      `select payload from app.stream_events where stream_id = $1 and type = 'message.updated'
         and payload->'message'->>'id' = $2 order by seq desc limit 1`,
      [`conv:${opsId}`, hop.questionMessageId],
    );
    expect(updated?.payload.message.consult).toMatchObject({ status: "cancelled", hopId: hop.hopId });
    const audited = await cancelledAudits(hop.chainId);
    expect(audited).toHaveLength(1);
    expect(audited[0]).toMatchObject({
      actor_kind: "user",
      actor_id: victorId,
      user_id: victorId,
      result: "success",
      metadata: { chainId: hop.chainId, reason: "user", cancelledHops: 1 },
    });
  });

  it("Bea's late answer still posts (visible), but her done delivers nothing", async () => {
    const answer = await post(bea, "PO-1187 is confirmed.");
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    expect(answer.body.created).toBe(true);
    expect((await done(bea)).status).toBe(200);
    expect(
      (await rows("select status from app.agent_chain_hops where id = $1", [hop.hopId]))[0]?.status,
    ).toBe("cancelled");
    expect(await repliesFor(hop.hopId)).toHaveLength(0);
  });

  it("a new consult from Archie's turn is 409 chain_closed; a second Stop is 200 with no new audit", async () => {
    const again = await consult(archie, beaId, `${archie.eventId}:consult:1`);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("chain_closed");
    const second = await cancel(victor, hop.chainId);
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ chainId: hop.chainId, status: "cancelled" });
    expect(await cancelledAudits(hop.chainId)).toHaveLength(1);
  });
});

describe("Stop authority and tenancy (T-07.7-06-04, T-07.7-06-06)", () => {
  it("Ada, an admin who moderates #ops, may stop Víctor's chain", async () => {
    const { hop } = await pending();
    const r = await cancel(ada, hop.chainId);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body?.status).toBe("cancelled");
  });

  it("Sam, a member who reads the thread but is not the chain's human, is refused 403 not_chain_owner", async () => {
    const { hop } = await pending();
    const r = await cancel(sam, hop.chainId);
    expect(r.status).toBe(403);
    expect(errorCode(r)).toBe("not_chain_owner");
    expect((await rows("select status from app.agent_chains where id = $1", [hop.chainId]))[0]?.status).toBe(
      "active",
    );
    expect(await cancelledAudits(hop.chainId)).toHaveLength(0);
  });

  it("a chain in a private channel Sam cannot read is 404 chain_not_found, like a chain that does not exist", async () => {
    const privId = await channel(`priv-${randomUUID().slice(0, 6)}`, [archieId, beaId], "private");
    const { hop } = await pending(privId);
    const hidden = await cancel(sam, hop.chainId);
    expect(hidden.status).toBe(404);
    expect(errorCode(hidden)).toBe("chain_not_found");
    const missing = await cancel(sam, randomUUID());
    expect(missing.status).toBe(404);
    expect(errorCode(missing)).toBe("chain_not_found");
    expect((await rows("select status from app.agent_chains where id = $1", [hop.chainId]))[0]?.status).toBe(
      "active",
    );
  });

  it("organization B's admin with organization A's chain id gets 404; org B's cell cannot report org A's turns", async () => {
    const { hop, bea } = await pending();
    const r = await cancel(eve, hop.chainId);
    expect(r.status).toBe(404);
    expect(errorCode(r)).toBe("chain_not_found");
    expect((await done(bea, tokenB)).status).toBe(404);
    // Org A's cell token reporting org B's event: unknown here.
    const foreign = await cell(`/turns/${orgBEventId}/done`, { agentId: archieId, outcome: "replied" });
    expect(foreign.status).toBe(404);
    expect((await rows("select status from app.agent_chains where id = $1", [hop.chainId]))[0]?.status).toBe(
      "active",
    );
  });

  it("an anonymous call is 401", async () => {
    const { hop } = await pending();
    const r = await cancel(new TestClient(stack.baseUrl), hop.chainId);
    expect(r.status).toBe(401);
  });
});

describe("target visibility at the route (D-02, P-05; 07.7-03's unit_agent precondition)", () => {
  it("Sam (not in Ops) asks Archie: Opsy is not offered, and a forced consult is 403 not_allowed", async () => {
    const archie = await archieTurn(sam, floorId);
    // Bea (an organization bot) is offered, so the turn has the tool; Opsy is hidden from Sam.
    expect(archie.turn.consult?.targets.map((t: Json) => t.id)).toEqual([beaId]);
    const forced = await consult(archie, opsyId);
    expect(forced.status).toBe(403);
    expect(forced.body.code).toBe("not_allowed");
    expect(
      await rows("select id from app.agent_chain_hops where source_event_id = $1", [archie.eventId]),
    ).toEqual([]);
  });

  it("Pat (a member of Ops) asks Archie: Opsy is offered and the consult is sent", async () => {
    const archie = await archieTurn(pat, floorId);
    expect(archie.turn.consult?.targets.map((t: Json) => t.id)).toContain(opsyId);
    const r = await consult(archie, opsyId);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.ok).toBe(true);
    const opsy = await deliveryOn(r.body.questionMessageId as string, opsyId);
    expect(opsy.origin.onBehalfOf.displayName).toBe("Pat Ops");
    // Sam stopping Pat's chain is refused; it is Pat's.
    expect((await cancel(sam, r.body.chainId as string)).status).toBe(403);
    expect((await cancel(pat, r.body.chainId as string)).status).toBe(200);
  });
});
