import { randomUUID } from "node:crypto";
import { EventTypes } from "@ocw/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../app";
import { createEnvFileSecretStore } from "../../lib/secret-store";
import { TEST_SETUP_TOKEN, TestClient } from "../../testing";
import { type AiStack, seedPlan, startAiStack, subscribeConv, withoutTitles } from "../../testing-ai";
import { invite } from "../../testing-workzone";

/**
 * API tracer of Phase 5 (05-02): a member's ChatGPT-plan turn goes POST /ai-chats → model gateway (his own token)
 * → AI SDK streamText → fake POST /v1/responses → coalesced `ai.delta` frames on `conv:<id>` → a WebSocket
 * subscriber, then one durable final message with a usage record. Real PostgreSQL + Redis, in-process fake.
 */

let stack: AiStack;
let su: pg.Client;
let admin: TestClient;
let sam: TestClient;
let alex: TestClient;
let samId: string;
let alexId: string;
let orgId: string;

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
type Json = Record<string, any>;

const PLAN_MODEL = { backend: "chatgpt_plan", provider: "openai", modelId: "gpt-6-astra" } as const;
const FORBIDDEN = [
  "max_output_tokens",
  "temperature",
  "top_p",
  "metadata",
  "user",
  "truncation",
  "previous_response_id",
  "prompt_cache_retention",
  "safety_identifier",
  "background",
  "conversation",
  "max_tool_calls",
];

const cid = () => `cm-${randomUUID()}`;
/** Prompt text that must never reach a log line. */
const MARKER = "zebra-quokka-confidential-merger";
const errorOf = (r: { body: Record<string, unknown> | null }) => (r.body as Json | null)?.error as Json;

async function ok(res: Promise<{ status: number; body: Record<string, unknown> | null }>, status = 200) {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as Json;
}

const createChat = (as: TestClient, body: string, extra: Json = {}) =>
  as.request("POST", "/api/v1/ai-chats", { clientMessageId: cid(), body, model: PLAN_MODEL, ...extra });
const send = (as: TestClient, chatId: string, body: string, extra: Json = {}) =>
  as.request("POST", `/api/v1/ai-chats/${chatId}/messages`, {
    clientMessageId: cid(),
    body,
    model: PLAN_MODEL,
    ...extra,
  });

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

/** Every key and string value at any depth of a JSON value. */
function walk(v: unknown, keys: string[] = [], values: string[] = []): { keys: string[]; values: string[] } {
  if (Array.isArray(v)) for (const x of v) walk(x, keys, values);
  else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      keys.push(k);
      walk(x, keys, values);
    }
  } else if (typeof v === "string") values.push(v);
  return { keys, values };
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
  ({ client: alex, userId: alexId } = await invite(
    stack,
    admin,
    "alex@example.test",
    "Alex Kim",
    "standard",
  ));
});

afterAll(async () => {
  await su?.end();
  await stack?.stop();
});

