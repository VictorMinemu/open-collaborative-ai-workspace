import { randomUUID } from "node:crypto";
import { EventTypes } from "@ocw/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_SETUP_TOKEN, TestClient } from "../../../testing";
import { type AiStack, seedPlan, startAiStack, subscribeConv } from "../../../testing-ai";
import { invite } from "../../../testing-workzone";

/**
 * Every "Sign in with ChatGPT – ChatGPT plan usage" error code maps to one generation outcome and one credential
 * state (05-07, D-02, Pitfall 5). A failed plan turn is never retried and never re-routed to an organization key:
 * the member chooses. Real PostgreSQL + Redis, the in-process fake for the plan, SIWC and Anthropic.
 */

let stack: AiStack;
let su: pg.Client;
let admin: TestClient;
let sam: TestClient;
let alex: TestClient;
let samId: string;
let alexId: string;

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
type Json = Record<string, any>;

const PLAN_MODEL = { backend: "chatgpt_plan", provider: "openai", modelId: "gpt-6-astra" } as const;
const SONNET = { backend: "org_key", provider: "anthropic", modelId: "claude-sonnet-5-5" } as const;
const ANTHROPIC_KEY = "sk-ant-planerrors-SECRET-0123456789-q1Wx";
const STATUS = "/api/v1/me/model-credentials/chatgpt";
const WELCOME_SEEN = "/api/v1/me/model-credentials/chatgpt/welcome-seen";

const cid = () => `cm-${randomUUID()}`;
const errorOf = (r: { body: Record<string, unknown> | null }) => (r.body as Json | null)?.error as Json;

async function ok(res: Promise<{ status: number; body: Record<string, unknown> | null }>, status = 200) {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as Json;
}

