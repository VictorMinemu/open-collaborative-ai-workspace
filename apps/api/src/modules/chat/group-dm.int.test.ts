import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeCellPlugin } from "../../../../../e2e/support/fake-cell-plugin";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";

/**
 * 04-07 Task 2 (CHAT-04, D-06, T-04-07-02/03/04/05): group DMs of up to 9 participants, humans and team bots.
 * Fixed membership (a new member means a new group), team bots answer only when @mentioned and only if already
 * members, personal bots never join, groups are flat and never moderated. Real PostgreSQL + Redis.
 */

const CELL_TOKEN = "ocw-test-cell-token-group-dm-0123456789abcdef";
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
let adminId: string;
let samId: string;
let alexId: string;
const extraIds: string[] = [];
let helperId: string;
let outsiderBotId: string;
let disabledBotId: string;
let adminPersonalId: string;
let samPersonalId: string;

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
type Json = Record<string, any>;

async function ok(res: Promise<{ status: number; body: Record<string, unknown> | null }>, status = 200) {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as Json;
}

const codeOf = (r: { body: Record<string, unknown> | null }) =>
  (r.body as { error?: { code?: string } } | null)?.error?.code;

async function joinAs(email: string, name: string) {
  const inv = await ok(admin.request("POST", "/api/v1/invitations", { email, role: "developer" }));
  const c = new TestClient(stack.baseUrl);
  const acc = await ok(
    c.request("POST", `/api/v1/invitations/${inv.id}/accept`, { name, password: "another-long-password" }),
  );
  return [c, acc.user.id as string] as const;
}

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

const user = (id: string) => ({ kind: "user", id });
const agent = (id: string) => ({ kind: "agent", id });
const openDm = (c: TestClient, participants: Json[]) => c.request("POST", "/api/v1/dms", { participants });

/** `agent.mention.v1` events on the cell stream in one conversation. */
const cellEvents = async (conversationId: string) =>
  (
    await su.query(
      `select payload from app.stream_events
        where stream_id = $1 and type = 'agent.mention.v1' and payload->'conversation'->>'id' = $2 order by seq`,
      [`cell:${orgId}`, conversationId],
    )
  ).rows.map((r) => r.payload as Json);

const membersOf = async (conversationId: string) =>
  (
    await su.query(
      "select member_kind, member_id, role from app.conversation_members where conversation_id = $1",
      [conversationId],
    )
  ).rows as Json[];

beforeAll(async () => {
  stack = await startTestStack({ env: { OCW_CELL_TOKEN: CELL_TOKEN, OCW_MODEL_PROVIDER: "mock" } });
  su = new pg.Client({ connectionString: stack.db.superuserUrl });
  await su.connect();
  admin = new TestClient(stack.baseUrl);
  const setup = await ok(admin.request("POST", "/api/v1/setup", { token: TEST_SETUP_TOKEN, ...ADMIN }));
  orgId = setup.organization.id;
  adminId = setup.user.id;
  [sam, samId] = await joinAs("sam@example.test", "Sam Lee");
  [alex, alexId] = await joinAs("alex@example.test", "Alex Kim");
  for (let i = 3; i <= 9; i++) extraIds.push((await joinAs(`p${i}@example.test`, `Person ${i}`))[1]);

  helperId = await teamBot("Helper", "helper");
  // Reply mode `all` must never make a bot answer unaddressed group messages.
  await ok(admin.request("PATCH", `/api/v1/agents/${helperId}/capabilities`, { replyMode: "all" }));
  outsiderBotId = await teamBot("Outsider", "outsider");
  disabledBotId = await teamBot("Sleepy", "sleepy");
  await su.query("update app.agents set status = 'disabled' where id = $1", [disabledBotId]);
  adminPersonalId = (await ok(admin.request("POST", "/api/v1/agents/personal", {}))).agent.id;
  samPersonalId = (await ok(sam.request("POST", "/api/v1/agents/personal", {}))).agent.id;
}, 180_000);

afterAll(async () => {
  await su?.end();
  await stack?.stop();
});