describe("ChatGPT plan models (D-01, D-02)", () => {
  it("before seeding Sam sees one unavailable plan row (not_connected); the default is not a plan model", async () => {
    const list = await ok(sam.request("GET", "/api/v1/ai-chat/models"));
    expect(list.chatgptPlan.state).toBe("not_connected");
    const plan = list.models.filter((m: Json) => m.group === "chatgpt_plan");
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({
      group: "chatgpt_plan",
      available: false,
      reason: "not_connected",
    });
    // 05-04: with OCW_MODEL_PROVIDER=mock the mock backend is the only available model (no org key configured).
    expect(list.models.filter((m: Json) => m.group !== "chatgpt_plan").map((m: Json) => m.group)).toEqual([
      "mock",
    ]);
    expect(list.defaultRef).toEqual({ backend: "mock", provider: "mock", modelId: "mock-1" });
  });

  it("Sam seeds his plan: the two `list` models, connected, default on the plan; tokens sealed, never plaintext", async () => {
    const status = await seedPlan(sam);
    expect(status).toMatchObject({ state: "connected", email: "sam@example.test" });
    const list = await ok(sam.request("GET", "/api/v1/ai-chat/models"));
    expect(list.chatgptPlan.state).toBe("connected");
    const plan = list.models.filter((m: Json) => m.group === "chatgpt_plan");
    expect(plan.map((m: Json) => m.ref.modelId)).toEqual(["gpt-6-astra", "gpt-5.6-luna"]);
    expect(plan.map((m: Json) => m.label)).toEqual(["GPT-6 Astra", "GPT-5.6 Luna"]);
    expect(plan.every((m: Json) => m.available && !m.metered)).toBe(true);
    expect(list.defaultRef).toEqual(PLAN_MODEL);
    expect(JSON.stringify(list)).not.toContain("fake-plan-");

    const cred = (await su.query("select * from app.user_model_credentials where user_id = $1", [samId]))
      .rows[0];
    expect(cred).toMatchObject({ status: "connected", provider: "chatgpt_plan" });
    const secret = (await su.query("select * from app.secrets where id = $1", [cred.secret_id])).rows[0];
    expect(secret.kind).toBe("user_model_credential");
    expect(JSON.stringify(secret)).not.toContain("fake-plan-");
    expect(JSON.stringify(secret)).not.toContain("fake-refresh-");
    const connected = await audit("ai_credential.connected");
    expect(connected).toHaveLength(1);
    expect(connected[0].metadata).toEqual({ provider: "chatgpt_plan", source: "test_seed" });

    const me = await ok(sam.request("GET", "/api/v1/me/model-credentials/chatgpt"));
    expect(me.state).toBe("connected");
  });
});

