import { randomUUID } from "node:crypto";
import { EventTypes } from "@ocw/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_SETUP_TOKEN, TestClient } from "../../testing";
import { type AiStack, seedPlan, startAiStack, subscribeConv, withoutTitles } from "../../testing-ai";
import { invite } from "../../testing-workzone";

/**
 * Regenerate (05-06, AICHAT-02, AICHAT-03): the last answer streams again on the same message — on the same model
 * or another one — while the replaced text is kept append-only in `message_versions` (kind `regenerate`). One
 * generation per chat, owner only (hidden = 404), audited without bodies.
 */

let stack: AiStack;
let su: pg.Client;
let admin: TestClient;
let sam: TestClient;
let alex: TestClient;
let samId: string;
let orgId: string;

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
type Json = Record<string, any>;

const PLAN_MODEL = { backend: "chatgpt_plan", provider: "openai", modelId: "gpt-6-astra" } as const;
const MOCK = { backend: "mock", provider: "mock", modelId: "mock-1" } as const;
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
const regenerate = (as: TestClient, chatId: string, body: Json = {}) =>
  as.request("POST", `/api/v1/ai-chats/${chatId}/regenerate`, body);

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

const versionsOf = async (messageId: string) =>
  (await su.query("select * from app.message_versions where message_id = $1 order by version", [messageId]))
    .rows;
const usageFor = async (messageId: string) =>
  (
    await su.query(
      "select * from app.ai_usage_records where message_id = $1 and kind = 'chat' order by created_at",
      [messageId],
    )
  ).rows;
const bodyOf = async (messageId: string) =>
  (await su.query("select body, status from app.messages where id = $1", [messageId])).rows[0] as Json;

/** A chat of Sam's with two finished turns; returns the chat and the second (last) answer. */
async function twoTurns(): Promise<{ chatId: string; first: Json; last: Json }> {
  const created = await ok(createChat(sam, "first question"), 201);
  await settled(created.generation.id);
  const next = await ok(send(sam, created.chat.id, "second question"), 201);
  await settled(next.generation.id);
  return { chatId: created.chat.id, first: created.assistantMessage, last: next.assistantMessage };
}

beforeAll(async () => {
  stack = await startAiStack();
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
  await seedPlan(sam);
});

afterAll(async () => {
  await su?.end();
  await stack?.stop();
});

