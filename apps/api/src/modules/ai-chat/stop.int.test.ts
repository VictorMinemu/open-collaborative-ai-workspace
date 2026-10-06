import { randomUUID } from "node:crypto";
import { type AiDeltaEvent, EventTypes, estimateTokens } from "@ocw/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_SETUP_TOKEN, TestClient } from "../../testing";
import { type AiStack, seedPlan, startAiStack, startSecondInstance, subscribeConv } from "../../testing-ai";
import { invite } from "../../testing-workzone";
import { createModelGateway } from "../model-gateway";
import { ABORT_CHANNEL } from "./generations";
import { createRunLoop } from "./run-loop";
import { createGenerationSweeper } from "./sweeper";

/**
 * The generation lifecycle (05-06, D-05): Stop crosses API instances through Redis and keeps the partial answer;
 * one generation per chat; the sweeper finalizes answers whose process died; a closing instance finalizes its own
 * answers as interrupted; the per-user concurrency cap. Two API instances on one PostgreSQL + Redis, in-process fake.
 */

let stack: AiStack;
let second: Awaited<ReturnType<typeof startSecondInstance>>;
let su: pg.Client;
let admin: TestClient;
let sam: TestClient;
/** Sam's session on instance B. */
let samB: TestClient;
let alex: TestClient;
let samId: string;
let orgId: string;
/** Every raw message seen on the abort channel. */
const abortMessages: string[] = [];

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

const createChat = (as: TestClient, body: string) =>
  as.request("POST", "/api/v1/ai-chats", { clientMessageId: cid(), body, model: PLAN_MODEL });
const send = (as: TestClient, chatId: string, body: string) =>
  as.request("POST", `/api/v1/ai-chats/${chatId}/messages`, {
    clientMessageId: cid(),
    body,
    model: PLAN_MODEL,
  });
const stop = (as: TestClient, chatId: string, generationId: string) =>
  as.request("POST", `/api/v1/ai-chats/${chatId}/generations/${generationId}/stop`, {});

const generation = async (id: string) =>
  (await su.query("select * from app.ai_generations where id = $1", [id])).rows[0] as Json;

