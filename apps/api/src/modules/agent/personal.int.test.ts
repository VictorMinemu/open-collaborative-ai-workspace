import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeCellPlugin } from "../../../../../e2e/support/fake-cell-plugin";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";

/**
 * 03.1-01 (BOT-01/02/03, SC1): a member creates a personal bot in one click, gets a private DM with it, and
 * the bot is asked on every DM message (no @mention) through the real chat → agent-channel bridge; the
 * cell's flat reply lands at the top level of the DM. Real PostgreSQL + Redis.
 */

const CELL_TOKEN = "ocw-test-cell-token-personal-0123456789abcdefgh";
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
let botId: string;
let dmId: string;
const plugins: FakeCellPlugin[] = [];

async function ok(res: Promise<{ status: number; body: Record<string, unknown> | null }>, status = 200) {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  // biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
  return r.body as Record<string, any>;
}

// biome-ignore lint/suspicious/noExplicitAny: stored event payloads are asserted field by field
type Payload = Record<string, any>;

const cellMentions = async () =>
  (
    await su.query(
      "select seq, payload from app.stream_events where stream_id = $1 and type = 'agent.mention.v1' order by seq",
      [`cell:${orgId}`],
    )
  ).rows as Array<{ seq: number; payload: Payload }>;

async function joinAs(email: string, name: string, role: "developer" | "standard") {
  const inv = await ok(admin.request("POST", "/api/v1/invitations", { email, role }));
  const c = new TestClient(stack.baseUrl);
  const acc = await ok(
    c.request("POST", `/api/v1/invitations/${inv.id}/accept`, { name, password: "another-long-password" }),
  );
  return [c, acc.user.id as string] as const;
}

beforeAll(async () => {
  stack = await startTestStack({ env: { OCW_CELL_TOKEN: CELL_TOKEN, OCW_MODEL_PROVIDER: "mock" } });
  su = new pg.Client({ connectionString: stack.db.superuserUrl });
  await su.connect();
  admin = new TestClient(stack.baseUrl);
  const setup = await ok(admin.request("POST", "/api/v1/setup", { token: TEST_SETUP_TOKEN, ...ADMIN }));
  orgId = setup.organization.id;
  [sam, samId] = await joinAs("sam@example.test", "Sam Lee", "developer");
}, 180_000);

afterAll(async () => {
  for (const p of plugins) await p.stop();
  await su?.end();
  await stack?.stop();
});

