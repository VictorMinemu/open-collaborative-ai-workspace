import { randomUUID } from "node:crypto";
import { estimateCostMicros, estimateTokens, PRICE_TABLE_VERSION } from "@ocw/contracts";
import { aiGenerations } from "@ocw/db";
import { eq } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_SETUP_TOKEN, TestClient } from "../../testing";
import { type AiStack, seedPlan, startAiStack } from "../../testing-ai";
import { invite } from "../../testing-workzone";
import { createModelGateway } from "../model-gateway";
import { createRunLoop } from "./run-loop";
import { createGenerationSweeper } from "./sweeper";
import { recordUsage } from "./usage";

/**
 * Metering (05-08, D-06, AICHAT-07): every generation, whatever its outcome, writes exactly one immutable usage
 * record with provider counts (or an honest estimate), a sourced cost (or null) and the requester; today's per-member
 * counters gain its tokens and cost in the same transaction. Real PostgreSQL + Redis, the in-process fake model
 * (Anthropic `[[cache:N]]` / `[[http:500]]` / `[[slow]]`); no real provider is ever called.
 */

let stack: AiStack;
let su: pg.Client;
let admin: TestClient;
let sam: TestClient;
let samId: string;
let orgId: string;

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
type Json = Record<string, any>;

const PLAN = { backend: "chatgpt_plan", provider: "openai", modelId: "gpt-6-astra" } as const;
const SONNET = { backend: "org_key", provider: "anthropic", modelId: "claude-sonnet-5-5" } as const;
const MOCK = { backend: "mock", provider: "mock", modelId: "mock-1" } as const;
const FAKE_KEY = "sk-ant-usage-SECRET-0123456789-u5Tq";

const cid = () => `cm-${randomUUID()}`;

async function ok(res: Promise<{ status: number; body: Record<string, unknown> | null }>, status = 200) {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as Json;
}

const createChat = (as: TestClient, body: string, model: Json = SONNET) =>
  as.request("POST", "/api/v1/ai-chats", { clientMessageId: cid(), body, model });
const stop = (as: TestClient, chatId: string, generationId: string) =>
  as.request("POST", `/api/v1/ai-chats/${chatId}/generations/${generationId}/stop`, {});

const generation = async (id: string) =>
  (await su.query("select * from app.ai_generations where id = $1", [id])).rows[0] as Json;

async function settled(generationId: string, timeoutMs = 20_000): Promise<Json> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const g = await generation(generationId);
    if (g && g.status !== "running") return g;
    if (Date.now() > until) throw new Error(`generation ${generationId} still running`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const usageOf = async (generationId: string) =>
  (await su.query("select * from app.ai_usage_records where generation_id = $1", [generationId]))
    .rows as Json[];

/** The one usage record of a generation (fails when there is none or more than one). */
async function oneUsage(generationId: string): Promise<Json> {
  const rows = await usageOf(generationId);
  expect(rows, `usage records of ${generationId}`).toHaveLength(1);
  return rows[0] as Json;
}

const today = () => new Date().toISOString().slice(0, 10);

/** Today's counters of a member and backend class (null when there is no row). */
async function daily(userId: string, backendClass: "org_key" | "chatgpt_plan"): Promise<Json | null> {
  const rows = (
    await su.query(
      "select * from app.ai_usage_daily where user_id = $1 and day = $2 and backend_class = $3",
      [userId, today(), backendClass],
    )
  ).rows;
  return (rows[0] as Json | undefined) ?? null;
}

/** Sums of today's usage records of a member for one backend class (mock counts as org_key). */
async function recordSums(userId: string, backendClass: "org_key" | "chatgpt_plan") {
  const backends = backendClass === "org_key" ? ["org_key", "mock"] : ["chatgpt_plan"];
  const r = (
    await su.query(
      `select coalesce(sum(u.input_tokens), 0)::bigint as input, coalesce(sum(u.output_tokens), 0)::bigint as output,
              coalesce(sum(u.cost_micros_usd), 0)::bigint as cost
       from app.ai_usage_records u join app.ai_generations g on g.id = u.generation_id
       where u.requester_user_id = $1 and u.backend = any($2) and (g.started_at at time zone 'UTC')::date = $3::date`,
      [userId, backends, today()],
    )
  ).rows[0] as Json;
  return { input: Number(r.input), output: Number(r.output), cost: Number(r.cost) };
}

/** One turn in a fresh chat of Sam's, settled. */
async function turn(text: string, model: Json = SONNET) {
  const created = await ok(createChat(sam, text, model), 201);
  const g = await settled(created.generation.id);
  return { created, g, chatId: created.chat.id as string, generationId: created.generation.id as string };
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
  await ok(
    admin.request("POST", "/api/v1/model-providers", {
      provider: "anthropic",
      apiKey: FAKE_KEY,
      baseUrl: stack.fake.baseUrl,
      allowedModels: ["claude-sonnet-5-5", "claude-haiku-4-5"],
    }),
  );
});

afterAll(async () => {
  await su?.end();
  await stack?.stop();
});

