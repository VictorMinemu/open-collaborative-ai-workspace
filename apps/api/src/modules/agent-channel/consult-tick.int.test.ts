import { randomUUID } from "node:crypto";
import { agentChains } from "@ocw/db";
import { eq } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sha256Hex } from "../../lib/crypto";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";
import { invite } from "../../testing-workzone";
import { createPermissionService } from "../organization";
import { chainLive } from "./chains";
import { closeIdleChains, sweepConsults } from "./consult-tick";

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
const idle = (now: Date) => closeIdleChains(core(), now);

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

describe("a lost done never strands a hop or a chain (CR-A-06)", () => {
  it("Bea posted her answer but her done was lost: the tick closes the hop answered, never timed out", async () => {
    await parkOthers();
    const { hop, asked } = await consulted();
    const posted = await ok(post(asked, ANSWER));
    expect(await sweep(plus(await deadlineOf(hop.hopId), 1000))).toEqual({ timedOut: 0, cancelled: 0 });
    expect(await hopRow(hop.hopId)).toMatchObject({
      status: "answered",
      answer_message_id: posted.messageId,
    });
    const replies = await repliesFor(hop.hopId);
    expect(replies).toHaveLength(1);
    expect(replies[0]?.payload.consultReply).toMatchObject({
      outcome: "answered",
      answerMessageId: posted.messageId,
    });
    expect(replies[0]?.payload.message).toMatchObject({ id: posted.messageId, text: ANSWER });
    expect(await auditsFor("agent.consult.answered", "hopId", hop.hopId)).toHaveLength(1);
    expect(await auditsFor("agent.consult.timed_out", "hopId", hop.hopId)).toHaveLength(0);
    // The late done changes nothing.
    await ok(done(asked));
    expect(await repliesFor(hop.hopId)).toHaveLength(1);
  });

  it("the return turn's and the first turn's done were lost: the idle sweep completes the chain, never one with a pending hop", async () => {
    await parkOthers();
    const { hop, asked } = await consulted();
    await ok(post(asked, ANSWER));
    await ok(done(asked));
    const [back] = await repliesFor(hop.hopId);
    await ok(post(back?.payload as Json, "Víctor: confirmed."));
    const { hop: waiting } = await consulted();
    const now = new Date();
    expect((await chainRow(hop.chainId)).status).toBe("active");
    await idle(plus(now, 60_000));
    expect((await chainRow(hop.chainId)).status).toBe("active");
    expect(await idle(plus(now, 11 * 60_000))).toBeGreaterThanOrEqual(1);
    expect(await chainRow(hop.chainId)).toMatchObject({ status: "completed", closed_at: expect.any(Date) });
    expect((await chainRow(waiting.chainId)).status).toBe("active");
    expect((await hopRow(waiting.hopId)).status).toBe("pending");
  });
});

describe("a hop the tick cannot close is retried with backoff, then given up (CR-A-08)", () => {
  it("a poison hop never starves a newer expired one, and ends failed tick_error after its last attempt", async () => {
    await parkOthers();
    const { hop: poison } = await consulted();
    const { hop: good } = await consulted();
    const goodDeadline = await deadlineOf(good.hopId);
    await su.query("update app.agent_chain_hops set deadline_at = $2 where id = $1", [
      poison.hopId,
      plus(goodDeadline, -60_000).toISOString(),
    ]);
    // The poison hop cannot be timed out (a broken row in production; a trigger here).
    await su.query(`create or replace function app.test_poison_hop() returns trigger language plpgsql as $$
      begin
        if new.id = '${poison.hopId}'::uuid and new.status = 'timed_out' then raise exception 'poison hop'; end if;
        return new;
      end $$`);
    await su.query(
      "create trigger test_poison_hop before update on app.agent_chain_hops for each row execute function app.test_poison_hop()",
    );
    try {
      let at = plus(goodDeadline, 1000);
      // Oldest first: the poison hop fails, and its next try moves behind the newer hop.
      expect(await sweep(at, 1)).toEqual({ timedOut: 0, cancelled: 0 });
      const once = await hopRow(poison.hopId);
      expect(once).toMatchObject({ status: "pending", tick_attempts: 1 });
      expect(new Date(once.deadline_at).getTime()).toBeGreaterThan(at.getTime());
      expect(await sweep(at, 1)).toEqual({ timedOut: 1, cancelled: 0 });
      expect((await hopRow(good.hopId)).status).toBe("timed_out");
      // Bounded: each later failure counts, and the last one ends the hop.
      for (let i = 0; i < 10 && (await hopRow(poison.hopId)).status === "pending"; i++) {
        at = plus(await deadlineOf(poison.hopId), 1000);
        await sweep(at, 1);
      }
      expect(await hopRow(poison.hopId)).toMatchObject({
        status: "failed",
        refusal_reason: "tick_error",
        tick_attempts: 5,
        closed_at: expect.any(Date),
      });
      const failed = await auditsFor("agent.consult.failed", "hopId", poison.hopId);
      expect(failed).toHaveLength(1);
      expect(failed[0]).toMatchObject({
        actor_kind: "system",
        result: "error",
        metadata: { reason: "tick_error" },
      });
    } finally {
      await su.query("drop trigger if exists test_poison_hop on app.agent_chain_hops");
      await su.query("drop function if exists app.test_poison_hop()");
    }
  });
});

