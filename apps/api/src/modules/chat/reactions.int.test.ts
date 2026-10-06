import { randomUUID } from "node:crypto";
import { MAX_REACTIONS_PER_MESSAGE } from "@ocw/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";

/**
 * CHAT-07 (04-05): emoji reactions over real PostgreSQL + Redis. A reaction is a toggle per (message, emoji,
 * member); `reaction.updated` carries the absolute count, the first reactors, the actor and `added`, never a
 * viewer field (P-04); the message page hydrates `reactions` with `mine` for whoever asks.
 */

let stack: TestStack;
let su: pg.Client;
let admin: TestClient;
let sam: TestClient;
let orgId: string;
let adminId: string;
let samId: string;
let archieId: string;
let channelId: string;

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
type Json = Record<string, any>;

async function ok(res: Promise<{ status: number; body: Record<string, unknown> | null }>, status = 200) {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as Json;
}

const errorOf = (r: { body: Record<string, unknown> | null }) => (r.body as Json | null)?.error as Json;

async function events(conversationId: string, type: string): Promise<Json[]> {
  const res = await su.query(
    "select payload from app.stream_events where stream_id = $1 and type = $2 order by seq",
    [`conv:${conversationId}`, type],
  );
  return res.rows.map((r) => r.payload);
}

const post = (as: TestClient, conv: string, body: string, extra: Json = {}) =>
  ok(as.request("POST", `/api/v1/conversations/${conv}/messages`, { body, ...extra }));
const enc = (emoji: string) => encodeURIComponent(emoji);
const react = (as: TestClient, id: string, emoji: string) =>
  as.request("PUT", `/api/v1/messages/${id}/reactions/${enc(emoji)}`);
const unreact = (as: TestClient, id: string, emoji: string) =>
  as.request("DELETE", `/api/v1/messages/${id}/reactions/${enc(emoji)}`);

async function pageOf(as: TestClient, conv: string): Promise<Json[]> {
  return (await ok(as.request("GET", `/api/v1/conversations/${conv}/messages`))).messages;
}

const rowCount = async (messageId: string) =>
  (await su.query("select count(*)::int as n from app.message_reactions where message_id = $1", [messageId]))
    .rows[0].n as number;

beforeAll(async () => {
  stack = await startTestStack();
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
  adminId = setup.user.id;

  const inv = await ok(
    admin.request("POST", "/api/v1/invitations", { email: "sam@example.test", role: "developer" }),
  );
  sam = new TestClient(stack.baseUrl);
  samId = (
    await ok(
      sam.request("POST", `/api/v1/invitations/${inv.id}/accept`, {
        name: "Sam Lee",
        password: "another-long-password",
      }),
    )
  ).user.id;

  archieId = randomUUID();
  await su.query(
    `insert into app.agents (id, organization_id, name, username, instructions, model_provider, model_id, status)
     values ($1, $2, 'Archie', 'archie', 'x', 'mock', 'mock-1', 'ready')`,
    [archieId, orgId],
  );

  channelId = (await ok(admin.request("POST", "/api/v1/channels", { name: "reacts", visibility: "public" })))
    .id;
  await ok(sam.request("POST", `/api/v1/channels/${channelId}/join`));
});

afterAll(async () => {
  await su?.end();
  await stack?.stop();
});

