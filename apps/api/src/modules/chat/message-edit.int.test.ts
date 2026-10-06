import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentMention } from "../../lib/chat-agent-bridge";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";

/**
 * CHAT-06 (04-01): message edit and delete over real PostgreSQL + Redis. Versions are append-only, audit rows
 * carry ids and the version but never a body, `message.updated`/`message.deleted` reach the conversation
 * stream, and only the author (or, for delete, an admin where readable and never in a DM) may change one.
 */

let stack: TestStack;
let su: pg.Client;
let admin: TestClient;
let alex: TestClient;
let orgId: string;
let adminId: string;
let alexId: string;
let archieId: string;
let channelId: string;
const mentions: AgentMention[] = [];

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
type Json = Record<string, any>;

async function ok(res: Promise<{ status: number; body: Record<string, unknown> | null }>, status = 200) {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as Json;
}

const errorOf = (r: { body: Record<string, unknown> | null }) => (r.body as Json | null)?.error as Json;

const audit = async (action: string) =>
  (await su.query("select * from app.audit_events where action = $1 order by occurred_at", [action])).rows;

const versionsOf = async (messageId: string) =>
  (await su.query("select * from app.message_versions where message_id = $1 order by version", [messageId]))
    .rows;

async function lastEvent(conversationId: string, type: string): Promise<Json | undefined> {
  const res = await su.query(
    "select payload from app.stream_events where stream_id = $1 and type = $2 order by seq desc limit 1",
    [`conv:${conversationId}`, type],
  );
  return res.rows[0]?.payload;
}

/** Every key at any depth of a JSON value. */
function keysDeep(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) for (const x of v) keysDeep(x, out);
  else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      out.push(k);
      keysDeep(x, out);
    }
  }
  return out;
}

const post = (as: TestClient, conv: string, body: string, extra: Json = {}) =>
  ok(as.request("POST", `/api/v1/conversations/${conv}/messages`, { body, ...extra }));
const edit = (as: TestClient, id: string, body: string) =>
  as.request("PATCH", `/api/v1/messages/${id}`, { body });

beforeAll(async () => {
  stack = await startTestStack();
  su = new pg.Client({ connectionString: stack.db.superuserUrl });
  await su.connect();
  stack.built.core.chatAgent.onAgentMention(async (_tx, m) => {
    mentions.push(m);
  });

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
    admin.request("POST", "/api/v1/invitations", { email: "alex@example.test", role: "developer" }),
  );
  alex = new TestClient(stack.baseUrl);
  const accepted = await ok(
    alex.request("POST", `/api/v1/invitations/${inv.id}/accept`, {
      name: "Alex Kim",
      password: "another-long-password",
    }),
  );
  alexId = accepted.user.id;

  archieId = randomUUID();
  await su.query(
    `insert into app.agents (id, organization_id, name, username, instructions, model_provider, model_id, status)
     values ($1, $2, 'Archie', 'archie', 'x', 'mock', 'mock-1', 'ready')`,
    [archieId, orgId],
  );

  channelId = (await ok(admin.request("POST", "/api/v1/channels", { name: "edits", visibility: "public" })))
    .id;
  await ok(alex.request("POST", `/api/v1/channels/${channelId}/join`));
});

afterAll(async () => {
  await su?.end();
  await stack?.stop();
});

