import { randomUUID } from "node:crypto";
import { AgentConsultReplyEvent } from "@ocw/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sha256Hex } from "../../lib/crypto";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";
import { invite } from "../../testing-workzone";

/**
 * 07.7-06 Task 1 (A2A-01, A2A-03; D-01, D-04, D-06, D-07, D-09, D-13, D-15; P-02, P-08, P-09): the answer comes back.
 * Víctor Ruiz (admin) asks Archie in a thread of #ops; Archie consults Bea (`POST /consultations`, the fake cell's call);
 * Bea answers in the thread through `/messages` (accepted by PR #25's rule as it is) and reports done; the hop becomes
 * `answered` and Archie gets `agent.consult_reply.v1` as a new turn for Víctor; Archie replies there and its done
 * completes the chain. Task 2 adds taint, who pays, limits, memory, card turns and automation roots. Real PostgreSQL +
 * Redis. Organization B (Mallory) has its own cell token.
 */

const CELL_TOKEN = "ocw-test-cell-token-chains-0123456789abcdef";
const QUESTION = "Is the pump order confirmed?";
const ANSWER = "Yes, PO-1187 was confirmed on Monday.";

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
type Json = Record<string, any>;
type Res = { status: number; body: Record<string, unknown> | null };

let stack: TestStack;
let su: pg.Client;
let victor: TestClient;
let sam: TestClient;
let orgId: string;
let victorId: string;
let samId: string;
let archieId: string;
let beaId: string;
let opsId: string;
let tokenB: string;
let orgBEventId: string;

async function ok(res: Promise<Res> | Res, status = 200): Promise<Json> {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return (r.body ?? {}) as Json;
}

/** The fake cell's call to the Agent Channel API. */
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

const consult = (ev: Json, target: string, over: Json = {}) =>
  cell("/consultations", {
    eventId: ev.eventId,
    agentId: ev.agent.id,
    target,
    question: QUESTION,
    idempotencyKey: `${ev.eventId}:consult:0`,
    ...over,
  });

/** A bot's post for a delivered turn (what the bridge sends): in the turn's thread, with its event id. */
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

const done = (ev: Json, outcome: "replied" | "failed" = "replied", over: Json = {}, token = CELL_TOKEN) =>
  cell(`/turns/${ev.eventId}/done`, { agentId: ev.agent.id, outcome, ...over }, token);

/** Cell events of one type for one bot (oldest first). */
const cellEvents = (type: string, agentId?: string) =>
  rows(
    `select payload from app.stream_events where stream_id = $1 and type = $2
       and ($3::text is null or payload->'agent'->>'id' = $3) order by seq`,
    [`cell:${orgId}`, type, agentId ?? null],
  ).then((r) => r.map((x) => x.payload as Json));

const replies = (agentId?: string) => cellEvents("agent.consult_reply.v1", agentId);

/** The delivery for one message to one bot. */
async function deliveryOn(messageId: string, agentId: string): Promise<Json> {
  const [ev] = (await cellEvents("agent.mention.v1", agentId)).filter((p) => p.message.id === messageId);
  if (!ev) throw new Error(`no delivery for ${agentId} on ${messageId}`);
  return ev;
}

const turnRow = async (eventId: string) =>
  (await rows("select * from app.agent_turns where event_id = $1", [eventId]))[0] as Json;
const hopRow = async (hopId: string) =>
  (await rows("select * from app.agent_chain_hops where id = $1", [hopId]))[0] as Json;
const chainRow = async (chainId: string) =>
  (await rows("select * from app.agent_chains where id = $1", [chainId]))[0] as Json;

const audits = async (action: string) =>
  rows(
    "select actor_kind, actor_id, agent_id, user_id, resource_type, resource_id, result, metadata from app.audit_events where action = $1 and organization_id = $2 order by occurred_at, id",
    [action, orgId],
  );

/** `message.updated` frames for one message on its conversation's stream. */
const updates = (conversationId: string, messageId: string) =>
  rows(
    `select payload from app.stream_events where stream_id = $1 and type = 'message.updated'
       and payload->'message'->>'id' = $2 order by seq`,
    [`conv:${conversationId}`, messageId],
  ).then((r) => r.map((x) => x.payload.message as Json));

