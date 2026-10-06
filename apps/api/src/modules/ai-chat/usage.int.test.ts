import { randomUUID } from "node:crypto";
import {
  DEFAULT_AI_CHAT_POLICY,
  estimateCostMicros,
  estimateTokens,
  PRICE_TABLE_VERSION,
} from "@ocw/contracts";
import { aiGenerations } from "@ocw/db";
import { eq } from "drizzle-orm";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
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
const send = (as: TestClient, chatId: string, body: string, model: Json = SONNET) =>
  as.request("POST", `/api/v1/ai-chats/${chatId}/messages`, { clientMessageId: cid(), body, model });
const regenerate = (as: TestClient, chatId: string) =>
  as.request("POST", `/api/v1/ai-chats/${chatId}/regenerate`, {});
const errorOf = (r: { body: Record<string, unknown> | null }) => (r.body as Json | null)?.error as Json;
const putPolicy = (as: TestClient, body: Json) => as.request("PUT", "/api/v1/ai-chat/policy", body);
const nextMidnightUtc = () => {
  const n = new Date();
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate() + 1)).toISOString();
};
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

// ---------------------------------------------------------------- Task 2: daily caps and the admin policy

let memberSeq = 0;
/** A member with no usage today (each cap test starts from zero). */
async function freshMember(name: string): Promise<{ client: TestClient; userId: string }> {
  memberSeq += 1;
  return invite(
    stack,
    admin,
    `${name.toLowerCase()}-${memberSeq}-${randomUUID().slice(0, 6)}@example.test`,
    name,
    "standard",
  );
}

const generationsOf = async (userId: string) =>
  Number(
    (
      await su.query("select count(*)::int as n from app.ai_generations where requester_user_id = $1", [
        userId,
      ])
    ).rows[0].n,
  );
const messagesBy = async (userId: string) =>
  Number(
    (await su.query("select count(*)::int as n from app.messages where author_id = $1", [userId])).rows[0].n,
  );
const auditsOf = async (action: string, userId?: string) =>
  (
    await su.query(
      `select * from app.audit_events where action = $1 ${userId ? "and user_id = $2" : ""} order by occurred_at`,
      userId ? [action, userId] : [action],
    )
  ).rows as Json[];

