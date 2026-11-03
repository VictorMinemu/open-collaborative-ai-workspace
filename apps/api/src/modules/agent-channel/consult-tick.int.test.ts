import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sha256Hex } from "../../lib/crypto";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";
import { invite } from "../../testing-workzone";
import { createPermissionService } from "../organization";
import { sweepConsults } from "./consult-tick";

/**
 * 07.7-09 (A2A-03; D-03, D-04, D-06, D-11; P-10, P-15; C-02): a hop nobody answers ends by itself. The `consult.tick`
 * (07.6's job runtime, one minute, UTC) finds hops past their deadline through the ids-only function and times each out
 * inside its own organization as the chain's human: the asker hears "@bea did not answer in time." as a new turn and may
 * tell the human. Exactly one outcome per hop under races (a done, a second replica), across organizations, nested
 * deadlines in order, and orphaned chains (thread root deleted, human gone) cancelled `auto` at their next touch. The
 * clock is injected; nothing sleeps for minutes. Real PostgreSQL + Redis + pg-boss, the fake cell's calls only.
 */

const CELL_TOKEN = "ocw-test-cell-token-consult-tick-0123456789";
const QUESTION = "Is the pump order confirmed?";
const ANSWER = "Yes, confirmed on Monday.";

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
type Json = Record<string, any>;
type Res = { status: number; body: Record<string, unknown> | null };

let stack: TestStack;
let su: pg.Client;
let victor: TestClient;
let sam: TestClient;
let eve: TestClient;
let orgId: string;
let orgB: string;
let victorId: string;
let samId: string;
let eveId: string;
let archieId: string;
let beaId: string;
let carlId: string;
let opsId: string;
let tokenB: string;
let maxId: string;
let nellId: string;
let labId: string;

const core = () => stack.built.core;
const deps = () => ({ perms: createPermissionService(core()), memory: stack.built.memory });
const sweep = (now: Date, batch?: number) => sweepConsults(core(), deps(), now, batch);

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

const consult = (ev: Json, target: string, over: Json = {}, token = CELL_TOKEN) =>
  cell(
    "/consultations",
    {
      eventId: ev.eventId,
      agentId: ev.agent.id,
      target,
      question: QUESTION,
      idempotencyKey: `${ev.eventId}:consult:${target}`,
      ...over,
    },
    token,
  );

/** A bot's post for a delivered turn (what the bridge sends): in the turn's thread, with its event id. */
const post = (ev: Json, text: string, token = CELL_TOKEN) =>
  cell(
    "/messages",
    {
      agentId: ev.agent.id,
      conversationId: ev.conversation.id,
      threadRootMessageId: ev.thread.rootMessageId,
      inReplyToMessageId: ev.message.id,
      eventId: ev.eventId,
      text,
      idempotencyKey: `evt:${ev.eventId}`,
    },
    token,
  );

const done = (ev: Json, outcome: "replied" | "failed" = "replied", token = CELL_TOKEN) =>
  cell(`/turns/${ev.eventId}/done`, { agentId: ev.agent.id, outcome }, token);

/** Cell events of one type on one organization's cell topic (oldest first). */
const cellEvents = (type: string, org = orgId) =>
  rows("select payload from app.stream_events where stream_id = $1 and type = $2 order by seq", [
    `cell:${org}`,
    type,
  ]).then((r) => r.map((x) => x.payload as Json));

/** Every consult reply for one hop, on any organization's cell topic. */
const repliesFor = async (hopId: string) =>
  rows(
    `select stream_id, payload from app.stream_events where type = 'agent.consult_reply.v1'
       and payload->'consultReply'->>'hopId' = $1 order by seq`,
    [hopId],
  );

async function deliveryOn(messageId: string, agentId: string, org = orgId): Promise<Json> {
  const [ev] = (await cellEvents("agent.mention.v1", org)).filter(
    (p) => p.message.id === messageId && p.agent.id === agentId,
  );
  if (!ev) throw new Error(`no delivery for ${agentId} on ${messageId}`);
  return ev;
}

const hopRow = async (hopId: string) =>
  (await rows("select * from app.agent_chain_hops where id = $1", [hopId]))[0] as Json;
const chainRow = async (chainId: string) =>
  (await rows("select * from app.agent_chains where id = $1", [chainId]))[0] as Json;
const turnRow = async (eventId: string) =>
  (await rows("select * from app.agent_turns where event_id = $1", [eventId]))[0] as Json;