describe("regenerate the last answer (AICHAT-03)", () => {
  it("streams the same message again from offset 0 and keeps the replaced answer in message_versions", async () => {
    const { chatId, last } = await twoTurns();
    const oldBody = (await bodyOf(last.id)).body as string;
    expect(oldBody).toMatch(/^Echo: second question/u);
    const [firstUsage] = await usageFor(last.id);
    const ws = await subscribeConv(stack.baseUrl, sam, chatId);
    stack.fake.reset();

    const res = await ok(regenerate(sam, chatId, { messageId: last.id }), 201);
    expect(res.assistantMessage.id).toBe(last.id);
    expect(res.assistantMessage.status).toBe("streaming");
    expect(res.assistantMessage.body).toBe("");
    expect(res.userMessage.body).toBe("second question");
    expect(res.generation).toMatchObject({ attempt: 2, status: "running", ...PLAN_MODEL });
    expect(res.chat.generating).toBe(true);
    const gid = res.generation.id as string;

    // The replaced answer, append-only, attributed to Sam.
    const versions = await versionsOf(last.id);
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({
      kind: "regenerate",
      version: 1,
      body: oldBody,
      edited_by_kind: "user",
      edited_by: samId,
      organization_id: orgId,
    });

    const g = await settled(gid);
    expect(g.status).toBe("completed");
    await ws.waitFor(() =>
      ws
        .durable(EventTypes.messageUpdated)
        .some(
          (f) =>
            ((f.data as Json).message as Json).generation?.id === gid &&
            (f.data as Json).message.status === "completed",
        ),
    );
    const updates = ws
      .durable(EventTypes.messageUpdated)
      .map((f) => (f.data as Json).message as Json)
      .filter((m) => m.id === last.id && m.generation?.id === gid);
    expect(updates[0]).toMatchObject({ status: "streaming", body: "", generation: { attempt: 2 } });
    const final = updates.at(-1) as Json;
    expect(final).toMatchObject({ status: "completed", generation: { status: "completed", attempt: 2 } });
    const deltas = ws.deltas().filter((d) => d.generationId === gid);
    expect(deltas[0]?.offset).toBe(0);
    expect(deltas.map((d) => d.text).join("")).toBe(final.body);
    expect(final.body).toBe((await bodyOf(last.id)).body);

    // A second usage record; the first is untouched.
    const usage = await usageFor(last.id);
    expect(usage).toHaveLength(2);
    expect(usage[0]).toEqual(firstUsage);
    expect(usage[1]).toMatchObject({ generation_id: gid, kind: "chat" });

    // The prompt ends with the last user turn and never carries the replaced answer.
    const calls = withoutTitles(stack.fake.requests("responses"));
    expect(calls).toHaveLength(1);
    const input = calls[0]?.body?.input as Json[];
    const lastItem = input.at(-1) as Json;
    expect(lastItem.role).toBe("user");
    expect(JSON.stringify(lastItem)).toContain("second question");
    expect(JSON.stringify(input)).toContain("Echo: first question");
    expect(JSON.stringify(input)).not.toContain(oldBody);
    ws.close();

    // The snapshot shows the new answer with attempt 2.
    const snap = await ok(sam.request("GET", `/api/v1/ai-chats/${chatId}`));
    const answer = (snap.messages as Json[]).find((m) => m.id === last.id) as Json;
    expect(answer.generation).toMatchObject({ id: gid, attempt: 2 });
  });

  it("Regenerate with… another model runs the new generation on that backend", async () => {
    const { chatId, last } = await twoTurns();
    stack.fake.reset();
    const res = await ok(regenerate(sam, chatId, { messageId: last.id, model: MOCK }), 201);
    expect(res.generation).toMatchObject({
      backend: "mock",
      provider: "mock",
      modelId: "mock-1",
      attempt: 2,
    });
    const g = await settled(res.generation.id);
    expect(g).toMatchObject({ status: "completed", backend: "mock", model_id: "mock-1" });
    expect(withoutTitles(stack.fake.requests("openai"))).toHaveLength(1);
    expect(withoutTitles(stack.fake.requests("responses"))).toHaveLength(0);
    const chat = (await su.query("select last_model from app.ai_chats where conversation_id = $1", [chatId]))
      .rows[0];
    expect(chat.last_model).toEqual(MOCK);
    // Plain Regenerate keeps the previous generation's model (now the mock); version 2 keeps the mock answer.
    const again = await ok(regenerate(sam, chatId, {}), 201);
    expect(again.generation).toMatchObject({ ...MOCK, attempt: 3 });
    await settled(again.generation.id);
    const versions = await versionsOf(last.id);
    expect(versions.map((v) => v.version)).toEqual([1, 2]);
  });

  it("refuses an older answer, a running generation, a missing answer and an unavailable model (409)", async () => {
    const { chatId, first, last } = await twoTurns();
    const older = await regenerate(sam, chatId, { messageId: first.id });
    expect(older.status).toBe(409);
    expect(errorOf(older).code).toBe("not_last_answer");

    const unavailable = await regenerate(sam, chatId, {
      messageId: last.id,
      model: { backend: "org_key", provider: "anthropic", modelId: "claude-sonnet-5-5" },
    });
    expect(unavailable.status).toBe(409);
    expect(errorOf(unavailable).code).toBe("model_unavailable");

    const slow = await ok(send(sam, chatId, "count [[slow]]"), 201);
    const busy = await regenerate(sam, chatId, {});
    expect(busy.status).toBe(409);
    expect(errorOf(busy).code).toBe("generation_in_progress");

    // A stopped last answer can be regenerated.
    await ok(
      sam.request("POST", `/api/v1/ai-chats/${chatId}/generations/${slow.generation.id}/stop`, {}),
      202,
    );
    expect((await settled(slow.generation.id, 3_000)).status).toBe("stopped");
    const afterStop = await ok(regenerate(sam, chatId, { messageId: slow.assistantMessage.id }), 201);
    expect(afterStop.generation.attempt).toBe(2);
    expect((await versionsOf(slow.assistantMessage.id))[0]?.body).toBe(
      (await generation(slow.generation.id)).partial_text,
    );
    await settled(afterStop.generation.id);

    // The last message is a user turn without an answer: nothing to regenerate.
    const bumped = await su.query(
      "update app.streams set last_seq = last_seq + 1 where id = $1 returning last_seq",
      [`conv:${chatId}`],
    );
    await su.query(
      `insert into app.messages (organization_id, conversation_id, seq, author_kind, author_id, body)
       values ($1, $2, $3, 'user', $4, 'unanswered')`,
      [orgId, chatId, bumped.rows[0].last_seq, samId],
    );
    const nothing = await regenerate(sam, chatId, {});
    expect(nothing.status).toBe(409);
    expect(errorOf(nothing).code).toBe("nothing_to_regenerate");
  });

  it("a failed last answer can be regenerated", async () => {
    const created = await ok(createChat(sam, "hello [[plan:unavailable]]"), 201);
    expect((await settled(created.generation.id)).status).toBe("failed");
    const res = await ok(regenerate(sam, created.chat.id, {}), 201);
    expect(res.assistantMessage.id).toBe(created.assistantMessage.id);
    expect(res.generation.attempt).toBe(2);
    await settled(res.generation.id);
  });

  it("nobody else can regenerate Sam's answer: Alex and the admin get 404, nothing changes", async () => {
    const { chatId, last } = await twoTurns();
    for (const as of [alex, admin]) {
      const res = await regenerate(as, chatId, { messageId: last.id });
      expect(res.status).toBe(404);
    }
    expect(await versionsOf(last.id)).toHaveLength(0);
    expect(
      (
        await su.query("select count(*)::int as n from app.ai_generations where assistant_message_id = $1", [
          last.id,
        ])
      ).rows[0].n,
    ).toBe(1);
  });

  it("ai_chat.regenerated is audited with ids, backend, provider, model and attempt only", async () => {
    const rows = (
      await su.query(
        "select * from app.audit_events where action = 'ai_chat.regenerated' order by occurred_at",
      )
    ).rows;
    expect(rows.length).toBeGreaterThanOrEqual(4);
    for (const row of rows) {
      expect(row.organization_id).toBe(orgId);
      expect(Object.keys(row.metadata).sort()).toEqual(
        ["attempt", "backend", "conversationId", "generationId", "messageId", "modelId", "provider"].sort(),
      );
      expect(JSON.stringify(row.metadata)).not.toMatch(/question|Echo|count/u);
    }
  });
});