describe("creating group DMs (D-06)", () => {
  let trio: string;

  it("the admin creates a group with Sam and Alex: kind group, sorted user key, all three members", async () => {
    const g = await ok(openDm(admin, [user(samId), user(alexId)]));
    trio = g.id;
    expect(g.kind).toBe("group");
    expect(g.visibility).toBe("private");
    const row = (await su.query("select kind, dm_key from app.conversations where id = $1", [g.id])).rows[0];
    expect(row.kind).toBe("group");
    expect(row.dm_key).toBe(
      [adminId, samId, alexId]
        .map((id) => `user:${id}`)
        .sort()
        .join("|"),
    );
    const members = await membersOf(g.id);
    expect(members.map((m) => m.member_id).sort()).toEqual([adminId, samId, alexId].sort());
    expect(new Set(members.map((m) => m.role))).toEqual(new Set(["member"]));
    // Others only, in pick order, the caller excluded.
    expect(g.counterpart).toMatchObject({ kind: "group", name: "Sam Lee and Alex Kim" });
    expect(g.counterpart.members.map((m: Json) => m.id)).toEqual([samId, alexId]);
  });

  it("the same set in another order (from another member) is the same group", async () => {
    const again = await ok(openDm(sam, [user(alexId), user(adminId), user(samId)]));
    expect(again.id).toBe(trio);
    expect(again.counterpart.name).toBe("Víctor Ruiz and Alex Kim");
  });

  it("adding a team bot is a different group, its key starting with the agent part", async () => {
    const withBot = await ok(openDm(admin, [user(samId), user(alexId), agent(helperId)]));
    expect(withBot.id).not.toBe(trio);
    const row = (await su.query("select dm_key from app.conversations where id = $1", [withBot.id])).rows[0];
    expect(row.dm_key.startsWith(`agent:${helperId}|user:`)).toBe(true);
    expect(row.dm_key).not.toMatch(/Helper|Sam/);
    expect(withBot.counterpart.name).toBe("Sam Lee, Alex Kim and Helper");
    expect((await membersOf(withBot.id)).filter((m) => m.member_kind === "agent")).toEqual([
      { member_kind: "agent", member_id: helperId, role: "member" },
    ]);
  });

  it("9 participants work, 10 are refused with too_many_participants", async () => {
    const eight = [user(samId), user(alexId), ...extraIds.slice(0, 6).map(user)];
    const nine = await ok(openDm(admin, eight));
    expect((await membersOf(nine.id)).length).toBe(9);
    expect(nine.counterpart.members).toHaveLength(8);
    expect(nine.counterpart.name).toBe("Sam Lee, Alex Kim, Person 3 and 5 more");
    const ten = await openDm(admin, [...eight, user(extraIds[6] as string)]);
    expect(ten.status).toBe(400);
    expect(codeOf(ten)).toBe("too_many_participants");
    // Duplicates and the caller do not count.
    const deduped = await ok(openDm(admin, [...eight, user(samId), user(adminId)]));
    expect(deduped.id).toBe(nine.id);
  });

  it("personal bots never join a group, not even the creator's own; disabled bots are refused", async () => {
    const own = await openDm(admin, [user(samId), agent(adminPersonalId)]);
    expect(own.status).toBe(409);
    expect(codeOf(own)).toBe("personal_bot_dm_only");
    // Someone else's personal bot does not exist for the caller.
    expect((await openDm(admin, [user(samId), agent(samPersonalId)])).status).toBe(404);
    const disabled = await openDm(admin, [user(samId), agent(disabledBotId)]);
    expect(disabled.status).toBe(400);
    expect(codeOf(disabled)).toBe("agent_disabled");
    expect((await openDm(admin, [user(samId), agent(randomUUID())])).status).toBe(404);
    const groups = await su.query(
      "select count(*)::int as n from app.conversation_members m join app.conversations c on c.id = m.conversation_id where c.kind = 'group' and m.member_kind = 'agent' and m.member_id = any($1::uuid[])",
      [[adminPersonalId, samPersonalId, disabledBotId]],
    );
    expect(groups.rows[0].n).toBe(0);
  });

  it("GET /dms lists the group for each member with the others only", async () => {
    const alexList = (await ok(alex.request("GET", "/api/v1/dms"))).dms as Json[];
    const g = alexList.find((d) => d.id === trio);
    expect(g?.counterpart).toMatchObject({ kind: "group", name: "Víctor Ruiz and Sam Lee" });
    expect(g?.counterpart.members.map((m: Json) => m.id)).toEqual([adminId, samId]);
    // A member outside the group never lists it.
    const [outsider] = await joinAs("out@example.test", "Out Sider");
    const theirs = (await ok(outsider.request("GET", "/api/v1/dms"))).dms as Json[];
    expect(theirs.some((d) => d.id === trio)).toBe(false);
  });
});