/** `as` writes in `conversationId` (in a thread when `threadRootId`) mentioning Archie; Archie's delivered turn. */
async function archieTurn(p: { as?: TestClient; conversationId?: string; threadRootId?: string } = {}) {
  await su.query("delete from app.agent_usage_daily");
  const conversationId = p.conversationId ?? opsId;
  const threadRootId =
    p.threadRootId ??
    ((
      await ok(
        (p.as ?? victor).request("POST", `/api/v1/conversations/${conversationId}/messages`, {
          body: `Pump order ${randomUUID().slice(0, 6)}`,
        }),
      )
    ).id as string);
  const msg = await ok(
    (p.as ?? victor).request("POST", `/api/v1/conversations/${conversationId}/messages`, {
      body: "@archie can you check the pump order with Bea?",
      mentions: [{ kind: "agent", id: archieId }],
      threadRootId,
    }),
  );
  return { root: threadRootId, archie: await deliveryOn(msg.id as string, archieId) };
}

/** Archie consults Bea in a fresh thread; Bea's question turn. */
async function consulted(p: { as?: TestClient; conversationId?: string } = {}) {
  const { root, archie } = await archieTurn(p);
  const answer = await ok(consult(archie, beaId));
  expect(answer.ok).toBe(true);
  const bea = await deliveryOn(answer.questionMessageId as string, beaId);
  return { root, archie, answer, bea };
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
  ({ client: sam, userId: samId } = await invite(stack, victor, "sam@example.test", "Sam Lee", "standard"));
  archieId = await teamBot("Archie", "archie");
  beaId = await teamBot("Bea", "bea");
  opsId = await channel("ops", [archieId, beaId]);
  await ok(sam.request("POST", `/api/v1/channels/${opsId}/join`));
  // The organization switch "Bots may consult each other" (07.7-03): one `everyone` allow row.
  await ok(victor.request("PUT", "/api/v1/agent-messaging", { enabled: true }));

  // Organization B: its own cell token and one delivered turn of its own bot (a foreign event id).
  const orgB = randomUUID();
  await su.query("insert into auth.organization (id, name, slug) values ($1, 'Evil', $2)", [
    orgB,
    `evil-${orgB}`,
  ]);
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
    [orgBEventId, orgB, mallory, randomUUID(), randomUUID(), randomUUID()],
  );
}, 240_000);

afterAll(async () => {
  await su?.end();
  await stack?.stop();
});

