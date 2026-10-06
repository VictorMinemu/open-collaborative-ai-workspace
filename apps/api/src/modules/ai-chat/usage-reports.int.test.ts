import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_SETUP_TOKEN, TestClient } from "../../testing";
import { type AiStack, seedPlan, startAiStack } from "../../testing-ai";
import { invite } from "../../testing-workzone";

/**
 * Usage reports (05-09, AICHAT-07, D-06): the organization report by member and by model (admins, `provider.manage`)
 * aggregates `ai_usage_records` written by real answers over a 7/30/90-day window. Reports carry ids, counts and money
 * only: never prompt, answer or title text. RLS keeps organizations apart. Real PostgreSQL + Redis and the in-process
 * fake model; no real provider is ever called.
 */

let stack: AiStack;
let su: pg.Client;
let admin: TestClient;
let sam: TestClient;
let alex: TestClient;
let samId: string;
let alexId: string;
let orgId: string;
/** Text that must never appear in a report (prompts and answers). */
const SECRET_PROMPT = `the-${randomUUID().slice(0, 8)}-merger-plan`;
const answerBodies: string[] = [];

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
type Json = Record<string, any>;

const PLAN = { backend: "chatgpt_plan", provider: "openai", modelId: "gpt-6-astra" } as const;
const SONNET = { backend: "org_key", provider: "anthropic", modelId: "claude-sonnet-5-5" } as const;
const MOCK = { backend: "mock", provider: "mock", modelId: "mock-1" } as const;
const FAKE_KEY = "sk-ant-usage-reports-0123456789-r9Qz";

const SONNET_KEY = "org_key:anthropic/claude-sonnet-5-5";
const PLAN_KEY = "chatgpt_plan:openai/gpt-6-astra";
const MOCK_KEY = "mock:mock/mock-1";
const HAIKU_TITLES_KEY = "org_key:anthropic/claude-haiku-4-5 · titles";

const cid = () => `cm-${randomUUID()}`;

async function ok(res: Promise<{ status: number; body: Record<string, unknown> | null }>, status = 200) {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as Json;
}

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

/** One settled turn in a fresh chat; remembers the answer text so reports can be checked for it. */
async function turn(as: TestClient, text: string, model: Json) {
  const created = await ok(
    as.request("POST", "/api/v1/ai-chats", { clientMessageId: cid(), body: text, model }),
    201,
  );
  const g = await settled(created.generation.id);
  const body = (await su.query("select body from app.messages where id = $1", [created.assistantMessage.id]))
    .rows[0]?.body as string | undefined;
  if (body) answerBodies.push(body);
  return { g, chatId: created.chat.id as string, generationId: created.generation.id as string };
}

/** A stopped answer (estimated usage). */
async function stoppedTurn(as: TestClient) {
  const created = await ok(
    as.request("POST", "/api/v1/ai-chats", {
      clientMessageId: cid(),
      body: `count slowly ${SECRET_PROMPT} [[slow]]`,
      model: SONNET,
    }),
    201,
  );
  const gid = created.generation.id as string;
  const until = Date.now() + 10_000;
  while (((await generation(gid))?.partial_text ?? "").length === 0) {
    if (Date.now() > until) throw new Error("no partial text");
    await new Promise((r) => setTimeout(r, 100));
  }
  await ok(as.request("POST", `/api/v1/ai-chats/${created.chat.id}/generations/${gid}/stop`, {}), 202);
  const g = await settled(gid, 5_000);
  expect(g.status).toBe("stopped");
}

/** A usage record written directly (titles before 05-10 produces real ones; records outside the window). */
async function seedRecord(r: {
  org?: string;
  userId: string;
  kind?: "chat" | "title";
  backend?: string;
  provider?: string;
  modelId?: string;
  input?: number;
  output?: number;
  cost?: number | null;
  estimated?: boolean;
  createdAt?: string;
}) {
  await su.query(
    `insert into app.ai_usage_records (organization_id, generation_id, kind, requester_user_id, conversation_id,
       backend, provider, model_id, input_tokens, output_tokens, estimated, cost_micros_usd, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, coalesce($13::timestamptz, now()))`,
    [
      r.org ?? orgId,
      randomUUID(),
      r.kind ?? "chat",
      r.userId,
      randomUUID(),
      r.backend ?? "org_key",
      r.provider ?? "anthropic",
      r.modelId ?? "claude-sonnet-5-5",
      r.input ?? 10,
      r.output ?? 5,
      r.estimated ?? false,
      r.cost === undefined ? 1000 : r.cost,
      r.createdAt ?? null,
    ],
  );
}