describe("exactly one outcome per hop under races (D-04, D-11)", () => {
  it("a tick racing the answer's done: one final status and one consult reply", async () => {
    await parkOthers();
    const { hop, asked } = await consulted();
    expect((await post(asked, ANSWER)).status).toBe(200);
    const deadline = await deadlineOf(hop.hopId);
    const [swept, signalled] = await Promise.all([sweep(plus(deadline, 1000)), done(asked)]);
    expect(signalled.status).toBe(200);
    const status = (await hopRow(hop.hopId)).status as string;
    expect(["answered", "timed_out"]).toContain(status);
    expect(swept.timedOut).toBe(status === "timed_out" ? 1 : 0);
    const replies = await repliesFor(hop.hopId);
    expect(replies).toHaveLength(1);
    expect(replies[0]?.payload.consultReply.outcome).toBe(status);
    const closings = [
      ...(await auditsFor("agent.consult.answered", "hopId", hop.hopId)),
      ...(await auditsFor("agent.consult.timed_out", "hopId", hop.hopId)),
    ];
    expect(closings).toHaveLength(1);
  });

  it("two ticks at once (two replicas): one times the hop out, one reply in total", async () => {
    await parkOthers();
    const { hop } = await consulted();
    const at = plus(await deadlineOf(hop.hopId), 1000);
    const both = await Promise.all([sweep(at), sweep(at)]);
    expect(both.reduce((n, r) => n + r.timedOut, 0)).toBe(1);
    expect((await hopRow(hop.hopId)).status).toBe("timed_out");
    expect(await repliesFor(hop.hopId)).toHaveLength(1);
    expect(await auditsFor("agent.consult.timed_out", "hopId", hop.hopId)).toHaveLength(1);
  });
});

describe("each hop in its own organization (C-02, T-07.7-09-01)", () => {
  it("expired hops of two organizations time out in their tenants; each reply lands on its own cell; batch 1 = one per pass", async () => {
    await parkOthers();
    const a = await consulted();
    const { turn: max } = await rootTurn({
      as: eve,
      conversationId: labId,
      botId: maxId,
      handle: "max",
      org: orgB,
    });
    const b = await ok(consult(max, nellId, {}, tokenB));
    expect(b.ok, JSON.stringify(b)).toBe(true);
    const latest = Math.max((await deadlineOf(a.hop.hopId)).getTime(), (await deadlineOf(b.hopId)).getTime());
    const at = new Date(latest + 1000);

    expect(await sweep(at, 1)).toEqual({ timedOut: 1, cancelled: 0 });
    const statuses = [(await hopRow(a.hop.hopId)).status, (await hopRow(b.hopId)).status];
    expect(statuses.filter((x) => x === "timed_out")).toHaveLength(1);
    expect(await sweep(at, 1)).toEqual({ timedOut: 1, cancelled: 0 });
    expect((await hopRow(a.hop.hopId)).status).toBe("timed_out");
    expect((await hopRow(b.hopId)).status).toBe("timed_out");

    const ra = await repliesFor(a.hop.hopId);
    const rb = await repliesFor(b.hopId);
    expect(ra.map((r) => r.stream_id)).toEqual([`cell:${orgId}`]);
    expect(rb.map((r) => r.stream_id)).toEqual([`cell:${orgB}`]);
    expect(rb[0]?.payload).toMatchObject({
      agent: { id: maxId },
      message: { text: "@nell did not answer in time." },
    });
    expect(rb[0]?.payload.consultReply.outcome).toBe("timed_out");
    expect((await turnRow(rb[0]?.payload.eventId)).user_id).toBe(eveId);
    const [auditB] = await auditsFor("agent.consult.timed_out", "hopId", b.hopId);
    expect(auditB?.organization_id).toBe(orgB);
    expect(auditB?.user_id).toBe(eveId);
  });
});