describe("PUT/DELETE /messages/:id/reactions/:emoji", () => {
  it("toggles a reaction, emits reaction.updated with absolute counts and hydrates `mine` per viewer", async () => {
    const msg = await post(admin, channelId, "Ship it?");

    expect(await ok(react(admin, msg.id, "👍"))).toEqual({ ok: true });
    // Idempotent: a second PUT adds no row and no event.
    expect(await ok(react(admin, msg.id, "👍"))).toEqual({ ok: true });
    expect(await rowCount(msg.id)).toBe(1);
    let evs = (await events(channelId, "reaction.updated")).filter((e) => e.messageId === msg.id);
    expect(evs).toHaveLength(1);
    expect(evs[0]).toEqual({
      messageId: msg.id,
      conversationId: channelId,
      threadId: null,
      emoji: "👍",
      count: 1,
      members: [{ kind: "user", id: adminId }],
      actor: { kind: "user", id: adminId },
      added: true,
    });
    expect(Object.keys(evs[0] ?? {})).not.toContain("mine");

    await ok(react(sam, msg.id, "👍"));
    evs = (await events(channelId, "reaction.updated")).filter((e) => e.messageId === msg.id);
    expect(evs.at(-1)).toMatchObject({ count: 2, added: true, actor: { kind: "user", id: samId } });
    expect(evs.at(-1)?.members).toEqual([
      { kind: "user", id: adminId },
      { kind: "user", id: samId },
    ]);

    await ok(unreact(admin, msg.id, "👍"));
    evs = (await events(channelId, "reaction.updated")).filter((e) => e.messageId === msg.id);
    expect(evs.at(-1)).toMatchObject({ count: 1, added: false, actor: { kind: "user", id: adminId } });
    expect(evs.at(-1)?.members).toEqual([{ kind: "user", id: samId }]);
    // Removing a reaction that is not there changes nothing and emits nothing.
    await ok(unreact(admin, msg.id, "👍"));
    expect((await events(channelId, "reaction.updated")).filter((e) => e.messageId === msg.id)).toHaveLength(
      3,
    );

    const forSam = (await pageOf(sam, channelId)).find((m) => m.id === msg.id);
    expect(forSam?.reactions).toEqual([
      { emoji: "👍", count: 1, mine: true, members: [{ kind: "user", id: samId }] },
    ]);
    const forAdmin = (await pageOf(admin, channelId)).find((m) => m.id === msg.id);
    expect(forAdmin?.reactions).toEqual([
      { emoji: "👍", count: 1, mine: false, members: [{ kind: "user", id: samId }] },
    ]);
  });

  it("orders emoji by their first reaction and accepts ZWJ sequences, flags and skin tones", async () => {
    const msg = await post(admin, channelId, "Party");
    for (const e of ["🎉", "👍🏽", "🇪🇸", "👩‍💻"]) await ok(react(sam, msg.id, e));
    await ok(react(admin, msg.id, "🎉"));
    const m = (await pageOf(admin, channelId)).find((x) => x.id === msg.id);
    expect(m?.reactions.map((r: Json) => [r.emoji, r.count, r.mine])).toEqual([
      ["🎉", 2, true],
      ["👍🏽", 1, false],
      ["🇪🇸", 1, false],
      ["👩‍💻", 1, false],
    ]);
  });

  it("works on a thread reply (thread view hydrated, threadId on the event)", async () => {
    const root = await post(admin, channelId, "Thread root");
    const reply = await post(sam, channelId, "A reply", { threadRootId: root.id });
    await ok(react(admin, reply.id, "✅"));
    const ev = (await events(channelId, "reaction.updated")).at(-1);
    expect(ev).toMatchObject({ messageId: reply.id, threadId: root.id, count: 1 });
    const thread = await ok(sam.request("GET", `/api/v1/messages/${root.id}/thread`));
    expect(thread.replies[0].reactions).toEqual([
      { emoji: "✅", count: 1, mine: false, members: [{ kind: "user", id: adminId }] },
    ]);
    expect(thread.root.reactions).toEqual([]);
  });

  it("works on a bot's message", async () => {
    await ok(admin.request("POST", `/api/v1/channels/${channelId}/members`, { kind: "agent", id: archieId }));
    const bot = await stack.built.core.chatAgent.postAgentMessage(
      { organizationId: orgId, userId: null },
      {
        agentId: archieId,
        conversationId: channelId,
        threadRootId: null,
        body: "Deployed to staging",
        idempotencyKey: "react-bot-1",
      },
    );
    await ok(react(sam, bot.messageId, "👀"));
    const m = (await pageOf(sam, channelId)).find((x) => x.id === bot.messageId);
    expect(m?.reactions).toEqual([
      { emoji: "👀", count: 1, mine: true, members: [{ kind: "user", id: samId }] },
    ]);
  });

  it(`caps distinct emoji at ${MAX_REACTIONS_PER_MESSAGE} (409 too_many_reactions); existing ones stay toggleable`, async () => {
    const msg = await post(admin, channelId, "Emoji storm");
    // Fill the message directly (fast), then cross the cap through the API.
    const pictos = [...Array(MAX_REACTIONS_PER_MESSAGE).keys()].map((i) => String.fromCodePoint(0x1f600 + i));
    for (const e of pictos) {
      await su.query(
        "insert into app.message_reactions (organization_id, message_id, conversation_id, emoji, member_kind, member_id) values ($1, $2, $3, $4, 'user', $5)",
        [orgId, msg.id, channelId, e, adminId],
      );
    }
    const r = await react(sam, msg.id, "🦄");
    expect(r.status).toBe(409);
    expect(errorOf(r).code).toBe("too_many_reactions");
    // An emoji already on the message is not a new distinct one.
    await ok(react(sam, msg.id, pictos[0] ?? "😀"));
  });

  it("refuses anything that is not a single emoji (400)", async () => {
    const msg = await post(admin, channelId, "No text reactions");
    for (const bad of ["abc", "<b>", "👍abc", "1"]) {
      const r = await react(admin, msg.id, bad);
      expect(r.status, bad).toBe(400);
    }
    expect(await rowCount(msg.id)).toBe(0);
  });

  it("hidden private channel → 404; public non-member → 403 channel.post; archived → 410; deleted → 409", async () => {
    const secret = (
      await ok(admin.request("POST", "/api/v1/channels", { name: "secret-reacts", visibility: "private" }))
    ).id;
    const hidden = await post(admin, secret, "private");
    const r404 = await react(sam, hidden.id, "👍");
    expect(r404.status).toBe(404);
    expect(errorOf(r404).details).toBeUndefined();
    expect((await unreact(sam, hidden.id, "👍")).status).toBe(404);
    expect((await react(sam, randomUUID(), "👍")).status).toBe(404);

    const lobby = (await ok(admin.request("POST", "/api/v1/channels", { name: "lobby-reacts" }))).id;
    const open = await post(admin, lobby, "public, but Sam never joined");
    const r403 = await react(sam, open.id, "👍");
    expect(r403.status).toBe(403);
    expect(errorOf(r403).details).toMatchObject({ permission: "channel.post", reason: "not_a_member" });

    const old = (await ok(admin.request("POST", "/api/v1/channels", { name: "old-reacts" }))).id;
    const before = await post(admin, old, "before archiving");
    await ok(admin.request("POST", `/api/v1/channels/${old}/archive`));
    const r410 = await react(admin, before.id, "👍");
    expect(r410.status).toBe(410);
    expect(errorOf(r410).code).toBe("channel_archived");

    const gone = await post(sam, channelId, "about to vanish");
    await ok(react(admin, gone.id, "👍"));
    await ok(sam.request("DELETE", `/api/v1/messages/${gone.id}`));
    expect(await rowCount(gone.id)).toBe(0);
    const r409 = await react(admin, gone.id, "👍");
    expect(r409.status).toBe(409);
    expect(errorOf(r409).code).toBe("message_deleted");
    const tomb = (await pageOf(admin, channelId)).find((m) => m.id === gone.id);
    expect(tomb?.reactions ?? []).toEqual([]);
  });

  it("works in a bot DM for its participant", async () => {
    const dm = randomUUID();
    await su.query(
      "insert into app.conversations (id, organization_id, kind, visibility, dm_key, created_by) values ($1, $2, 'dm', 'private', $3, $4)",
      [dm, orgId, `agent:${archieId}|user:${samId}`, samId],
    );
    await su.query(
      `insert into app.conversation_members (conversation_id, organization_id, member_kind, member_id, role)
       values ($1, $2, 'user', $3, 'owner'), ($1, $2, 'agent', $4, 'member')`,
      [dm, orgId, samId, archieId],
    );
    const reply = await stack.built.core.chatAgent.postAgentMessage(
      { organizationId: orgId, userId: null },
      { agentId: archieId, conversationId: dm, threadRootId: null, body: "hi", idempotencyKey: "dm-r-1" },
    );
    await ok(react(sam, reply.messageId, "🙏"));
    expect((await pageOf(sam, dm)).find((m) => m.id === reply.messageId)?.reactions).toHaveLength(1);
    // Nobody else even learns the DM exists.
    expect((await react(admin, reply.messageId, "🙏")).status).toBe(404);
  });
});