const auditsFor = async (action: string, key: "hopId" | "chainId", id: string) =>
  (
    await rows(
      "select organization_id, actor_kind, actor_id, agent_id, user_id, result, metadata from app.audit_events where action = $1",
      [action],
    )
  ).filter((a) => a.metadata[key] === id);

/** `message.updated` frames for one message on its conversation's stream. */
const updates = (conversationId: string, messageId: string) =>
  rows(
    `select payload from app.stream_events where stream_id = $1 and type = 'message.updated'
       and payload->'message'->>'id' = $2 order by seq`,
    [`conv:${conversationId}`, messageId],
  ).then((r) => r.map((x) => x.payload.message as Json));

/** The hop's deadline (database time) as a Date. */
const deadlineOf = async (hopId: string) => new Date((await hopRow(hopId)).deadline_at as Date);
const plus = (d: Date, ms: number) => new Date(d.getTime() + ms);

/** Every hop of earlier tests is pushed a day out, so each test's sweep sees only its own hops. */
const parkOthers = () =>
  su.query("update app.agent_chain_hops set deadline_at = now() + interval '1 day' where status = 'pending'");

/** `as` mentions `botId` in a fresh thread of `conversationId`; the bot's delivered turn and the thread root. */
async function rootTurn(
  p: { as?: TestClient; conversationId?: string; botId?: string; handle?: string; org?: string } = {},
) {
  await su.query("delete from app.agent_usage_daily");
  const as = p.as ?? victor;
  const conversationId = p.conversationId ?? opsId;
  const root = await ok(
    as.request("POST", `/api/v1/conversations/${conversationId}/messages`, {
      body: `Pump order ${randomUUID().slice(0, 6)}`,
    }),
  );
  const msg = await ok(
    as.request("POST", `/api/v1/conversations/${conversationId}/messages`, {
      body: `@${p.handle ?? "archie"} can you check the pump order?`,
      mentions: [{ kind: "agent", id: p.botId ?? archieId }],
      threadRootId: root.id,
    }),
  );
  return {
    root: root.id as string,
    turn: await deliveryOn(msg.id as string, p.botId ?? archieId, p.org ?? orgId),
  };
}

/** Archie consults `target` in a fresh thread; the hop answer and the target's question turn. */
async function consulted(
  p: { as?: TestClient; conversationId?: string; target?: string; mode?: "consult" | "handoff" } = {},
) {
  const { root, turn: archie } = await rootTurn(p);
  const target = p.target ?? beaId;
  const hop = await ok(consult(archie, target, p.mode ? { mode: p.mode } : {}));
  expect(hop.ok, JSON.stringify(hop)).toBe(true);
  return { root, archie, hop, asked: await deliveryOn(hop.questionMessageId as string, target) };
}

async function insertBot(org: string, name: string): Promise<string> {
  return (
    await su.query(
      `insert into app.agents (organization_id, name, username, instructions, model_provider, model_id, status)
       values ($1, $2, $3, $4, 'mock', 'mock-1', 'ready') returning id`,
      [org, name, name.toLowerCase(), `You are ${name}.`],
    )
  ).rows[0].id as string;
}

