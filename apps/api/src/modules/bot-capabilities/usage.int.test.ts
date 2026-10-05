import { sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";
import { consumeTurn, limitNotice, nextResetAt, usageOf, utcDay } from "./index";

/**
 * 03.1-05 (BOT-07, SC5, D-11): every delivered turn counts once per bot per UTC day with one conditional
 * upsert, so concurrent messages never overshoot; at the limit the bot posts a notice (after commit), no
 * event reaches the cell (so no model call) and the hit is audited without content. Real PostgreSQL + Redis.
 */

const CELL_TOKEN = "ocw-test-cell-token-usage-limits-0123456789ab";
const ADMIN = {
  name: "Víctor Ruiz",
  email: "victor@example.test",
  password: "correct-horse-battery",
  orgName: "Autofy Labs",
};

let stack: TestStack;
let su: pg.Client;
let admin: TestClient;
let sam: TestClient;
let alex: TestClient;
let orgId: string;
let samId: string;
let samBotId: string;
let samDmId: string;
let alexBotId: string;
let alexDmId: string;

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
type Json = Record<string, any>;

async function ok(res: Promise<{ status: number; body: Record<string, unknown> | null }>, status = 200) {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as Json;
}

async function joinAs(email: string, name: string, role: "developer" | "standard") {
  const inv = await ok(admin.request("POST", "/api/v1/invitations", { email, role }));
  const c = new TestClient(stack.baseUrl);
  const acc = await ok(
    c.request("POST", `/api/v1/invitations/${inv.id}/accept`, { name, password: "another-long-password" }),
  );
  return [c, acc.user.id as string] as const;
}

/** `agent.mention.v1` events on the cell stream for one bot. */
const cellEvents = async (agentId: string) =>
  (
    await su.query(
      `select payload from app.stream_events
        where stream_id = $1 and type = 'agent.mention.v1' and payload->'agent'->>'id' = $2 order by seq`,
      [`cell:${orgId}`, agentId],
    )
  ).rows.map((r) => r.payload as Json);

/** Messages authored by a bot in a conversation, oldest first. */
const botMessages = async (agentId: string, conversationId: string) =>
  (
    await su.query(
      `select id, body, thread_id, client_message_id from app.messages
        where author_kind = 'agent' and author_id = $1 and conversation_id = $2 order by seq`,
      [agentId, conversationId],
    )
  ).rows as Array<{ id: string; body: string; thread_id: string | null; client_message_id: string | null }>;

const limitAudits = async (agentId: string) =>
  (
    await su.query(
      `select actor_kind, actor_id, agent_id, user_id, resource_type, resource_id, result, metadata
         from app.audit_events where action = 'agent.limit_reached' and organization_id = $1 and agent_id = $2
        order by occurred_at, id`,
      [orgId, agentId],
    )
  ).rows as Json[];

const turnsToday = async (agentId: string) =>
  Number(
    (
      await su.query(
        "select coalesce(sum(turns), 0)::int as n from app.agent_usage_daily where agent_id = $1 and day = $2",
        [agentId, utcDay()],
      )
    ).rows[0].n,
  );

const say = (c: TestClient, conversationId: string, body: string) =>
  ok(c.request("POST", `/api/v1/conversations/${conversationId}/messages`, { body }));

beforeAll(async () => {
  stack = await startTestStack({ env: { OCW_CELL_TOKEN: CELL_TOKEN, OCW_MODEL_PROVIDER: "mock" } });
  su = new pg.Client({ connectionString: stack.db.superuserUrl });
  await su.connect();
  admin = new TestClient(stack.baseUrl);
  const setup = await ok(admin.request("POST", "/api/v1/setup", { token: TEST_SETUP_TOKEN, ...ADMIN }));
  orgId = setup.organization.id;
  [sam, samId] = await joinAs("sam@example.test", "Sam Lee", "developer");
  [alex] = await joinAs("alex@example.test", "Alex Kim", "developer");

  const samBot = await ok(sam.request("POST", "/api/v1/agents/personal", {}));
  samBotId = samBot.agent.id;
  samDmId = samBot.dmId;
  const alexBot = await ok(alex.request("POST", "/api/v1/agents/personal", {}));
  alexBotId = alexBot.agent.id;
  alexDmId = alexBot.dmId;
}, 180_000);

afterAll(async () => {
  await su?.end();
  await stack?.stop();
});

describe("a personal bot at its daily limit (DM)", () => {
  it("delivers up to the limit, then answers with the notice and sends nothing to the cell", async () => {
    await ok(sam.request("PATCH", `/api/v1/agents/${samBotId}/capabilities`, { dailyLimit: 3 }));
    for (const body of ["one", "two", "three"]) await say(sam, samDmId, body);
    expect(await cellEvents(samBotId)).toHaveLength(3);
    expect(await turnsToday(samBotId)).toBe(3);
    expect(await botMessages(samBotId, samDmId)).toHaveLength(0);

    const fourth = await say(sam, samDmId, "four, with a secret: hunter2");
    expect(await cellEvents(samBotId)).toHaveLength(3);
    expect(await turnsToday(samBotId)).toBe(3);
    const notices = await botMessages(samBotId, samDmId);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      body: "I've reached my daily limit of 3 replies, so I can't answer right now. I'll be back after 00:00 UTC.",
      // DMs are flat (D-04).
      thread_id: null,
      client_message_id: `limit:${fourth.id}`,
    });

    const rows = await limitAudits(samBotId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor_kind: "agent",
      actor_id: samBotId,
      agent_id: samBotId,
      user_id: samId,
      resource_type: "agent",
      resource_id: samBotId,
      result: "denied",
      metadata: { limit: 3, conversationKind: "dm", notified: true },
    });
    // Ids and numbers only: never the message text.
    expect(JSON.stringify(rows[0])).not.toContain("hunter2");
    expect(JSON.stringify(rows[0])).not.toContain("four");
  });

  it("every further DM message gets its own notice, still without any cell event", async () => {
    await say(sam, samDmId, "five");
    expect(await cellEvents(samBotId)).toHaveLength(3);
    expect(await botMessages(samBotId, samDmId)).toHaveLength(2);
    expect(await limitAudits(samBotId)).toHaveLength(2);
  });

  it("the notice is idempotent: replaying its key creates nothing", async () => {
    const [first] = await botMessages(samBotId, samDmId);
    const key = first!.client_message_id as string;
    const replay = await stack.built.core.chatAgent.postAgentMessage(
      { organizationId: orgId, userId: null },
      {
        agentId: samBotId,
        conversationId: samDmId,
        threadRootId: null,
        body: "anything",
        idempotencyKey: key,
        inReplyToMessageId: key.slice("limit:".length),
      },
    );
    expect(replay).toEqual({ messageId: first!.id, created: false });
    expect(await botMessages(samBotId, samDmId)).toHaveLength(2);
  });

  it("the owner sees today's usage against the limit with the reset time", async () => {
    const v = await ok(sam.request("GET", `/api/v1/agents/${samBotId}/capabilities`));
    expect(v.usage).toEqual({ today: 3, limit: 3, resetsAt: nextResetAt() });
  });

  it("an admin sees the same numbers in the governance list", async () => {
    const list = await ok(admin.request("GET", "/api/v1/bot-governance"));
    const entry = list.bots.find((b: Json) => b.id === samBotId);
    expect(entry.usage).toEqual({ today: 3, limit: 3, resetsAt: nextResetAt() });
  });

  it("raising the limit lets the next message through", async () => {
    await ok(sam.request("PATCH", `/api/v1/agents/${samBotId}/capabilities`, { dailyLimit: 4 }));
    await say(sam, samDmId, "six");
    expect(await cellEvents(samBotId)).toHaveLength(4);
    expect(await turnsToday(samBotId)).toBe(4);
    expect(await botMessages(samBotId, samDmId)).toHaveLength(2);
  });
});

