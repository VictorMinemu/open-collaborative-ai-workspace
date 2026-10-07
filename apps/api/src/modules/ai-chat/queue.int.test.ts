import { randomUUID } from "node:crypto";
import { AI_QUEUE_MAX, EventTypes } from "@ocw/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_SETUP_TOKEN, TestClient } from "../../testing";
import {
  type AiStack,
  type ConvSubscription,
  seedPlan,
  startAiStack,
  startSecondInstance,
  subscribeConv,
  withoutTitles,
} from "../../testing-ai";
import { invite } from "../../testing-workzone";
import { createModelGateway } from "../model-gateway";
import { createRunLoop } from "./run-loop";
import { createGenerationSweeper } from "./sweeper";

/**
 * One generation per conversation in shared AI chats (06-06, MULTI-04, D-01, D-05, P-07, P-08): a message answers
 * only when addressed (Ask AI or no mention), a message addressed while an answer runs is queued (never 409), every
 * participant sees the queue (`ai.queue.updated`), and the moment the running answer ends the next one starts in the
 * same finalize transaction, coalescing every queued message, on the FIRST waiting author's own plan. Authors without
 * a usable model, or at their daily cap, are skipped with the reason; nobody else's plan is tried. The sweeper picks
 * up a queue left idle by a crash; two API instances share the work. Real PostgreSQL + Redis, the in-process fake.
 */

let stack: AiStack;
let su: pg.Client;
let victor: TestClient;
let alex: TestClient;
let sam: TestClient;
let victorId: string;
let alexId: string;
let samId: string;
let orgId: string;
let chatId: string;
let victorConv: ConvSubscription;
let alexConv: ConvSubscription;
let samConv: ConvSubscription;

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
type Json = Record<string, any>;

const PLAN_MODEL = { backend: "chatgpt_plan", provider: "openai", modelId: "gpt-6-astra" } as const;
const cid = () => `cm-${randomUUID()}`;
const errorOf = (r: { body: Record<string, unknown> | null }) => (r.body as Json | null)?.error as Json;

async function ok(res: Promise<{ status: number; body: Record<string, unknown> | null }>, status = 200) {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as Json;
}

const send = (as: TestClient, id: string, body: string, extra: Json = {}) =>
  as.request("POST", `/api/v1/ai-chats/${id}/messages`, {
    clientMessageId: cid(),
    body,
    model: PLAN_MODEL,
    ...extra,
  });
const stop = (as: TestClient, id: string, generationId: string) =>
  as.request("POST", `/api/v1/ai-chats/${id}/generations/${generationId}/stop`, {});
const regenerate = (as: TestClient, id: string) =>
  as.request("POST", `/api/v1/ai-chats/${id}/regenerate`, {});