describe("a plan turn streams over the WebSocket and persists with a usage record", () => {
  let chatId: string;

  it("POST /ai-chats: 201 with the chat, the user message, a streaming assistant message and a running generation", async () => {
    stack.fake.reset();
    const res = await createChat(sam, "Plan the quarterly offsite agenda\nwith details");
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const body = res.body as Json;
    chatId = body.chat.id;
    expect(body.chat).toMatchObject({ title: "Plan the quarterly offsite", titleSource: "heuristic" });
    expect(body.chat.lastModel).toEqual(PLAN_MODEL);
    expect(body.userMessage).toMatchObject({ authorKind: "user", authorId: samId, status: "sent" });
    expect(body.assistantMessage).toMatchObject({
      authorKind: "agent",
      authorId: null,
      status: "streaming",
      body: "",
      author: { kind: "agent", id: null, displayName: "GPT-6 Astra" },
    });
    expect(body.assistantMessage.seq).toBe(body.userMessage.seq + 1);
    expect(body.generation).toMatchObject({
      status: "running",
      backend: "chatgpt_plan",
      provider: "openai",
      modelId: "gpt-6-astra",
      metered: false,
      attempt: 1,
      usage: null,
    });
    expect(body.assistantMessage.generation.id).toBe(body.generation.id);

    const done = await settled(body.generation.id);
    expect(done.status).toBe("completed");
    const msg = (await su.query("select * from app.messages where id = $1", [body.assistantMessage.id]))
      .rows[0];
    expect(msg.status).toBe("completed");
    expect(msg.body).toBe("Echo: Plan the quarterly offsite agenda with details");

    const conv = (await su.query("select * from app.conversations where id = $1", [chatId])).rows[0];
    expect(conv).toMatchObject({ kind: "ai_chat", visibility: "private" });
    const members = (
      await su.query("select * from app.conversation_members where conversation_id = $1", [chatId])
    ).rows;
    expect(members).toEqual([
      expect.objectContaining({ member_kind: "user", member_id: samId, role: "owner" }),
    ]);
  });

  it("the fake saw exactly one /v1/responses call with Sam's own bearer, store:false, stream:true, a developer item and no forbidden key", async () => {
    const calls = withoutTitles(stack.fake.requests("responses"));
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.headers.authorization).toMatch(new RegExp(`^Bearer fake-plan-${samId}-`));
    expect(call.body?.store).toBe(false);
    expect(call.body?.stream).toBe(true);
    expect(call.body?.model).toBe("gpt-6-astra");
    const input = call.body?.input as Json[];
    expect(input[0]).toMatchObject({ role: "developer" });
    expect(JSON.stringify(input[0])).toContain("You are chatting with Sam Rivera in Autofy Labs");
    expect(input.some((i) => i.role === "system")).toBe(false);
    for (const key of FORBIDDEN) expect(call.body, key).not.toHaveProperty(key);
  });

  it("one immutable usage record: backend, provider, model, tokens, requester; plan cost null", async () => {
    const gen = (await su.query("select * from app.ai_generations where conversation_id = $1", [chatId]))
      .rows;
    expect(gen).toHaveLength(1);
    const usage = (await su.query("select * from app.ai_usage_records where generation_id = $1", [gen[0].id]))
      .rows;
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({
      kind: "chat",
      backend: "chatgpt_plan",
      provider: "openai",
      model_id: "gpt-6-astra",
      requester_user_id: samId,
      conversation_id: chatId,
      estimated: false,
      cost_micros_usd: null,
    });
    expect(usage[0].input_tokens).toBeGreaterThan(0);
    expect(usage[0].output_tokens).toBeGreaterThan(0);
  });

  it("a follow-up streams as ai.delta frames chained from offset 0, then message.updated equal to the joined deltas", async () => {
    const ws = await subscribeConv(stack.baseUrl, sam, chatId);
    expect(ws.outcome).toBe("subscribed");
    stack.fake.reset();
    const res = await send(sam, chatId, "count for me [[slow]]");
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const { assistantMessage, generation: gen } = res.body as Json;

    // While it runs, the body stays empty and partial text goes to ai_generations (P-06).
    await ws.waitFor(() => ws.deltas().length >= 3);
    await new Promise((r) => setTimeout(r, 1_200));
    const midway = (await su.query("select body from app.messages where id = $1", [assistantMessage.id]))
      .rows[0];
    expect(midway.body).toBe("");
    expect((await generation(gen.id)).partial_text.length).toBeGreaterThan(0);

    await ws.waitFor(
      () =>
        ws
          .durable(EventTypes.messageUpdated)
          .some((f) => (f.data as Json).message.id === assistantMessage.id),
      15_000,
    );
    const deltas = ws.deltas().filter((d) => d.messageId === assistantMessage.id);
    expect(deltas.length).toBeGreaterThan(3);
    let offset = 0;
    for (const d of deltas) {
      expect(d).toMatchObject({ conversationId: chatId, generationId: gen.id, offset });
      offset += d.text.length;
    }
    const final = ws
      .durable(EventTypes.messageUpdated)
      .find((f) => (f.data as Json).message.id === assistantMessage.id)!.data as Json;
    const joined = deltas.map((d) => d.text).join("");
    expect(final.message.body).toBe(joined);
    expect(joined).toBe(`Echo: count for me${Array.from({ length: 40 }, (_, i) => ` ${i + 1}`).join("")}`);
    expect(final.message).toMatchObject({ status: "completed" });
    expect(final.message.generation).toMatchObject({ id: gen.id, status: "completed" });
    expect(final.message.generation.usage).toMatchObject({ estimated: false, costMicrosUsd: null });
    expect(final.message.generation.usage.outputTokens).toBeGreaterThan(0);
    expect(final.message.generation.finishedAt).toEqual(expect.any(String));
    ws.close();
  });

  it("the snapshot after completion returns both turns of each exchange and running: null", async () => {
    const snap = await ok(sam.request("GET", `/api/v1/ai-chats/${chatId}`));
    expect(snap.chat).toMatchObject({ id: chatId, generating: false, archived: false });
    expect(snap.chat.settings).toEqual({
      instructions: "",
      usePersonalInstructions: true,
      tools: { web: false },
    });
    expect(snap.chat.tools.map((t: Json) => t.key)).toEqual(["web", "companyKnowledge", "mcp", "skills"]);
    expect(snap.chat.tools.find((t: Json) => t.key === "mcp")).toMatchObject({
      enabled: false,
      available: false,
      reason: "not_available_yet",
    });
    expect(snap.chat.viewerCan).toEqual(expect.arrayContaining(["ai_chat.use"]));
    expect(snap.messages).toHaveLength(4);
    expect(snap.messages.map((m: Json) => m.authorKind)).toEqual(["user", "agent", "user", "agent"]);
    expect(snap.messages[1].generation.status).toBe("completed");
    expect(snap.running).toBeNull();
    expect(snap.hasMore).toBe(false);
    expect(snap.lastSeq).toBeGreaterThanOrEqual(snap.messages.at(-1).seq);

    const page = await ok(
      sam.request("GET", `/api/v1/ai-chats/${chatId}/messages?before=${snap.messages[2].seq}`),
    );
    expect(page.messages.map((m: Json) => m.id)).toEqual([snap.messages[0].id, snap.messages[1].id]);
    expect(page.nextBefore).toBeNull();
  });
});

