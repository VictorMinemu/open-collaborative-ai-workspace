import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";
import { utcDay } from "../bot-capabilities";
import { REPLY_MODE_PER_MINUTE } from "./index";

/**
 * 03.1-08 (BOT-04, BOT-05, D-12): a team bot with reply mode `all` answers every human message in the channels
 * it is a member of, in the message's thread, without being mentioned. Guardrails: never a bot's message, never
 * when another bot is mentioned, at most REPLY_MODE_PER_MINUTE automatic replies per minute per conversation
 * (the excess audited once), the org policy decided at delivery, and the daily limit like any turn.
 * Real PostgreSQL + Redis.
 */

const CELL_TOKEN = "ocw-test-cell-token-reply-mode-0123456789abcd";
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
let orgId: string;
let samId: string;
let followerId: string;
let otherBotId: string;

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

/** `agent.mention.v1` events on the cell stream for one bot, optionally in one conversation. */
const cellEvents = async (agentId: string, conversationId?: string) =>
  (
    await su.query(
      `select payload from app.stream_events
        where stream_id = $1 and type = 'agent.mention.v1' and payload->'agent'->>'id' = $2
          and ($3::text is null or payload->'conversation'->>'id' = $3) order by seq`,
      [`cell:${orgId}`, agentId, conversationId ?? null],
    )
  ).rows.map((r) => r.payload as Json);

const audits = async (action: string, agentId: string) =>
  (
    await su.query(
      `select actor_kind, actor_id, agent_id, user_id, resource_type, resource_id, result, metadata
         from app.audit_events where action = $1 and organization_id = $2 and agent_id = $3
        order by occurred_at, id`,
      [action, orgId, agentId],
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

const say = (c: TestClient, conversationId: string, body: string, extra: Record<string, unknown> = {}) =>
  ok(c.request("POST", `/api/v1/conversations/${conversationId}/messages`, { body, ...extra }));

async function teamBot(name: string, username: string): Promise<string> {
  const bot = await ok(
    admin.request("POST", "/api/v1/agents", {
      name,
      username,
      instructions: `You are ${name}.`,
      modelProvider: "mock",
      modelId: "mock-1",
    }),
  );
  return bot.id as string;
}

/** A fresh public channel with Sam and the given bots as members. */
async function channel(name: string, botIds: string[]): Promise<string> {
  const id = (await ok(admin.request("POST", "/api/v1/channels", { name }))).id as string;
  await ok(sam.request("POST", `/api/v1/channels/${id}/join`, {}));
  for (const botId of botIds) {
    await ok(admin.request("POST", `/api/v1/channels/${id}/members`, { kind: "agent", id: botId }));
  }
  return id;
}

/** Waits for a fresh minute window when fewer than `margin` seconds are left (the cap is per epoch minute). */
async function awayFromMinuteEdge(marginSeconds = 15) {
  const left = 60 - new Date().getUTCSeconds();
  if (left < marginSeconds) await new Promise((r) => setTimeout(r, left * 1000 + 200));
}

beforeAll(async () => {
  stack = await startTestStack({ env: { OCW_CELL_TOKEN: CELL_TOKEN, OCW_MODEL_PROVIDER: "mock" } });
  su = new pg.Client({ connectionString: stack.db.superuserUrl });
  await su.connect();
  admin = new TestClient(stack.baseUrl);
  const setup = await ok(admin.request("POST", "/api/v1/setup", { token: TEST_SETUP_TOKEN, ...ADMIN }));
  orgId = setup.organization.id;
  [sam, samId] = await joinAs("sam@example.test", "Sam Lee", "developer");

  followerId = await teamBot("Follower", "follower");
  await ok(admin.request("PATCH", `/api/v1/agents/${followerId}/capabilities`, { replyMode: "all" }));
  otherBotId = await teamBot("Other Bot", "other-bot");
}, 180_000);

afterAll(async () => {
  await su?.end();
  await stack?.stop();
});

describe("a team bot set to 'every message' (D-12)", () => {
  let ops: string;
  let rootId: string;

  beforeAll(async () => {
    ops = await channel("ops", [followerId, otherBotId]);
  });

  it("answers a plain top-level human message in that message's thread", async () => {
    const msg = await say(sam, ops, "deploy done");
    rootId = msg.id;
    const events = await cellEvents(followerId, ops);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      agent: { id: followerId },
      conversation: { id: ops, kind: "channel" },
      thread: { rootMessageId: msg.id },
      message: { id: msg.id, text: "deploy done", author: { kind: "user", id: samId } },
    });
    // Nobody was mentioned: the event never claims a bot mention the message does not have.
    expect(events[0]!.message.mentions).toEqual([]);
    expect(events[0]!.turn).toBeTruthy();
    // A bot left in 'mentions only' stays silent.
    expect(await cellEvents(otherBotId, ops)).toHaveLength(0);
  });

  it("answers a reply inside an existing thread in that thread", async () => {
    const reply = await say(sam, ops, "and the smoke tests passed", { threadRootId: rootId });
    const events = await cellEvents(followerId, ops);
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ thread: { rootMessageId: rootId }, message: { id: reply.id } });
  });

  it("never answers a bot's message", async () => {
    await stack.built.core.chatAgent.postAgentMessage(
      { organizationId: orgId, userId: null },
      {
        agentId: otherBotId,
        conversationId: ops,
        threadRootId: null,
        body: "I am a bot talking in the channel",
        idempotencyKey: "reply-mode-bot-author",
      },
    );
    expect(await cellEvents(followerId, ops)).toHaveLength(2);
  });

  it("stays silent when the message mentions another bot; that bot alone is asked", async () => {
    const msg = await say(sam, ops, "@other-bot hi");
    expect(await cellEvents(followerId, ops)).toHaveLength(2);
    const other = await cellEvents(otherBotId, ops);
    expect(other).toHaveLength(1);
    expect(other[0]).toMatchObject({ message: { id: msg.id }, thread: { rootMessageId: msg.id } });
  });

  it("does nothing in a channel it is not a member of", async () => {
    const elsewhere = await channel("elsewhere", []);
    await say(sam, elsewhere, "anyone here?");
    expect(await cellEvents(followerId, elsewhere)).toHaveLength(0);
  });

  it("reply-mode turns count against the daily limit like mentions", async () => {
    const before = await turnsToday(followerId);
    const room = await channel("metered", [followerId]);
    await say(sam, room, "one");
    await say(sam, room, "two");
    expect(await cellEvents(followerId, room)).toHaveLength(2);
    expect(await turnsToday(followerId)).toBe(before + 2);
  });
});

