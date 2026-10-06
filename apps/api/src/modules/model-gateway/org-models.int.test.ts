import { randomUUID } from "node:crypto";
import { estimateCostMicros, EventTypes } from "@ocw/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../app";
import { createEnvFileSecretStore } from "../../lib/secret-store";
import { TEST_SETUP_TOKEN, TestClient } from "../../testing";
import { type AiStack, seedPlan, startAiStack, subscribeConv } from "../../testing-ai";
import { invite } from "../../testing-workzone";

/**
 * Organization keys and the mock backend in AI chats (05-04, D-01, D-03, D-07, P-04, P-11): an admin's provider
 * key, stored as a `db` SecretReference, reaches a member's AI chat through the model gateway; every org model is
 * METERED, the bots' `openai-codex` sign-in never shows up, and each provider kind speaks its own wire API to the
 * in-process fake. Real PostgreSQL + Redis; no real provider is ever called.
 */

let stack: AiStack;
let su: pg.Client;
let admin: TestClient;
let sam: TestClient;
let samId: string;
let orgId: string;

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
type Json = Record<string, any>;

const ANTHROPIC_KEY = "sk-ant-orgmodels-SECRET-0123456789-k7Qz";
const OPENAI_KEY = "sk-openai-orgmodels-SECRET-0123456789-p2Lm";
const OPENROUTER_KEY = "sk-or-orgmodels-SECRET-0123456789-r8Xy";
const COMPATIBLE_KEY = "compat-orgmodels-SECRET-0123456789-c4Vw";

const PLAN_MODEL = { backend: "chatgpt_plan", provider: "openai", modelId: "gpt-6-astra" } as const;
const SONNET = { backend: "org_key", provider: "anthropic", modelId: "claude-sonnet-5-5" } as const;
const MOCK = { backend: "mock", provider: "mock", modelId: "mock-1" } as const;

const cid = () => `cm-${randomUUID()}`;
const errorOf = (r: { body: Record<string, unknown> | null }) => (r.body as Json | null)?.error as Json;

async function ok(res: Promise<{ status: number; body: Record<string, unknown> | null }>, status = 200) {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as Json;
}

const createChat = (as: TestClient, body: string, model: Json = PLAN_MODEL) =>
  as.request("POST", "/api/v1/ai-chats", { clientMessageId: cid(), body, model });
const send = (as: TestClient, chatId: string, body: string, model: Json) =>
  as.request("POST", `/api/v1/ai-chats/${chatId}/messages`, { clientMessageId: cid(), body, model });

const upsert = (body: Json) => admin.request("POST", "/api/v1/model-providers", body);

async function settled(generationId: string, timeoutMs = 15_000): Promise<Json> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const g = (await su.query("select * from app.ai_generations where id = $1", [generationId])).rows[0];
    if (g && g.status !== "running") return g;
    if (Date.now() > until) throw new Error(`generation ${generationId} still running`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const usageOf = async (generationId: string) =>
  (await su.query("select * from app.ai_usage_records where generation_id = $1", [generationId])).rows;

const providerRow = async (provider: string) =>
  (await su.query("select * from app.model_providers where provider = $1", [provider])).rows[0] as Json;

/** One org-key turn in a fresh chat; returns the settled generation and the created response. */
async function orgTurn(model: Json, text = "Hello from the org key") {
  const created = await ok(createChat(sam, text, model), 201);
  const g = await settled(created.generation.id);
  expect(g.status, JSON.stringify(g)).toBe("completed");
  return { created, g };
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
  await seedPlan(sam);
});

afterAll(async () => {
  await su?.end();
  await stack?.stop();
});