describe("inside a group: fixed, flat, mention-only, unmoderated", () => {
  let groupId: string;
  let plainGroupId: string;

  beforeAll(async () => {
    groupId = (await ok(openDm(admin, [user(samId), user(alexId), agent(helperId)]))).id;
    plainGroupId = (await ok(openDm(admin, [user(samId), user(alexId)]))).id;
  });

  it("membership cannot change: the channel members route is 404 and nothing is added", async () => {
    const add = await admin.request(
      "POST",
      `/api/v1/channels/${groupId}/members`,
      user(extraIds[0] as string),
    );
    expect(add.status).toBe(404);
    const remove = await admin.request("DELETE", `/api/v1/channels/${groupId}/members/user/${samId}`);
    expect(remove.status).toBe(404);
    expect((await admin.request("POST", `/api/v1/channels/${groupId}/archive`)).status).toBe(404);
    expect(await membersOf(groupId)).toHaveLength(4);
  });

  it("a thread reply is refused with dm_is_flat", async () => {
    const root = await ok(sam.request("POST", `/api/v1/conversations/${groupId}/messages`, { body: "root" }));
    const reply = await sam.request("POST", `/api/v1/conversations/${groupId}/messages`, {
      body: "in a thread",
      threadRootId: root.id,
    });
    expect(reply.status).toBe(400);
    expect(codeOf(reply)).toBe("dm_is_flat");
  });

  it("a message without a mention reaches no bot, even one whose reply mode is 'all'", async () => {
    const before = (await cellEvents(groupId)).length;
    await ok(sam.request("POST", `/api/v1/conversations/${groupId}/messages`, { body: "lunch at 2?" }));
    await new Promise((r) => setTimeout(r, 200));
    expect((await cellEvents(groupId)).length).toBe(before);
  });

  it("@helper is one flat delivery with the whole group as history (no deleted text); the reply is top level", async () => {
    const gone = await ok(
      alex.request("POST", `/api/v1/conversations/${groupId}/messages`, { body: "secret typo to delete" }),
    );
    await ok(alex.request("DELETE", `/api/v1/messages/${gone.id}`));
    const kept = await ok(
      alex.request("POST", `/api/v1/conversations/${groupId}/messages`, { body: "the deploy is on Friday" }),
    );
    const before = (await cellEvents(groupId)).length;
    const asked = await ok(
      sam.request("POST", `/api/v1/conversations/${groupId}/messages`, {
        body: "@helper when is the deploy?",
      }),
    );
    const events = (await cellEvents(groupId)).slice(before);
    expect(events).toHaveLength(1);
    const ev = events[0] as Json;
    expect(ev.agent.id).toBe(helperId);
    expect(ev.conversation.kind).toBe("group");
    expect(ev.message.id).toBe(asked.id);
    const history = (ev.threadHistory as Json[]).map((h) => h.text);
    expect(history).toContain("the deploy is on Friday");
    expect(history).toContain("lunch at 2?");
    expect(history).not.toContain("secret typo to delete");
    expect((ev.threadHistory as Json[]).some((h) => h.id === kept.id)).toBe(true);
    expect((ev.roster as Json[]).map((r) => r.id).sort()).toEqual([adminId, samId, alexId, helperId].sort());

    const plugin = new FakeCellPlugin({ apiUrl: stack.baseUrl, token: CELL_TOKEN });
    const res = await plugin.request<Json>("POST", "/messages", {
      agentId: helperId,
      conversationId: groupId,
      threadRootMessageId: asked.id,
      inReplyToMessageId: asked.id,
      text: "Friday at 10.",
      idempotencyKey: `group-${randomUUID()}`,
    });
    expect(res.status).toBe(200);
    const stored = (
      await su.query("select thread_id, conversation_id from app.messages where id = $1", [
        res.body.messageId,
      ])
    ).rows[0];
    expect(stored).toEqual({ thread_id: null, conversation_id: groupId });
  });

  it("a bot that is not a member is never added or asked by a mention", async () => {
    const before = (await cellEvents(plainGroupId)).length;
    await ok(
      sam.request("POST", `/api/v1/conversations/${plainGroupId}/messages`, { body: "@outsider @helper hi" }),
    );
    expect((await cellEvents(plainGroupId)).length).toBe(before);
    expect((await membersOf(plainGroupId)).every((m) => m.member_kind === "user")).toBe(true);
    const stored = (
      await su.query(
        "select mentions from app.messages where conversation_id = $1 order by seq desc limit 1",
        [plainGroupId],
      )
    ).rows[0];
    // The mention is recorded as text attribution, never as a membership change.
    expect(stored.mentions).toEqual(
      expect.arrayContaining([
        { kind: "agent", id: outsiderBotId },
        { kind: "agent", id: helperId },
      ]),
    );
  });

  it("the admin, a participant, cannot delete Sam's message (403 direct_conversation); Sam can", async () => {
    const msg = await ok(sam.request("POST", `/api/v1/conversations/${groupId}/messages`, { body: "mine" }));
    const denied = await admin.request("DELETE", `/api/v1/messages/${msg.id}`);
    expect(denied.status).toBe(403);
    expect(JSON.stringify(denied.body)).toContain("direct_conversation");
    await ok(sam.request("DELETE", `/api/v1/messages/${msg.id}`));
  });
});