describe("rate cap (T-03.1-08-01)", () => {
  it(`at most ${REPLY_MODE_PER_MINUTE} automatic replies per minute per conversation, the excess audited once`, async () => {
    const busy = await channel("busy", [followerId]);
    const auditsBefore = (await audits("agent.reply_rate_limited", followerId)).length;
    await awayFromMinuteEdge();
    for (let i = 1; i <= 8; i++) await say(sam, busy, `update ${i} with secret hunter2`);

    const events = await cellEvents(followerId, busy);
    expect(events).toHaveLength(REPLY_MODE_PER_MINUTE);
    expect(events.map((e) => e.message.text)).toEqual(
      Array.from({ length: REPLY_MODE_PER_MINUTE }, (_, i) => `update ${i + 1} with secret hunter2`),
    );
    const rows = (await audits("agent.reply_rate_limited", followerId)).slice(auditsBefore);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor_kind: "agent",
      actor_id: followerId,
      agent_id: followerId,
      user_id: samId,
      resource_type: "agent",
      resource_id: followerId,
      result: "denied",
      metadata: { conversationId: busy, limit: REPLY_MODE_PER_MINUTE },
    });
    expect(JSON.stringify(rows[0])).not.toContain("hunter2");
    // No notice either: the bot posts nothing in the channel.
    const posted = await su.query(
      "select count(*)::int as n from app.messages where author_kind = 'agent' and author_id = $1 and conversation_id = $2",
      [followerId, busy],
    );
    expect(posted.rows[0].n).toBe(0);
  });

  it("the cap is per conversation: another channel is not affected", async () => {
    const calm = await channel("calm", [followerId]);
    await say(sam, calm, "hello");
    expect(await cellEvents(followerId, calm)).toHaveLength(1);
  });
});

describe("org policy (BOT-05, T-03.1-08-03)", () => {
  it("reply mode denied org-wide: the next plain message gets no automatic reply, mentions still work", async () => {
    const quiet = await channel("quiet", [followerId]);
    await ok(
      admin.request("PUT", "/api/v1/bot-policy", {
        capabilities: { replyModeAll: { orgWide: false, personal: false } },
      }),
    );
    try {
      await say(sam, quiet, "status of the release?");
      expect(await cellEvents(followerId, quiet)).toHaveLength(0);
      const asked = await say(sam, quiet, "@follower status of the release?");
      const events = await cellEvents(followerId, quiet);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ message: { id: asked.id } });
    } finally {
      await ok(
        admin.request("PUT", "/api/v1/bot-policy", {
          capabilities: { replyModeAll: { orgWide: true, personal: true } },
        }),
      );
    }
    await say(sam, quiet, "back on?");
    expect(await cellEvents(followerId, quiet)).toHaveLength(2);
  });
});
