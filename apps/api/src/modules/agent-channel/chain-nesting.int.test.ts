import { randomUUID } from "node:crypto";
import { agentChainHops, type Tx } from "@ocw/db";
import { eq } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";
import { createPermissionService } from "../organization";
import { deliverConsultReply } from "./chains";

/**
 * 07.7-06 Task 2 (A2A-01, A2A-03; D-01, D-04, Pattern 3, Pattern 5, Pitfall 6): the chain closes in the right order.
 * A → B → C (Archie, Bea and Carl in #ops, for Víctor Ruiz): Bea's question turn consults Carl, so her first turn does
 * not answer Archie; Carl's answer returns to Bea as her return turn, and only her answer there returns to Archie, once.
 * A handoff closes with no return turn; a failed turn returns the failure; double and late done signals change nothing.
 * Real PostgreSQL + Redis, the fake cell's calls only.
 */

const CELL_TOKEN = "ocw-test-cell-token-chain-nesting-0123456789";
const QUESTION = "Is the pump order confirmed?";

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
type Json = Record<string, any>;
type Res = { status: number; body: Record<string, unknown> | null };

let stack: TestStack;
let su: pg.Client;
let victor: TestClient;
let orgId: string;
let victorId: string;
let archieId: string;
let beaId: string;
let carlId: string;
let opsId: string;

async function ok(res: Promise<Res> | Res, status = 200): Promise<Json> {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return (r.body ?? {}) as Json;
}