async function settled(generationId: string, timeoutMs = 15_000): Promise<Json> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const g = await generation(generationId);
    if (g && g.status !== "running") return g;
    if (Date.now() > until) throw new Error(`generation ${generationId} still running`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const audit = async (action: string) =>
  (await su.query("select * from app.audit_events where action = $1 order by occurred_at", [action])).rows;

const usageOf = async (generationId: string) =>
  (
    await su.query("select * from app.ai_usage_records where generation_id = $1 and kind = 'chat'", [
      generationId,
    ])
  ).rows;

/** Durable `message.updated` events of one message on its chat stream. */
const updatesOf = async (chatId: string, messageId: string) =>
  (
    await su.query(
      `select seq, payload from app.stream_events
       where stream_id = $1 and type = $2 and payload->'message'->>'id' = $3 order by seq`,
      [`conv:${chatId}`, EventTypes.messageUpdated, messageId],
    )
  ).rows as Array<{ seq: string; payload: Json }>;

/** The concatenated text of contiguous deltas from offset 0 (throws on a hole or an overlap). */
function joined(deltas: AiDeltaEvent[]): string {
  let text = "";
  for (const d of [...deltas].sort((a, b) => a.offset - b.offset)) {
    if (d.offset !== text.length) throw new Error(`delta chain broken at ${d.offset} (have ${text.length})`);
    text += d.text;
  }
  return text;
}

/** A chat of Sam's with one finished turn (so a later slow send can be watched from its first delta). */
async function readyChat(as: TestClient = sam): Promise<string> {
  const created = await ok(createChat(as, "hello there"), 201);
  await settled(created.generation.id);
  return created.chat.id as string;
}

/**
 * A `running` generation planted with the superuser (no process holds it): a user turn plus a streaming answer,
 * `partial_text`, `instance_id` and a heartbeat `ageSeconds` old.
 */
async function plantRunning(
  chatId: string,
  opts: { partial: string; ageSeconds: number; instanceId: string },
): Promise<{ generationId: string; messageId: string }> {
  const bumped = await su.query(
    "update app.streams set last_seq = last_seq + 2 where id = $1 returning last_seq",
    [`conv:${chatId}`],
  );
  const last = Number(bumped.rows[0].last_seq);
  const user = await su.query(
    `insert into app.messages (organization_id, conversation_id, seq, author_kind, author_id, body)
     values ($1, $2, $3, 'user', $4, 'a planted question') returning id`,
    [orgId, chatId, last - 1, samId],
  );
  const answer = await su.query(
    `insert into app.messages (organization_id, conversation_id, seq, author_kind, author_id, body, status)
     values ($1, $2, $3, 'agent', null, '', 'streaming') returning id`,
    [orgId, chatId, last],
  );
  const gen = await su.query(
    `insert into app.ai_generations (organization_id, conversation_id, user_message_id, assistant_message_id,
       requester_user_id, backend, provider, model_id, attempt, status, partial_text, instance_id, heartbeat_at)
     values ($1, $2, $3, $4, $5, 'chatgpt_plan', 'openai', 'gpt-6-astra', 1, 'running', $6, $7,
       now() - make_interval(secs => $8)) returning id`,
    [
      orgId,
      chatId,
      user.rows[0].id,
      answer.rows[0].id,
      samId,
      opts.partial,
      opts.instanceId,
      opts.ageSeconds,
    ],
  );
  return { generationId: gen.rows[0].id as string, messageId: answer.rows[0].id as string };
}

/** A sweeper of a run loop that holds nothing (like an instance that just started). */
function freshSweeper() {
  const core = stack.built.core;
  const runLoop = createRunLoop(core, { gateway: createModelGateway(core) });
  return createGenerationSweeper(core, { runLoop });
}

beforeAll(async () => {
  stack = await startAiStack();
  second = await startSecondInstance(stack);
  await second.built.core.bus.subscribe(ABORT_CHANNEL, (m) => void abortMessages.push(m));
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
  ({ client: sam, userId: samId } = await invite(stack, admin, "sam@example.test", "Sam Rivera", "standard"));
  ({ client: alex } = await invite(stack, admin, "alex@example.test", "Alex Kim", "standard"));
  samB = new TestClient(second.baseUrl);
  samB.cookies = sam.cookies;
  await seedPlan(sam);
});

afterAll(async () => {
  await su?.end();
  await second?.stop();
  await stack?.stop();
});

describe("Stop crosses API instances and keeps the partial answer (D-05, AICHAT-03)", () => {
  it("a slow answer started on A and stopped through B ends Stopped with exactly the text streamed so far", async () => {
    const chatId = await readyChat();
    const ws = await subscribeConv(stack.baseUrl, sam, chatId);
    const slow = await ok(send(sam, chatId, "count [[slow]]"), 201);
    const gid = slow.generation.id as string;
    const mid = slow.assistantMessage.id as string;
    await ws.waitFor(() => ws.deltas().filter((d) => d.generationId === gid).length >= 3);

    // While it runs, the chat refuses a second message (one generation per conversation).
    const busy = await send(sam, chatId, "and another one");
    expect(busy.status).toBe(409);
    expect(errorOf(busy).code).toBe("generation_in_progress");

    const at = Date.now();
    const res = await ok(stop(samB, chatId, gid), 202);
    expect(["running", "stopped"]).toContain(res.status);
    const final = () =>
      ws
        .durable(EventTypes.messageUpdated)
        .map((f) => (f.data as Json).message as Json)
        .find((m) => m.id === mid && m.generation?.status !== "running");
    await ws.waitFor(() => final() !== undefined, 2_000);
    expect(Date.now() - at).toBeLessThan(2_000);
    const message = final() as Json;
    expect(message.status).toBe("completed");
    expect(message.generation.status).toBe("stopped");

    const streamed = joined(ws.deltas().filter((d) => d.generationId === gid));
    expect(message.body.length).toBeGreaterThan(0);
    expect(message.body).toBe(streamed);
    expect(message.body).not.toMatch(/ 40$/u);
    // No delta after the final message.
    const finalAt = ws.frames.findIndex(
      (f) =>
        f.op === "ev" &&
        f.type === EventTypes.messageUpdated &&
        ((f.data as Json).message as Json).id === mid,
    );
    expect(
      ws.frames.slice(finalAt).some((f) => f.op === "eph" && (f.data as Json).generationId === gid),
    ).toBe(false);

    const g = await generation(gid);
    expect(g).toMatchObject({ status: "stopped", finish_reason: "abort", partial_text: message.body });
    const [usage, ...more] = await usageOf(gid);
    expect(more).toHaveLength(0);
    expect(usage.estimated).toBe(true);
    expect(usage.output_tokens).toBe(estimateTokens(message.body));
    expect(message.generation.usage).toMatchObject({ estimated: true, outputTokens: usage.output_tokens });

    const audits = (await audit("ai_generation.stopped")).filter((a) => a.metadata.generationId === gid);
    expect(audits).toHaveLength(1);
    expect(audits[0].metadata).toEqual({ conversationId: chatId, generationId: gid });
    expect(audits[0].organization_id).toBe(orgId);

    // Idempotent: a second stop answers the final status and audits nothing.
    expect(await ok(stop(sam, chatId, gid), 202)).toEqual({ status: "stopped" });
    expect(
      (await audit("ai_generation.stopped")).filter((a) => a.metadata.generationId === gid),
    ).toHaveLength(1);

    // The abort hint on Redis carries the two ids only.
    const hints = abortMessages.map((m) => JSON.parse(m) as Json).filter((m) => m.generationId === gid);
    expect(hints.length).toBeGreaterThanOrEqual(1);
    for (const h of hints) expect(Object.keys(h).sort()).toEqual(["generationId", "organizationId"]);
    expect(hints[0]).toEqual({ organizationId: orgId, generationId: gid });

    // The chat takes the next message again.
    const next = await ok(send(sam, chatId, "now something short"), 201);
    expect((await settled(next.generation.id)).status).toBe("completed");
    ws.close();
  });

  it("stopped text is kept in the snapshot of either instance", async () => {
    const chatId = await readyChat();
    const slow = await ok(send(samB, chatId, "count from B [[slow]]"), 201);
    const gid = slow.generation.id as string;
    // Held by B, stopped through A.
    await new Promise((r) => setTimeout(r, 600));
    await ok(stop(sam, chatId, gid), 202);
    const g = await settled(gid, 3_000);
    expect(g.status).toBe("stopped");
    for (const as of [sam, samB]) {
      const snap = await ok(as.request("GET", `/api/v1/ai-chats/${chatId}`));
      const answer = (snap.messages as Json[]).find((m) => m.id === slow.assistantMessage.id) as Json;
      expect(answer.status).toBe("completed");
      expect(answer.generation.status).toBe("stopped");
      expect(answer.body).toBe(g.partial_text);
      expect(answer.body.length).toBeGreaterThan(0);
      expect(snap.running).toBeNull();
    }
  });

  it("nobody else can stop Sam's answer: Alex, the admin and a foreign generation id get 404", async () => {
    const chatId = await readyChat();
    const slow = await ok(send(sam, chatId, "keep going [[slow]]"), 201);
    const gid = slow.generation.id as string;
    for (const as of [alex, admin]) {
      const res = await stop(as, chatId, gid);
      expect(res.status).toBe(404);
    }
    // A generation of another chat of Sam's under this chat's id is not this chat's.
    const other = await readyChat();
    expect((await stop(sam, other, gid)).status).toBe(404);
    expect((await stop(sam, chatId, randomUUID())).status).toBe(404);
    expect((await generation(gid)).status).toBe("running");
    await ok(stop(sam, chatId, gid), 202);
    await settled(gid, 3_000);
  });
});

describe("crashed and closing instances never leave an answer spinning (D-05, P-07)", () => {
  it("the sweeper finalizes a dead instance's stale generation as interrupted with its partial text", async () => {
    const chatId = await readyChat();
    const planted = await plantRunning(chatId, {
      partial: "half an answer",
      ageSeconds: 120,
      instanceId: `dead-${randomUUID()}`,
    });
    const liveChat = await readyChat();
    const live = await plantRunning(liveChat, { partial: "still going", ageSeconds: 1, instanceId: "live" });

    const swept = await freshSweeper().runOnce();
    expect(swept).toBeLessThanOrEqual(1);

    const g = await generation(planted.generationId);
    expect(g).toMatchObject({
      status: "interrupted",
      error_code: "interrupted",
      partial_text: "half an answer",
    });
    const msg = (await su.query("select body, status from app.messages where id = $1", [planted.messageId]))
      .rows[0];
    expect(msg).toEqual({ body: "half an answer", status: "completed" });
    const updates = await updatesOf(chatId, planted.messageId);
    expect(updates).toHaveLength(1);
    expect(updates[0]?.payload.message).toMatchObject({
      body: "half an answer",
      status: "completed",
      generation: { status: "interrupted", errorCode: "interrupted", usage: { estimated: true } },
    });
    const usage = await usageOf(planted.generationId);
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ estimated: true, output_tokens: estimateTokens("half an answer") });
    const snap = await ok(sam.request("GET", `/api/v1/ai-chats/${chatId}`));
    expect(snap.running).toBeNull();

    // A fresh heartbeat is left alone.
    expect((await generation(live.generationId)).status).toBe("running");
    expect(await usageOf(live.generationId)).toHaveLength(0);
    await su.query("update app.ai_generations set status = 'failed' where id = $1", [live.generationId]);
  });

  it("two sweepers at once finalize each stale row exactly once", async () => {
    const a = await plantRunning(await readyChat(), { partial: "one", ageSeconds: 90, instanceId: "gone-1" });
    const b = await plantRunning(await readyChat(), { partial: "two", ageSeconds: 90, instanceId: "gone-2" });
    const [n1, n2] = await Promise.all([freshSweeper().runOnce(), freshSweeper().runOnce()]);
    expect(n1 + n2).toBeLessThanOrEqual(2);
    for (const p of [a, b]) {
      expect((await generation(p.generationId)).status).toBe("interrupted");
      expect(await usageOf(p.generationId)).toHaveLength(1);
      const chat = (await generation(p.generationId)).conversation_id as string;
      expect(await updatesOf(chat, p.messageId)).toHaveLength(1);
    }
  });

  it("closing an instance mid-answer finalizes it as interrupted with its partial text", async () => {
    const third = await startSecondInstance(stack);
    const samC = new TestClient(third.baseUrl);
    samC.cookies = sam.cookies;
    const chatId = await readyChat();
    const ws = await subscribeConv(stack.baseUrl, sam, chatId);
    const slow = await ok(send(samC, chatId, "count until shutdown [[slow]]"), 201);
    const gid = slow.generation.id as string;
    await ws.waitFor(() => ws.deltas().filter((d) => d.generationId === gid).length >= 3);
    const at = Date.now();
    await third.stop();
    const g = await settled(gid, 5_000);
    expect(Date.now() - at).toBeLessThan(5_000);
    expect(g.status).toBe("interrupted");
    expect(g.partial_text.length).toBeGreaterThan(0);
    const snap = await ok(sam.request("GET", `/api/v1/ai-chats/${chatId}`));
    const answer = (snap.messages as Json[]).find((m) => m.id === slow.assistantMessage.id) as Json;
    expect(answer).toMatchObject({ status: "completed", body: g.partial_text });
    expect(answer.generation).toMatchObject({ status: "interrupted", usage: { estimated: true } });
    expect(snap.running).toBeNull();
    ws.close();
  });

  it("Sam's fourth simultaneous answer is 429 concurrent_generations and goes through once one ends", async () => {
    const running = await Promise.all([1, 2, 3].map((i) => ok(createChat(sam, `cap ${i} [[slow]]`), 201)));
    const fourth = await createChat(sam, "cap 4 [[slow]]");
    expect(fourth.status).toBe(429);
    expect(errorOf(fourth).code).toBe("concurrent_generations");
    const [first, ...rest] = running;
    await ok(stop(sam, first?.chat.id, first?.generation.id), 202);
    await settled(first?.generation.id, 3_000);
    const retry = await ok(createChat(sam, "cap 4 [[slow]]"), 201);
    for (const r of [...rest, retry]) await ok(stop(sam, r.chat.id, r.generation.id), 202);
    for (const r of [...rest, retry]) expect((await settled(r.generation.id, 3_000)).status).toBe("stopped");
  });

  it("app.stale_ai_generations returns ids only and is not executable by PUBLIC", async () => {
    const res = await su.query("select * from app.stale_ai_generations(10, now())");
    expect(res.fields.map((f) => f.name)).toEqual(["id", "organization_id"]);
    const priv = await su.query(
      `select has_function_privilege('public', 'app.stale_ai_generations(integer, timestamptz)', 'execute') as pub,
              has_function_privilege('ocw_app', 'app.stale_ai_generations(integer, timestamptz)', 'execute') as app,
              p.prosecdef as definer, p.proconfig as config
       from pg_proc p where p.oid = 'app.stale_ai_generations(integer, timestamptz)'::regprocedure`,
    );
    expect(priv.rows[0]).toMatchObject({ pub: false, app: true, definer: true });
    expect(priv.rows[0].config).toContain("search_path=pg_catalog, pg_temp");
  });
});