describe("an admin's Anthropic key reaches a member's AI chat through its SecretReference (D-03, D-07)", () => {
  it("the upsert stores the key sealed and writes secret_ref = {db, secretId, organizationId} (secret_id in sync)", async () => {
    const dto = await ok(
      upsert({
        provider: "anthropic",
        apiKey: ANTHROPIC_KEY,
        baseUrl: stack.fake.baseUrl,
        allowedModels: ["claude-sonnet-5-5", "claude-haiku-4-5"],
      }),
    );
    expect(dto).toMatchObject({ provider: "anthropic", hasKey: true, keyHint: ANTHROPIC_KEY.slice(-4) });
    expect(JSON.stringify(dto)).not.toContain(ANTHROPIC_KEY);
    const row = await providerRow("anthropic");
    expect(row.secret_id).toEqual(expect.any(String));
    expect(row.secret_ref).toEqual({ provider: "db", secretId: row.secret_id, organizationId: orgId });
    const secret = (await su.query("select * from app.secrets where id = $1", [row.secret_id])).rows[0];
    expect(secret.kind).toBe("provider_api_key");
    expect(JSON.stringify(secret)).not.toContain(ANTHROPIC_KEY);
  });

  it("GET /model-providers shows hasKey and a 4-char hint, never the key", async () => {
    const list = await ok(admin.request("GET", "/api/v1/model-providers"));
    const a = list.providers.find((p: Json) => p.provider === "anthropic");
    expect(a).toMatchObject({ hasKey: true, keyHint: ANTHROPIC_KEY.slice(-4) });
    expect(a.keyHint).toHaveLength(4);
    expect(JSON.stringify(list)).not.toContain(ANTHROPIC_KEY);
  });

  it("Sam's models: Claude Sonnet 5.5 and Haiku 4.5 METERED in `organization`, mock in `mock`; never openai-codex", async () => {
    // The bots' ChatGPT subscription (signed in through the cell) is not an AI chat model (P-14).
    await su.query(
      `insert into app.model_providers (organization_id, provider, allowed_models, enabled, account)
       values ($1, 'openai-codex', '{gpt-6-astra,gpt-5.6-luna}', true, $2)`,
      [
        orgId,
        JSON.stringify({
          email: "victor@example.test",
          planType: "pro",
          connectedAt: new Date().toISOString(),
          needsReconnect: false,
        }),
      ],
    );
    const list = await ok(sam.request("GET", "/api/v1/ai-chat/models"));
    const org = list.models.filter((m: Json) => m.group === "organization");
    expect(org.map((m: Json) => m.ref)).toEqual([
      SONNET,
      { backend: "org_key", provider: "anthropic", modelId: "claude-haiku-4-5" },
    ]);
    expect(org.map((m: Json) => m.label)).toEqual(["Claude Sonnet 5.5", "Claude Haiku 4.5"]);
    for (const m of org) {
      expect(m).toMatchObject({ metered: true, available: true, reason: null, providerLabel: "Anthropic" });
      expect(m.caps).toEqual({ vision: true, pdf: true, webSearch: "function" });
    }
    const mock = list.models.filter((m: Json) => m.group === "mock");
    expect(mock).toHaveLength(1);
    expect(mock[0]).toMatchObject({ ref: MOCK, metered: false, available: true });
    expect(list.models.some((m: Json) => m.ref.provider === "openai-codex")).toBe(false);
    // Plan rows still come first and the default stays on the member's own plan.
    expect(list.models[0].group).toBe("chatgpt_plan");
    expect(list.defaultRef).toEqual(PLAN_MODEL);
    expect(JSON.stringify(list)).not.toContain(ANTHROPIC_KEY);
  });

  it("a send with {org_key, anthropic, claude-sonnet-5-5} streams from POST /v1/messages with the admin's key", async () => {
    const first = await ok(createChat(sam, "Warm-up on my plan"), 201);
    await settled(first.generation.id);
    const chatId = first.chat.id;
    const ws = await subscribeConv(stack.baseUrl, sam, chatId);
    expect(ws.outcome).toBe("subscribed");
    stack.fake.reset();

    const res = await send(sam, chatId, "Summarise the offsite plan", SONNET);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const { assistantMessage, generation } = res.body as Json;
    expect(generation).toMatchObject({
      backend: "org_key",
      provider: "anthropic",
      modelId: "claude-sonnet-5-5",
      modelLabel: "Claude Sonnet 5.5",
      metered: true,
    });
    await ws.waitFor(
      () =>
        ws
          .durable(EventTypes.messageUpdated)
          .some((f) => (f.data as Json).message.id === assistantMessage.id),
      15_000,
    );
    const calls = stack.fake.requests("anthropic");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe("/v1/messages");
    expect(calls[0]?.headers["x-api-key"]).toBe(ANTHROPIC_KEY);
    expect(calls[0]?.body?.model).toBe("claude-sonnet-5-5");
    expect(calls[0]?.body?.stream).toBe(true);
    expect(stack.fake.requests("responses")).toHaveLength(0);

    const deltas = ws.deltas().filter((d) => d.messageId === assistantMessage.id);
    expect(deltas.length).toBeGreaterThan(0);
    const final = ws
      .durable(EventTypes.messageUpdated)
      .find((f) => (f.data as Json).message.id === assistantMessage.id)!.data as Json;
    expect(final.message.status).toBe("completed");
    expect(final.message.body).toBe(deltas.map((d) => d.text).join(""));
    expect(final.message.generation).toMatchObject({ backend: "org_key", metered: true });
    ws.close();

    const usage = await usageOf(generation.id);
    expect(usage).toHaveLength(1);
    const u = usage[0];
    expect(u).toMatchObject({
      kind: "chat",
      backend: "org_key",
      provider: "anthropic",
      model_id: "claude-sonnet-5-5",
      estimated: false,
      input_tokens: 100,
      output_tokens: final.message.body.length,
    });
    const expected = estimateCostMicros("org_key", "anthropic", "claude-sonnet-5-5", {
      inputTokens: u.input_tokens,
      outputTokens: u.output_tokens,
      cachedInputTokens: u.cached_input_tokens,
    });
    expect(Number(u.cost_micros_usd)).toBe(expected.costMicrosUsd);
    expect(expected.costMicrosUsd).toBeGreaterThan(0);
    expect(u.price_ref).toBe(expected.priceRef);
  });

  it("no log line carries the key", () => {
    expect(stack.logs.join("\n")).not.toContain(ANTHROPIC_KEY);
  });
});