describe("every outcome writes exactly one correct usage record (D-06, AICHAT-07)", () => {
  it("a completed Anthropic answer stores the provider counts, the sourced price and the table version", async () => {
    const { g, chatId, generationId, created } = await turn("Summarise the offsite plan");
    expect(g.status).toBe("completed");
    const u = await oneUsage(generationId);
    expect(u).toMatchObject({
      kind: "chat",
      requester_user_id: samId,
      conversation_id: chatId,
      message_id: created.assistantMessage.id,
      backend: "org_key",
      provider: "anthropic",
      model_id: "claude-sonnet-5-5",
      input_tokens: 100,
      estimated: false,
    });
    const body = (
      await su.query("select body from app.messages where id = $1", [created.assistantMessage.id])
    ).rows[0].body as string;
    expect(u.output_tokens).toBe(body.length);
    const expected = estimateCostMicros("org_key", "anthropic", "claude-sonnet-5-5", {
      inputTokens: 100,
      outputTokens: body.length,
      cachedInputTokens: u.cached_input_tokens,
    });
    expect(Number(u.cost_micros_usd)).toBe(expected.costMicrosUsd);
    expect(Number(u.cost_micros_usd)).toBeGreaterThan(0);
    expect(u.price_ref).toBe(`${PRICE_TABLE_VERSION}:anthropic/claude-sonnet-5-5`);

    // The snapshot's answer carries the same usage as the record.
    const snap = await ok(sam.request("GET", `/api/v1/ai-chats/${chatId}`));
    const answer = (snap.messages as Json[]).find((m) => m.id === created.assistantMessage.id) as Json;
    expect(answer.generation.usage).toEqual({
      inputTokens: u.input_tokens,
      outputTokens: u.output_tokens,
      cachedInputTokens: u.cached_input_tokens,
      reasoningTokens: u.reasoning_tokens,
      estimated: false,
      costMicrosUsd: Number(u.cost_micros_usd),
      priceRef: u.price_ref,
    });
  });

  it("cached input reported by the provider is stored (inside the input count) and priced at the cache rate", async () => {
    const { g, generationId } = await turn("Use the cache [[cache:400]]");
    expect(g.status).toBe("completed");
    const u = await oneUsage(generationId);
    expect(u).toMatchObject({ input_tokens: 500, cached_input_tokens: 400, estimated: false });
    // 100 uncached × $2 + 400 cached × $0.20 + output × $10 (micro-USD = tokens × USD per MTok).
    expect(Number(u.cost_micros_usd)).toBe(Math.round(100 * 2 + 400 * 0.2 + u.output_tokens * 10));
  });

  it("a stopped answer stores an estimate: output ≈ estimateTokens(the text kept)", async () => {
    const created = await ok(createChat(sam, "count slowly [[slow]]"), 201);
    const gid = created.generation.id as string;
    // Let a few deltas arrive, then stop.
    const until = Date.now() + 10_000;
    while (((await generation(gid))?.partial_text ?? "").length === 0) {
      if (Date.now() > until) throw new Error("no partial text");
      await new Promise((r) => setTimeout(r, 100));
    }
    await ok(stop(sam, created.chat.id, gid), 202);
    const g = await settled(gid, 5_000);
    expect(g.status).toBe("stopped");
    const u = await oneUsage(gid);
    expect(u.estimated).toBe(true);
    expect(u.output_tokens).toBe(estimateTokens(g.partial_text));
    expect(u.input_tokens).toBeGreaterThan(0);
    const expected = estimateCostMicros("org_key", "anthropic", "claude-sonnet-5-5", {
      inputTokens: u.input_tokens,
      outputTokens: u.output_tokens,
      cachedInputTokens: null,
    });
    expect(Number(u.cost_micros_usd)).toBe(expected.costMicrosUsd);
  });

  it("a failed answer (the provider answers HTTP 500) stores exactly one record", async () => {
    const { g, generationId } = await turn("This one breaks [[http:500]]");
    expect(g.status).toBe("failed");
    const u = await oneUsage(generationId);
    expect(u).toMatchObject({ backend: "org_key", estimated: true, output_tokens: 0 });
    expect(u.input_tokens).toBeGreaterThan(0);
  }, 30_000);

  it("an interrupted answer (finalized by the sweeper) stores exactly one estimated record", async () => {
    const { chatId } = await turn("A first question");
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
    const planted = await su.query(
      `insert into app.ai_generations (organization_id, conversation_id, user_message_id, assistant_message_id,
         requester_user_id, backend, provider, model_id, attempt, status, partial_text, instance_id, heartbeat_at)
       values ($1, $2, $3, $4, $5, 'org_key', 'anthropic', 'claude-sonnet-5-5', 1, 'running', 'half an answer',
         'dead-instance', now() - interval '5 minutes') returning id`,
      [orgId, chatId, user.rows[0].id, answer.rows[0].id, samId],
    );
    const gid = planted.rows[0].id as string;
    const core = stack.built.core;
    const sweeper = createGenerationSweeper(core, {
      runLoop: createRunLoop(core, { gateway: createModelGateway(core) }),
    });
    await sweeper.runOnce();
    expect((await generation(gid)).status).toBe("interrupted");
    const u = await oneUsage(gid);
    expect(u).toMatchObject({ estimated: true, output_tokens: estimateTokens("half an answer") });
    expect(Number(u.cost_micros_usd)).toBeGreaterThan(0);
  });

  it("a plan answer stores cost null and a mock answer cost 0", async () => {
    const plan = await turn("On my plan", PLAN);
    expect(plan.g.status).toBe("completed");
    expect(await oneUsage(plan.generationId)).toMatchObject({
      backend: "chatgpt_plan",
      cost_micros_usd: null,
      price_ref: null,
    });
    const mock = await turn("On the mock", MOCK);
    expect(mock.g.status).toBe("completed");
    const u = await oneUsage(mock.generationId);
    expect(u).toMatchObject({ backend: "mock", price_ref: `${PRICE_TABLE_VERSION}:mock/mock-1` });
    expect(Number(u.cost_micros_usd)).toBe(0);
  });
});