describe("tracer: Bea answers, reports done, and Archie gets the answer back as a new turn for Víctor (Task 1)", () => {
  let root: string;
  let archie: Json;
  let answer: Json;
  let bea: Json;
  let answerMessageId: string;
  let reply: Json;

  it("Bea's answer in reply to the question, with her event id, is accepted by the existing rule and recorded on her turn", async () => {
    ({ root, archie, answer, bea } = await consulted());
    const r = await post(bea, ANSWER);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ created: true, conversationId: opsId, threadRootMessageId: root });
    answerMessageId = r.body.messageId as string;
    expect((await turnRow(bea.eventId)).reply_message_id).toBe(answerMessageId);
    // Nothing closes on the post alone: the hop waits for the turn's end.
    expect((await hopRow(answer.hopId)).status).toBe("pending");
    expect(await replies()).toHaveLength(0);
  });

  it("done → the hop is answered with the answer, and Archie gets exactly one agent.consult_reply.v1", async () => {
    const r = await done(bea);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toEqual({ ok: true });
    expect(await hopRow(answer.hopId)).toMatchObject({
      status: "answered",
      answer_message_id: answerMessageId,
      closed_at: expect.any(Date),
    });
    const got = await replies(archieId);
    expect(got).toHaveLength(1);
    reply = got[0]!;
    expect(AgentConsultReplyEvent.safeParse({ ...reply, seq: 1 }).success).toBe(true);
    expect(reply.type).toBe("agent.consult_reply.v1");
    expect(reply.agent).toMatchObject({ id: archieId, handle: "archie" });
    expect(reply.thread).toEqual({ rootMessageId: root });
    expect(reply.message).toMatchObject({
      id: answerMessageId,
      text: ANSWER,
      author: { kind: "agent", id: beaId, displayName: "Bea" },
    });
    expect(reply.consultReply).toEqual({
      chainId: answer.chainId,
      hopId: answer.hopId,
      target: { id: beaId, handle: "bea", displayName: "Bea" },
      mode: "consult",
      outcome: "answered",
      answerMessageId,
    });
    // The human the chain runs for, structurally (the plugin names them, never the consulted bot).
    expect(reply.origin).toMatchObject({
      chainId: answer.chainId,
      hopId: answer.hopId,
      onBehalfOf: { kind: "user", id: victorId, displayName: "Víctor Ruiz" },
    });
    // Unattended (D-13), and no further consult: Bea was asked already and Archie is the root.
    expect((reply.turn.tools as string[]).filter((t) => t.startsWith("ocw_browser_"))).toEqual([]);
    expect(reply.turn.tools).not.toContain("ocw_consult_agent");
    expect(reply.turn.tainted).toBeUndefined();
    // Bea's answer is the event's message, not history; the question is in the history, attributed to Archie.
    const history = reply.threadHistory as Json[];
    expect(history.some((h) => h.id === answerMessageId)).toBe(false);
    expect(history.find((h) => h.id === answer.questionMessageId)?.author).toMatchObject({
      kind: "agent",
      id: archieId,
    });
  });

  it("Archie's return turn is Víctor's, in the chain at depth 0, returning the hop, on Bea's answer", async () => {
    expect(await turnRow(reply.eventId)).toMatchObject({
      agent_id: archieId,
      user_id: victorId,
      conversation_id: opsId,
      message_id: answerMessageId,
      chain_id: answer.chainId,
      chain_depth: 0,
      answering_hop_id: null,
      returning_hop_id: answer.hopId,
      tainted: false,
      member_data: false,
    });
  });

  it("audits agent.consult.answered with ids only and announces the question and the answer", async () => {
    const answered = (await audits("agent.consult.answered")).filter(
      (a) => a.metadata.hopId === answer.hopId,
    );
    expect(answered).toHaveLength(1);
    expect(answered[0]).toMatchObject({
      actor_kind: "agent",
      actor_id: beaId,
      agent_id: beaId,
      user_id: victorId,
      resource_type: "agent_chain_hop",
      resource_id: answer.hopId,
      result: "success",
      metadata: {
        chainId: answer.chainId,
        hopId: answer.hopId,
        questionMessageId: answer.questionMessageId,
        answerMessageId,
        targetAgentId: beaId,
        eventId: bea.eventId,
        returnEventId: reply.eventId,
      },
    });
    expect(JSON.stringify(answered[0]!.metadata)).not.toContain("PO-1187");
    const question = await updates(opsId, answer.questionMessageId);
    expect(question.at(-1)?.consult).toMatchObject({
      role: "question",
      status: "answered",
      hopId: answer.hopId,
    });
    const answerUpdates = await updates(opsId, answerMessageId);
    expect(answerUpdates.at(-1)?.consult).toMatchObject({
      role: "answer",
      status: "answered",
      hopId: answer.hopId,
      targetAgentId: beaId,
    });
    // The thread snapshot agrees.
    const thread = await ok(victor.request("GET", `/api/v1/messages/${root}/thread`));
    const listed = (thread.replies as Json[]).find((m) => m.id === answerMessageId);
    expect(listed?.consult).toMatchObject({ role: "answer", status: "answered" });
  });

  it("a second done and a replayed post change nothing: one consult reply, one answer message", async () => {
    expect((await done(bea)).status).toBe(200);
    const again = await post(bea, ANSWER);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ messageId: answerMessageId, created: false });
    expect(await replies(archieId)).toHaveLength(1);
    expect(
      await rows("select id from app.messages where client_message_id = $1", [`evt:${bea.eventId}`]),
    ).toHaveLength(1);
    expect(
      (await audits("agent.consult.answered")).filter((a) => a.metadata.hopId === answer.hopId),
    ).toHaveLength(1);
  });

  it("Archie replies to Bea's answer in the same thread (accepted), and its done completes the chain", async () => {
    expect((await chainRow(answer.chainId)).status).toBe("active");
    const r = await post(reply, "Víctor: Bea says PO-1187 was confirmed on Monday.");
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ created: true, threadRootMessageId: root });
    expect((await turnRow(reply.eventId)).reply_message_id).toBe(r.body.messageId);
    expect((await done(reply)).status).toBe(200);
    expect(await chainRow(answer.chainId)).toMatchObject({
      status: "completed",
      closed_at: expect.any(Date),
    });
    // A root return turn delivers nothing further.
    expect(await replies()).toHaveLength(1);
  });

  it("Archie's first turn reporting done after the chain completed changes nothing", async () => {
    expect((await done(archie)).status).toBe(200);
    expect((await chainRow(answer.chainId)).status).toBe("completed");
  });
});