describe("cross-tenant", () => {
  it("org B's admin gets 404 and writes nothing", async () => {
    const msg = await post(admin, channelId, "org A only");
    const email = `eve-${randomUUID().slice(0, 8)}@example.test`;
    const inv = await ok(admin.request("POST", "/api/v1/invitations", { email, role: "standard" }));
    const eve = new TestClient(stack.baseUrl);
    const userB = (
      await ok(
        eve.request("POST", `/api/v1/invitations/${inv.id}/accept`, {
          name: "Eve",
          password: "eve-long-password-1",
        }),
      )
    ).user.id as string;
    const orgB = randomUUID();
    await su.query("insert into auth.organization (id, name, slug) values ($1, 'Evil', $2)", [
      orgB,
      `evil-${orgB}`,
    ]);
    await su.query("delete from auth.member where user_id = $1", [userB]);
    await su.query("delete from app.org_members where user_id = $1", [userB]);
    await su.query("insert into auth.member (organization_id, user_id, role) values ($1, $2, 'owner')", [
      orgB,
      userB,
    ]);
    await su.query(
      "insert into app.org_members (organization_id, user_id, display_name, role) values ($1, $2, 'Eve', 'admin')",
      [orgB, userB],
    );
    await su.query("update auth.session set active_organization_id = $1 where user_id = $2", [orgB, userB]);
    const r = await react(eve, msg.id, "👍");
    expect(r.status).toBe(404);
    expect(await rowCount(msg.id)).toBe(0);
  });
});
