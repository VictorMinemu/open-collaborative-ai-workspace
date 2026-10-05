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

/**
 * 03.1-02 Task 2 (SC1, BOT-01/02, D-01/D-04, T-03.1-02-01/02/03/05/06/07): a personal bot exists only for its
 * owner in lists, details and events; admins govern it (disable, enable, delete; audited) without editing
 * what is inside; disabling or deleting archives its chat.
 */
describe("personal bot visibility and governance", () => {
  let kim: TestClient;
  let kimId: string;
  let rex: TestClient;
  let kimBot: string;
  let kimDm: string;
  let teamId: string;

  const errorOf = (r: { body: Record<string, unknown> | null }) =>
    (r.body as { error?: { code?: string; details?: Record<string, unknown> } } | null)?.error ?? {};
  const archivedAt = async (convId: string) =>
    (await su.query("select archived_at from app.conversations where id = $1", [convId])).rows[0]
      ?.archived_at;
  const orgEventsAbout = async (agentId: string) =>
    (
      await su.query(
        "select type from app.stream_events where stream_id = $1 and (payload->>'id' = $2 or payload->>'agentId' = $2)",
        [`org:${orgId}`, agentId],
      )
    ).rows.map((r) => r.type as string);
  const userEventsAbout = async (userId: string, agentId: string) =>
    (
      await su.query(
        "select type from app.stream_events where stream_id = $1 and payload->>'id' = $2 order by seq",
        [`user:${userId}`, agentId],
      )
    ).rows.map((r) => r.type as string);

  beforeAll(async () => {
    [kim, kimId] = await joinAs("kim@example.test", "Kim Park", "developer");
    [rex] = await joinAs("rex@example.test", "Rex Moore", "developer");
    const created = await ok(kim.request("POST", "/api/v1/agents/personal", {}));
    kimBot = created.agent.id;
    kimDm = created.dmId;
    const team = await ok(
      admin.request("POST", "/api/v1/agents", {
        name: "Ops",
        instructions: "Help with operations.",
        modelProvider: "mock",
        modelId: "mock-1",
      }),
    );
    teamId = team.id;
  });

  it("GET /agents lists team bots for everyone and a personal bot for its owner only, with viewerCan", async () => {
    const asRex = (await ok(rex.request("GET", "/api/v1/agents"))).agents as Payload[];
    const asKim = (await ok(kim.request("GET", "/api/v1/agents"))).agents as Payload[];
    const asAdmin = (await ok(admin.request("GET", "/api/v1/agents"))).agents as Payload[];
    expect(asRex.some((a) => a.scope === "personal")).toBe(false);
    expect(asAdmin.some((a) => a.scope === "personal")).toBe(false);
    expect(asKim.filter((a) => a.scope === "personal").map((a) => a.id)).toEqual([kimBot]);
    for (const list of [asRex, asKim, asAdmin]) {
      expect(list.some((a) => a.id === teamId)).toBe(true);
      for (const a of list) expect(Array.isArray(a.viewerCan)).toBe(true);
    }
    expect(asKim.find((a) => a.id === kimBot)?.viewerCan).toEqual(["bot.read", "bot.configure"]);
    expect(asRex.find((a) => a.id === teamId)?.viewerCan).toEqual(["bot.read"]);
    expect(asAdmin.find((a) => a.id === teamId)?.viewerCan).toEqual([
      "bot.read",
      "bot.configure",
      "bot.manage",
    ]);
  });

  it("GET /agents/:id hides a personal bot from everyone but its owner (404)", async () => {
    expect((await rex.request("GET", `/api/v1/agents/${kimBot}`)).status).toBe(404);
    expect((await admin.request("GET", `/api/v1/agents/${kimBot}`)).status).toBe(404);
    expect(await ok(kim.request("GET", `/api/v1/agents/${kimBot}`))).toMatchObject({
      id: kimBot,
      viewerCan: ["bot.read", "bot.configure"],
    });
  });

  it("the owner edits it; an admin cannot (403 personal_bot); anyone else does not see it (404)", async () => {
    const edited = await ok(
      kim.request("PATCH", `/api/v1/agents/${kimBot}`, {
        name: "Kim's helper",
        instructions: "Be brief.",
        modelProvider: "mock",
        modelId: "mock-1",
      }),
    );
    expect(edited).toMatchObject({ name: "Kim's helper", instructions: "Be brief." });

    const byAdmin = await admin.request("PATCH", `/api/v1/agents/${kimBot}`, { instructions: "Spy." });
    expect(byAdmin.status).toBe(403);
    expect(errorOf(byAdmin).details).toMatchObject({ permission: "bot.configure", reason: "personal_bot" });
    expect((await rex.request("PATCH", `/api/v1/agents/${kimBot}`, { enabled: false })).status).toBe(404);
    expect((await rex.request("DELETE", `/api/v1/agents/${kimBot}`)).status).toBe(404);
    const row = (await su.query("select instructions, status from app.agents where id = $1", [kimBot]))
      .rows[0];
    expect(row.instructions).toBe("Be brief.");

    // Every change so far travelled on Kim's topic only.
    expect(await userEventsAbout(kimId, kimBot)).toEqual(
      expect.arrayContaining(["agent.created", "agent.updated"]),
    );
    expect(await orgEventsAbout(kimBot)).toEqual([]);
  });

  it("an owner's model change honours personal_allowed_models (400 model_not_allowed)", async () => {
    await ok(
      admin.request("POST", "/api/v1/model-providers", {
        provider: "anthropic",
        apiKey: "sk-ant-test-fake-key-not-real-000000",
        allowedModels: ["claude-sonnet-5-5"],
      }),
    );
    await su.query(
      `insert into app.bot_policies (organization_id, personal_allowed_models) values ($1, '{mock/mock-1}')
       on conflict (organization_id) do update set personal_allowed_models = excluded.personal_allowed_models`,
      [orgId],
    );
    try {
      const res = await kim.request("PATCH", `/api/v1/agents/${kimBot}`, {
        modelProvider: "anthropic",
        modelId: "claude-sonnet-5-5",
      });
      expect(res.status).toBe(400);
      expect(errorOf(res).code).toBe("model_not_allowed");
      // The same model is fine for a team bot: the narrowing is for personal bots only.
      await ok(
        admin.request("PATCH", `/api/v1/agents/${teamId}`, {
          modelProvider: "anthropic",
          modelId: "claude-sonnet-5-5",
        }),
      );
    } finally {
      await su.query(
        "update app.bot_policies set personal_allowed_models = '{}' where organization_id = $1",
        [orgId],
      );
    }
  });

  it("an admin disables it (audited as governance), its chat is archived; only an admin re-enables it", async () => {
    const off = await ok(admin.request("PATCH", `/api/v1/agents/${kimBot}`, { enabled: false }));
    expect(off).toMatchObject({ status: "disabled", statusMessage: "Disabled by a workspace admin" });
    // The governance response carries metadata only, never the owner's instructions.
    expect(off.instructions).toBe("");
    expect(JSON.stringify(off)).not.toContain("Be brief.");
    const audit = (
      await su.query(
        "select user_id, metadata from app.audit_events where action = 'agent.disabled' and resource_id = $1",
        [kimBot],
      )
    ).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0].metadata).toMatchObject({ governance: true, scope: "personal", ownerUserId: kimId });
    expect(JSON.stringify(audit[0].metadata)).not.toContain("Be brief.");

    expect(await archivedAt(kimDm)).not.toBeNull();
    const post = await kim.request("POST", `/api/v1/conversations/${kimDm}/messages`, { body: "hello?" });
    expect(post.status).toBe(410);
    expect(((await ok(kim.request("GET", "/api/v1/dms"))).dms as Payload[]).some((d) => d.id === kimDm)).toBe(
      false,
    );
    const updated = await su.query(
      "select 1 from app.stream_events where stream_id = $1 and type = 'conversation.updated' and payload->>'conversationId' = $2",
      [`user:${kimId}`, kimDm],
    );
    expect(updated.rowCount).toBe(1);

    // The owner cannot undo an admin's decision.
    const undo = await kim.request("PATCH", `/api/v1/agents/${kimBot}`, { enabled: true });
    expect(undo.status).toBe(403);
    expect(errorOf(undo).code).toBe("disabled_by_admin");

    const on = await ok(admin.request("PATCH", `/api/v1/agents/${kimBot}`, { enabled: true }));
    expect(on).toMatchObject({ status: "provisioning", statusMessage: null });
    expect(await archivedAt(kimDm)).toBeNull();
    expect(((await ok(kim.request("GET", "/api/v1/dms"))).dms as Payload[]).some((d) => d.id === kimDm)).toBe(
      true,
    );
    await ok(kim.request("POST", `/api/v1/conversations/${kimDm}/messages`, { body: "back" }));

    // The owner may switch their own bot off and on again (not governance).
    await ok(kim.request("PATCH", `/api/v1/agents/${kimBot}`, { enabled: false }));
    await ok(kim.request("PATCH", `/api/v1/agents/${kimBot}`, { enabled: true }));
    const own = (
      await su.query(
        "select metadata from app.audit_events where action = 'agent.disabled' and resource_id = $1 and user_id = $2",
        [kimBot, kimId],
      )
    ).rows;
    expect(own).toHaveLength(1);
    expect(own[0].metadata.governance).toBeUndefined();
    expect(await orgEventsAbout(kimBot)).toEqual([]);
  });

  it("an admin deletes it (audited as governance); the chat is archived and leaves /dms", async () => {
    await ok(admin.request("DELETE", `/api/v1/agents/${kimBot}`));
    const audit = (
      await su.query(
        "select metadata from app.audit_events where action = 'agent.deleted' and resource_id = $1",
        [kimBot],
      )
    ).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0].metadata).toMatchObject({ governance: true, scope: "personal", ownerUserId: kimId });
    expect(await archivedAt(kimDm)).not.toBeNull();
    expect(((await ok(kim.request("GET", "/api/v1/dms"))).dms as Payload[]).some((d) => d.id === kimDm)).toBe(
      false,
    );
    expect((await kim.request("GET", `/api/v1/agents/${kimBot}`)).status).toBe(404);
    expect(await userEventsAbout(kimId, kimBot)).toContain("agent.deleted");
    expect(await orgEventsAbout(kimBot)).toEqual([]);
  });

  it("the owner deletes their own bot (no governance flag)", async () => {
    const created = await ok(kim.request("POST", "/api/v1/agents/personal", { name: "Scratch" }));
    await ok(kim.request("DELETE", `/api/v1/agents/${created.agent.id}`));
    const audit = (
      await su.query(
        "select metadata from app.audit_events where action = 'agent.deleted' and resource_id = $1",
        [created.agent.id],
      )
    ).rows;
    expect(audit[0].metadata.governance).toBeUndefined();
    expect(await archivedAt(created.dmId)).not.toBeNull();
  });

  it("the organization's limit applies (bot_policies.max_personal_bots_per_user = 1)", async () => {
    await su.query(
      `insert into app.bot_policies (organization_id, max_personal_bots_per_user) values ($1, 1)
       on conflict (organization_id) do update set max_personal_bots_per_user = 1`,
      [orgId],
    );
    try {
      const [lou] = await joinAs("lou@example.test", "Lou Diaz", "developer");
      await ok(lou.request("POST", "/api/v1/agents/personal", {}));
      const second = await lou.request("POST", "/api/v1/agents/personal", { name: "Another" });
      expect(second.status).toBe(409);
      expect(errorOf(second).code).toBe("personal_bot_limit");
    } finally {
      await su.query(
        "update app.bot_policies set max_personal_bots_per_user = 3 where organization_id = $1",
        [orgId],
      );
    }
  });
});