describe("PATCH /messages/:id (edit)", () => {
  let messageId: string;

  it("the author edits: new body, editedAt, an append-only version, message.updated and an audit row", async () => {
    const original = await post(admin, channelId, "Deploy at 9");
    messageId = original.id;
    expect(original.editedAt).toBeNull();

    const edited = await ok(edit(admin, messageId, "Deploy at 10, not 9"));
    expect(edited).toMatchObject({ id: messageId, body: "Deploy at 10, not 9", seq: original.seq });
    expect(edited.editedAt).toEqual(expect.any(String));
    expect(edited.deletedAt ?? null).toBeNull();

    const versions = await versionsOf(messageId);
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({
      version: 1,
      kind: "edit",
      body: "Deploy at 9",
      edited_by_kind: "user",
      edited_by: adminId,
      organization_id: orgId,
    });

    const ev = await lastEvent(channelId, "message.updated");
    expect(ev?.message).toMatchObject({ id: messageId, body: "Deploy at 10, not 9" });
    expect(ev?.message.editedAt).toEqual(expect.any(String));
    for (const viewerField of ["reactions", "pinned", "saved"]) {
      expect(Object.keys(ev?.message ?? {}), viewerField).not.toContain(viewerField);
    }

    const rows = await audit("message.edited");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ resource_type: "message", resource_id: messageId, actor_id: adminId });
    expect(rows[0].metadata).toEqual({ messageId, conversationId: channelId, version: 1 });
    expect(keysDeep(rows[0].metadata)).not.toContain("body");

    // The list snapshot shows the edit.
    const page = await ok(alex.request("GET", `/api/v1/conversations/${channelId}/messages`));
    expect(page.messages.find((m: Json) => m.id === messageId)).toMatchObject({
      body: "Deploy at 10, not 9",
      editedAt: edited.editedAt,
    });
  });

  it("a second edit is version 2; an unchanged body adds no version", async () => {
    await ok(edit(admin, messageId, "Deploy at 11"));
    await ok(edit(admin, messageId, "Deploy at 11"));
    const versions = await versionsOf(messageId);
    expect(versions.map((v) => [v.version, v.body])).toEqual([
      [1, "Deploy at 9"],
      [2, "Deploy at 10, not 9"],
    ]);
    expect((await audit("message.edited")).map((r) => r.metadata.version)).toEqual([1, 2]);
  });

  it("mentions are re-resolved from the new body, and an edit never triggers a bot", async () => {
    const msg = await post(admin, channelId, "no mentions yet");
    const before = mentions.length;
    const withAlex = await ok(edit(admin, msg.id, "ping @alex"));
    expect(withAlex.mentions).toEqual([{ kind: "user", id: alexId }]);
    const withBot = await ok(edit(admin, msg.id, "ping @alex and @archie"));
    expect(withBot.mentions).toEqual(
      expect.arrayContaining([
        { kind: "user", id: alexId },
        { kind: "agent", id: archieId },
      ]),
    );
    // Pitfall 8: no delivery, and the bot is not auto-added to the channel by an edit.
    expect(mentions.length).toBe(before);
    const captured = await ok(admin.request("GET", "/api/v1/test/chat/mentions"));
    expect(captured.mentions.filter((m: Json) => m.messageId === msg.id)).toEqual([]);
    const members = await ok(admin.request("GET", `/api/v1/channels/${channelId}/members`));
    expect(members.members.some((m: Json) => m.kind === "agent")).toBe(false);
  });

  it("another member gets 403 not_author, and nothing changes", async () => {
    const r = await edit(alex, messageId, "hijacked");
    expect(r.status).toBe(403);
    expect(errorOf(r).code).toBe("not_author");
    const row = (await su.query("select body from app.messages where id = $1", [messageId])).rows[0];
    expect(row.body).toBe("Deploy at 11");
    expect(await versionsOf(messageId)).toHaveLength(2);
  });

  it("a non-member of a private channel gets 404; a missing id is 404 too", async () => {
    const secret = (
      await ok(admin.request("POST", "/api/v1/channels", { name: "secret-edits", visibility: "private" }))
    ).id;
    const msg = await post(admin, secret, "private plan");
    const hidden = await edit(alex, msg.id, "peek");
    expect(hidden.status).toBe(404);
    expect(errorOf(hidden).details).toBeUndefined();
    expect((await edit(admin, randomUUID(), "nothing")).status).toBe(404);
  });

  it("an archived channel answers 410 channel_archived", async () => {
    const old = (await ok(admin.request("POST", "/api/v1/channels", { name: "old-edits" }))).id;
    const msg = await post(admin, old, "before archiving");
    await ok(admin.request("POST", `/api/v1/channels/${old}/archive`));
    const r = await edit(admin, msg.id, "after archiving");
    expect(r.status).toBe(410);
    expect(errorOf(r).code).toBe("channel_archived");
  });

  it("a thread reply can be edited and the thread view shows the new body", async () => {
    const root = await post(admin, channelId, "thread root");
    const reply = await post(alex, channelId, "first reply", { threadRootId: root.id });
    const edited = await ok(edit(alex, reply.id, "first reply (fixed)"));
    expect(edited).toMatchObject({ threadId: root.id, body: "first reply (fixed)" });
    const thread = await ok(admin.request("GET", `/api/v1/messages/${root.id}/thread`));
    expect(thread.replies.map((r: Json) => r.body)).toEqual(["first reply (fixed)"]);
    expect(thread.replies[0].editedAt).toEqual(expect.any(String));
    const ev = await lastEvent(channelId, "message.updated");
    expect(ev?.message).toMatchObject({ id: reply.id, threadId: root.id });
  });

  it("refuses an empty body", async () => {
    expect((await edit(admin, messageId, "   ")).status).toBe(400);
  });
});