describe("each provider kind speaks its own wire API to the fake (P-04)", () => {
  it("OpenAI key → POST /v1/responses with store:false and the admin's bearer", async () => {
    await ok(
      upsert({
        provider: "openai",
        apiKey: OPENAI_KEY,
        baseUrl: `${stack.fake.baseUrl}/v1`,
        allowedModels: ["gpt-5"],
      }),
    );
    stack.fake.reset();
    const { g } = await orgTurn({ backend: "org_key", provider: "openai", modelId: "gpt-5" });
    const calls = stack.fake.requests("responses");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe("/v1/responses");
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${OPENAI_KEY}`);
    expect(calls[0]?.body?.store).toBe(false);
    expect(calls[0]?.body?.model).toBe("gpt-5");
    expect(g).toMatchObject({ backend: "org_key", provider: "openai" });
  });

  it("OpenRouter key → POST /v1/chat/completions with stream_options.include_usage", async () => {
    await ok(
      upsert({
        provider: "openrouter",
        apiKey: OPENROUTER_KEY,
        baseUrl: `${stack.fake.baseUrl}/v1`,
        allowedModels: ["anthropic/claude-sonnet-5-5"],
      }),
    );
    stack.fake.reset();
    const { g } = await orgTurn({
      backend: "org_key",
      provider: "openrouter",
      modelId: "anthropic/claude-sonnet-5-5",
    });
    const calls = stack.fake.requests("openai");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe("/v1/chat/completions");
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${OPENROUTER_KEY}`);
    expect(calls[0]?.body?.stream_options?.include_usage).toBe(true);
    expect(calls[0]?.body?.model).toBe("anthropic/claude-sonnet-5-5");
    const [u] = await usageOf(g.id);
    expect(u).toMatchObject({ estimated: false, input_tokens: 100 });
  });

  it("OpenAI-compatible key → POST /v1/chat/completions with stream_options.include_usage", async () => {
    await ok(
      upsert({
        provider: "openai-compatible",
        apiKey: COMPATIBLE_KEY,
        baseUrl: `${stack.fake.baseUrl}/v1`,
        allowedModels: ["llama-4-70b"],
      }),
    );
    const list = await ok(sam.request("GET", "/api/v1/ai-chat/models"));
    const compat = list.models.find((m: Json) => m.ref.provider === "openai-compatible");
    expect(compat).toMatchObject({
      group: "organization",
      metered: true,
      available: true,
      caps: { vision: false, pdf: false, webSearch: "function" },
    });
    stack.fake.reset();
    await orgTurn({ backend: "org_key", provider: "openai-compatible", modelId: "llama-4-70b" });
    const calls = stack.fake.requests("openai");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${COMPATIBLE_KEY}`);
    expect(calls[0]?.body?.stream_options?.include_usage).toBe(true);
  });

  it("the mock backend answers through the fake chat-completions route, not metered, cost 0", async () => {
    stack.fake.reset();
    const { g, created } = await orgTurn(MOCK, "Hello mock");
    expect(created.generation).toMatchObject({ backend: "mock", metered: false });
    const calls = stack.fake.requests("openai");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body?.model).toBe("mock-1");
    const [u] = await usageOf(g.id);
    expect(u).toMatchObject({ backend: "mock", provider: "mock", model_id: "mock-1" });
    expect(Number(u.cost_micros_usd)).toBe(0);
  });

  it("an org model that is not in the allowed list or names openai-codex is refused (409 model_unavailable)", async () => {
    const notAllowed = await createChat(sam, "x", {
      backend: "org_key",
      provider: "anthropic",
      modelId: "claude-opus-5-5",
    });
    expect(notAllowed.status).toBe(409);
    expect(errorOf(notAllowed)).toMatchObject({ code: "model_unavailable", details: { reason: "not_allowed" } });
    const codex = await createChat(sam, "x", {
      backend: "org_key",
      provider: "openai-codex",
      modelId: "gpt-6-astra",
    });
    // The contract itself refuses openai-codex as an org key (400); never a 2xx.
    expect([400, 409]).toContain(codex.status);
  });

  it("no key of any provider reaches a log line", () => {
    const logs = stack.logs.join("\n");
    for (const k of [ANTHROPIC_KEY, OPENAI_KEY, OPENROUTER_KEY, COMPATIBLE_KEY]) expect(logs).not.toContain(k);
  });
});

describe("without OCW_MODEL_PROVIDER=mock there is no mock backend", () => {
  it("no mock group and {mock, mock, mock-1} → 409 model_unavailable", async () => {
    const env = { ...stack.env, OCW_MODEL_PROVIDER: null };
    const built = await buildApp(env, {
      logger: false,
      secretStore: createEnvFileSecretStore({}),
    });
    await built.app.listen({ host: "127.0.0.1", port: 0 });
    try {
      const addr = built.app.server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      const other = new TestClient(`http://127.0.0.1:${port}`);
      other.cookies = new Map(sam.cookies);
      const list = await ok(other.request("GET", "/api/v1/ai-chat/models"));
      expect(list.models.some((m: Json) => m.group === "mock")).toBe(false);
      expect(list.models.some((m: Json) => m.group === "organization")).toBe(true);
      const res = await other.request("POST", "/api/v1/ai-chats", {
        clientMessageId: cid(),
        body: "x",
        model: MOCK,
      });
      expect(res.status).toBe(409);
      expect(errorOf(res)).toMatchObject({ code: "model_unavailable" });
    } finally {
      await built.close();
    }
  });
});