async function channel(
  as: TestClient,
  name: string,
  botIds: string[],
  visibility: "public" | "private" = "public",
): Promise<string> {
  const id = (await ok(as.request("POST", "/api/v1/channels", { name, visibility }))).id as string;
  for (const botId of botIds) {
    await ok(as.request("POST", `/api/v1/channels/${id}/members`, { kind: "agent", id: botId }));
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
  ({ client: sam, userId: samId } = await invite(stack, victor, "sam@example.test", "Sam Lee", "standard"));
  ({ client: eve, userId: eveId } = await invite(stack, victor, "eve@example.test", "Eve Black", "standard"));

  archieId = await insertBot(orgId, "Archie");
  beaId = await insertBot(orgId, "Bea");
  carlId = await insertBot(orgId, "Carl");
  opsId = await channel(victor, "ops", [archieId, beaId, carlId]);
  await ok(sam.request("POST", `/api/v1/channels/${opsId}/join`));
  await ok(victor.request("PUT", "/api/v1/agent-messaging", { enabled: true }));

  // Organization B: Eve moves into her own organization as its admin, with its own cell token, bots and channel.
  orgB = randomUUID();
  await su.query("insert into auth.organization (id, name, slug) values ($1, 'Second', $2)", [
    orgB,
    `second-${orgB}`,
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
  maxId = await insertBot(orgB, "Max");
  nellId = await insertBot(orgB, "Nell");
  labId = await channel(eve, "lab", [maxId, nellId]);
  await ok(eve.request("PUT", "/api/v1/agent-messaging", { enabled: true }));
}, 240_000);

afterAll(async () => {
  await su?.end();
  await stack?.stop();
});

describe("an unanswered hop times out at the next tick (D-04, D-06, D-11)", () => {
  it("nothing before the deadline; after it the hop is timed_out once and Archie hears back as a new turn", async () => {
    await parkOthers();
    const { archie, hop } = await consulted();
    const deadline = await deadlineOf(hop.hopId);
    // Five minutes of database time (D-04).
    expect(deadline.getTime() - Date.now()).toBeGreaterThan(4 * 60_000);

    expect(await sweep(plus(deadline, -1000))).toEqual({ timedOut: 0, cancelled: 0 });
    expect((await hopRow(hop.hopId)).status).toBe("pending");
    expect(await repliesFor(hop.hopId)).toHaveLength(0);

    expect(await sweep(plus(deadline, 1000))).toEqual({ timedOut: 1, cancelled: 0 });
    const row = await hopRow(hop.hopId);
    expect(row.status).toBe("timed_out");
    expect(row.closed_at).toBeInstanceOf(Date);

    // Audited with ids only (never the question).
    const audits = await auditsFor("agent.consult.timed_out", "hopId", hop.hopId);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ organization_id: orgId, user_id: victorId, result: "error" });
    expect(JSON.stringify(audits[0])).not.toContain(QUESTION);

    // The question's chip says so.
    expect((await updates(archie.conversation.id, hop.questionMessageId)).at(-1)?.consult).toMatchObject({
      role: "question",
      status: "timed_out",
    });

    // Exactly one consult reply, for Archie, on the question, with the server sentence.
    const replies = await repliesFor(hop.hopId);
    expect(replies).toHaveLength(1);
    const reply = replies[0]?.payload as Json;
    expect(replies[0]?.stream_id).toBe(`cell:${orgId}`);
    expect(reply.agent.id).toBe(archieId);
    expect(reply.consultReply).toMatchObject({
      outcome: "timed_out",
      answerMessageId: null,
      hopId: hop.hopId,
    });
    expect(reply.message).toMatchObject({ id: hop.questionMessageId, text: "@bea did not answer in time." });
    const ret = await turnRow(reply.eventId);
    expect(ret).toMatchObject({
      user_id: victorId,
      agent_id: archieId,
      returning_hop_id: hop.hopId,
      chain_depth: 0,
      chain_id: hop.chainId,
    });

    // Archie tells Víctor, in reply to the question with that event id (PR #25's rule, D-06).
    const told = await post(reply, "Bea did not answer in time; I'll check the order myself.");
    expect(told.status, JSON.stringify(told.body)).toBe(200);

    // A second tick changes nothing.
    expect(await sweep(plus(deadline, 1000))).toEqual({ timedOut: 0, cancelled: 0 });
    expect(await repliesFor(hop.hopId)).toHaveLength(1);
    expect(archie.eventId).not.toBe(reply.eventId);
  });

  it("a late answer still posts, but its done delivers no second consult reply", async () => {
    await parkOthers();
    const { hop, asked } = await consulted();
    expect((await sweep(plus(await deadlineOf(hop.hopId), 1000))).timedOut).toBe(1);
    const late = await post(asked, ANSWER);
    expect(late.status, JSON.stringify(late.body)).toBe(200);
    expect((await done(asked)).status).toBe(200);
    expect((await hopRow(hop.hopId)).status).toBe("timed_out");
    expect(await repliesFor(hop.hopId)).toHaveLength(1);
  });

  it("the consult.tick worker runs the sweep: a queued tick drains once and times out an expired hop; its data is {}", async () => {
    await parkOthers();
    const { hop } = await consulted();
    await su.query(
      "update app.agent_chain_hops set deadline_at = now() - interval '1 second' where id = $1",
      [hop.hopId],
    );
    await core().db.withTenant({ organizationId: orgId, userId: null }, (tx) =>
      core().jobs.sendInTx(tx, "consult.tick", {}),
    );
    expect(await core().jobs.drain("consult.tick")).toBe(1);
    expect((await hopRow(hop.hopId)).status).toBe("timed_out");
    expect(await repliesFor(hop.hopId)).toHaveLength(1);
    const jobs = await rows("select data from pgboss.job where name = 'consult.tick'");
    expect(jobs.length).toBeGreaterThan(0);
    for (const j of jobs) expect(j.data).toEqual({});
  });
});