async function cell(path: string, body: unknown): Promise<{ status: number; body: Json }> {
  const res = await fetch(`${stack.baseUrl}/agent-channel/v1${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${CELL_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as Json };
}

const rows = async (sql: string, args: unknown[] = []) => (await su.query(sql, args)).rows as Json[];

const consult = (ev: Json, target: string, over: Json = {}) =>
  cell("/consultations", {
    eventId: ev.eventId,
    agentId: ev.agent.id,
    target,
    question: QUESTION,
    idempotencyKey: `${ev.eventId}:consult:0`,
    ...over,
  });

const post = (ev: Json, text: string, over: Json = {}) =>
  cell("/messages", {
    agentId: ev.agent.id,
    conversationId: ev.conversation.id,
    threadRootMessageId: ev.thread.rootMessageId,
    inReplyToMessageId: ev.message.id,
    eventId: ev.eventId,
    text,
    idempotencyKey: `evt:${ev.eventId}`,
    ...over,
  });

const done = (ev: Json, outcome: "replied" | "failed" = "replied") =>
  cell(`/turns/${ev.eventId}/done`, { agentId: ev.agent.id, outcome });

/** Cell events of one type for one bot, with their seq (oldest first). */
const cellEvents = (type: string, agentId: string) =>
  rows(
    `select seq, payload from app.stream_events where stream_id = $1 and type = $2
       and payload->'agent'->>'id' = $3 order by seq`,
    [`cell:${orgId}`, type, agentId],
  );

/** Consult replies to one bot for one hop. */
const repliesFor = async (agentId: string, hopId: string) =>
  (await cellEvents("agent.consult_reply.v1", agentId)).filter((r) => r.payload.consultReply.hopId === hopId);

async function deliveryOn(messageId: string, agentId: string): Promise<Json> {
  const [ev] = (await cellEvents("agent.mention.v1", agentId)).filter(
    (r) => r.payload.message.id === messageId,
  );
  if (!ev) throw new Error(`no delivery for ${agentId} on ${messageId}`);
  return ev.payload as Json;
}

const turnRow = async (eventId: string) =>
  (await rows("select * from app.agent_turns where event_id = $1", [eventId]))[0] as Json;
const hopRow = async (hopId: string) =>
  (await rows("select * from app.agent_chain_hops where id = $1", [hopId]))[0] as Json;
const chainRow = async (chainId: string) =>
  (await rows("select * from app.agent_chains where id = $1", [chainId]))[0] as Json;
const audits = async (action: string, hopId: string) =>
  (
    await rows(
      "select user_id, agent_id, result, metadata from app.audit_events where action = $1 and organization_id = $2",
      [action, orgId],
    )
  ).filter((a) => a.metadata.hopId === hopId);

/** Víctor asks Archie in a fresh thread of #ops; Archie's turn. */
async function archieTurn(): Promise<Json> {
  await su.query("delete from app.agent_usage_daily");
  const root = await ok(
    victor.request("POST", `/api/v1/conversations/${opsId}/messages`, {
      body: `Pumps ${randomUUID().slice(0, 6)}`,
    }),
  );
  const msg = await ok(
    victor.request("POST", `/api/v1/conversations/${opsId}/messages`, {
      body: "@archie can you check the pump order?",
      mentions: [{ kind: "agent", id: archieId }],
      threadRootId: root.id,
    }),
  );
  return deliveryOn(msg.id as string, archieId);
}

/** Archie asks `target` (consult or handoff); the hop and the target's question turn. */
async function asked(mode: "consult" | "handoff" = "consult", target = beaId) {
  const archie = await archieTurn();
  const hop = await ok(consult(archie, target, { mode }));
  expect(hop.ok, JSON.stringify(hop)).toBe(true);
  return { archie, hop, turn: await deliveryOn(hop.questionMessageId as string, target) };
}

async function teamBot(name: string, username: string): Promise<string> {
  const bot = await ok(
    victor.request("POST", "/api/v1/agents", {
      name,
      username,
      instructions: `You are ${name}.`,
      modelProvider: "mock",
      modelId: "mock-1",
    }),
  );
  await su.query("update app.agents set status = 'ready' where id = $1", [bot.id]);
  return bot.id as string;
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
  archieId = await teamBot("Archie", "archie");
  beaId = await teamBot("Bea", "bea");
  carlId = await teamBot("Carl", "carl");
  opsId = (await ok(victor.request("POST", "/api/v1/channels", { name: "ops" }))).id as string;
  for (const id of [archieId, beaId, carlId]) {
    await ok(victor.request("POST", `/api/v1/channels/${opsId}/members`, { kind: "agent", id }));
  }
  await ok(victor.request("PUT", "/api/v1/agent-messaging", { enabled: true }));
}, 240_000);

afterAll(async () => {
  await su?.end();
  await stack?.stop();
});

describe("A → B → C: Archie gets exactly one answer, after Bea's second turn (Pitfall 6)", () => {
  let archie: Json;
  let ab: Json;
  let bea: Json;
  let bc: Json;
  let carl: Json;
  let beaBack: Json;
  let beaAnswerId: string;

  it("Bea's question turn consults Carl (depth 2) and says so; her done leaves Archie's hop pending and Archie unwoken", async () => {
    ({ archie, hop: ab, turn: bea } = await asked());
    expect(bea.turn.consult?.targets.map((t: Json) => t.id)).toEqual([carlId]);
    bc = await ok(consult(bea, carlId));
    expect(bc.ok).toBe(true);
    expect(await hopRow(bc.hopId)).toMatchObject({
      depth: 2,
      parent_hop_id: ab.hopId,
      source_agent_id: beaId,
    });
    await ok(post(bea, "Checking with Carl."));
    await ok(done(bea));
    expect((await hopRow(ab.hopId)).status).toBe("pending");
    expect(await repliesFor(archieId, ab.hopId)).toHaveLength(0);
  });

  it("Carl answers and reports done: Bea gets her return turn (answering Archie's hop, returning Carl's, depth 1)", async () => {
    carl = await deliveryOn(bc.questionMessageId as string, carlId);
    expect(await turnRow(carl.eventId)).toMatchObject({ chain_depth: 2, answering_hop_id: bc.hopId });
    // At depth 2 nobody is offered a consult.
    expect(carl.turn.tools).not.toContain("ocw_consult_agent");
    await ok(post(carl, "PO-1187 shipped on Monday."));
    await ok(done(carl));
    expect((await hopRow(bc.hopId)).status).toBe("answered");
    const back = await repliesFor(beaId, bc.hopId);
    expect(back).toHaveLength(1);
    beaBack = back[0]!.payload as Json;
    expect(beaBack.consultReply).toMatchObject({ outcome: "answered", target: { id: carlId } });
    expect(await turnRow(beaBack.eventId)).toMatchObject({
      agent_id: beaId,
      user_id: victorId,
      chain_id: ab.chainId,
      chain_depth: 1,
      answering_hop_id: ab.hopId,
      returning_hop_id: bc.hopId,
    });
    // Still nothing for Archie.
    expect((await hopRow(ab.hopId)).status).toBe("pending");
    expect(await repliesFor(archieId, ab.hopId)).toHaveLength(0);
  });

  it("Bea answers on her return turn and reports done: Archie's hop is answered with it, one reply, after Bea's turn", async () => {
    const r = await ok(post(beaBack, "Carl confirms PO-1187 shipped Monday."));
    beaAnswerId = r.messageId as string;
    await ok(done(beaBack));
    expect(await hopRow(ab.hopId)).toMatchObject({ status: "answered", answer_message_id: beaAnswerId });
    const toArchie = await repliesFor(archieId, ab.hopId);
    expect(toArchie).toHaveLength(1);
    expect(toArchie[0]!.payload.message).toMatchObject({
      id: beaAnswerId,
      author: { kind: "agent", id: beaId },
    });
    const beaReturnSeq = (await cellEvents("agent.consult_reply.v1", beaId)).find(
      (e) => e.payload.eventId === beaBack.eventId,
    )?.seq;
    expect(Number(toArchie[0]!.seq)).toBeGreaterThan(Number(beaReturnSeq));
    expect(await turnRow(toArchie[0]!.payload.eventId)).toMatchObject({
      agent_id: archieId,
      chain_depth: 0,
      answering_hop_id: null,
      returning_hop_id: ab.hopId,
      user_id: victorId,
    });
    // Late and double signals change nothing.
    for (const ev of [bea, carl, beaBack]) expect((await done(ev)).status).toBe(200);
    expect(await repliesFor(archieId, ab.hopId)).toHaveLength(1);
    expect(await repliesFor(beaId, bc.hopId)).toHaveLength(1);
    expect((await chainRow(ab.chainId)).status).toBe("active");
    await ok(post(toArchie[0]!.payload as Json, "Víctor: PO-1187 shipped Monday."));
    await ok(done(toArchie[0]!.payload as Json));
    await ok(done(archie));
    expect((await chainRow(ab.chainId)).status).toBe("completed");
  });

  it("when Carl's done arrives before Bea's first done, her first turn still does not answer Archie", async () => {
    const { hop: first, turn: b } = await asked();
    const child = await ok(consult(b, carlId));
    await ok(post(b, "Checking with Carl."));
    const c = await deliveryOn(child.questionMessageId as string, carlId);
    await ok(post(c, "Shipped."));
    await ok(done(c));
    await ok(done(b));
    expect((await hopRow(first.hopId)).status).toBe("pending");
    expect(await repliesFor(archieId, first.hopId)).toHaveLength(0);
  });
});

describe("handoff (Pattern 5): the hop closes with no return turn", () => {
  it("Archie hands off to Bea; done(Bea) answers the hop, wakes nobody, announces it; the chain completes", async () => {
    const { archie, hop, turn: bea } = await asked("handoff");
    expect(bea.origin.mode).toBe("handoff");
    const answer = await ok(post(bea, "I'll take it from here, Víctor: PO-1187 is confirmed."));
    await ok(done(bea));
    expect(await hopRow(hop.hopId)).toMatchObject({
      status: "answered",
      answer_message_id: answer.messageId,
    });
    expect(await repliesFor(archieId, hop.hopId)).toHaveLength(0);
    const updated = await rows(
      `select payload from app.stream_events where stream_id = $1 and type = 'message.updated'
         and payload->'message'->>'id' = $2 order by seq`,
      [`conv:${opsId}`, hop.questionMessageId],
    );
    expect(updated.at(-1)?.payload.message.consult).toMatchObject({ mode: "handoff", status: "answered" });
    expect(await audits("agent.consult.answered", hop.hopId)).toHaveLength(1);
    await ok(done(archie));
    expect((await chainRow(hop.chainId)).status).toBe("completed");
  });
});

describe("failed hops return the failure to the asker", () => {
  it("done(failed) after Bea's failure notice: hop failed, Archie's reply carries the notice, outcome failed", async () => {
    const { hop, turn: bea } = await asked();
    const notice = await ok(post(bea, "Sorry, I couldn't finish that."));
    await ok(done(bea, "failed"));
    expect(await hopRow(hop.hopId)).toMatchObject({ status: "failed", answer_message_id: notice.messageId });
    const [reply] = await repliesFor(archieId, hop.hopId);
    expect(reply?.payload.consultReply).toMatchObject({ outcome: "failed", answerMessageId: null });
    expect(reply?.payload.message).toMatchObject({
      id: notice.messageId,
      author: { kind: "agent", id: beaId },
    });
    const failed = await audits("agent.consult.failed", hop.hopId);
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ user_id: victorId, agent_id: beaId, result: "error" });
    // Double done and done after the failure change nothing.
    await ok(done(bea));
    await ok(done(bea, "failed"));
    expect(await repliesFor(archieId, hop.hopId)).toHaveLength(1);
    expect((await hopRow(hop.hopId)).status).toBe("failed");
  });

  it("when Bea posted nothing: the reply is on the question with the server sentence, and Archie may reply to it", async () => {
    const { hop, turn: bea } = await asked();
    await ok(done(bea, "failed"));
    expect(await hopRow(hop.hopId)).toMatchObject({ status: "failed", answer_message_id: null });
    const [reply] = await repliesFor(archieId, hop.hopId);
    const ev = reply?.payload as Json;
    expect(ev.consultReply).toMatchObject({ outcome: "failed", answerMessageId: null });
    expect(ev.message).toMatchObject({
      id: hop.questionMessageId,
      text: "@bea couldn't answer.",
      author: { kind: "user", id: victorId },
    });
    expect((await turnRow(ev.eventId)).message_id).toBe(hop.questionMessageId);
    const r = await post(ev, "Víctor, Bea couldn't answer; I'll check the order myself.");
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  });

  it("a replied done without any post is a failure, never an empty answer", async () => {
    const { hop, turn: bea } = await asked();
    await ok(done(bea, "replied"));
    expect((await hopRow(hop.hopId)).status).toBe("failed");
  });
});

describe("timed_out (the 07.7-09 sweeper's delivery): the reply says so and carries no answer", () => {
  it("deliverConsultReply(timed_out) on a timed-out hop returns the question with the server sentence", async () => {
    const { hop } = await asked();
    await su.query("update app.agent_chain_hops set status = 'timed_out', closed_at = now() where id = $1", [
      hop.hopId,
    ]);
    const core = stack.built.core;
    const ev = await core.db.withTenant({ organizationId: orgId, userId: victorId }, async (tx: Tx) => {
      const [stored] = await tx.select().from(agentChainHops).where(eq(agentChainHops.id, hop.hopId));
      if (!stored) throw new Error("hop missing");
      return deliverConsultReply(tx, { core, perms: createPermissionService(core) }, stored, "timed_out");
    });
    expect(ev?.consultReply).toMatchObject({ outcome: "timed_out", answerMessageId: null });
    expect(ev?.message).toMatchObject({ id: hop.questionMessageId, text: "@bea did not answer in time." });
    expect(await repliesFor(archieId, hop.hopId)).toHaveLength(1);
  });
});
