import { randomUUID } from "node:crypto";
import { type AiDeltaEvent, estimateTokens, EventTypes } from "@ocw/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_SETUP_TOKEN, TestClient } from "../../testing";
import { type AiStack, seedPlan, startAiStack, startSecondInstance, subscribeConv } from "../../testing-ai";
import { invite } from "../../testing-workzone";
import { ABORT_CHANNEL } from "./generations";

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
  as.request("POST", `/api/v1/ai-chats/${chatId}/messages`, { clientMessageId: cid(), body, model: PLAN_MODEL });
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
  (await su.query("select * from app.ai_usage_records where generation_id = $1", [generationId])).rows;

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
      (f) => f.op === "ev" && f.type === EventTypes.messageUpdated && ((f.data as Json).message as Json).id === mid,
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
    expect((await audit("ai_generation.stopped")).filter((a) => a.metadata.generationId === gid)).toHaveLength(1);

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