/** The expected aggregate of the caller-visible records, computed straight from the table. */
async function expected(where: string, params: unknown[]) {
  const r = (
    await su.query(
      `select count(*) filter (where kind = 'chat')::int as generations,
              count(*) filter (where kind = 'chat' and estimated)::int as estimated,
              coalesce(sum(input_tokens), 0)::bigint as input, coalesce(sum(output_tokens), 0)::bigint as output,
              sum(cost_micros_usd)::bigint as cost
       from app.ai_usage_records where ${where}`,
      params,
    )
  ).rows[0] as Json;
  return {
    generations: r.generations as number,
    estimatedGenerations: r.estimated as number,
    inputTokens: Number(r.input),
    outputTokens: Number(r.output),
    costMicrosUsd: r.cost === null ? null : Number(r.cost),
  };
}

const report = (as: TestClient, query: string) => as.request("GET", `/api/v1/ai-usage/report?${query}`);
const myReport = (as: TestClient, query: string) => as.request("GET", `/api/v1/me/ai-usage/report?${query}`);
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
const utcDay = (d: Date) => d.toISOString().slice(0, 10);

/** No prompt, answer or title text anywhere in a response. */
function expectNoText(body: Json) {
  const json = JSON.stringify(body);
  expect(json).not.toContain(SECRET_PROMPT);
  for (const a of answerBodies) if (a.length >= 12) expect(json).not.toContain(a);
}

function sumRows(rows: Json[]) {
  const costs = rows.map((r) => r.costMicrosUsd).filter((c): c is number => c !== null);
  return {
    generations: rows.reduce((n, r) => n + r.generations, 0),
    inputTokens: rows.reduce((n, r) => n + r.inputTokens, 0),
    outputTokens: rows.reduce((n, r) => n + r.outputTokens, 0),
    estimatedGenerations: rows.reduce((n, r) => n + r.estimatedGenerations, 0),
    costMicrosUsd: costs.length === 0 ? null : costs.reduce((n, c) => n + c, 0),
  };
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
  await seedPlan(sam);
  await ok(
    admin.request("POST", "/api/v1/model-providers", {
      provider: "anthropic",
      apiKey: FAKE_KEY,
      baseUrl: stack.fake.baseUrl,
      allowedModels: ["claude-sonnet-5-5", "claude-haiku-4-5"],
    }),
  );

  // Real answers: Sam on his plan and on Anthropic (one stopped → estimated), Alex on the mock.
  await turn(sam, `Summarise ${SECRET_PROMPT}`, SONNET);
  await turn(sam, `Again on Sonnet: ${SECRET_PROMPT}`, SONNET);
  await turn(sam, `On my plan: ${SECRET_PROMPT}`, PLAN);
  await stoppedTurn(sam);
  await turn(alex, `Mock question ${SECRET_PROMPT}`, MOCK);
  await turn(alex, `Another mock question ${SECRET_PROMPT}`, MOCK);
  // A title record (05-10 produces real ones) and a record outside the 30-day window.
  await seedRecord({
    userId: samId,
    kind: "title",
    modelId: "claude-haiku-4-5",
    input: 40,
    output: 8,
    cost: 80,
  });
  await seedRecord({ userId: samId, input: 1_000, output: 500, cost: 7_000, createdAt: daysAgo(40) });
}, 120_000);

afterAll(async () => {
  await su?.end();
  await stack?.stop();
});

