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
let carlId: string;
let trioId: string;
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

/** Cell events of one type on one message. */
const eventsOn = (type: string, messageId: string) =>
  rows(
    `select payload from app.stream_events where stream_id = $1 and type = $2
       and payload->'message'->>'id' = $3 order by seq`,
    [`cell:${orgId}`, type, messageId],
  ).then((r) => r.map((x) => x.payload as Json));

/** The consult reply to Archie for one hop. */
async function replyFor(hopId: string): Promise<Json> {
  const [ev] = (await replies(archieId)).filter((p) => p.consultReply.hopId === hopId);
  if (!ev) throw new Error(`no consult reply for ${hopId}`);
  return ev;
}

/** The cell's tool gate call for a delivered turn. */
const askTool = (ev: Json, tool: string, params: Json = {}) =>
  cell("/tool-calls", { eventId: ev.eventId, agentId: ev.agent.id, tool, params });

async function until<T>(read: () => Promise<T>, ready: (v: T) => boolean, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (ready(v) || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
}

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
  carlId = await teamBot("Carl", "carl");
  // #trio: a third bot, so a return turn there would be offered a consult unless something takes it away.
  trioId = await channel("trio", [archieId, beaId, carlId]);
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

  it("Archie replies to Bea's answer in the same thread (accepted); its done leaves the chain to his first turn, still running (CR-A-07)", async () => {
    expect((await chainRow(answer.chainId)).status).toBe("active");
    const r = await post(reply, "Víctor: Bea says PO-1187 was confirmed on Monday.");
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ created: true, threadRootMessageId: root });
    expect((await turnRow(reply.eventId)).reply_message_id).toBe(r.body.messageId);
    expect((await done(reply)).status).toBe(200);
    expect((await turnRow(reply.eventId)).done_at).toEqual(expect.any(Date));
    expect((await chainRow(answer.chainId)).status).toBe("active");
    // A root return turn delivers nothing further.
    expect(await replies()).toHaveLength(1);
  });

  it("Archie's first turn reporting done completes the chain; a second done changes nothing", async () => {
    expect((await done(archie)).status).toBe(200);
    expect(await chainRow(answer.chainId)).toMatchObject({
      status: "completed",
      closed_at: expect.any(Date),
    });
    expect((await done(archie)).status).toBe(200);
    expect((await chainRow(answer.chainId)).status).toBe("completed");
  });
});