describe("daily caps stop organization-key use before any model call (D-06, T-05-08-01)", () => {
  afterEach(async () => {
    // Every test starts from the defaults.
    await ok(
      putPolicy(admin, {
        orgKeyDailyGenerations: DEFAULT_AI_CHAT_POLICY.orgKeyDailyGenerations,
        orgKeyDailyCostMicros: null,
        planDailyGenerations: null,
        concurrentGenerationsPerUser: DEFAULT_AI_CHAT_POLICY.concurrentGenerationsPerUser,
      }),
    );
  });

  it("at a cap of 2 the third org-key answer of the UTC day (sends and regenerates alike) is 429 with the reset time and nothing written", async () => {
    await ok(putPolicy(admin, { orgKeyDailyGenerations: 2 }));
    const { client: riley, userId: rileyId } = await freshMember("Riley");
    const first = await ok(createChat(riley, "First of the day"), 201);
    await settled(first.generation.id);
    // Regenerate consumes the same counter.
    const again = await ok(regenerate(riley, first.chat.id), 201);
    await settled(again.generation.id);

    const requestsBefore = stack.fake.requests("anthropic").length;
    const gensBefore = await generationsOf(rileyId);
    const messagesBefore = await messagesBy(rileyId);
    const refused = await send(riley, first.chat.id, "A third one");
    expect(refused.status).toBe(429);
    expect(errorOf(refused)).toMatchObject({
      code: "daily_limit_reached",
      details: { limit: "generations", backendClass: "org_key", max: 2, resetsAt: nextMidnightUtc() },
    });
    // A new chat, a regenerate and the mock (an organization model too) are refused the same way.
    for (const res of [
      await createChat(riley, "In a new chat"),
      await regenerate(riley, first.chat.id),
      await send(riley, first.chat.id, "On the mock", MOCK),
    ]) {
      expect(res.status).toBe(429);
      expect(errorOf(res).code).toBe("daily_limit_reached");
    }
    expect(await generationsOf(rileyId)).toBe(gensBefore);
    expect(await messagesBy(rileyId)).toBe(messagesBefore);
    expect(stack.fake.requests("anthropic").length).toBe(requestsBefore);
    const row = await daily(rileyId, "org_key");
    expect(row?.generations).toBe(2);

    const audits = await auditsOf("ai_chat.limit_reached", rileyId);
    expect(audits).toHaveLength(4);
    expect(audits[0]).toMatchObject({
      organization_id: orgId,
      result: "denied",
      metadata: { backendClass: "org_key", limit: "generations" },
    });

    // The member's own plan is not limited by the org-key cap.
    await seedPlan(riley);
    const plan = await ok(send(riley, first.chat.id, "On my plan instead", PLAN), 201);
    expect((await settled(plan.generation.id)).status).toBe("completed");

    // A higher cap applies to the very next send (no restart).
    await ok(putPolicy(admin, { orgKeyDailyGenerations: 3 }));
    const third = await ok(send(riley, first.chat.id, "Now it fits"), 201);
    await settled(third.generation.id);
    expect((await daily(rileyId, "org_key"))?.generations).toBe(3);
  });

  it("plan answers are capped only when planDailyGenerations is set, and then only plan answers count", async () => {
    const { client: pat, userId: patId } = await freshMember("Pat");
    await seedPlan(pat);
    const chat = await ok(createChat(pat, "Plan one", PLAN), 201);
    await settled(chat.generation.id);
    const two = await ok(send(pat, chat.chat.id, "Plan two", PLAN), 201);
    await settled(two.generation.id);
    expect((await daily(patId, "chatgpt_plan"))?.generations).toBe(2);

    await ok(putPolicy(admin, { planDailyGenerations: 2 }));
    const refused = await send(pat, chat.chat.id, "Plan three", PLAN);
    expect(refused.status).toBe(429);
    expect(errorOf(refused).details).toMatchObject({
      limit: "generations",
      backendClass: "chatgpt_plan",
      max: 2,
    });
    // Organization models keep their own counter.
    const org = await ok(send(pat, chat.chat.id, "On the org key"), 201);
    await settled(org.generation.id);
    expect((await daily(patId, "org_key"))?.generations).toBe(1);
    expect((await daily(patId, "chatgpt_plan"))?.generations).toBe(2);
  });

  it("ten concurrent sends at a cap of 5 succeed exactly five times", async () => {
    await ok(putPolicy(admin, { orgKeyDailyGenerations: 5, concurrentGenerationsPerUser: 10 }));
    const { client: casey, userId: caseyId } = await freshMember("Casey");
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => createChat(casey, `Concurrent ${i}`, MOCK)),
    );
    const created = results.filter((r) => r.status === 201);
    const refused = results.filter((r) => r.status === 429);
    expect(created).toHaveLength(5);
    expect(refused).toHaveLength(5);
    for (const r of refused) expect(errorOf(r).code).toBe("daily_limit_reached");
    for (const r of created) await settled((r.body as Json).generation.id);
    expect((await daily(caseyId, "org_key"))?.generations).toBe(5);
    expect(await generationsOf(caseyId)).toBe(5);
  });

  it("with a dollar cap, a send is refused once today's org-key cost reached it", async () => {
    await ok(putPolicy(admin, { orgKeyDailyCostMicros: 1 }));
    const { client: dana, userId: danaId } = await freshMember("Dana");
    const first = await ok(createChat(dana, "One priced answer"), 201);
    await settled(first.generation.id);
    expect(Number((await daily(danaId, "org_key"))?.cost_micros_usd)).toBeGreaterThan(0);
    const refused = await send(dana, first.chat.id, "Over the dollar cap");
    expect(refused.status).toBe(429);
    expect(errorOf(refused).details).toMatchObject({ limit: "cost", backendClass: "org_key", max: 1 });
    expect((await auditsOf("ai_chat.limit_reached", danaId))[0]?.metadata).toEqual({
      backendClass: "org_key",
      limit: "cost",
    });
  });
});

describe("GET /me/ai-usage/today (T-05-08-03)", () => {
  it("reports the caller's own counts, tokens, cost and limits; nobody else's", async () => {
    await ok(putPolicy(admin, { orgKeyDailyGenerations: 50, planDailyGenerations: 7 }));
    try {
      const mine = await ok(sam.request("GET", "/api/v1/me/ai-usage/today"));
      const org = await daily(samId, "org_key");
      const plan = await daily(samId, "chatgpt_plan");
      expect(mine).toEqual({
        day: today(),
        orgKey: {
          generations: org?.generations ?? 0,
          inputTokens: Number(org?.input_tokens ?? 0),
          outputTokens: Number(org?.output_tokens ?? 0),
          costMicrosUsd: Number(org?.cost_micros_usd ?? 0),
        },
        chatgptPlan: {
          generations: plan?.generations ?? 0,
          inputTokens: Number(plan?.input_tokens ?? 0),
          outputTokens: Number(plan?.output_tokens ?? 0),
        },
        limits: { orgKeyGenerations: 50, orgKeyCostMicros: null, planGenerations: 7 },
        resetsAt: nextMidnightUtc(),
      });
      expect(mine.orgKey.generations).toBeGreaterThan(0);
      expect(mine.orgKey.costMicrosUsd).toBeGreaterThan(0);

      const { client: quiet } = await freshMember("Quinn");
      const theirs = await ok(quiet.request("GET", "/api/v1/me/ai-usage/today"));
      expect(theirs.orgKey).toEqual({ generations: 0, inputTokens: 0, outputTokens: 0, costMicrosUsd: 0 });
      expect(theirs.chatgptPlan).toEqual({ generations: 0, inputTokens: 0, outputTokens: 0 });
      // Never prompt or answer text, never another member.
      expect(JSON.stringify(mine)).not.toContain("offsite");
      expect(JSON.stringify(mine)).not.toContain(samId);
    } finally {
      await ok(putPolicy(admin, { orgKeyDailyGenerations: 200, planDailyGenerations: null }));
    }
  });
});