describe("nested deadlines (P-10) and handoffs", () => {
  it("A → B bumped past B → C: at C's deadline only B → C times out (Bea hears back); A → B only after its own", async () => {
    await parkOthers();
    const { hop: ab, asked: bea } = await consulted();
    const bc = await ok(consult(bea, carlId));
    expect(bc.ok, JSON.stringify(bc)).toBe(true);
    const dBC = await deadlineOf(bc.hopId);
    const dAB = await deadlineOf(ab.hopId);
    expect(dAB.getTime()).toBeGreaterThanOrEqual(dBC.getTime() + 2 * 60_000);

    expect(await sweep(plus(dBC, 1000))).toEqual({ timedOut: 1, cancelled: 0 });
    expect((await hopRow(bc.hopId)).status).toBe("timed_out");
    expect((await hopRow(ab.hopId)).status).toBe("pending");
    const [toBea] = await repliesFor(bc.hopId);
    expect(toBea?.payload).toMatchObject({
      agent: { id: beaId },
      message: { text: "@carl did not answer in time." },
    });
    expect(await turnRow(toBea?.payload.eventId)).toMatchObject({
      user_id: victorId,
      chain_depth: 1,
      answering_hop_id: ab.hopId,
      returning_hop_id: bc.hopId,
    });

    expect(await sweep(plus(dAB, -1000))).toEqual({ timedOut: 0, cancelled: 0 });
    expect(await sweep(plus(dAB, 1000))).toEqual({ timedOut: 1, cancelled: 0 });
    expect((await hopRow(ab.hopId)).status).toBe("timed_out");
    const [toArchie] = await repliesFor(ab.hopId);
    expect(toArchie?.payload.agent.id).toBe(archieId);
  });

  it("an expired handoff becomes timed_out with no reply, and the chain completes", async () => {
    await parkOthers();
    const { hop } = await consulted({ mode: "handoff" });
    expect(await sweep(plus(await deadlineOf(hop.hopId), 1000))).toEqual({ timedOut: 1, cancelled: 0 });
    expect((await hopRow(hop.hopId)).status).toBe("timed_out");
    expect(await repliesFor(hop.hopId)).toHaveLength(0);
    expect((await chainRow(hop.chainId)).status).toBe("completed");
  });
});