describe("a chain completes only once none of its turns still runs (CR-A-07)", () => {
  it("Bea answers before Archie's first turn ends: its late done leaves the return turn its consult", async () => {
    const { archie, answer, bea } = await consulted({ conversationId: trioId });
    await ok(post(bea, ANSWER));
    await ok(done(bea));
    const reply = await replyFor(answer.hopId);
    // The first turn ends after the answer came back: the return turn is still running.
    await ok(done(archie));
    expect((await chainRow(answer.chainId)).status).toBe("active");
    const more = await consult(reply, carlId, { idempotencyKey: `${reply.eventId}:consult:0` });
    expect(more.status, JSON.stringify(more.body)).toBe(200);
    expect(more.body.ok).toBe(true);
  });

  it("the return turn ends first while Archie's first turn still runs: that turn may still consult", async () => {
    const { archie, answer, bea } = await consulted({ conversationId: trioId });
    await ok(post(bea, ANSWER));
    await ok(done(bea));
    const reply = await replyFor(answer.hopId);
    await ok(post(reply, "Víctor: confirmed."));
    await ok(done(reply));
    expect((await chainRow(answer.chainId)).status).toBe("active");
    const more = await consult(archie, carlId, { idempotencyKey: `${archie.eventId}:consult:1` });
    expect(more.status, JSON.stringify(more.body)).toBe(200);
    expect(more.body.ok).toBe(true);
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
    const unknownId = randomUUID();
    const unknown = await done({ eventId: unknownId, agent: { id: beaId } });
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
    // CR-A-09: every refusal is audited like any other cell route's unknown turn, with ids and the code only.
    const refused = (
      await rows(
        "select organization_id, actor_kind, result, metadata from app.audit_events where action = 'bot.tool_call' and resource_id = 'turn.done'",
      )
    ).filter((a) => a.metadata.reason === "unknown_turn");
    const forEvent = (eventId: string, org = orgId) =>
      refused.filter((a) => a.metadata.eventId === eventId && a.organization_id === org);
    expect(forEvent(unknownId)).toHaveLength(1);
    expect(forEvent(bea.eventId).filter((a) => a.metadata.agentId === archieId)).toHaveLength(1);
    expect(forEvent(orgBEventId)).toHaveLength(1);
    expect(
      refused.filter((a) => a.metadata.eventId === bea.eventId && a.organization_id !== orgId),
    ).toHaveLength(1);
    for (const a of refused) expect(a).toMatchObject({ actor_kind: "system", result: "denied" });
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

describe("the hop's answer is the consulted bot's whole reply, never a failure notice (CR-A-03, CR-A-04)", () => {
  it("CR-A-03: Bea's reply in two chunks reaches Archie whole, as one answer, not repeated as history", async () => {
    const { answer, bea } = await consulted();
    const first = await ok(post(bea, "Part one: PO-1187 is confirmed."));
    const second = await ok(
      post(bea, "Part two: it ships Monday.", { idempotencyKey: `evt:${bea.eventId}:1` }),
    );
    // A post of another turn of Bea in the same thread is not part of this answer.
    const other = await ok(
      victor.request("POST", `/api/v1/conversations/${opsId}/messages`, {
        body: "@bea something else",
        mentions: [{ kind: "agent", id: beaId }],
        threadRootId: bea.thread.rootMessageId,
      }),
    );
    const otherTurn = await deliveryOn(other.id as string, beaId);
    await ok(post(otherTurn, "Unrelated."));
    await ok(done(bea));
    expect(await hopRow(answer.hopId)).toMatchObject({
      status: "answered",
      answer_message_id: first.messageId,
    });
    const reply = await replyFor(answer.hopId);
    expect(reply.message).toMatchObject({
      id: first.messageId,
      text: "Part one: PO-1187 is confirmed.\n\nPart two: it ships Monday.",
      author: { kind: "agent", id: beaId },
    });
    expect(reply.consultReply).toMatchObject({ outcome: "answered", answerMessageId: first.messageId });
    const historyIds = (reply.threadHistory as Json[]).map((h) => h.id);
    expect(historyIds).not.toContain(first.messageId);
    expect(historyIds).not.toContain(second.messageId);
  });

  it("CR-A-04: Bea's turn failed: the bridge's failure notice is not her answer", async () => {
    const { root, answer, bea } = await consulted();
    const notice = await ok(
      post(bea, "Sorry, I couldn't generate a reply. Please try again in a moment.", {
        idempotencyKey: `evt:${bea.eventId}:failed`,
      }),
    );
    await ok(done(bea, "failed"));
    expect(await hopRow(answer.hopId)).toMatchObject({ status: "failed", answer_message_id: null });
    const reply = await replyFor(answer.hopId);
    expect(reply.consultReply).toMatchObject({ outcome: "failed", answerMessageId: null });
    expect(reply.message).toMatchObject({
      id: answer.questionMessageId,
      text: "@bea couldn't answer.",
      author: { kind: "user", id: victorId },
    });
    const thread = await ok(victor.request("GET", `/api/v1/messages/${root}/thread`));
    const listed = (thread.replies as Json[]).find((m) => m.id === notice.messageId);
    expect(listed?.consult?.role).not.toBe("answer");
  });
});

describe("one lock order: thread stream → turn → hop → chain (CR-A-02, CR-A-05)", () => {
  /** A second connection holding the thread's stream row, the way an in-flight post does. */
  async function holdStream(conversationId: string): Promise<pg.Client> {
    const holder = new pg.Client({ connectionString: stack.db.superuserUrl });
    await holder.connect();
    await holder.query("begin");
    await holder.query("select last_seq from app.streams where id = $1 for update", [
      `conv:${conversationId}`,
    ]);
    return holder;
  }
  /** Until some backend waits on a lock while reading the streams table (the request is parked on the stream). */
  const blockedOnStream = () =>
    until(
      () =>
        rows(
          `select count(*)::int as n from pg_stat_activity
            where wait_event_type = 'Lock' and query ilike '%app.streams%' and pid <> pg_backend_pid()`,
        ),
      (r) => (r[0]?.n ?? 0) > 0,
    );

  it("CR-A-02: a consult waits for the thread's stream before it claims the turn (no deadlock with a first post)", async () => {
    const { archie } = await archieTurn();
    const holder = await holdStream(opsId);
    let pending: Promise<{ status: number; body: Json }> | null = null;
    try {
      pending = consult(archie, beaId);
      expect((await blockedOnStream())[0]?.n).toBeGreaterThan(0);
      // The turn row is free: a first post holding the stream could still record its reply on it.
      const probe = new pg.Client({ connectionString: stack.db.superuserUrl });
      await probe.connect();
      try {
        await probe.query("begin");
        const locked = await probe
          .query("select event_id from app.agent_turns where event_id = $1 for update nowait", [
            archie.eventId,
          ])
          .then(
            () => false,
            (e: { code?: string }) => e.code === "55P03",
          );
        await probe.query("rollback");
        expect(locked).toBe(false);
      } finally {
        await probe.end();
      }
    } finally {
      await holder.query("rollback");
      await holder.end();
    }
    expect((await pending!).status).toBe(200);
  });

  it("CR-A-02: Archie's first post and his consult, at the same time, both succeed", async () => {
    for (let i = 0; i < 5; i++) {
      const { archie } = await archieTurn();
      const [posted, asked] = await Promise.all([
        post(archie, "Let me check with @bea."),
        consult(archie, beaId),
      ]);
      expect(posted.status, JSON.stringify(posted.body)).toBe(200);
      expect(asked.status, JSON.stringify(asked.body)).toBe(200);
    }
  });

  it("CR-A-05: done reads the turn after the stream lock, so a post committing under it is the answer", async () => {
    const { answer, bea } = await consulted();
    const posted = await ok(post(bea, ANSWER));
    // Seen from done's side, the post has not committed yet: it is in flight and holds the stream.
    await su.query("update app.agent_turns set reply_message_id = null where event_id = $1", [bea.eventId]);
    const holder = await holdStream(opsId);
    let pending: Promise<{ status: number; body: Json }> | null = null;
    try {
      await holder.query("update app.agent_turns set reply_message_id = $2 where event_id = $1", [
        bea.eventId,
        posted.messageId,
      ]);
      pending = done(bea);
      await blockedOnStream();
      await holder.query("commit");
    } finally {
      await holder.end().catch(() => undefined);
    }
    expect((await pending!).status).toBe(200);
    expect(await hopRow(answer.hopId)).toMatchObject({
      status: "answered",
      answer_message_id: posted.messageId,
    });
  });
});

describe("taint flows forward (Task 2; D-09, P-11, Pitfall 2)", () => {
  beforeAll(async () => {
    await ok(victor.request("PATCH", `/api/v1/agents/${beaId}/capabilities`, { internet: true }));
  });
  afterAll(async () => {
    await ok(victor.request("PATCH", `/api/v1/agents/${beaId}/capabilities`, { internet: false }));
  });

  it("Bea read the web while answering: Archie's return turn starts tainted, without the consult tool, side effects refused", async () => {
    const { answer, bea } = await consulted({ conversationId: trioId });
    expect(bea.turn.tools).toContain("web_search");
    expect((await askTool(bea, "web_search", { query: "pump order" })).body).toMatchObject({ allowed: true });
    expect((await turnRow(bea.eventId)).tainted).toBe(true);
    await ok(post(bea, ANSWER));
    await ok(done(bea));
    const reply = await replyFor(answer.hopId);
    expect(reply.turn.tainted).toBe(true);
    expect((await turnRow(reply.eventId)).tainted).toBe(true);
    // In #trio an untainted return turn would be offered Carl; a tainted one is never offered a consult.
    expect(reply.turn.tools).not.toContain("ocw_consult_agent");
    expect(reply.turn.consult).toBeUndefined();
    const forced = await cell("/consultations", {
      eventId: reply.eventId,
      agentId: archieId,
      target: carlId,
      question: QUESTION,
      idempotencyKey: `${reply.eventId}:consult:0`,
    });
    expect(forced.status).toBe(403);
    expect(forced.body.code).toBe("tainted");
    const sideEffecting = Object.entries(reply.turn.toolFlags as Record<string, Json>)
      .filter(([, f]) => f.sideEffecting === true)
      .map(([tool]) => tool);
    expect(sideEffecting.length).toBeGreaterThan(0);
    const refused = await askTool(reply, sideEffecting[0] as string);
    expect(refused.body).toMatchObject({ allowed: false, reason: "tainted" });
  });

  it("CR-A-01: Archie's own turn read outside content after asking: the return turn starts tainted (same session, nothing laundered)", async () => {
    const { archie, answer, bea } = await consulted({ conversationId: trioId });
    // The asking turn keeps running after the consult call and reads untrusted content (a web or MCP result).
    await su.query("update app.agent_turns set tainted = true where event_id = $1", [archie.eventId]);
    await ok(post(bea, ANSWER));
    await ok(done(bea));
    expect((await turnRow(bea.eventId)).tainted).toBe(false);
    const reply = await replyFor(answer.hopId);
    expect(reply.turn.tainted).toBe(true);
    expect((await turnRow(reply.eventId)).tainted).toBe(true);
    expect(reply.turn.tools).not.toContain("ocw_consult_agent");
    const forced = await cell("/consultations", {
      eventId: reply.eventId,
      agentId: archieId,
      target: carlId,
      question: QUESTION,
      idempotencyKey: `${reply.eventId}:consult:0`,
    });
    expect(forced.status).toBe(403);
    expect(forced.body.code).toBe("tainted");
  });

  describe("CR-A-01 follow-up: the asking turn reads outside content after the answer came back (late taint)", () => {
    beforeAll(async () => {
      await ok(victor.request("PATCH", `/api/v1/agents/${archieId}/capabilities`, { internet: true }));
    });
    afterAll(async () => {
      await ok(victor.request("PATCH", `/api/v1/agents/${archieId}/capabilities`, { internet: false }));
    });

    /** Bea answers while Archie's asking turn still runs: the return turn is delivered untainted. */
    async function answeredWhileAsking() {
      const { archie, answer, bea } = await consulted({ conversationId: trioId });
      expect(archie.turn.tools).toContain("web_search");
      await ok(post(bea, ANSWER));
      await ok(done(bea));
      const reply = await replyFor(answer.hopId);
      expect(reply.turn.tainted).not.toBe(true);
      expect((await turnRow(reply.eventId)).tainted).toBe(false);
      expect((await turnRow(archie.eventId)).done_at).toBeNull();
      return { archie, answer, reply };
    }

    it("the asking turn becomes tainted afterwards: its live return turn is tainted too, side effects refused", async () => {
      const { archie, reply } = await answeredWhileAsking();
      // The asking turn, still running, reads the web through the real gate.
      expect((await askTool(archie, "web_search", { query: "pump order" })).body).toMatchObject({
        allowed: true,
      });
      expect((await turnRow(archie.eventId)).tainted).toBe(true);
      expect((await turnRow(reply.eventId)).tainted).toBe(true);
      const forced = await consult(reply, carlId, { idempotencyKey: `${reply.eventId}:consult:0` });
      expect(forced.status).toBe(403);
      expect(forced.body.code).toBe("tainted");
      const sideEffecting = Object.entries(reply.turn.toolFlags as Record<string, Json>)
        .filter(([tool, f]) => f.sideEffecting === true && tool !== "ocw_consult_agent")
        .map(([tool]) => tool);
      expect(sideEffecting.length).toBeGreaterThan(0);
      expect((await askTool(reply, sideEffecting[0] as string)).body).toMatchObject({
        allowed: false,
        reason: "tainted",
      });
    });

    it("transitively: a return turn that asked again hands the late taint to its own live return turn", async () => {
      const { archie, reply } = await answeredWhileAsking();
      // The untainted return turn consults Carl; Carl answers; a second return turn is delivered, untainted.
      const second = await ok(consult(reply, carlId, { idempotencyKey: `${reply.eventId}:consult:0` }));
      const carl = await deliveryOn(second.questionMessageId as string, carlId);
      await ok(post(carl, ANSWER));
      await ok(done(carl));
      const again = await replyFor(second.hopId as string);
      expect((await turnRow(again.eventId)).tainted).toBe(false);
      // Then the first asking turn reads the web.
      expect((await askTool(archie, "web_search", { query: "pump order" })).body).toMatchObject({
        allowed: true,
      });
      expect((await turnRow(reply.eventId)).tainted).toBe(true);
      expect((await turnRow(again.eventId)).tainted).toBe(true);
      // The consulted bots' own turns are not touched: the taint flows to the asker's continuations only.
      expect((await turnRow(carl.eventId)).tainted).toBe(false);
    });

    it("a return turn that already finished is left as it was; a turn of another chain is never touched", async () => {
      const { archie, reply } = await answeredWhileAsking();
      await ok(post(reply, "Víctor: confirmed."));
      await ok(done(reply));
      const other = await answeredWhileAsking();
      expect((await askTool(archie, "web_search", { query: "pump order" })).body).toMatchObject({
        allowed: true,
      });
      expect((await turnRow(reply.eventId)).tainted).toBe(false);
      expect((await turnRow(other.reply.eventId)).tainted).toBe(false);
    });
  });

  it("CR-A-01: member data the asking turn read stays with its return turn", async () => {
    const { archie, answer, bea } = await consulted();
    await su.query("update app.agent_turns set member_data = true where event_id = $1", [archie.eventId]);
    await ok(post(bea, ANSWER));
    await ok(done(bea));
    const reply = await replyFor(answer.hopId);
    expect(await turnRow(reply.eventId)).toMatchObject({ member_data: true, user_id: victorId });
  });

  it("member data read while answering stays with the answer: the return turn starts with it (the 07.5 re-run rule)", async () => {
    const { answer, bea } = await consulted();
    await su.query("update app.agent_turns set member_data = true where event_id = $1", [bea.eventId]);
    await ok(post(bea, ANSWER));
    await ok(done(bea));
    const reply = await replyFor(answer.hopId);
    expect(await turnRow(reply.eventId)).toMatchObject({ member_data: true, tainted: false });
  });
});

describe("the root human pays every hop (Task 2; D-03, D-04, P-12, ADR-0019)", () => {
  it("A → B → C in #trio: every turn is Víctor's, each bot meters its own turns, no AI usage record is written", async () => {
    const aiUsageRecords = async () =>
      Number((await rows("select count(*)::int as n from app.ai_usage_records"))[0]?.n);
    const before = await aiUsageRecords();
    const { archie, answer: ab, bea } = await consulted({ conversationId: trioId });
    const bc = await ok(consult(bea, carlId));
    await ok(post(bea, "Checking with Carl."));
    await ok(done(bea));
    const carl = await deliveryOn(bc.questionMessageId as string, carlId);
    await ok(post(carl, "Shipped Monday."));
    await ok(done(carl));
    const [beaBack] = (await replies(beaId)).filter((p) => p.consultReply.hopId === bc.hopId);
    await ok(post(beaBack!, ANSWER));
    await ok(done(beaBack!));
    const archieBack = await replyFor(ab.hopId);
    await ok(post(archieBack, "Víctor: confirmed."));
    await ok(done(archieBack));
    // CR-A-07: Archie's first turn still runs until its own done.
    expect((await chainRow(ab.chainId)).status).toBe("active");
    await ok(done(archie));
    expect((await chainRow(ab.chainId)).status).toBe("completed");

    const turns = await rows(
      "select agent_id, user_id from app.agent_turns where chain_id = $1 or event_id = $2",
      [ab.chainId, archie.eventId],
    );
    expect(turns).toHaveLength(5);
    expect(new Set(turns.map((t) => t.user_id))).toEqual(new Set([victorId]));
    const usage = await rows("select agent_id, turns from app.agent_usage_daily where organization_id = $1", [
      orgId,
    ]);
    expect(Object.fromEntries(usage.map((u) => [u.agent_id, u.turns]))).toEqual({
      [archieId]: 2,
      [beaId]: 2,
      [carlId]: 1,
    });
    expect(await aiUsageRecords()).toBe(before);
    const consultAudits = (
      await rows(
        "select user_id, metadata from app.audit_events where organization_id = $1 and action like 'agent.consult.%'",
        [orgId],
      )
    ).filter((a) => a.metadata.chainId === ab.chainId);
    expect(consultAudits.length).toBeGreaterThanOrEqual(4);
    expect(new Set(consultAudits.map((a) => a.user_id))).toEqual(new Set([victorId]));
  });

  it("Archie at its daily limit when Bea is done: hop answered, no return turn, the usual notice once, chain completed", async () => {
    const limitsId = await channel(`limits-${randomUUID().slice(0, 6)}`, [archieId, beaId]);
    const { archie, answer, bea } = await consulted({ conversationId: limitsId });
    const posted = await ok(post(bea, ANSWER));
    await su.query("update app.agent_usage_daily set turns = 100000 where agent_id = $1", [archieId]);
    await ok(done(bea));
    expect((await hopRow(answer.hopId)).status).toBe("answered");
    expect((await replies(archieId)).filter((p) => p.consultReply.hopId === answer.hopId)).toHaveLength(0);
    const notice = await until(
      () =>
        rows("select author_id from app.messages where client_message_id = $1", [
          `limit:${posted.messageId}`,
        ]),
      (r) => r.length > 0,
    );
    expect(notice).toEqual([{ author_id: archieId }]);
    const limited = (
      await rows(
        "select user_id, metadata from app.audit_events where action = 'agent.limit_reached' and agent_id = $1",
        [archieId],
      )
    ).filter((a) => a.metadata.messageId === posted.messageId);
    expect(limited).toHaveLength(1);
    expect(limited[0]).toMatchObject({ user_id: victorId, metadata: { notified: true } });
    // Nothing is pending and no return turn runs: the chain completes once Archie's first turn ends (CR-A-07).
    await ok(done(archie));
    expect((await chainRow(answer.chainId)).status).toBe("completed");
    await su.query("delete from app.agent_usage_daily");
  });
});

describe("chain turns carry no memory; card decisions never continue a chain (Task 2; Pitfall 4, P-13, D-10)", () => {
  afterAll(async () => {
    await ok(victor.request("PATCH", `/api/v1/agents/${beaId}/capabilities`, { memory: false }));
  });

  it("Bea keeps a note about Víctor: her chain turn carries no memory and no memory write tool", async () => {
    await ok(victor.request("PATCH", `/api/v1/agents/${beaId}/capabilities`, { memory: true }));
    const dmId = (await ok(victor.request("POST", `/api/v1/agents/${beaId}/dm`))).dmId as string;
    const said = await ok(
      victor.request("POST", `/api/v1/conversations/${dmId}/messages`, {
        body: "remember: I like short answers",
      }),
    );
    const dmTurn = await deliveryOn(said.id as string, beaId);
    await ok(
      cell("/memories", { eventId: dmTurn.eventId, agentId: beaId, text: "Víctor likes short answers" }),
    );
    const later = await ok(
      victor.request("POST", `/api/v1/conversations/${dmId}/messages`, { body: "hi again" }),
    );
    expect((await deliveryOn(later.id as string, beaId)).turn.memory.length).toBeGreaterThan(0);

    const { bea } = await consulted();
    expect(bea.turn.memory).toEqual([]);
    expect(bea.turn.tools).not.toContain("ocw_memory_save");
    expect(bea.turn.tools).not.toContain("ocw_memory_write");
    expect(JSON.stringify(bea.turn)).not.toContain("short answers");
  });

  it("Bea posts a card in her chain turn; Víctor approves it: that turn is outside the chain and its done touches no hop", async () => {
    const { root, answer, bea } = await consulted();
    const card = await cell("/cards", {
      agentId: beaId,
      conversationId: opsId,
      threadRootId: root,
      inReplyToMessageId: answer.questionMessageId,
      eventId: bea.eventId,
      idempotencyKey: `card-${randomUUID()}`,
      card: {
        kind: "approval",
        title: "Confirm PO-1187",
        fields: [{ label: "Order", value: "PO-1187" }],
        status: "pending",
        actions: [{ kind: "approve", label: "Approve", denyLabel: "Deny" }],
        summary: "Confirm the pump order PO-1187",
      },
    });
    expect(card.status, JSON.stringify(card.body)).toBe(201);
    const cardId = card.body.messageId as string;
    expect((await turnRow(bea.eventId)).reply_message_id).toBe(cardId);
    await ok(victor.request("POST", `/api/v1/cards/${cardId}/decision`, { outcome: "approved" }));
    const [action] = await eventsOn("agent.card_action.v1", cardId);
    expect(action).toBeDefined();
    expect(action!.origin).toBeUndefined();
    expect(await turnRow(action!.eventId)).toMatchObject({
      user_id: victorId,
      chain_id: null,
      chain_depth: 0,
      answering_hop_id: null,
      returning_hop_id: null,
    });
    await ok(done(action!));
    expect((await hopRow(answer.hopId)).status).toBe("pending");
    // Bea's own turn answers with its card.
    await ok(done(bea));
    expect(await hopRow(answer.hopId)).toMatchObject({ status: "answered", answer_message_id: cardId });
  });
});

describe("an automation-rooted chain returns to the run's bot for the run-as person (Task 2; D-12)", () => {
  it("a Run-now run of Archie consults Bea; the answer returns for Víctor; only Archie's own anchor reply answers the run", async () => {
    const core = stack.built.core;
    const automation = await ok(
      victor.request("POST", "/api/v1/automations", {
        name: `Pump report ${randomUUID().slice(0, 4)}`,
        agentId: archieId,
        instructions: "Check the pump orders with the team.",
        trigger: { kind: "schedule", schedule: { cron: "0 17 * * 5", timeZone: "Europe/Madrid" } },
        target: { kind: "channel", conversationId: opsId },
        maxRunsPerDay: 24,
      }),
      201,
    );
    const automationId = automation.automation.id as string;
    await su.query("delete from app.agent_usage_daily");
    await ok(victor.request("POST", `/api/v1/automations/${automationId}/run`), 202);
    await core.jobs.drain("automation.fire");
    const [run] = (await cellEvents("agent.automation_run.v1", archieId)).filter(
      (p) => p.automationRun.automationId === automationId,
    );
    expect(run).toBeDefined();
    const answer = await ok(consult(run!, beaId));
    const bea = await deliveryOn(answer.questionMessageId as string, beaId);
    expect((await turnRow(bea.eventId)).user_id).toBe(victorId);
    await ok(post(bea, ANSWER));
    await ok(done(bea));
    const back = await replyFor(answer.hopId);
    expect(await turnRow(back.eventId)).toMatchObject({ user_id: victorId, returning_hop_id: answer.hopId });
    const runStatus = async () =>
      (await rows("select status from app.automation_runs where id = $1", [run!.automationRun.runId]))[0]
        ?.status;
    expect(await runStatus()).toBe("delivered");
    const reply = await post(back, "Víctor: Bea confirms PO-1187.");
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    // Neither the question nor the return turn's reply marks the run; Archie's own reply on the anchor does.
    expect(await runStatus()).toBe("delivered");
    await ok(post(run!, "Pump report: PO-1187 confirmed."));
    expect(await runStatus()).toBe("answered");
  });
});