/**
 * An HTTP client signed in as the admin of ANOTHER organization: a fresh invitee of this org whose membership is
 * moved to org B (auth.member, the org_members projection and the session's active organization).
 */
async function otherOrgAdmin(): Promise<{ client: TestClient; orgB: string; userB: string }> {
  const email = `eve-${randomUUID().slice(0, 8)}@example.test`;
  const inv = await ok(admin.request("POST", "/api/v1/invitations", { email, role: "standard" }));
  const client = new TestClient(stack.baseUrl);
  const accepted = await ok(
    client.request("POST", `/api/v1/invitations/${inv.id}/accept`, {
      name: "Eve",
      password: "eve-long-password-1",
    }),
  );
  const userB: string = accepted.user.id;
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
  const me = await ok(client.request("GET", "/api/v1/me/permissions"));
  expect(me.role).toBe("admin");
  return { client, orgB, userB };
}

describe("cross-tenant", () => {
  it("org B's admin gets 404 on PATCH for org A's message, and nothing is written", async () => {
    const msg = await post(admin, channelId, "org A only");
    const { client, orgB } = await otherOrgAdmin();
    const r = await edit(client, msg.id, "pwned");
    expect(r.status).toBe(404);
    expect(errorOf(r).details).toBeUndefined();
    const row = (await su.query("select body, edited_at from app.messages where id = $1", [msg.id])).rows[0];
    expect(row).toEqual({ body: "org A only", edited_at: null });
    expect(await versionsOf(msg.id)).toHaveLength(0);
    const leaked = await su.query(
      "select count(*)::int as n from app.message_versions where organization_id = $1",
      [orgB],
    );
    expect(leaked.rows[0].n).toBe(0);
  });
});

const del = (as: TestClient, id: string) => as.request("DELETE", `/api/v1/messages/${id}`);