describe("the organization report by member and by model (AICHAT-07)", () => {
  it("groupBy=user: one row per member with answers, tokens, null-safe cost and estimated answers; totals = Σ rows", async () => {
    const r = await ok(report(admin, "days=30&groupBy=user"));
    const now = new Date();
    expect(r.groupBy).toBe("user");
    expect(r.to).toBe(utcDay(now));
    expect(r.from).toBe(utcDay(new Date(now.getTime() - 29 * 86_400_000)));
    expect(r.rows).toHaveLength(2);

    const window = "created_at >= $2::date and organization_id = $3";
    const samRow = (r.rows as Json[]).find((x) => x.key === samId) as Json;
    expect(samRow).toMatchObject({ label: "Sam Rivera", backend: null });
    expect(samRow).toMatchObject(
      await expected(`requester_user_id = $1 and ${window}`, [samId, r.from, orgId]),
    );
    // Two Sonnet answers, one plan answer, one stopped answer: four answers, the stopped one estimated; the plan
    // answer adds tokens but no cost, the title adds tokens and cost but no answer.
    expect(samRow.generations).toBe(4);
    expect(samRow.estimatedGenerations).toBe(1);
    expect(samRow.costMicrosUsd).toBeGreaterThan(0);

    const alexRow = (r.rows as Json[]).find((x) => x.key === alexId) as Json;
    expect(alexRow).toMatchObject({
      label: "Alex Kim",
      backend: null,
      generations: 2,
      estimatedGenerations: 0,
    });
    expect(alexRow).toMatchObject(
      await expected(`requester_user_id = $1 and ${window}`, [alexId, r.from, orgId]),
    );
    // The mock costs 0, never null.
    expect(alexRow.costMicrosUsd).toBe(0);

    expect(r.totals).toEqual(sumRows(r.rows));
    expectNoText(r);
  });

  it("groupBy=model: one row per backend, provider and model with labels; titles under their own key", async () => {
    const r = await ok(report(admin, "days=30&groupBy=model"));
    expect(r.groupBy).toBe("model");
    const byKey = new Map((r.rows as Json[]).map((x) => [x.key as string, x]));
    expect([...byKey.keys()].sort()).toEqual([HAIKU_TITLES_KEY, PLAN_KEY, MOCK_KEY, SONNET_KEY].sort());

    expect(byKey.get(SONNET_KEY)).toMatchObject({
      label: "Claude Sonnet 5.5",
      backend: "org_key",
      generations: 3,
      estimatedGenerations: 1,
    });
    // The member's plan costs the organization nothing: cost null, not 0.
    expect(byKey.get(PLAN_KEY)).toMatchObject({
      label: "GPT-6 Astra",
      backend: "chatgpt_plan",
      generations: 1,
      costMicrosUsd: null,
    });
    expect(byKey.get(MOCK_KEY)).toMatchObject({ backend: "mock", generations: 2, costMicrosUsd: 0 });
    expect(byKey.get(HAIKU_TITLES_KEY)).toMatchObject({
      label: "Claude Haiku 4.5 · titles",
      backend: "org_key",
      generations: 0,
      inputTokens: 40,
      outputTokens: 8,
      costMicrosUsd: 80,
    });
    for (const [key, row] of byKey) {
      const [ref = "", titles] = key.split(" · ");
      const [backend, rest = ""] = ref.split(":");
      const slash = rest.indexOf("/");
      expect(row, key).toMatchObject(
        await expected(
          "backend = $1 and provider = $2 and model_id = $3 and kind = $4 and created_at >= $5::date and organization_id = $6",
          [backend, rest.slice(0, slash), rest.slice(slash + 1), titles ? "title" : "chat", r.from, orgId],
        ),
      );
    }
    expect(r.totals).toEqual(sumRows(r.rows));
    // The same records, grouped differently: the same totals.
    expect(r.totals).toEqual((await ok(report(admin, "days=30&groupBy=user"))).totals);
    expectNoText(r);
  });

  it("the window excludes older records: 7 and 30 days leave the 40-day-old record out, 90 days include it", async () => {
    const d30 = await ok(report(admin, "days=30&groupBy=user"));
    const d7 = await ok(report(admin, "days=7&groupBy=user"));
    const d90 = await ok(report(admin, "days=90&groupBy=user"));
    expect(d7.totals).toEqual(d30.totals);
    expect(d90.totals.inputTokens).toBe(d30.totals.inputTokens + 1_000);
    expect(d90.totals.outputTokens).toBe(d30.totals.outputTokens + 500);
    expect(d90.totals.generations).toBe(d30.totals.generations + 1);
    expect(d90.totals.costMicrosUsd).toBe(d30.totals.costMicrosUsd + 7_000);
    // Defaults: 30 days by member.
    expect(await ok(report(admin, ""))).toEqual(d30);
  });

  it("rejects windows over 90 days and unknown groupings (Zod at the boundary)", async () => {
    for (const q of ["days=91", "days=0", "days=abc", "groupBy=conversation"]) {
      expect((await report(admin, q)).status, q).toBe(400);
    }
  });

  it("a standard member never reaches the organization report (403)", async () => {
    expect((await report(sam, "days=30&groupBy=user")).status).toBe(403);
    expect((await report(alex, "days=30&groupBy=model")).status).toBe(403);
  });

  it("another organization's records never appear, and its admin sees only its own", async () => {
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
    // Org B's records: one by Eve, and one naming Sam's id (a forged requester) that org A must still never see.
    await seedRecord({ org: orgB, userId: eveId, input: 77_777, output: 1, cost: 999_000 });
    await seedRecord({ org: orgB, userId: samId, input: 66_666, output: 1, cost: 888_000 });

    const ours = await ok(report(admin, "days=30&groupBy=user"));
    expect((ours.rows as Json[]).map((x) => x.key).sort()).toEqual([samId, alexId].sort());
    expect(JSON.stringify(ours)).not.toContain("77777");
    expect(JSON.stringify(ours)).not.toContain("66666");

    const theirs = await ok(report(eve, "days=30&groupBy=user"));
    expect(theirs.totals).toMatchObject({ inputTokens: 77_777 + 66_666, costMicrosUsd: 999_000 + 888_000 });
    expect((theirs.rows as Json[]).find((x) => x.key === eveId)).toMatchObject({
      label: "Eve",
      inputTokens: 77_777,
    });
    expectNoText(theirs);
  });
});