describe("today's counters (one row per member, day and backend class)", () => {
  it("gain every generation's tokens and cost; mock counts as org_key; the plan has its own row", async () => {
    const org = await daily(samId, "org_key");
    const plan = await daily(samId, "chatgpt_plan");
    expect(org).not.toBeNull();
    expect(plan).not.toBeNull();
    const orgSums = await recordSums(samId, "org_key");
    const planSums = await recordSums(samId, "chatgpt_plan");
    expect({
      input: Number(org?.input_tokens),
      output: Number(org?.output_tokens),
      cost: Number(org?.cost_micros_usd),
    }).toEqual(orgSums);
    expect({
      input: Number(plan?.input_tokens),
      output: Number(plan?.output_tokens),
      cost: Number(plan?.cost_micros_usd),
    }).toEqual(planSums);
    expect(planSums.cost).toBe(0);
    const rows = (
      await su.query("select backend_class from app.ai_usage_daily where user_id = $1 and day = $2", [
        samId,
        today(),
      ])
    ).rows.map((r) => r.backend_class);
    expect(rows.sort()).toEqual(["chatgpt_plan", "org_key"]);
  });

  it("are written in the usage record's transaction: a rollback leaves neither, a retried finalize adds nothing", async () => {
    const { generationId } = await turn("Something to re-record");
    const before = await daily(samId, "org_key");
    const core = stack.built.core;
    const [gen] = await core.db.withTenant({ organizationId: orgId }, (tx) =>
      tx.select().from(aiGenerations).where(eq(aiGenerations.id, generationId)),
    );
    if (!gen) throw new Error("generation missing");
    // A second recordUsage for the same generation (a retried finalize) is a no-op for the record and the counters.
    await core.db.withTenant({ organizationId: orgId }, (tx) =>
      recordUsage(tx, {
        generation: gen,
        kind: "chat",
        reported: { inputTokens: 9_999, outputTokens: 9_999, cachedInputTokens: 0, reasoningTokens: 0 },
        promptText: "",
        outputText: "",
      }),
    );
    expect(await usageOf(generationId)).toHaveLength(1);
    expect(await daily(samId, "org_key")).toEqual(before);
    // A title record of a fresh generation inside a transaction that rolls back leaves nothing behind.
    await expect(
      core.db.withTenant({ organizationId: orgId }, async (tx) => {
        await recordUsage(tx, {
          generation: gen,
          kind: "title",
          reported: {
            inputTokens: 50,
            outputTokens: 5,
            cachedInputTokens: undefined,
            reasoningTokens: undefined,
          },
          promptText: "",
          outputText: "",
        });
        throw new Error("roll back");
      }),
    ).rejects.toThrow("roll back");
    expect(await usageOf(generationId)).toHaveLength(1);
    expect(await daily(samId, "org_key")).toEqual(before);
  });

  it("no usage row carries prompt or answer text (T-05-08-04)", async () => {
    const cols = (
      await su.query(
        `select table_name, column_name from information_schema.columns
         where table_schema = 'app' and table_name in ('ai_usage_records', 'ai_usage_daily')
           and data_type in ('text', 'character varying', 'jsonb', 'json')
         order by 1, 2`,
      )
    ).rows.map((r) => `${r.table_name}.${r.column_name}`);
    expect(cols).toEqual([
      "ai_usage_daily.backend_class",
      "ai_usage_records.backend",
      "ai_usage_records.kind",
      "ai_usage_records.model_id",
      "ai_usage_records.price_ref",
      "ai_usage_records.provider",
    ]);
    const dump = JSON.stringify(
      (await su.query("select * from app.ai_usage_records where requester_user_id = $1", [samId])).rows,
    );
    for (const phrase of ["offsite", "Use the cache", "count slowly", "half an answer", "On my plan"]) {
      expect(dump).not.toContain(phrase);
    }
  });
});