describe("DELETE /messages/:id (tombstones, D-01)", () => {
  it("the author deletes: tombstone row, a delete version, message.deleted and an audit row without the body", async () => {
    const msg = await post(alex, channelId, "ping @victor about the secret roadmap");
    // Reactions and pins of the message go with it; its attachments are marked deleted.
    await su.query(
      "insert into app.message_reactions (organization_id, message_id, conversation_id, emoji, member_kind, member_id) values ($1, $2, $3, '👍', 'user', $4)",
      [orgId, msg.id, channelId, adminId],
    );
    await su.query(
      "insert into app.message_pins (organization_id, conversation_id, message_id, pinned_by) values ($1, $2, $3, $4)",
      [orgId, channelId, msg.id, adminId],
    );
    await su.query(
      "insert into app.attachments (organization_id, conversation_id, message_id, uploader_id, filename, declared_type, size_bytes, status) values ($1, $2, $3, $4, 'r.pdf', 'application/pdf', 10, 'ready')",
      [orgId, channelId, msg.id, alexId],
    );

    expect(await ok(del(alex, msg.id))).toEqual({ ok: true });

    const row = (await su.query("select * from app.messages where id = $1", [msg.id])).rows[0];
    expect(row).toMatchObject({ body: "", mentions: [], deleted_by: alexId });
    expect(row.deleted_at).toBeInstanceOf(Date);
    const versions = await versionsOf(msg.id);
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({
      version: 1,
      kind: "delete",
      body: "ping @victor about the secret roadmap",
    });

    const ev = await lastEvent(channelId, "message.deleted");
    expect(ev).toMatchObject({ messageId: msg.id, conversationId: channelId, threadId: null, replyCount: 0 });
    expect(ev?.deletedAt).toEqual(expect.any(String));
    expect(await lastEvent(channelId, "pin.updated")).toMatchObject({ messageId: msg.id, pinned: false });

    const rows = (await audit("message.deleted")).filter((r) => r.resource_id === msg.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata).toEqual({
      messageId: msg.id,
      conversationId: channelId,
      version: 1,
      moderated: false,
    });
    expect(keysDeep(rows[0].metadata)).not.toContain("body");

    expect(
      (await su.query("select count(*)::int as n from app.message_reactions where message_id = $1", [msg.id]))
        .rows[0].n,
    ).toBe(0);
    expect(
      (await su.query("select count(*)::int as n from app.message_pins where message_id = $1", [msg.id]))
        .rows[0].n,
    ).toBe(0);
    const att = (
      await su.query("select status, deleted_at from app.attachments where message_id = $1", [msg.id])
    ).rows[0];
    expect(att.status).toBe("deleted");
    expect(att.deleted_at).toBeInstanceOf(Date);

    // The snapshot keeps a tombstone (the client hides it or shows "This message was deleted.").
    const page = await ok(admin.request("GET", `/api/v1/conversations/${channelId}/messages`));
    const tomb = page.messages.find((m: Json) => m.id === msg.id);
    expect(tomb).toMatchObject({ body: "", mentions: [] });
    expect(tomb.deletedAt).toEqual(expect.any(String));

    // A deleted message can be neither edited nor deleted again.
    const edited = await edit(alex, msg.id, "resurrect");
    expect(edited.status).toBe(409);
    expect(errorOf(edited).code).toBe("message_deleted");
    expect((await del(alex, msg.id)).status).toBe(409);
  });

  it("an admin deletes someone else's message in a public channel (moderated), even without joining", async () => {
    const lobby = (await ok(alex.request("POST", "/api/v1/channels", { name: "lobby-del" }))).id;
    const msg = await post(alex, lobby, "spam spam spam");
    expect(await ok(del(admin, msg.id))).toEqual({ ok: true });
    const rows = (await audit("message.deleted")).filter((r) => r.resource_id === msg.id);
    expect(rows[0].metadata).toEqual({
      messageId: msg.id,
      conversationId: lobby,
      version: 1,
      moderated: true,
    });
    expect(rows[0].actor_id).toBe(adminId);
  });

  it("a developer deleting someone else's message gets 403 message.delete_any; nothing changes", async () => {
    const msg = await post(admin, channelId, "admin words");
    const r = await del(alex, msg.id);
    expect(r.status).toBe(403);
    expect(errorOf(r).details).toMatchObject({ permission: "message.delete_any" });
    expect(
      (await su.query("select body, deleted_at from app.messages where id = $1", [msg.id])).rows[0],
    ).toEqual({
      body: "admin words",
      deleted_at: null,
    });
  });

  it("an admin who is not in a private channel gets 404", async () => {
    const hidden = (
      await ok(alex.request("POST", "/api/v1/channels", { name: "alex-only", visibility: "private" }))
    ).id;
    const msg = await post(alex, hidden, "between me and me");
    const r = await del(admin, msg.id);
    expect(r.status).toBe(404);
    expect(errorOf(r).details).toBeUndefined();
  });

  it("in a bot DM the participant admin may delete their own message but never the bot's (direct_conversation)", async () => {
    const dm = randomUUID();
    await su.query(
      "insert into app.conversations (id, organization_id, kind, visibility, dm_key, created_by) values ($1, $2, 'dm', 'private', $3, $4)",
      [dm, orgId, `agent:${archieId}|user:${adminId}`, adminId],
    );
    await su.query(
      `insert into app.conversation_members (conversation_id, organization_id, member_kind, member_id, role)
       values ($1, $2, 'user', $3, 'owner'), ($1, $2, 'agent', $4, 'member')`,
      [dm, orgId, adminId, archieId],
    );
    const mine = await post(admin, dm, "hello bot");
    const reply = await stack.built.core.chatAgent.postAgentMessage(
      { organizationId: orgId, userId: null },
      {
        agentId: archieId,
        conversationId: dm,
        threadRootId: null,
        body: "hello human",
        idempotencyKey: "dm-del-1",
      },
    );
    const r = await del(admin, reply.messageId);
    expect(r.status).toBe(403);
    expect(errorOf(r).details).toMatchObject({
      permission: "message.delete_any",
      reason: "direct_conversation",
    });
    expect(await ok(del(admin, mine.id))).toEqual({ ok: true });
    // Nobody else even learns the DM exists.
    expect((await del(alex, reply.messageId)).status).toBe(404);
  });

  it("deleting a thread root keeps its thread; a deleted reply leaves the thread and the reply count", async () => {
    const root = await post(admin, channelId, "root to delete");
    const r1 = await post(alex, channelId, "reply one", { threadRootId: root.id });
    await post(alex, channelId, "reply two", { threadRootId: root.id });
    expect(await ok(del(admin, root.id))).toEqual({ ok: true });
    expect(await lastEvent(channelId, "message.deleted")).toMatchObject({
      messageId: root.id,
      replyCount: 2,
    });
    const thread = await ok(alex.request("GET", `/api/v1/messages/${root.id}/thread`));
    expect(thread.root).toMatchObject({ id: root.id, body: "", replyCount: 2 });
    expect(thread.root.deletedAt).toEqual(expect.any(String));
    expect(thread.replies.map((m: Json) => m.body)).toEqual(["reply one", "reply two"]);

    expect(await ok(del(alex, r1.id))).toEqual({ ok: true });
    expect(await lastEvent(channelId, "message.deleted")).toMatchObject({
      messageId: r1.id,
      threadId: root.id,
      replyCount: 0,
    });
    expect(await lastEvent(channelId, "thread.updated")).toMatchObject({ rootId: root.id, replyCount: 1 });
    const after = await ok(alex.request("GET", `/api/v1/messages/${root.id}/thread`));
    expect(after.root.replyCount).toBe(1);
  });

  it("bots never see deleted text: thread context and the delivered history skip deleted messages", async () => {
    const root = await post(admin, channelId, "release plan");
    const secret = await post(alex, channelId, "TOP-SECRET-PASSWORD 1234", { threadRootId: root.id });
    await post(alex, channelId, "a normal reply", { threadRootId: root.id });
    await ok(del(alex, secret.id));

    const ctx = await stack.built.core.chatAgent.getThreadContext(
      { organizationId: orgId, userId: null },
      channelId,
      root.id,
      50,
    );
    expect(ctx.history.map((h) => h.body)).toEqual(["release plan", "a normal reply"]);

    const ask = await post(admin, channelId, "@archie summarize this thread", { threadRootId: root.id });
    const delivered = await su.query(
      "select payload from app.stream_events where stream_id = $1 and type = 'agent.mention.v1' order by seq desc limit 1",
      [`cell:${orgId}`],
    );
    const payload = delivered.rows[0]?.payload as Json | undefined;
    expect(payload?.message?.id).toBe(ask.id);
    const bodies = (payload?.threadHistory ?? []).map((h: Json) => h.body ?? h.text ?? "");
    expect(bodies.length).toBeGreaterThan(0);
    expect(JSON.stringify(payload)).not.toContain("TOP-SECRET-PASSWORD");
  });
});