describe("personal bot: one click → private DM", () => {
  it("creates a personal bot owned by the caller, its DM, an audit row, and tells only the owner", async () => {
    const res = await ok(sam.request("POST", "/api/v1/agents/personal", {}));
    expect(res.agent).toMatchObject({
      scope: "personal",
      ownerUserId: samId,
      name: "Sam's assistant",
      modelProvider: "mock",
      modelId: "mock-1",
      status: "provisioning",
    });
    expect(res.agent.instructions).toContain("personal assistant of Sam Lee");
    botId = res.agent.id;
    dmId = res.dmId;

    const conv = (await su.query("select * from app.conversations where id = $1", [dmId])).rows[0];
    expect(conv).toMatchObject({
      kind: "dm",
      visibility: "private",
      name: null,
      dm_key: `agent:${botId}|user:${samId}`,
    });
    const members = (
      await su.query(
        "select member_kind, member_id, role from app.conversation_members where conversation_id = $1 order by member_kind desc",
        [dmId],
      )
    ).rows;
    expect(members).toEqual([
      { member_kind: "user", member_id: samId, role: "owner" },
      { member_kind: "agent", member_id: botId, role: "member" },
    ]);

    const audit = (
      await su.query(
        "select metadata, user_id from app.audit_events where action = 'agent.created' and resource_id = $1",
        [botId],
      )
    ).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0].metadata).toMatchObject({ scope: "personal", ownerUserId: samId, model: "mock/mock-1" });
    expect(audit[0].user_id).toBe(samId);

    // The new bot is announced on the owner's topic only, never the org topic (Pitfall 4).
    const orgCreated = await su.query(
      "select 1 from app.stream_events where stream_id = $1 and type = 'agent.created' and payload->>'id' = $2",
      [`org:${orgId}`, botId],
    );
    expect(orgCreated.rowCount).toBe(0);
    const userCreated = await su.query(
      "select 1 from app.stream_events where stream_id = $1 and type = 'agent.created' and payload->>'id' = $2",
      [`user:${samId}`, botId],
    );
    expect(userCreated.rowCount).toBe(1);
    const cellChanged = await su.query(
      "select 1 from app.stream_events where stream_id = $1 and type = 'cell.config.changed' and payload->>'agentId' = $2",
      [`cell:${orgId}`, botId],
    );
    expect(cellChanged.rowCount).toBe(1);
  });

  it("GET /dms lists exactly that DM with the bot as counterpart", async () => {
    const res = await ok(sam.request("GET", "/api/v1/dms"));
    expect(res.dms).toHaveLength(1);
    expect(res.dms[0]).toMatchObject({
      id: dmId,
      kind: "dm",
      visibility: "private",
      counterpart: { kind: "agent", id: botId, name: "Sam's assistant", scope: "personal" },
      latestMessageSeq: 0,
      lastReadSeq: 0,
    });
    expect(typeof res.userSeq).toBe("number");
    expect((await ok(admin.request("GET", "/api/v1/dms"))).dms).toEqual([]);
  });

  it("every human DM message (no mention) produces exactly one flat delivery with the DM history", async () => {
    const first = await ok(sam.request("POST", `/api/v1/conversations/${dmId}/messages`, { body: "hello" }));
    let events = await cellMentions();
    expect(events).toHaveLength(1);
    const ev = events[0]!.payload;
    expect(ev).toMatchObject({
      type: "agent.mention.v1",
      agent: { id: botId },
      conversation: { id: dmId, kind: "dm", name: null },
      thread: { rootMessageId: first.id },
      message: { id: first.id, text: "hello", author: { kind: "user", id: samId, displayName: "Sam Lee" } },
      threadHistory: [],
    });
    expect(ev.roster.map((r: { kind: string; id: string }) => `${r.kind}:${r.id}`).sort()).toEqual(
      [`agent:${botId}`, `user:${samId}`].sort(),
    );

    const second = await ok(
      sam.request("POST", `/api/v1/conversations/${dmId}/messages`, { body: "and a follow-up" }),
    );
    events = await cellMentions();
    expect(events).toHaveLength(2);
    expect(events[1]!.payload.thread.rootMessageId).toBe(second.id);
    // History = earlier DM messages only (the current one excluded), oldest first.
    expect(events[1]!.payload.threadHistory.map((h: { id: string }) => h.id)).toEqual([first.id]);

    const read = await ok(sam.request("POST", `/api/v1/conversations/${dmId}/read`, { seq: second.seq }));
    expect(read).toEqual({ ok: true });
    const dms = await ok(sam.request("GET", "/api/v1/dms"));
    expect(dms.dms[0]).toMatchObject({ latestMessageSeq: second.seq, lastReadSeq: second.seq });
  });

  it("the cell's reply with threadRootMessageId null is stored top-level in the DM, once", async () => {
    const plugin = new FakeCellPlugin({ apiUrl: stack.baseUrl, token: CELL_TOKEN });
    plugins.push(plugin);
    const ack = await plugin.request("POST", `/agents/${botId}/status`, { status: "ready" });
    expect(ack.status).toBe(200);
    const [last] = (await cellMentions()).slice(-1);
    const body = {
      agentId: botId,
      conversationId: dmId,
      threadRootMessageId: null,
      inReplyToMessageId: last!.payload.message.id,
      text: "Hi Sam!",
      idempotencyKey: `evt:${last!.payload.eventId}`,
    };
    const res = await plugin.request<{ messageId: string; created: boolean; threadRootMessageId: null }>(
      "POST",
      "/messages",
      body,
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ created: true, threadRootMessageId: null });
    const again = await plugin.request<{ messageId: string; created: boolean }>("POST", "/messages", body);
    expect(again.body).toMatchObject({ created: false, messageId: res.body.messageId });

    const stored = (
      await su.query(
        "select author_kind, author_id, thread_id from app.messages where conversation_id = $1",
        [dmId],
      )
    ).rows;
    expect(stored.filter((m) => m.author_kind === "agent")).toEqual([
      { author_kind: "agent", author_id: botId, thread_id: null },
    ]);
    const page = await ok(sam.request("GET", `/api/v1/conversations/${dmId}/messages`));
    expect(page.messages.map((m: { body: string }) => m.body)).toEqual([
      "hello",
      "and a follow-up",
      "Hi Sam!",
    ]);
    // A bot-authored message never triggers another delivery.
    expect(await cellMentions()).toHaveLength(2);
  });

  it("a deny rule on bot.create_personal for developers → 403 with the denial and an authz.denied row", async () => {
    const ruleId = randomUUID();
    await su.query(
      `insert into app.permission_rules (id, organization_id, subject_kind, subject_id, permission, effect)
       values ($1, $2, 'role', 'developer', 'bot.create_personal', 'deny')`,
      [ruleId, orgId],
    );
    try {
      const res = await sam.request("POST", "/api/v1/agents/personal", {});
      expect(res.status).toBe(403);
      expect((res.body as { error: { details: unknown } }).error.details).toMatchObject({
        permission: "bot.create_personal",
        layer: "org",
        reason: "denied_by_rule",
        ruleId,
      });
      const denied = await su.query(
        "select metadata from app.audit_events where action = 'authz.denied' and user_id = $1 and metadata->>'permission' = 'bot.create_personal'",
        [samId],
      );
      expect(denied.rowCount).toBe(1);
    } finally {
      await su.query("delete from app.permission_rules where id = $1", [ruleId]);
    }
  });

  it("caps personal bots per member at the default limit (3) with personal_bot_limit", async () => {
    await ok(sam.request("POST", "/api/v1/agents/personal", { name: "Second" }));
    await ok(sam.request("POST", "/api/v1/agents/personal", { name: "Third" }));
    const over = await sam.request("POST", "/api/v1/agents/personal", { name: "Fourth" });
    expect(over.status).toBe(409);
    expect((over.body as { error: { code: string } }).error.code).toBe("personal_bot_limit");
    expect((await ok(sam.request("GET", "/api/v1/dms"))).dms).toHaveLength(3);
  });

  it("an explicit model the organization does not allow is refused", async () => {
    const [lee] = await joinAs("lee@example.test", "Lee", "standard");
    const res = await lee.request("POST", "/api/v1/agents/personal", {
      modelProvider: "anthropic",
      modelId: "claude-sonnet-5-5",
    });
    expect(res.status).toBe(400);
    expect((res.body as { error: { code: string } }).error.code).toBe("model_not_allowed");
  });
});