async function settled(generationId: string, timeoutMs = 15_000): Promise<Json> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const g = (await su.query("select * from app.ai_generations where id = $1", [generationId])).rows[0];
    if (g && g.status !== "running") return g;
    if (Date.now() > until) throw new Error(`generation ${generationId} still running`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const credential = async (userId: string) =>
  (await su.query("select * from app.user_model_credentials where user_id = $1", [userId])).rows[0] as
    | Json
    | undefined;
const messageOf = async (id: string) =>
  (await su.query("select * from app.messages where id = $1", [id])).rows[0] as Json;
const usageOf = async (generationId: string) =>
  (await su.query("select * from app.ai_usage_records where generation_id = $1", [generationId])).rows;

/** A chat with one completed plan exchange, so a test can subscribe before its failing turn. */
async function planChat(as: TestClient): Promise<string> {
  const created = await ok(
    as.request("POST", "/api/v1/ai-chats", { clientMessageId: cid(), body: "Warm up", model: PLAN_MODEL }),
    201,
  );
  expect((await settled(created.generation.id)).status).toBe("completed");
  return created.chat.id;
}

const send = (as: TestClient, chatId: string, body: string, model: Json = PLAN_MODEL) =>
  as.request("POST", `/api/v1/ai-chats/${chatId}/messages`, { clientMessageId: cid(), body, model });

/** Sends one plan turn and returns the settled generation, the assistant message and the request counts it caused. */
async function failingTurn(as: TestClient, chatId: string, body: string) {
  stack.fake.reset();
  const res = await ok(send(as, chatId, body), 201);
  const g = await settled(res.generation.id);
  // Give a (forbidden) retry or fallback the time it would need to show up at the fake.
  await new Promise((r) => setTimeout(r, 300));
  return {
    res,
    g,
    msg: await messageOf(res.assistantMessage.id),
    responses: stack.fake.requests("responses").length,
    anthropic: stack.fake.requests("anthropic").length,
  };
}

const planRows = (list: Json) => list.models.filter((m: Json) => m.group === "chatgpt_plan");
const orgRows = (list: Json) => list.models.filter((m: Json) => m.group === "organization");

beforeAll(async () => {
  stack = await startAiStack();
  su = new pg.Client({ connectionString: stack.db.superuserUrl });
  await su.connect();
  admin = new TestClient(stack.baseUrl);
  await ok(
    admin.request("POST", "/api/v1/setup", {
      token: TEST_SETUP_TOKEN,
      name: "Víctor Ruiz",
      email: "victor@example.test",
      password: "correct-horse-battery",
      orgName: "Autofy Labs",
    }),
  );
  ({ client: sam, userId: samId } = await invite(stack, admin, "sam@example.test", "Sam Rivera", "standard"));
  ({ client: alex, userId: alexId } = await invite(
    stack,
    admin,
    "alex@example.test",
    "Alex Kim",
    "standard",
  ));
  // The admin configured Anthropic: an organization model is available as the alternative to the plan.
  await ok(
    admin.request("POST", "/api/v1/model-providers", {
      provider: "anthropic",
      apiKey: ANTHROPIC_KEY,
      baseUrl: stack.fake.baseUrl,
      allowedModels: ["claude-sonnet-5-5"],
    }),
  );
  await seedPlan(sam);
  await seedPlan(alex);
});

afterAll(async () => {
  await su?.end();
  await stack?.stop();
});

describe("a usage limit mid-answer keeps the partial text and never switches billing (D-02, Pitfall 5)", () => {
  it("three deltas stream, then the message fails with usage_limit_exceeded and keeps the partial body", async () => {
    const chatId = await planChat(sam);
    const ws = await subscribeConv(stack.baseUrl, sam, chatId);
    expect(ws.outcome).toBe("subscribed");
    const { res, g, msg, responses, anthropic } = await failingTurn(
      sam,
      chatId,
      "hello [[plan:usage_limit]]",
    );
    const messageId = res.assistantMessage.id;

    await ws.waitFor(() =>
      ws.durable(EventTypes.messageUpdated).some((f) => (f.data as Json).message.id === messageId),
    );
    // The fake streams exactly three pieces ("Echo", ": he", "llo"); the run loop may coalesce them into fewer
    // frames (P-06, 50 ms), so the frames are asserted by content and offsets.
    const deltas = ws.deltas().filter((d) => d.messageId === messageId);
    expect(deltas.length).toBeGreaterThan(0);
    let offset = 0;
    for (const d of deltas) {
      expect(d.offset).toBe(offset);
      offset += d.text.length;
    }
    const partial = deltas.map((d) => d.text).join("");
    expect(partial).toBe("Echo: hello");

    const updated = ws
      .durable(EventTypes.messageUpdated)
      .find((f) => (f.data as Json).message.id === messageId)?.data as Json;
    expect(updated.message).toMatchObject({ status: "failed", body: partial });
    expect(updated.message.generation).toMatchObject({
      status: "failed",
      errorCode: "usage_limit_exceeded",
      errorParam: null,
      backend: "chatgpt_plan",
      metered: false,
    });
    expect(msg).toMatchObject({ status: "failed", body: partial });
    expect(g).toMatchObject({ status: "failed", error_code: "usage_limit_exceeded" });

    // One plan request, no retry; nothing went to the organization's Anthropic key.
    expect(responses).toBe(1);
    expect(anthropic).toBe(0);

    // The usage record exists and costs the organization nothing. The fake's `response.failed` reports usage (as
    // the Responses API does), so the counts are the reported ones rather than an estimate.
    const usage = await usageOf(g.id);
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ cost_micros_usd: null, backend: "chatgpt_plan" });
    expect(usage[0].output_tokens).toBeGreaterThan(0);
    expect(updated.message.generation.usage).toMatchObject({ costMicrosUsd: null });
    ws.close();
  });

  it("the credential stays connected and the plan stays the default model", async () => {
    expect((await credential(samId))?.status).toBe("connected");
    expect((await ok(sam.request("GET", STATUS))).state).toBe("connected");
    const list = await ok(sam.request("GET", "/api/v1/ai-chat/models"));
    expect(list.defaultRef).toMatchObject({ backend: "chatgpt_plan" });
    expect(orgRows(list).some((m: Json) => m.available && m.ref.modelId === SONNET.modelId)).toBe(true);
  });

  it("only an explicit org-model send reaches Anthropic, labelled METERED", async () => {
    const chatId = await planChat(sam);
    stack.fake.reset();
    const res = await ok(send(sam, chatId, "now on the organization model", SONNET), 201);
    const g = await settled(res.generation.id);
    expect(g).toMatchObject({ status: "completed", backend: "org_key" });
    expect(stack.fake.requests("anthropic").length).toBeGreaterThan(0);
    expect(stack.fake.requests("responses")).toHaveLength(0);
    expect(res.generation.metered).toBe(true);
  });
});