describe("concurrency", () => {
  it("20 parallel messages against a limit of 5 deliver exactly 5 turns", async () => {
    await ok(alex.request("PATCH", `/api/v1/agents/${alexBotId}/capabilities`, { dailyLimit: 5 }));
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        alex.request("POST", `/api/v1/conversations/${alexDmId}/messages`, { body: `burst ${i}` }),
      ),
    );
    expect(results.map((r) => r.status)).toEqual(Array(20).fill(200));
    expect(await cellEvents(alexBotId)).toHaveLength(5);
    expect(await turnsToday(alexBotId)).toBe(5);
    expect(await botMessages(alexBotId, alexDmId)).toHaveLength(15);
    expect(await limitAudits(alexBotId)).toHaveLength(15);
  });
});

describe("consumeTurn and the UTC day", () => {
  const ctx = () => ({ organizationId: orgId, userId: null });

  it("counts per UTC day: yesterday's full counter does not block today", async () => {
    const { db } = stack.built.core;
    const yesterday = new Date("2026-01-01T23:59:59Z");
    const today = new Date("2026-01-02T00:00:00Z");
    const run = (now: Date, limit: number) =>
      db.withTenant(ctx(), (tx) => consumeTurn(tx, samBotId, limit, now));

    expect(await run(yesterday, 2)).toEqual({ ok: true, turns: 1 });
    expect(await run(yesterday, 2)).toEqual({ ok: true, turns: 2 });
    expect(await run(yesterday, 2)).toEqual({ ok: false });
    expect(await run(today, 2)).toEqual({ ok: true, turns: 1 });

    const usage = await db.withTenant(ctx(), (tx) => usageOf(tx, samBotId, 2, today));
    expect(usage).toEqual({ today: 1, limit: 2, resetsAt: "2026-01-03T00:00:00.000Z" });
    const before = await db.withTenant(ctx(), (tx) => usageOf(tx, samBotId, 2, yesterday));
    expect(before).toEqual({ today: 2, limit: 2, resetsAt: "2026-01-02T00:00:00.000Z" });
  });

  it("a lowered limit below today's count refuses without decrementing", async () => {
    const { db } = stack.built.core;
    const now = new Date("2026-01-02T12:00:00Z");
    expect(await db.withTenant(ctx(), (tx) => consumeTurn(tx, samBotId, 1, now))).toEqual({ ok: false });
    expect((await db.withTenant(ctx(), (tx) => usageOf(tx, samBotId, 1, now))).today).toBe(1);
  });

  it("20 concurrent transactions racing on one counter (no other lock in between) yield exactly 5 turns", async () => {
    const { db } = stack.built.core;
    const now = new Date("2026-03-03T10:00:00Z");
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        db.withTenant(ctx(), async (tx) => {
          const r = await consumeTurn(tx, alexBotId, 5, now);
          // Hold the row lock a moment so the other transactions really queue behind it.
          await tx.execute(sql`select pg_sleep(0.01)`);
          return r;
        }),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(5);
    expect(results.flatMap((r) => (r.ok ? [r.turns] : [])).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
    expect((await db.withTenant(ctx(), (tx) => usageOf(tx, alexBotId, 5, now))).today).toBe(5);
  });

  it("the notice text matches what the bot posted", () => {
    expect(limitNotice({ botName: "x", limit: 3 })).toContain("daily limit of 3 replies");
  });
});