describe("one generation per conversation, idempotent sends, a per-member cap (D-05, P-07)", () => {
  it("a second send while an answer is running is 409 generation_in_progress", async () => {
    const created = await ok(createChat(sam, "long one [[slow]]"), 201);
    const second = await send(sam, created.chat.id, "and another");
    expect(second.status).toBe(409);
    expect(errorOf(second).code).toBe("generation_in_progress");
    await settled(created.generation.id);
    const third = await send(sam, created.chat.id, "now it works");
    expect(third.status).toBe(201);
    await settled((third.body as Json).generation.id);
  });

  it("a retried POST with the same clientMessageId returns the same ids and starts no second generation", async () => {
    const clientMessageId = cid();
    const body = { clientMessageId, body: "idempotent please", model: PLAN_MODEL };
    const first = await ok(sam.request("POST", "/api/v1/ai-chats", body), 201);
    const again = await ok(sam.request("POST", "/api/v1/ai-chats", body), 201);
    expect(again.chat.id).toBe(first.chat.id);
    expect(again.userMessage.id).toBe(first.userMessage.id);
    expect(again.assistantMessage.id).toBe(first.assistantMessage.id);
    expect(again.generation.id).toBe(first.generation.id);
    await settled(first.generation.id);

    const followId = cid();
    const followBody = { clientMessageId: followId, body: "follow-up", model: PLAN_MODEL };
    const f1 = await ok(sam.request("POST", `/api/v1/ai-chats/${first.chat.id}/messages`, followBody), 201);
    const f2 = await ok(sam.request("POST", `/api/v1/ai-chats/${first.chat.id}/messages`, followBody), 201);
    expect(f2.userMessage.id).toBe(f1.userMessage.id);
    expect(f2.generation.id).toBe(f1.generation.id);
    await settled(f1.generation.id);
    const gens = await su.query(
      "select count(*)::int as n from app.ai_generations where conversation_id = $1",
      [first.chat.id],
    );
    expect(gens.rows[0].n).toBe(2);
  });

  it("a fourth simultaneous slow generation across four chats is 429 concurrent_generations", async () => {
    const running = await Promise.all([1, 2, 3].map((i) => ok(createChat(sam, `slow ${i} [[slow]]`), 201)));
    const fourth = await createChat(sam, "slow 4 [[slow]]");
    expect(fourth.status).toBe(429);
    expect(errorOf(fourth).code).toBe("concurrent_generations");
    for (const r of running) await settled(r.generation.id);
  });
});

describe("another member never uses Sam's plan (D-01, T-05-02-01)", () => {
  it("Alex (no credential) gets 409 model_unavailable not_connected and the fake sees no request for him", async () => {
    stack.fake.reset();
    const res = await createChat(alex, "use Sam's plan please");
    expect(res.status).toBe(409);
    expect(errorOf(res)).toMatchObject({ code: "model_unavailable", details: { reason: "not_connected" } });
    expect(withoutTitles(stack.fake.requests())).toEqual([]);
    const created = await su.query("select count(*)::int as n from app.ai_chats where owner_user_id = $1", [
      alexId,
    ]);
    expect(created.rows[0].n).toBe(0);
  });
});