describe("orphaned chains are cancelled `auto` at their next touch (P-15, T-07.7-09-04)", () => {
  const deleteRoot = async (root: string) => ok(victor.request("DELETE", `/api/v1/messages/${root}`));

  /** The chain was cancelled automatically, once, with a system actor and nothing delivered. */
  async function expectAutoCancelled(chainId: string, hopId: string) {
    expect(await chainRow(chainId)).toMatchObject({
      status: "cancelled",
      cancel_reason: "auto",
      cancelled_by_user_id: null,
    });
    expect((await hopRow(hopId)).status).toBe("cancelled");
    const audits = await auditsFor("agent.chain.cancelled", "chainId", chainId);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actor_kind: "system" });
    expect(audits[0]?.metadata.reason).toBe("auto");
    expect(await repliesFor(hopId)).toHaveLength(0);
  }

  it("chainLive is true for a normal chain and false once its thread root is deleted", async () => {
    await parkOthers();
    const { root, hop } = await consulted();
    const live = () =>
      core().db.withTenant({ organizationId: orgId, userId: victorId }, async (tx) => {
        const [chain] = await tx.select().from(agentChains).where(eq(agentChains.id, hop.chainId));
        if (!chain) throw new Error("chain missing");
        return chainLive(tx, core(), chain);
      });
    expect(await live()).toBe(true);
    await deleteRoot(root);
    expect(await live()).toBe(false);
  });

  it("thread root deleted → the next tick cancels the chain; a new consult is 409 chain_closed", async () => {
    await parkOthers();
    const { root, archie, hop } = await consulted();
    await deleteRoot(root);
    expect(await sweep(plus(await deadlineOf(hop.hopId), 1000))).toEqual({ timedOut: 0, cancelled: 1 });
    await expectAutoCancelled(hop.chainId, hop.hopId);
    const again = await consult(archie, carlId);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("chain_closed");
  });

  it("thread root deleted → the next consult request cancels the chain and answers 409 chain_closed", async () => {
    await parkOthers();
    const { root, archie, hop } = await consulted();
    await deleteRoot(root);
    const again = await consult(archie, carlId);
    expect(again.status, JSON.stringify(again.body)).toBe(409);
    expect(again.body.code).toBe("chain_closed");
    await expectAutoCancelled(hop.chainId, hop.hopId);
  });

  it("thread root deleted → the answer's done cancels the chain and returns nothing", async () => {
    await parkOthers();
    const { root, hop, asked } = await consulted();
    expect((await post(asked, ANSWER)).status).toBe(200);
    await deleteRoot(root);
    expect((await done(asked)).status).toBe(200);
    await expectAutoCancelled(hop.chainId, hop.hopId);
    // Nothing is left for a tick.
    expect(await sweep(plus(await deadlineOf(hop.hopId), 1000))).toEqual({ timedOut: 0, cancelled: 0 });
  });

  async function privateChain() {
    const privId = await channel(
      victor,
      `priv-${randomUUID().slice(0, 6)}`,
      [archieId, beaId, carlId],
      "private",
    );
    await ok(victor.request("POST", `/api/v1/channels/${privId}/members`, { kind: "user", id: samId }));
    const out = await consulted({ as: sam, conversationId: privId });
    expect((await chainRow(out.hop.chainId)).human_user_id).toBe(samId);
    await ok(victor.request("DELETE", `/api/v1/channels/${privId}/members/user/${samId}`));
    return out;
  }

  it("the chain's human removed from the private channel → the next tick cancels the chain", async () => {
    await parkOthers();
    const { hop } = await privateChain();
    expect(await sweep(plus(await deadlineOf(hop.hopId), 1000))).toEqual({ timedOut: 0, cancelled: 1 });
    await expectAutoCancelled(hop.chainId, hop.hopId);
  });

  it("the chain's human removed → the next consult request is refused (no live turn) and cancels the chain", async () => {
    await parkOthers();
    const { archie, hop } = await privateChain();
    const again = await consult(archie, carlId);
    expect(again.status).toBe(404);
    await expectAutoCancelled(hop.chainId, hop.hopId);
  });

  it("the chain's human removed → the done of the consulted bot's turn cancels the chain", async () => {
    await parkOthers();
    const { hop, asked } = await privateChain();
    expect((await done(asked, "failed")).status).toBe(200);
    await expectAutoCancelled(hop.chainId, hop.hopId);
  });
});

describe("pgboss holds ids only (ADR-0028, T-07.7-09-05)", () => {
  it("after every scenario, each consult.tick job carries {}", async () => {
    await core().db.withTenant({ organizationId: orgB, userId: null }, (tx) =>
      core().jobs.sendInTx(tx, "consult.tick", {}),
    );
    expect(await core().jobs.drain("consult.tick")).toBe(1);
    const jobs = await rows("select data from pgboss.job where name = 'consult.tick'");
    expect(jobs.length).toBeGreaterThanOrEqual(2);
    for (const j of jobs) expect(j.data).toEqual({});
  });
});