async function settled(generationId: string, timeoutMs = 20_000): Promise<Json> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const g = (await su.query("select * from app.ai_generations where id = $1", [generationId])).rows[0];
    if (g && g.status !== "running") return g;
    if (Date.now() > until) throw new Error(`generation ${generationId} still running`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function streaming(generationId: string, timeoutMs = 10_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const g = (await su.query("select partial_text from app.ai_generations where id = $1", [generationId]))
      .rows[0];
    if (g && g.partial_text.length > 0) return;
    if (Date.now() > until) throw new Error(`generation ${generationId} never streamed`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const contextOf = async (messageId: string) =>
  (await su.query("select * from app.ai_message_context where message_id = $1", [messageId])).rows[0] as Json;

const generationRow = async (id: string) =>
  (await su.query("select * from app.ai_generations where id = $1", [id])).rows[0] as Json;

const runningIn = async (id: string) =>
  (await su.query("select * from app.ai_generations where conversation_id = $1 and status = 'running'", [id]))
    .rows as Json[];

const generationCount = async (id: string) =>
  (await su.query("select count(*)::int as n from app.ai_generations where conversation_id = $1", [id]))
    .rows[0].n as number;

const usageOf = async (generationId: string) =>
  (
    await su.query(
      "select requester_user_id from app.ai_usage_records where generation_id = $1 and kind = 'chat'",
      [generationId],
    )
  ).rows;

/** The texts of one Responses `input` item. */
function textOf(item: Json): string {
  if (typeof item.content === "string") return item.content;
  return (item.content as Json[]).map((c) => (typeof c.text === "string" ? c.text : "")).join("");
}

const lastUserText = (call: Json) =>
  textOf((call.body.input as Json[]).filter((i) => i.role === "user").at(-1)!);

const queues = (ws: ConvSubscription) => ws.durable(EventTypes.aiQueueUpdated).map((f) => f.data as Json);

const createdOn = (ws: ConvSubscription, messageId: string) =>
  ws
    .durable(EventTypes.messageCreated)
    .map((f) => (f.data as Json).message as Json)
    .find((m) => m.id === messageId);

async function meId(client: TestClient): Promise<string> {
  return ((await ok(client.request("GET", "/api/v1/me"))).user as Json).id as string;
}

/** Víctor's slow question: started now (201), streaming before it returns. */
async function slowQuestion(as: TestClient = victor, id: string = chatId): Promise<Json> {
  const res = await ok(send(as, id, "Explain the plan step by step [[slow]]"), 201);
  await streaming(res.generation.id);
  return res;
}

beforeAll(async () => {
  stack = await startAiStack();
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
  victorId = await meId(victor);
  ({ client: alex, userId: alexId } = await invite(
    stack,
    victor,
    "alex@example.test",
    "Alex Kim",
    "developer",
  ));
  ({ client: sam, userId: samId } = await invite(
    stack,
    victor,
    "sam@example.test",
    "Sam Rivera",
    "standard",
  ));
  await seedPlan(victor);
  await seedPlan(alex);
  await seedPlan(sam);

  const first = await ok(
    victor.request("POST", "/api/v1/ai-chats", {
      clientMessageId: cid(),
      body: "We are designing the billing service",
      model: PLAN_MODEL,
    }),
    201,
  );
  chatId = first.chat.id;
  await settled(first.generation.id);
  for (const id of [alexId, samId]) {
    await ok(
      victor.request("POST", `/api/v1/ai-chats/${chatId}/grants`, {
        subject: { kind: "user", id },
        level: "chat",
      }),
      201,
    );
  }
  victorConv = await subscribeConv(stack.baseUrl, victor, chatId);
  alexConv = await subscribeConv(stack.baseUrl, alex, chatId);
  samConv = await subscribeConv(stack.baseUrl, sam, chatId);
  for (const ws of [victorConv, alexConv, samConv]) expect(ws.outcome).toBe("subscribed");
}, 180_000);

afterAll(async () => {
  for (const ws of [victorConv, alexConv, samConv]) ws?.close();
  await su?.end();
  await stack?.stop();
});

describe("tracer: Alex asks while Víctor's answer streams; his message queues and the next answer starts on Alex's plan", () => {
  it("Alex's message is queued (202), everyone sees it and the queue; Víctor's answer ending starts Alex's turn in the same finalize", async () => {
    const v = await slowQuestion();
    stack.fake.reset();
    const posted = await ok(send(alex, chatId, "What about multi-tenancy?"), 202);
    expect(posted.addressing).toEqual({
      addressed: true,
      status: "queued",
      skipReason: null,
      generationId: null,
    });
    expect(posted.userMessage.aiAddressing).toMatchObject({ addressed: true, status: "queued" });
    expect(posted.userMessage.author).toMatchObject({ id: alexId, displayName: "Alex Kim" });
    expect(posted).not.toHaveProperty("generation");
    const alexMsg = posted.userMessage.id as string;

    for (const ws of [victorConv, alexConv, samConv]) {
      await ws.waitFor(() => createdOn(ws, alexMsg) !== undefined);
      expect(createdOn(ws, alexMsg)!.aiAddressing).toMatchObject({ addressed: true, status: "queued" });
      await ws.waitFor(() => queues(ws).some((q) => q.pending.some((p: Json) => p.messageId === alexMsg)));
      const q = queues(ws).find((x) => x.pending.some((p: Json) => p.messageId === alexMsg))!;
      expect(q).toEqual({
        conversationId: chatId,
        running: { generationId: v.generation.id, requesterUserId: victorId, respondingTo: [victorId] },
        pending: [{ messageId: alexMsg, authorId: alexId }],
      });
    }
    // The snapshot carries the same queue and the message's addressing.
    const snap = await ok(sam.request("GET", `/api/v1/ai-chats/${chatId}`));
    expect(snap.queue.pending).toEqual([{ messageId: alexMsg, authorId: alexId }]);
    expect(snap.messages.find((m: Json) => m.id === alexMsg).aiAddressing.status).toBe("queued");
    expect(withoutTitles(stack.fake.requests("responses"))).toHaveLength(0);

    expect((await settled(v.generation.id)).status).toBe("completed");
    // Same finalize transaction: the moment Víctor's answer is final, Alex's turn exists.
    const ctx = await contextOf(alexMsg);
    expect(ctx.answered_by_generation_id).not.toBeNull();
    const next = await generationRow(ctx.answered_by_generation_id);
    expect(next).toMatchObject({ requester_user_id: alexId, user_message_id: alexMsg });
    expect((await settled(next.id)).status).toBe("completed");

    const calls = withoutTitles(stack.fake.requests("responses"));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers.authorization).toMatch(new RegExp(`^Bearer fake-plan-${alexId}-`));
    const last = lastUserText(calls[0]!);
    expect(last).toContain(`<responding_to name="Alex Kim" user_id="${alexId}"/>`);
    expect(last.match(/<responding_to /gu)).toHaveLength(1);
    expect(await usageOf(next.id)).toEqual([{ requester_user_id: alexId }]);

    for (const ws of [victorConv, alexConv, samConv]) {
      await ws.waitFor(() => queues(ws).some((q) => q.running?.generationId === next.id));
      expect(queues(ws).find((q) => q.running?.generationId === next.id)).toEqual({
        conversationId: chatId,
        running: { generationId: next.id, requesterUserId: alexId, respondingTo: [alexId] },
        pending: [],
      });
      await ws.waitFor(() =>
        ws
          .durable(EventTypes.messageUpdated)
          .some((f) => (f.data as Json).message.id === next.assistant_message_id),
      );
    }
    const audits = (
      await su.query(
        "select * from app.audit_events where action = 'ai_generation.queued_started' and resource_id = $1",
        [chatId],
      )
    ).rows;
    expect(audits.map((a) => a.metadata)).toContainEqual({
      conversationId: chatId,
      generationId: next.id,
      requesterUserId: alexId,
      messageIds: [alexMsg],
    });
    const after = await ok(victor.request("GET", `/api/v1/ai-chats/${chatId}`));
    expect(after.messages.find((m: Json) => m.id === alexMsg).aiAddressing).toEqual({
      addressed: true,
      status: "answered",
      skipReason: null,
      generationId: next.id,
    });
  });

  it("coalescing: Sam then Víctor queue; ONE turn answers both, billed to Sam (the first waiting author) on Sam's plan", async () => {
    const v = await slowQuestion();
    const samMsg = (await ok(send(sam, chatId, "Sam asks about invoices"), 202)).userMessage.id as string;
    const victorMsg = (await ok(send(victor, chatId, "Víctor adds a follow-up"), 202)).userMessage
      .id as string;
    stack.fake.reset();
    const before = await generationCount(chatId);
    await settled(v.generation.id);
    const [a, b] = [await contextOf(samMsg), await contextOf(victorMsg)];
    expect(a.answered_by_generation_id).not.toBeNull();
    expect(b.answered_by_generation_id).toBe(a.answered_by_generation_id);
    expect(await generationCount(chatId)).toBe(before + 1);
    const g = await generationRow(a.answered_by_generation_id);
    expect(g).toMatchObject({ requester_user_id: samId, user_message_id: samMsg });
    await settled(g.id);

    const calls = withoutTitles(stack.fake.requests("responses"));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers.authorization).toMatch(new RegExp(`^Bearer fake-plan-${samId}-`));
    const last = lastUserText(calls[0]!);
    const samAt = last.indexOf(`<responding_to name="Sam Rivera" user_id="${samId}"/>`);
    const victorAt = last.indexOf(`<responding_to name="Víctor Ruiz" user_id="${victorId}"/>`);
    expect(samAt).toBeGreaterThan(-1);
    expect(victorAt).toBeGreaterThan(samAt);
    expect(last).toContain("Sam asks about invoices");
    expect(last).toContain("Víctor adds a follow-up");
    expect(await usageOf(g.id)).toEqual([{ requester_user_id: samId }]);
    await victorConv.waitFor(() => queues(victorConv).some((q) => q.running?.generationId === g.id));
    expect(queues(victorConv).find((q) => q.running?.generationId === g.id)!.running.respondingTo).toEqual([
      samId,
      victorId,
    ]);
  });

  it("addressing: askAi false and a mention of only people are just posted; askAi true or no mention answers; the request's mentions are ignored", async () => {
    stack.fake.reset();
    const before = await generationCount(chatId);
    const note = await ok(send(victor, chatId, "Just a note for the team", { askAi: false }), 202);
    expect(note.addressing).toEqual({
      addressed: false,
      status: "not_addressed",
      skipReason: null,
      generationId: null,
    });
    const toSam = await ok(send(alex, chatId, "@sam can you check the invoices?"), 202);
    expect(toSam.addressing.status).toBe("not_addressed");
    expect(toSam.userMessage.mentions).toEqual([{ kind: "user", id: samId }]);
    expect(
      (await su.query("select mentions from app.messages where id = $1", [toSam.userMessage.id])).rows[0],
    ).toEqual({ mentions: [{ kind: "user", id: samId }] });
    expect((await contextOf(toSam.userMessage.id)).addressed).toBe(false);
    await new Promise((r) => setTimeout(r, 300));
    expect(withoutTitles(stack.fake.requests("responses"))).toHaveLength(0);
    expect(await generationCount(chatId)).toBe(before);

    const asked = await ok(send(alex, chatId, "@sam and AI, what do you think?", { askAi: true }), 201);
    expect(asked.userMessage.aiAddressing).toMatchObject({ addressed: true, status: "answering" });
    expect(asked.generation.requesterUserId).toBe(alexId);
    await settled(asked.generation.id);

    // A client-sent mention list never decides addressing: the text mentions nobody, so the model is asked.
    const forged = await ok(
      send(sam, chatId, "Summarise please", { mentions: [{ kind: "user", id: alexId }] }),
      201,
    );
    expect(forged.userMessage.mentions).toEqual([]);
    await settled(forged.generation.id);
  });

  it(`the ${AI_QUEUE_MAX + 1}th pending addressed message is 429 ai_queue_full and nothing is posted`, async () => {
    const v = await slowQuestion();
    const queued: string[] = [];
    for (let i = 0; i < AI_QUEUE_MAX; i++) {
      queued.push(
        (await ok(send(i % 2 === 0 ? alex : sam, chatId, `queued question ${i}`), 202)).userMessage.id,
      );
    }
    const clientMessageId = cid();
    const full = await alex.request("POST", `/api/v1/ai-chats/${chatId}/messages`, {
      clientMessageId,
      body: "one too many",
      model: PLAN_MODEL,
    });
    expect(full.status).toBe(429);
    expect(errorOf(full).code).toBe("ai_queue_full");
    expect(
      (
        await su.query("select count(*)::int as n from app.messages where client_message_id = $1", [
          clientMessageId,
        ])
      ).rows[0].n,
    ).toBe(0);
    // A message that addresses nobody is still posted.
    await ok(send(alex, chatId, "fine, I'll wait", { askAi: false }), 202);

    await ok(stop(victor, chatId, v.generation.id), 202);
    await settled(v.generation.id);
    const next = await generationRow((await contextOf(queued[0]!)).answered_by_generation_id);
    expect(next.requester_user_id).toBe(alexId);
    const answered = (
      await su.query("select message_id from app.ai_message_context where answered_by_generation_id = $1", [
        next.id,
      ])
    ).rows.map((r) => r.message_id);
    expect(answered.sort()).toEqual([...queued].sort());
    await settled(next.id);
  });

  it("Sam without any usable model: his addressed message is posted and skipped (not_connected); nobody else's plan is tried", async () => {
    await ok(sam.request("DELETE", "/api/v1/me/model-credentials/chatgpt"));
    stack.fake.reset();
    const before = await generationCount(chatId);
    const res = await ok(send(sam, chatId, "Can the AI help me?"), 202);
    expect(res.addressing).toEqual({
      addressed: true,
      status: "skipped",
      skipReason: "not_connected",
      generationId: null,
    });
    const msg = res.userMessage.id as string;
    expect((await contextOf(msg)).skip_reason).toBe("not_connected");
    for (const ws of [victorConv, alexConv]) {
      await ws.waitFor(() => createdOn(ws, msg) !== undefined);
      await ws.waitFor(() =>
        ws
          .durable(EventTypes.messageUpdated)
          .some(
            (f) =>
              (f.data as Json).message.id === msg &&
              (f.data as Json).message.aiAddressing?.skipReason === "not_connected",
          ),
      );
    }
    expect(await generationCount(chatId)).toBe(before);
    expect(withoutTitles(stack.fake.requests("responses"))).toHaveLength(0);
    const snap = await ok(victor.request("GET", `/api/v1/ai-chats/${chatId}`));
    expect(snap.messages.find((m: Json) => m.id === msg).aiAddressing).toMatchObject({
      status: "skipped",
      skipReason: "not_connected",
    });
    expect(snap.queue.pending).toEqual([]);

    const next = await ok(send(victor, chatId, "Then I'll ask"), 201);
    expect(next.generation.requesterUserId).toBe(victorId);
    await settled(next.generation.id);
    await seedPlan(sam);
  });

  it("a queued author at the daily cap when their turn comes is skipped (daily_limit_reached) and the next author's turn starts", async () => {
    const v = await slowQuestion();
    const alexMsg = (await ok(send(alex, chatId, "Alex is over his limit"), 202)).userMessage.id as string;
    const samMsg = (await ok(send(sam, chatId, "Sam is not"), 202)).userMessage.id as string;
    await ok(victor.request("PUT", "/api/v1/ai-chat/policy", { planDailyGenerations: 500 }));
    await su.query(
      "update app.ai_usage_daily set generations = 500 where user_id = $1 and backend_class = 'chatgpt_plan'",
      [alexId],
    );
    try {
      await settled(v.generation.id);
      expect((await contextOf(alexMsg)).skip_reason).toBe("daily_limit_reached");
      const samCtx = await contextOf(samMsg);
      expect(samCtx.answered_by_generation_id).not.toBeNull();
      const g = await generationRow(samCtx.answered_by_generation_id);
      expect(g.requester_user_id).toBe(samId);
      await settled(g.id);
      const limit = (
        await su.query(
          "select * from app.audit_events where action = 'ai_chat.limit_reached' and resource_id = $1",
          [alexId],
        )
      ).rows;
      expect(limit).toHaveLength(1);
      expect(limit[0].user_id).toBe(alexId);
    } finally {
      await ok(victor.request("PUT", "/api/v1/ai-chat/policy", { planDailyGenerations: null }));
    }
  });

  it("a solo chat keeps Phase 5: a second send while generating is 409 and the response shape is unchanged", async () => {
    const created = await ok(
      sam.request("POST", "/api/v1/ai-chats", { clientMessageId: cid(), body: "Hello", model: PLAN_MODEL }),
      201,
    );
    await settled(created.generation.id);
    const soloId = created.chat.id as string;
    const slow = await ok(send(sam, soloId, "count [[slow]]"), 201);
    expect(Object.keys(slow).sort()).toEqual(["assistantMessage", "chat", "generation", "userMessage"]);
    expect(slow.userMessage).not.toHaveProperty("aiAddressing");
    const busy = await send(sam, soloId, "another one", { askAi: true });
    expect(busy.status).toBe(409);
    expect(errorOf(busy).code).toBe("generation_in_progress");
    const snap = await ok(sam.request("GET", `/api/v1/ai-chats/${soloId}`));
    expect(snap).not.toHaveProperty("queue");
    await ok(stop(sam, soloId, slow.generation.id), 202);
    await settled(slow.generation.id);
  });
});

/** A sweeper of a run loop that holds nothing (like an instance that just started). */
function freshSweeper() {
  const core = stack.built.core;
  const gateway = createModelGateway(core);
  const runLoop = createRunLoop(core, { gateway });
  return createGenerationSweeper(core, { runLoop, gateway });
}

/** A pending addressed message planted with the superuser, as if its process died before starting the turn. */
async function plantPending(authorId: string, body: string): Promise<string> {
  const bumped = await su.query(
    "update app.streams set last_seq = last_seq + 1 where id = $1 returning last_seq",
    [`conv:${chatId}`],
  );
  const seq = Number(bumped.rows[0].last_seq);
  const msg = await su.query(
    `insert into app.messages (organization_id, conversation_id, seq, author_kind, author_id, body)
     values ($1, $2, $3, 'user', $4, $5) returning id`,
    [orgId, chatId, seq, authorId, body],
  );
  const id = msg.rows[0].id as string;
  await su.query(
    `insert into app.ai_message_context (message_id, organization_id, conversation_id, author_kind, access, level,
       addressed, model, shared)
     values ($1, $2, $3, 'user', 'grant', 'chat', true, $4, true)`,
    [id, orgId, chatId, JSON.stringify(PLAN_MODEL)],
  );
  return id;
}

describe("the queue survives stops, crashes and other instances; regenerate waits for it (P-08)", () => {
  it("Víctor stops his own answer while Alex is queued: stopped, and Alex's turn starts at once; Sam may not stop it", async () => {
    const v = await slowQuestion();
    const alexMsg = (await ok(send(alex, chatId, "Queued behind a stop"), 202)).userMessage.id as string;
    const bySam = await stop(sam, chatId, v.generation.id);
    expect(bySam.status).toBe(403);
    expect(errorOf(bySam).code).toBe("not_generation_requester");
    await ok(stop(victor, chatId, v.generation.id), 202);
    expect((await settled(v.generation.id)).status).toBe("stopped");
    const ctx = await contextOf(alexMsg);
    expect(ctx.answered_by_generation_id).not.toBeNull();
    const g = await generationRow(ctx.answered_by_generation_id);
    expect(g.requester_user_id).toBe(alexId);
    expect((await settled(g.id)).status).toBe("completed");
  });

  it("regenerate with a pending queue is 409 queue_pending; once the queue drains it works", async () => {
    const v = await slowQuestion();
    const alexMsg = (await ok(send(alex, chatId, "Do not jump me"), 202)).userMessage.id as string;
    const refused = await regenerate(victor, chatId);
    expect(refused.status).toBe(409);
    expect(errorOf(refused).code).toBe("queue_pending");
    await settled(v.generation.id);
    const g = await generationRow((await contextOf(alexMsg)).answered_by_generation_id);
    await settled(g.id);
    const again = await ok(regenerate(alex, chatId), 201);
    expect(again.generation.requesterUserId).toBe(alexId);
    await settled(again.generation.id);
  });

  it("a pending queue left idle by a crash is started by one sweeper tick, on its author's plan", async () => {
    expect(await runningIn(chatId)).toEqual([]);
    const msg = await plantPending(samId, "Planted before a crash");
    stack.fake.reset();
    const sweeper = freshSweeper();
    let started: string | null = null;
    for (let i = 0; i < 3 && !started; i++) {
      await sweeper.runOnce();
      started = (await contextOf(msg)).answered_by_generation_id;
    }
    expect(started).not.toBeNull();
    const g = await generationRow(started!);
    expect(g.requester_user_id).toBe(samId);
    expect((await settled(g.id)).status).toBe("completed");
    const [call] = withoutTitles(stack.fake.requests("responses"));
    expect(call!.headers.authorization).toMatch(new RegExp(`^Bearer fake-plan-${samId}-`));
  });

  it("the sweeper never starts a second generation while one runs; the partial unique index is the backstop", async () => {
    const v = await slowQuestion();
    const msg = await plantPending(alexId, "Planted while running");
    await freshSweeper().runOnce();
    const live = await runningIn(chatId);
    expect(live.map((g) => g.id)).toEqual([v.generation.id]);
    expect((await contextOf(msg)).answered_by_generation_id).toBeNull();

    const dup = await su
      .query(
        `insert into app.ai_generations (organization_id, conversation_id, user_message_id, assistant_message_id,
           requester_user_id, backend, provider, model_id, attempt, status, partial_text, instance_id)
         values ($1, $2, $3, $4, $5, 'chatgpt_plan', 'openai', 'gpt-6-astra', 2, 'running', '', 'planted')`,
        [orgId, chatId, msg, v.assistantMessage.id, alexId],
      )
      .then(
        () => null,
        (err: { code?: string }) => err.code,
      );
    expect(dup).toBe("23505");
    await settled(v.generation.id);
    const g = await generationRow((await contextOf(msg)).answered_by_generation_id);
    expect(g.requester_user_id).toBe(alexId);
    await settled(g.id);
  });

  it("two instances: an answer streamed by B finalizes there and B starts the queued turn; A's subscriber gets its deltas", async () => {
    const second = await startSecondInstance(stack);
    try {
      const victorB = new TestClient(second.baseUrl);
      victorB.cookies = victor.cookies;
      const v = await ok(send(victorB, chatId, "From instance B [[slow]]"), 201);
      await streaming(v.generation.id);
      const alexMsg = (await ok(send(alex, chatId, "Queued on A"), 202)).userMessage.id as string;
      const onB = (await generationRow(v.generation.id)).instance_id as string;
      await settled(v.generation.id);
      const g = await generationRow((await contextOf(alexMsg)).answered_by_generation_id);
      expect(g.requester_user_id).toBe(alexId);
      expect(g.instance_id).toBe(onB);
      expect((await settled(g.id)).status).toBe("completed");
      await alexConv.waitFor(() => alexConv.deltas().some((d) => d.generationId === g.id));
    } finally {
      await second.stop();
    }
  });

  it("app.pending_ai_queues returns ids only, is not executable by PUBLIC and is executable by ocw_app", async () => {
    const res = await su.query("select * from app.pending_ai_queues(10)");
    expect(res.fields.map((f) => f.name)).toEqual(["organization_id", "conversation_id"]);
    const priv = (
      await su.query(
        `select has_function_privilege('public', 'app.pending_ai_queues(integer)', 'execute') as pub,
                has_function_privilege('ocw_app', 'app.pending_ai_queues(integer)', 'execute') as app,
                p.prosecdef as definer
           from pg_proc p where p.oid = 'app.pending_ai_queues(integer)'::regprocedure`,
      )
    ).rows[0];
    expect(priv).toEqual({ pub: false, app: true, definer: true });
  });
});