describe("audit (ids, backend, provider and model only)", () => {
  it("ai_chat.created and ai_chat.message.sent carry no body at any depth", async () => {
    const created = await audit("ai_chat.created");
    const sent = await audit("ai_chat.message.sent");
    expect(created.length).toBeGreaterThan(0);
    expect(sent.length).toBeGreaterThan(0);
    for (const row of [...created, ...sent]) {
      expect(row.organization_id).toBe(orgId);
      expect(Object.keys(row.metadata).sort()).toEqual(
        ["attempt", "backend", "conversationId", "generationId", "modelId", "provider"].sort(),
      );
      const { values } = walk(row.metadata);
      expect(values.join(" ")).not.toMatch(/quarterly|idempotent|slow|Echo/u);
    }
  });
});

describe("AI chats are private to their owner (P-03, T-05-02-03/04)", () => {
  let samChat: string;

  beforeAll(async () => {
    const created = await ok(createChat(sam, `Summarize ${MARKER} for me`), 201);
    samChat = created.chat.id;
    await settled(created.generation.id);
  });

  it("Alex and the admin get 404 on every route of Sam's chat", async () => {
    for (const who of [alex, admin]) {
      const snap = await who.request("GET", `/api/v1/ai-chats/${samChat}`);
      expect(snap.status).toBe(404);
      expect(errorOf(snap).message).toBe("AI chat not found");
      expect((await who.request("GET", `/api/v1/ai-chats/${samChat}/messages`)).status).toBe(404);
      const post = await send(who, samChat, "let me in");
      expect(post.status).toBe(404);
      expect(JSON.stringify(snap.body)).not.toContain(MARKER);
    }
    // A missing id reads exactly the same.
    const missing = await alex.request("GET", `/api/v1/ai-chats/${randomUUID()}`);
    expect(missing.status).toBe(404);
    expect(errorOf(missing).message).toBe("AI chat not found");
  });

  it("Alex and the admin cannot subscribe to conv:<samChat>; Sam can", async () => {
    for (const who of [alex, admin]) {
      const ws = await subscribeConv(stack.baseUrl, who, samChat);
      expect(ws.outcome).toBe("error");
      ws.close();
    }
    const own = await subscribeConv(stack.baseUrl, sam, samChat);
    expect(own.outcome).toBe("subscribed");
    own.close();
  });

  it("the generic chat routes never post into or read an AI chat, not even for its owner", async () => {
    for (const who of [sam, admin]) {
      const post = await who.request("POST", `/api/v1/conversations/${samChat}/messages`, { body: "sneaky" });
      expect(post.status).toBe(404);
      expect((await who.request("GET", `/api/v1/conversations/${samChat}/messages`)).status).toBe(404);
    }
    const sneaky = await su.query("select count(*)::int as n from app.messages where body = 'sneaky'");
    expect(sneaky.rows[0].n).toBe(0);
    // Sidebars stay unchanged: AI chats are not in the default readable kinds.
    const dms = await ok(sam.request("GET", "/api/v1/dms"));
    expect(JSON.stringify(dms)).not.toContain(samChat);
  });

  it("org B's admin gets 404 on Sam's chat and never sees org A's plan state", async () => {
    const email = `eve-${randomUUID().slice(0, 8)}@example.test`;
    const inv = await ok(admin.request("POST", "/api/v1/invitations", { email, role: "standard" }));
    const eve = new TestClient(stack.baseUrl);
    const accepted = await ok(
      eve.request("POST", `/api/v1/invitations/${inv.id}/accept`, {
        name: "Eve",
        password: "eve-long-password-1",
      }),
    );
    const eveId: string = accepted.user.id;
    const orgB = randomUUID();
    await su.query("insert into auth.organization (id, name, slug) values ($1, 'Evil', $2)", [
      orgB,
      `evil-${orgB}`,
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

    expect((await eve.request("GET", `/api/v1/ai-chats/${samChat}`)).status).toBe(404);
    expect((await send(eve, samChat, "cross-tenant")).status).toBe(404);
    const ws = await subscribeConv(stack.baseUrl, eve, samChat);
    expect(ws.outcome).toBe("error");
    ws.close();
    const models = await ok(eve.request("GET", "/api/v1/ai-chat/models"));
    expect(models.chatgptPlan.state).toBe("not_connected");
    expect(
      models.models.filter((m: Json) => m.group === "chatgpt_plan").every((m: Json) => !m.available),
    ).toBe(true);
    const status = await ok(eve.request("GET", "/api/v1/me/model-credentials/chatgpt"));
    expect(status).toMatchObject({ state: "not_connected", email: null });
  });

  it("without the ChatGPT override (the production shape) the test seed route does not exist", async () => {
    const env = { ...stack.env, OCW_CHATGPT_API_BASE_URL: null };
    const built = await buildApp(env, { logger: false, secretStore: createEnvFileSecretStore({}) });
    await built.app.listen({ host: "127.0.0.1", port: 0 });
    try {
      const addr = built.app.server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      const other = new TestClient(`http://127.0.0.1:${port}`);
      other.cookies = new Map(sam.cookies);
      expect((await other.request("GET", "/api/v1/me/model-credentials/chatgpt")).status).toBe(200);
      expect((await other.request("POST", "/api/v1/test/ai/chatgpt-plan", {})).status).toBe(404);
      expect(built.authz.routes.has("POST /api/v1/test/ai/chatgpt-plan")).toBe(false);
    } finally {
      await built.close();
    }
    expect(stack.built.authz.routes.has("POST /api/v1/test/ai/chatgpt-plan")).toBe(true);
  });
});

describe("provider failures finalize cleanly (Pitfall 5, P-10)", () => {
  it("a mid-stream usage limit fails the generation, keeps the partial text and records usage", async () => {
    const created = await ok(createChat(sam, "hello [[plan:usage_limit]]"), 201);
    const g = await settled(created.generation.id);
    expect(g).toMatchObject({ status: "failed", error_code: "usage_limit_exceeded" });
    const msg = (await su.query("select * from app.messages where id = $1", [created.assistantMessage.id]))
      .rows[0];
    expect(msg.status).toBe("failed");
    expect(msg.body.length).toBeGreaterThan(0);
    expect("Echo: hello".startsWith(msg.body) || msg.body.startsWith("Echo")).toBe(true);
    const usage = await su.query("select * from app.ai_usage_records where generation_id = $1", [g.id]);
    expect(usage.rows).toHaveLength(1);
    const line = stack.logs.find((l) => l.includes("ai generation failed"));
    expect(line).toBeDefined();
    const logged = JSON.parse(line as string);
    expect(logged).toMatchObject({ code: "usage_limit_exceeded", provider: "chatgpt_plan" });
    expect(line).not.toContain("hello");
    // The member's plan is still connected: a usage limit is not a credential problem.
    expect((await ok(sam.request("GET", "/api/v1/me/model-credentials/chatgpt"))).state).toBe("connected");
  });

  it("an invalid-user refusal fails the generation and moves the credential to needs_reconnect", async () => {
    const created = await ok(createChat(sam, "hi [[plan:invalid_user]]"), 201);
    const g = await settled(created.generation.id);
    expect(g).toMatchObject({ status: "failed", error_code: "invalid_credential" });
    expect((await ok(sam.request("GET", "/api/v1/me/model-credentials/chatgpt"))).state).toBe(
      "needs_reconnect",
    );
    const refused = await createChat(sam, "again");
    expect(refused.status).toBe(409);
    expect(errorOf(refused)).toMatchObject({
      code: "model_unavailable",
      details: { reason: "needs_reconnect" },
    });
    await seedPlan(sam);
    expect((await ok(sam.request("GET", "/api/v1/me/model-credentials/chatgpt"))).state).toBe("connected");
  });
});

describe("logs (last: covers every turn above)", () => {
  it("no API log line carries a token, a refresh token or prompt text (T-05-02-02)", () => {
    expect(stack.logs.length).toBeGreaterThan(0);
    const all = stack.logs.join("\n");
    expect(all).not.toContain("fake-plan-");
    expect(all).not.toContain("fake-refresh-");
    expect(all).not.toContain(MARKER);
    expect(all).not.toContain("quarterly offsite");
  });
});