describe("PR #25's trigger rule, unchanged, decides consult hop posts (D-06, P-02, P-08)", () => {
  it("Bea's event id naming another message, or no trigger at all, is 403 no_trigger", async () => {
    const { answer, bea } = await consulted();
    const other = await post(bea, "x", {
      inReplyToMessageId: answer.questionMessageId,
      idempotencyKey: randomUUID(),
    });
    expect(other.status).toBe(200);
    // Another agent message in the thread (Bea's own post) is not the turn's message.
    const wrong = await post(bea, "y", {
      inReplyToMessageId: other.body.messageId,
      idempotencyKey: randomUUID(),
    });
    expect(wrong.status).toBe(403);
    expect(wrong.body.error?.code).toBe("no_trigger");
    const none = await post(bea, "z", {
      eventId: undefined,
      inReplyToMessageId: undefined,
      idempotencyKey: randomUUID(),
    });
    expect(none.status).toBe(403);
    expect(none.body.error?.code).toBe("no_trigger");
  });

  it("Bea's event id alone (no inReplyToMessageId) is accepted in the turn's thread", async () => {
    const { root, bea } = await consulted();
    const r = await post(bea, ANSWER, { inReplyToMessageId: undefined });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.threadRootMessageId).toBe(root);
  });

  it("Archie's return event replying to its own earlier message is 403 no_trigger", async () => {
    const { answer, bea } = await consulted();
    await ok(post(bea, ANSWER));
    await ok(done(bea));
    const [back] = (await replies(archieId)).filter((p) => p.consultReply.hopId === answer.hopId);
    expect(back).toBeDefined();
    const r = await post(back!, "mine", {
      inReplyToMessageId: answer.questionMessageId,
      idempotencyKey: randomUUID(),
    });
    expect(r.status).toBe(403);
    expect(r.body.error?.code).toBe("no_trigger");
  });

  it("Sam removed from the private channel before Bea answers: Bea's post is refused (Sam re-checked) and the hop stays pending", async () => {
    const privId = await channel(`priv-${randomUUID().slice(0, 6)}`, [archieId, beaId], "private");
    await ok(victor.request("POST", `/api/v1/channels/${privId}/members`, { kind: "user", id: samId }));
    const { answer, bea } = await consulted({ as: sam, conversationId: privId });
    expect((await turnRow(bea.eventId)).user_id).toBe(samId);
    await ok(victor.request("DELETE", `/api/v1/channels/${privId}/members/user/${samId}`));
    const r = await post(bea, ANSWER);
    expect(r.status).toBe(403);
    expect((await hopRow(answer.hopId)).status).toBe("pending");
  });
});

describe("POST /turns/:eventId/done is bound to this cell's turns (T-07.7-06-03)", () => {
  it("an unknown event, another bot's event or another organization's event is 404 unknown_turn", async () => {
    const { archie, bea } = await consulted();
    const unknown = await done({ eventId: randomUUID(), agent: { id: beaId } });
    expect(unknown.status).toBe(404);
    expect(unknown.body.error?.code).toBe("unknown_turn");
    const swapped = await done(bea, "replied", { agentId: archieId });
    expect(swapped.status).toBe(404);
    expect(swapped.body.error?.code).toBe("unknown_turn");
    const foreign = await done({ eventId: orgBEventId, agent: { id: archie.agent.id } });
    expect(foreign.status).toBe(404);
    // Org B's own token cannot report org A's turns either.
    const crossed = await done(bea, "replied", {}, tokenB);
    expect(crossed.status).toBe(404);
  });

  it("the body is strict (400 on extra fields or an unknown outcome)", async () => {
    const { bea } = await consulted();
    expect((await done(bea, "replied", { extra: 1 })).status).toBe(400);
    expect((await cell(`/turns/${bea.eventId}/done`, { agentId: beaId, outcome: "silent" })).status).toBe(
      400,
    );
  });

  it("a turn outside any chain: 200 and nothing changes", async () => {
    const msg = await ok(
      victor.request("POST", `/api/v1/conversations/${opsId}/messages`, {
        body: "@bea hello",
        mentions: [{ kind: "agent", id: beaId }],
      }),
    );
    const ev = await deliveryOn(msg.id as string, beaId);
    await ok(post(ev, "Hello!"));
    const before = await replies();
    expect((await done(ev)).status).toBe(200);
    expect(await replies()).toEqual(before);
    // An ordinary turn's reply is not recorded on the ledger (chain turns only).
    expect((await turnRow(ev.eventId)).reply_message_id).toBeNull();
  });
});