describe("the admin AI chat policy (GET/PUT /ai-chat/policy, provider.manage)", () => {
  it("admins read and change it (audited with the changed keys); members get 403; invalid values are 400", async () => {
    const before = await ok(admin.request("GET", "/api/v1/ai-chat/policy"));
    expect(Object.keys(before).sort()).toEqual(Object.keys(DEFAULT_AI_CHAT_POLICY).sort());
    // The ChatGPT host id generated for the organization (05-05) survives every policy change.
    await su.query(
      `insert into app.ai_chat_policies (organization_id, chatgpt_host_id) values ($1, 'urn:uuid:kept')
       on conflict (organization_id) do update set chatgpt_host_id = coalesce(app.ai_chat_policies.chatgpt_host_id, 'urn:uuid:kept')`,
      [orgId],
    );
    const hostId = (
      await su.query("select chatgpt_host_id from app.ai_chat_policies where organization_id = $1", [orgId])
    ).rows[0].chatgpt_host_id;

    const auditsBefore = (await auditsOf("ai_chat.policy_updated")).length;
    const updated = await ok(
      putPolicy(admin, {
        webEnabled: false,
        maxContextTokens: 32_000,
        planAllowedModels: ["gpt-6-astra"],
        titleModels: { anthropic: "claude-haiku-4-5" },
        orgKeyDailyGenerations: 200,
      }),
    );
    expect(updated).toMatchObject({
      webEnabled: false,
      maxContextTokens: 32_000,
      planAllowedModels: ["gpt-6-astra"],
      titleModels: { anthropic: "claude-haiku-4-5" },
    });
    expect(await ok(admin.request("GET", "/api/v1/ai-chat/policy"))).toEqual(updated);
    const audits = await auditsOf("ai_chat.policy_updated");
    expect(audits).toHaveLength(auditsBefore + 1);
    expect(audits.at(-1)).toMatchObject({
      organization_id: orgId,
      resource_type: "ai_chat_policy",
      metadata: { changed: ["maxContextTokens", "planAllowedModels", "titleModels", "webEnabled"] },
    });
    expect(
      (await su.query("select chatgpt_host_id from app.ai_chat_policies where organization_id = $1", [orgId]))
        .rows[0].chatgpt_host_id,
    ).toBe(hostId);
    // The same values again change nothing and audit nothing.
    await ok(putPolicy(admin, { webEnabled: false }));
    expect(await auditsOf("ai_chat.policy_updated")).toHaveLength(auditsBefore + 1);
    // The snapshot of a chat follows the policy at once (web search off).
    const chat = await turn("Policy check", MOCK);
    const snap = await ok(sam.request("GET", `/api/v1/ai-chats/${chat.chatId}`));
    expect((snap.chat.tools as Json[]).find((t) => t.key === "web")).toMatchObject({
      available: false,
      reason: "disabled_by_org",
    });

    // Members: 403 on both.
    expect((await sam.request("GET", "/api/v1/ai-chat/policy")).status).toBe(403);
    expect((await putPolicy(sam, { webEnabled: true })).status).toBe(403);
    // Invalid values (Zod at the boundary).
    for (const bad of [
      {},
      { orgKeyDailyGenerations: 0 },
      { concurrentGenerationsPerUser: 11 },
      { maxContextTokens: 10 },
      { orgKeyDailyCostMicros: -5 },
      { planAllowedModels: "gpt-6-astra" },
    ]) {
      const res = await putPolicy(admin, bad);
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
    await ok(
      putPolicy(admin, {
        webEnabled: true,
        maxContextTokens: 64_000,
        planAllowedModels: [],
        titleModels: {},
      }),
    );
  });

  it("an admin of another organization reads and changes only their own policy and usage", async () => {
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

    await ok(putPolicy(admin, { orgKeyDailyGenerations: 123 }));
    try {
      const theirs = await ok(eve.request("GET", "/api/v1/ai-chat/policy"));
      expect(theirs.orgKeyDailyGenerations).toBe(DEFAULT_AI_CHAT_POLICY.orgKeyDailyGenerations);
      await ok(putPolicy(eve, { orgKeyDailyGenerations: 1, webEnabled: false }));
      const ours = await ok(admin.request("GET", "/api/v1/ai-chat/policy"));
      expect(ours).toMatchObject({ orgKeyDailyGenerations: 123, webEnabled: true });
      const usage = await ok(eve.request("GET", "/api/v1/me/ai-usage/today"));
      expect(usage.orgKey.generations).toBe(0);
      expect(usage.limits.orgKeyGenerations).toBe(1);
      // Org B's audit row lives in org B.
      const audit = (await auditsOf("ai_chat.policy_updated", eveId)).at(-1);
      expect(audit?.organization_id).toBe(orgB);
    } finally {
      await ok(putPolicy(admin, { orgKeyDailyGenerations: 200 }));
    }
  });
});
