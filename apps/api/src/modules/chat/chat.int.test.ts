import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuthContext } from "../../core";
import type { AgentMention } from "../../lib/chat-agent-bridge";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack, WEB_ORIGIN } from "../../testing";
import { createPermissionService } from "../organization";
import { listChannels } from "./service";

let stack: TestStack;
let su: pg.Client;
let admin: TestClient;
let alex: TestClient;
let orgId: string;
let adminId: string;
let alexId: string;
let archieId: string;
let ghostId: string;
const mentions: AgentMention[] = [];

const ADMIN = {
  name: "Víctor Ruiz",
  email: "victor@example.test",
  password: "correct-horse-battery",
  orgName: "Autofy Labs",
};

async function ok(res: Promise<{ status: number; body: Record<string, unknown> | null }>, status = 200) {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  // biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
  return r.body as Record<string, any>;
}

const audit = async (action: string) =>
  (await su.query("select * from app.audit_events where action = $1 order by occurred_at", [action])).rows;

beforeAll(async () => {
  stack = await startTestStack();
  su = new pg.Client({ connectionString: stack.db.superuserUrl });
  await su.connect();
  stack.built.core.chatAgent.onAgentMention(async (_tx, m) => {
    mentions.push(m);
  });

  admin = new TestClient(stack.baseUrl);
  const setup = await ok(admin.request("POST", "/api/v1/setup", { token: TEST_SETUP_TOKEN, ...ADMIN }));
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
  ghostId = randomUUID();
  await su.query(
    `insert into app.agents (id, organization_id, name, username, instructions, model_provider, model_id, status)
     values ($1, $3, 'Archie', 'archie', 'x', 'mock', 'mock-1', 'ready'),
            ($2, $3, 'Ghost', 'ghost', 'x', 'mock', 'mock-1', 'disabled')`,
    [archieId, ghostId, orgId],
  );
});

afterAll(async () => {
  await su?.end();
  await stack?.stop();
});

describe("chat: channels", () => {
  let generalId: string;
  let archId: string;
  let secretId: string;

  it("seeds #general lazily and everyone is in it", async () => {
    const list = await ok(admin.request("GET", "/api/v1/channels"));
    expect(list.channels).toHaveLength(1);
    expect(list.channels[0]).toMatchObject({
      name: "general",
      isMember: true,
      isDefault: true,
      memberCount: 2,
    });
    generalId = list.channels[0].id;
    const again = await ok(alex.request("GET", "/api/v1/channels"));
    expect(again.channels.map((c: { id: string }) => c.id)).toEqual([generalId]);
    expect(again.channels[0].isMember).toBe(true);
    expect((await alex.request("POST", `/api/v1/channels/${generalId}/leave`)).status).toBe(400);
    expect((await admin.request("POST", `/api/v1/channels/${generalId}/archive`)).status).toBe(400);
  });

  it("creates public channels (unique names), join, members", async () => {
    const created = await ok(
      admin.request("POST", "/api/v1/channels", {
        name: "architecture",
        topic: "System design",
        visibility: "public",
      }),
    );
    archId = created.id;
    expect(created).toMatchObject({
      isMember: true,
      memberCount: 1,
      topic: "System design",
      visibility: "public",
    });
    expect((await admin.request("POST", "/api/v1/channels", { name: "Architecture" })).status).toBe(409);
    expect((await admin.request("POST", "/api/v1/channels", { name: "bad name!" })).status).toBe(400);

    const alexView = await ok(alex.request("GET", "/api/v1/channels"));
    expect(alexView.channels.find((c: { id: string }) => c.id === archId)).toMatchObject({ isMember: false });
    expect(
      (await alex.request("POST", `/api/v1/conversations/${archId}/messages`, { body: "hi" })).status,
    ).toBe(403);
    const joined = await ok(alex.request("POST", `/api/v1/channels/${archId}/join`));
    expect(joined).toMatchObject({ isMember: true, memberCount: 2 });

    const members = await ok(alex.request("GET", `/api/v1/channels/${archId}/members`));
    expect(members.members.map((m: { displayName: string }) => m.displayName)).toEqual([
      "Alex Kim",
      "Víctor Ruiz",
    ]);
    expect(members.members[0].handle).toBe("alex");
    expect((await audit("channel.created")).length).toBeGreaterThanOrEqual(2);
    expect((await audit("channel.member_added")).some((r) => r.metadata.memberId === alexId)).toBe(true);
  });

  it("private channels are invisible and inaccessible to non-members", async () => {
    const created = await ok(
      admin.request("POST", "/api/v1/channels", { name: "secret", visibility: "private" }),
    );
    secretId = created.id;
    const alexView = await ok(alex.request("GET", "/api/v1/channels"));
    expect(alexView.channels.some((c: { id: string }) => c.id === secretId)).toBe(false);
    for (const [method, path, body] of [
      ["GET", `/api/v1/channels/${secretId}`],
      ["GET", `/api/v1/conversations/${secretId}/messages`],
      ["POST", `/api/v1/conversations/${secretId}/messages`, { body: "let me in" }],
      ["POST", `/api/v1/channels/${secretId}/join`],
      ["GET", `/api/v1/channels/${secretId}/members`],
      ["POST", `/api/v1/channels/${secretId}/members`, { kind: "user", id: alexId }],
    ] as const) {
      expect((await alex.request(method, path, body)).status, `${method} ${path}`).toBe(404);
    }
    const alexAuth = { userId: alexId, organizationId: orgId } as AuthContext;
    expect(await stack.built.core.realtime.authorizeTopic(alexAuth, `conv:${secretId}`)).toBe(false);
    expect(await stack.built.core.realtime.authorizeTopic(alexAuth, `conv:${archId}`)).toBe(true);

    await ok(admin.request("POST", `/api/v1/channels/${secretId}/members`, { kind: "user", id: alexId }));
    expect(await stack.built.core.realtime.authorizeTopic(alexAuth, `conv:${secretId}`)).toBe(true);
    const after = await ok(alex.request("GET", "/api/v1/channels"));
    expect(after.channels.find((c: { id: string }) => c.id === secretId)).toMatchObject({ isMember: true });
  });

  it("only the channel owner or an admin can archive", async () => {
    expect((await alex.request("POST", `/api/v1/channels/${archId}/archive`)).status).toBe(403);
    const tmp = await ok(alex.request("POST", "/api/v1/channels", { name: "scratch" }));
    const archived = await ok(alex.request("POST", `/api/v1/channels/${tmp.id}/archive`));
    expect(archived.archivedAt).toBeTruthy();
    expect(
      (await alex.request("POST", `/api/v1/conversations/${tmp.id}/messages`, { body: "x" })).status,
    ).toBe(410);
    const list = await ok(alex.request("GET", "/api/v1/channels"));
    expect(list.channels.some((c: { id: string }) => c.id === tmp.id)).toBe(false);
    expect((await audit("channel.archived")).map((r) => r.resource_id)).toContain(tmp.id);
  });

  describe("messages, threads and mentions", () => {
    let rootId: string;

    it("posts, paginates and emits message.created with the message seq", async () => {
      for (let i = 1; i <= 3; i++) {
        await ok(admin.request("POST", `/api/v1/conversations/${archId}/messages`, { body: `message ${i}` }));
      }
      const page = await ok(alex.request("GET", `/api/v1/conversations/${archId}/messages?limit=2`));
      expect(page.messages.map((m: { body: string }) => m.body)).toEqual(["message 2", "message 3"]);
      expect(page.messages[0].author).toMatchObject({ kind: "user", displayName: "Víctor Ruiz" });
      expect(page.nextBefore).toBe(page.messages[0].seq);
      const older = await ok(
        alex.request("GET", `/api/v1/conversations/${archId}/messages?limit=2&before=${page.nextBefore}`),
      );
      expect(older.messages.map((m: { body: string }) => m.body)).toEqual(["message 1"]);
      expect(older.nextBefore).toBeNull();
      const last = page.messages[1];
      const ev = await su.query(
        "select type, payload from app.stream_events where stream_id = $1 and seq = $2",
        [`conv:${archId}`, last.seq],
      );
      expect(ev.rows[0].type).toBe("message.created");
      expect(ev.rows[0].payload.message.id).toBe(last.id);
      expect(page.lastSeq).toBeGreaterThanOrEqual(last.seq);
      rootId = page.messages[0].id;
    });

    it("thread replies update the root and refuse nesting", async () => {
      const reply = await ok(
        alex.request("POST", `/api/v1/conversations/${archId}/messages`, {
          body: "a reply",
          threadRootId: rootId,
        }),
      );
      expect(reply.threadId).toBe(rootId);
      const nested = await alex.request("POST", `/api/v1/conversations/${archId}/messages`, {
        body: "nested",
        threadRootId: reply.id,
      });
      expect(nested.status).toBe(400);
      expect((nested.body as { error: { code: string } }).error.code).toBe("thread_nesting");

      const thread = await ok(admin.request("GET", `/api/v1/messages/${reply.id}/thread`));
      expect(thread.root).toMatchObject({ id: rootId, replyCount: 1 });
      expect(thread.root.replyParticipants.map((p: { displayName: string }) => p.displayName)).toEqual([
        "Alex Kim",
      ]);
      expect(thread.replies.map((m: { body: string }) => m.body)).toEqual(["a reply"]);
      expect(thread.participants).toHaveLength(2);

      const top = await ok(admin.request("GET", `/api/v1/conversations/${archId}/messages`));
      expect(top.messages.some((m: { id: string }) => m.id === reply.id)).toBe(false);
      const types = (
        await su.query("select type from app.stream_events where stream_id = $1 order by seq desc limit 2", [
          `conv:${archId}`,
        ])
      ).rows.map((r) => r.type);
      expect(types).toEqual(["thread.updated", "message.created"]);
    });

    it("idempotent on clientMessageId", async () => {
      const body = { body: "once", clientMessageId: "web-1" };
      const a = await ok(admin.request("POST", `/api/v1/conversations/${archId}/messages`, body));
      const b = await ok(admin.request("POST", `/api/v1/conversations/${archId}/messages`, body));
      expect(b.id).toBe(a.id);
    });

    it("an agent mention auto-adds the bot and calls the bridge once, in the thread", async () => {
      mentions.length = 0;
      const msg = await ok(
        alex.request("POST", `/api/v1/conversations/${archId}/messages`, {
          body: "@archie what do you think? cc @victor @nobody @ghost",
          // The client array is ignored: the server parses the body.
          mentions: [{ kind: "agent", id: ghostId }],
        }),
      );
      expect(msg.mentions).toEqual(
        expect.arrayContaining([
          { kind: "agent", id: archieId },
          { kind: "user", id: adminId },
          { kind: "agent", id: ghostId },
        ]),
      );
      expect(mentions).toHaveLength(1);
      expect(mentions[0]).toEqual({
        organizationId: orgId,
        conversationId: archId,
        threadRootId: msg.id,
        messageId: msg.id,
        agentIds: [archieId],
        author: { kind: "user", id: alexId, displayName: "Alex Kim" },
        body: msg.body,
        createdAt: msg.createdAt,
        delivery: "thread",
      });
      const members = await ok(admin.request("GET", `/api/v1/channels/${archId}/members`));
      expect(members.members.at(-1)).toMatchObject({ kind: "agent", id: archieId, handle: "archie" });
      expect((await audit("channel.member_added")).some((r) => r.agent_id === archieId)).toBe(true);

      // Mention inside a thread → threadRootId is the root, not the reply.
      mentions.length = 0;
      const inThread = await ok(
        admin.request("POST", `/api/v1/conversations/${archId}/messages`, {
          body: "@Archie summarise please",
          threadRootId: rootId,
        }),
      );
      expect(mentions).toHaveLength(1);
      expect(mentions[0]).toMatchObject({
        threadRootId: rootId,
        messageId: inThread.id,
        agentIds: [archieId],
      });

      // No agent mention → no bridge call.
      mentions.length = 0;
      await ok(admin.request("POST", `/api/v1/conversations/${archId}/messages`, { body: "hey @alex" }));
      expect(mentions).toHaveLength(0);
    });

    it("postAgentMessage is idempotent, threaded and audited; thread context has roster + history", async () => {
      const { chatAgent } = stack.built.core;
      const ctx = { organizationId: orgId, userId: null };
      const input = {
        agentId: archieId,
        conversationId: archId,
        threadRootId: rootId,
        body: "Asked by Víctor Ruiz. Participants: Alex Kim, Víctor Ruiz.",
        idempotencyKey: "delivery-1",
      };
      const first = await chatAgent.postAgentMessage(ctx, input);
      const second = await chatAgent.postAgentMessage(ctx, input);
      expect(first.created).toBe(true);
      expect(second).toEqual({ messageId: first.messageId, created: false });
      const rows = await su.query("select * from app.messages where client_message_id = 'delivery-1'");
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0]).toMatchObject({ author_kind: "agent", author_id: archieId, thread_id: rootId });

      const thread = await ok(alex.request("GET", `/api/v1/messages/${rootId}/thread`));
      expect(thread.root.replyCount).toBe(3);
      expect(thread.replies.at(-1).author).toMatchObject({ kind: "agent", displayName: "Archie" });
      expect((await audit("agent.message.posted")).map((r) => r.agent_id)).toEqual([archieId]);

      const context = await chatAgent.getThreadContext(ctx, archId, rootId, 50);
      expect(context.roster.map((r) => `${r.kind}:${r.displayName}`)).toEqual([
        "user:Alex Kim",
        "user:Víctor Ruiz",
        "agent:Archie",
      ]);
      expect(context.history[0]).toMatchObject({ messageId: rootId, author: { displayName: "Víctor Ruiz" } });
      expect(context.history.at(-1)?.author).toMatchObject({ kind: "agent", displayName: "Archie" });
      expect((await chatAgent.getThreadContext(ctx, archId, rootId, 2)).history).toHaveLength(2);

      // An agent that is not a member cannot post.
      await expect(
        chatAgent.postAgentMessage(ctx, { ...input, conversationId: generalId, idempotencyKey: "x" }),
      ).rejects.toMatchObject({
        code: "agent_not_member",
      });
    });

    it("agent typing is published as an ephemeral event on the conversation", async () => {
      const frames: unknown[] = [];
      const off = await stack.built.core.realtime.listen(`conv:${archId}`, (f) => frames.push(f));
      await stack.built.core.chatAgent.agentTyping(
        { organizationId: orgId, userId: null },
        archieId,
        archId,
        rootId,
      );
      for (let i = 0; i < 50 && frames.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
      await off();
      expect(frames[0]).toMatchObject({
        op: "eph",
        type: "agent.typing",
        data: { agentId: archieId, displayName: "Archie", threadRootId: rootId },
      });
    });
  });

  it("cross-tenant: another org sees nothing and cannot write into this org", async () => {
    const orgB = randomUUID();
    const userB = randomUUID();
    await su.query("insert into auth.organization (id, name, slug) values ($1, 'Evil', $2)", [
      orgB,
      `evil-${orgB}`,
    ]);
    await su.query("insert into auth.user (id, name, email) values ($1, 'Eve', $2)", [
      userB,
      `${userB}@evil.test`,
    ]);
    await su.query(
      "insert into app.org_members (organization_id, user_id, display_name, role) values ($1, $2, 'Eve', 'admin')",
      [orgB, userB],
    );
    const { db, realtime, chatAgent } = stack.built.core;
    const ctxB = { organizationId: orgB, userId: userB };
    expect(await db.withTenant(ctxB, (tx) => listChannels(tx, userB))).toEqual([]);
    expect(await db.withTenant(ctxB, (tx) => listChannels(tx, userB, archId))).toEqual([]);
    const authB = { userId: userB, organizationId: orgB } as AuthContext;
    expect(await realtime.authorizeTopic(authB, `conv:${archId}`)).toBe(false);
    await expect(
      chatAgent.postAgentMessage(ctxB, {
        agentId: archieId,
        conversationId: archId,
        threadRootId: null,
        body: "pwned",
        idempotencyKey: "evil-1",
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(chatAgent.getThreadContext(ctxB, archId, randomUUID(), 10)).rejects.toMatchObject({
      statusCode: 404,
    });
    const leaked = await su.query("select count(*)::int as n from app.messages where body = 'pwned'");
    expect(leaked.rows[0].n).toBe(0);
  });
});

describe("archive is decided by the resolver", () => {
  const denials = async () =>
    (
      await su.query(
        "select * from app.audit_events where action = 'authz.denied' and organization_id = $1 order by occurred_at",
        [orgId],
      )
    ).rows;

  it("an admin archives a channel created by someone else", async () => {
    const theirs = await ok(alex.request("POST", "/api/v1/channels", { name: "alex-room" }));
    const archived = await ok(admin.request("POST", `/api/v1/channels/${theirs.id}/archive`));
    expect(archived.archivedAt).toBeTruthy();
    const rows = await audit("channel.archived");
    expect(rows.some((r) => r.resource_id === theirs.id && r.user_id === adminId)).toBe(true);
  });

  it("a developer archives the channel they own", async () => {
    const mine = await ok(alex.request("POST", "/api/v1/channels", { name: "alex-own" }));
    expect((await ok(alex.request("POST", `/api/v1/channels/${mine.id}/archive`))).archivedAt).toBeTruthy();
  });

  it("anyone else gets 403 with the denial, and the denial is audited after the rollback", async () => {
    const adminRoom = await ok(admin.request("POST", "/api/v1/channels", { name: "admin-room" }));
    await ok(alex.request("POST", `/api/v1/channels/${adminRoom.id}/join`));
    const before = (await denials()).length;
    const res = await alex.request("POST", `/api/v1/channels/${adminRoom.id}/archive`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      error: {
        code: "forbidden",
        details: { permission: "channel.archive", layer: "role", reason: "missing_permission" },
      },
    });
    const after = await denials();
    expect(after).toHaveLength(before + 1);
    expect(after.at(-1)).toMatchObject({
      result: "denied",
      user_id: alexId,
      resource_type: "route",
      resource_id: "/api/v1/channels/:id/archive",
      metadata: {
        permission: "channel.archive",
        layer: "role",
        reason: "missing_permission",
        method: "POST",
      },
    });
    const still = await su.query("select archived_at from app.conversations where id = $1", [adminRoom.id]);
    expect(still.rows[0].archived_at).toBeNull();
  });

  it("a private channel the caller is not a member of is 404, for admins too", async () => {
    const hidden = await ok(
      alex.request("POST", "/api/v1/channels", { name: "alex-hidden", visibility: "private" }),
    );
    const res = await admin.request("POST", `/api/v1/channels/${hidden.id}/archive`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: { code: "not_found" } });
    expect(JSON.stringify(res.body)).not.toContain("private_channel");
    const still = await su.query("select archived_at from app.conversations where id = $1", [hidden.id]);
    expect(still.rows[0].archived_at).toBeNull();
  });

  it("a deactivated member is denied by the user layer", async () => {
    const deeId = randomUUID();
    await su.query("insert into auth.user (id, name, email) values ($1, 'Dee', $2)", [
      deeId,
      `${deeId}@example.test`,
    ]);
    await su.query(
      `insert into app.org_members (organization_id, user_id, display_name, role, deactivated_at)
       values ($1, $2, 'Dee', 'admin', now())`,
      [orgId, deeId],
    );
    const { core } = stack.built;
    const perms = createPermissionService(core);
    const res = await core.db.withTenant({ organizationId: orgId, userId: adminId }, (tx) =>
      perms.decide(tx, { kind: "user", userId: deeId }, "channel.read"),
    );
    expect(res).toEqual({
      allowed: false,
      denial: { permission: "channel.read", layer: "user", reason: "deactivated" },
    });
    const active = await core.db.withTenant({ organizationId: orgId, userId: adminId }, (tx) =>
      perms.decide(tx, { kind: "user", userId: adminId }, "channel.archive"),
    );
    expect(active).toEqual({ allowed: true });
  });
});

describe("reading chat is decided by the resolver", () => {
  const viewerCanOf = async (client: TestClient, id: string) =>
    (await ok(client.request("GET", `/api/v1/channels/${id}`))).viewerCan as string[];

  it("private channels: list, detail and conv topic are hidden from non-members, visible to members", async () => {
    const vault = await ok(
      admin.request("POST", "/api/v1/channels", { name: "vault", visibility: "private" }),
    );
    const alexAuth = { userId: alexId, organizationId: orgId } as AuthContext;
    const adminAuth = { userId: adminId, organizationId: orgId } as AuthContext;
    const { realtime } = stack.built.core;

    const hidden = await ok(alex.request("GET", "/api/v1/channels"));
    expect(hidden.channels.some((c: { id: string }) => c.id === vault.id)).toBe(false);
    const detail = await alex.request("GET", `/api/v1/channels/${vault.id}`);
    expect(detail.status).toBe(404);
    expect(JSON.stringify(detail.body)).not.toContain("private_channel");
    expect(await realtime.authorizeTopic(alexAuth, `conv:${vault.id}`)).toBe(false);
    expect(await realtime.authorizeTopic(adminAuth, `conv:${vault.id}`)).toBe(true);

    await ok(admin.request("POST", `/api/v1/channels/${vault.id}/members`, { kind: "user", id: alexId }));
    const shown = await ok(alex.request("GET", "/api/v1/channels"));
    expect(shown.channels.find((c: { id: string }) => c.id === vault.id)).toMatchObject({ isMember: true });
    expect((await alex.request("GET", `/api/v1/channels/${vault.id}`)).status).toBe(200);
    expect(await realtime.authorizeTopic(alexAuth, `conv:${vault.id}`)).toBe(true);
  });

  it("every channel summary carries viewerCan from the resolver", async () => {
    // alex (developer) owns alex-pub; admin owns admin-pub.
    const alexPub = await ok(alex.request("POST", "/api/v1/channels", { name: "alex-pub" }));
    const adminPub = await ok(admin.request("POST", "/api/v1/channels", { name: "admin-pub" }));

    // Admin, not the owner and not a member: archive and remove members, but cannot post before joining.
    const asAdmin = await viewerCanOf(admin, alexPub.id);
    expect(asAdmin).toEqual(expect.arrayContaining(["channel.archive", "channel.members.remove"]));
    expect(asAdmin).not.toContain("channel.post");

    // Developer, not a member yet: no posting.
    expect(await viewerCanOf(alex, adminPub.id)).not.toContain("channel.post");

    // Developer member, not the owner: post and add members, never archive.
    await ok(alex.request("POST", `/api/v1/channels/${adminPub.id}/join`));
    const asMember = await viewerCanOf(alex, adminPub.id);
    expect(asMember).toEqual(expect.arrayContaining(["channel.post", "channel.members.add"]));
    expect(asMember).not.toContain("channel.archive");
    expect(asMember).not.toContain("channel.members.remove");

    // Channel owner (developer): archive their own channel.
    expect(await viewerCanOf(alex, alexPub.id)).toEqual(
      expect.arrayContaining([
        "channel.post",
        "channel.members.add",
        "channel.members.remove",
        "channel.archive",
      ]),
    );

    // The list carries the same answer.
    const list = await ok(alex.request("GET", "/api/v1/channels"));
    expect(list.channels.find((c: { id: string }) => c.id === adminPub.id).viewerCan).toEqual(asMember);
  });

  it("the channel read routes record no undecided response", () => {
    expect(stack.built.authz.undecided.filter((u) => u.url.startsWith("/api/v1/channels"))).toEqual([]);
    expect(stack.built.authz.routes.get("GET /api/v1/channels")).toBe("user");
    expect(stack.built.authz.routes.get("GET /api/v1/channels/:id")).toBe("user");
  });
});

describe("chat mutations and bot replies are decided by the resolver", () => {
  const ELECTRON_UA =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ocw-desktop/0.1.0 Chrome/140.0.7339.80 Electron/38.1.0 Safari/537.36";
  let stan: TestClient;
  let stanId: string;
  let boltId: string;

  const rule = async (subjectKind: "role" | "agent", subjectId: string, permission: string) => {
    const id = randomUUID();
    await su.query(
      `insert into app.permission_rules (id, organization_id, subject_kind, subject_id, permission, effect)
       values ($1, $2, $3, $4, $5, 'deny')`,
      [id, orgId, subjectKind, subjectId, permission],
    );
    return async () => {
      await su.query("delete from app.permission_rules where id = $1", [id]);
    };
  };
  const errorOf = (r: { body: Record<string, unknown> | null }) =>
    (r.body as { error: { code: string; details?: Record<string, unknown> } }).error;

  beforeAll(async () => {
    const inv = await ok(
      admin.request("POST", "/api/v1/invitations", { email: "stan@example.test", role: "standard" }),
    );
    stan = new TestClient(stack.baseUrl);
    const accepted = await ok(
      stan.request("POST", `/api/v1/invitations/${inv.id}/accept`, {
        name: "Stan Lee",
        password: "standard-long-password",
      }),
    );
    stanId = accepted.user.id;
    boltId = randomUUID();
    await su.query(
      `insert into app.agents (id, organization_id, name, username, instructions, model_provider, model_id, status)
       values ($1, $2, 'Bolt', 'bolt', 'x', 'mock', 'mock-1', 'ready')`,
      [boltId, orgId],
    );
  });

  it("a standard user creates a channel and posts in it; a non-member gets not_a_member", async () => {
    const room = await ok(stan.request("POST", "/api/v1/channels", { name: "stan-room" }));
    expect(room.viewerCan).toEqual(expect.arrayContaining(["channel.post", "channel.archive"]));
    await ok(stan.request("POST", `/api/v1/conversations/${room.id}/messages`, { body: "hello" }));

    const denied = await alex.request("POST", `/api/v1/conversations/${room.id}/messages`, { body: "hi" });
    expect(denied.status).toBe(403);
    expect(errorOf(denied)).toMatchObject({
      code: "not_a_member",
      details: { permission: "channel.post", layer: "resource", reason: "not_a_member" },
    });
    const addDenied = await alex.request("POST", `/api/v1/channels/${room.id}/members`, {
      kind: "user",
      id: alexId,
    });
    expect(addDenied.status).toBe(403);
    expect(errorOf(addDenied).code).toBe("not_a_member");
  });

  it("removing members: owner, admin and self are allowed; a plain member is not; #general stays", async () => {
    const room = await ok(stan.request("POST", "/api/v1/channels", { name: "remove-room" }));
    await ok(alex.request("POST", `/api/v1/channels/${room.id}/join`));
    await ok(admin.request("POST", `/api/v1/channels/${room.id}/join`));

    // Plain member (alex, developer) removing someone else → 403.
    const plain = await alex.request("DELETE", `/api/v1/channels/${room.id}/members/user/${adminId}`);
    expect(plain.status).toBe(403);
    expect(errorOf(plain).details).toMatchObject({ permission: "channel.members.remove" });

    // Admin (not the owner) removes alex; the owner (stan, standard) removes the admin.
    await ok(admin.request("DELETE", `/api/v1/channels/${room.id}/members/user/${alexId}`));
    await ok(stan.request("DELETE", `/api/v1/channels/${room.id}/members/user/${adminId}`));

    // Self: DELETE on one's own membership and leave.
    await ok(alex.request("POST", `/api/v1/channels/${room.id}/join`));
    await ok(alex.request("DELETE", `/api/v1/channels/${room.id}/members/user/${alexId}`));
    await ok(alex.request("POST", `/api/v1/channels/${room.id}/join`));
    await ok(alex.request("POST", `/api/v1/channels/${room.id}/leave`));
    const members = await ok(stan.request("GET", `/api/v1/channels/${room.id}/members`));
    expect(members.members.map((m: { id: string }) => m.id)).toEqual([stanId]);

    const general = (await ok(alex.request("GET", "/api/v1/channels"))).channels.find(
      (c: { isDefault: boolean }) => c.isDefault,
    );
    const leaveGeneral = await alex.request("POST", `/api/v1/channels/${general.id}/leave`);
    expect(leaveGeneral.status).toBe(400);
    expect(errorOf(leaveGeneral).code).toBe("default_channel");
  });

  it("a deny rule on channel.create reaches POST /channels for that role only, and is audited", async () => {
    const drop = await rule("role", "developer", "channel.create");
    try {
      const denied = await alex.request("POST", "/api/v1/channels", { name: "denied-room" });
      expect(denied.status).toBe(403);
      expect(errorOf(denied)).toMatchObject({
        code: "forbidden",
        details: { permission: "channel.create", layer: "org", reason: "denied_by_rule" },
      });
      await ok(admin.request("POST", "/api/v1/channels", { name: "allowed-room" }));
      await ok(stan.request("POST", "/api/v1/channels", { name: "stan-allowed" }));
      const rows = await su.query(
        "select * from app.audit_events where action = 'authz.denied' and user_id = $1 and resource_id = '/api/v1/channels'",
        [alexId],
      );
      expect(rows.rows.at(-1)?.metadata).toMatchObject({ permission: "channel.create", layer: "org" });
    } finally {
      await drop();
    }
    await ok(alex.request("POST", "/api/v1/channels", { name: "denied-room" }));
  });

  it("bot replies: agent gate, membership, agent rules and the human it answers (agent ∩ human)", async () => {
    const { chatAgent } = stack.built.core;
    const ctx = { organizationId: orgId, userId: null };
    const room = await ok(
      admin.request("POST", "/api/v1/channels", { name: "bot-room", visibility: "private" }),
    );
    await ok(admin.request("POST", `/api/v1/channels/${room.id}/members`, { kind: "user", id: alexId }));
    await ok(admin.request("POST", `/api/v1/channels/${room.id}/members`, { kind: "agent", id: archieId }));
    const reply = (agentId: string, extra: Record<string, unknown> = {}) =>
      chatAgent.postAgentMessage(ctx, {
        agentId,
        conversationId: room.id,
        threadRootId: null,
        body: "bot says hi",
        idempotencyKey: randomUUID(),
        ...extra,
      });

    // A disabled bot (even before membership) → agent_disabled on the agent layer.
    await expect(reply(ghostId)).rejects.toMatchObject({
      statusCode: 403,
      code: "agent_disabled",
      details: { layer: "agent", reason: "agent_disabled" },
    });
    // A bot that is not a member.
    await expect(reply(boltId)).rejects.toMatchObject({ statusCode: 403, code: "agent_not_member" });
    // A deny rule on the agent.
    const drop = await rule("agent", archieId, "channel.post");
    try {
      await expect(reply(archieId)).rejects.toMatchObject({
        statusCode: 403,
        details: { permission: "channel.post", layer: "agent", reason: "denied_by_rule" },
      });
    } finally {
      await drop();
    }

    // The human it answers lost access to the private channel → refused although the bot is a member.
    const asked = await ok(
      alex.request("POST", `/api/v1/conversations/${room.id}/messages`, { body: "@archie?" }),
    );
    await ok(admin.request("DELETE", `/api/v1/channels/${room.id}/members/user/${alexId}`));
    await expect(
      reply(archieId, { threadRootId: asked.id, inReplyToMessageId: asked.id }),
    ).rejects.toMatchObject({
      statusCode: 403,
      details: { layer: "resource", reason: "private_channel" },
    });

    // Happy path: the human still reads the channel → the reply lands in the thread.
    const question = await ok(
      admin.request("POST", `/api/v1/conversations/${room.id}/messages`, { body: "q" }),
    );
    const posted = await reply(archieId, { threadRootId: question.id, inReplyToMessageId: question.id });
    expect(posted.created).toBe(true);
    const row = await su.query("select thread_id, author_id, client_kind from app.messages where id = $1", [
      posted.messageId,
    ]);
    expect(row.rows[0]).toMatchObject({ thread_id: question.id, author_id: archieId, client_kind: "agent" });
  });

  it("a mention auto-adds a bot only when the poster may add members", async () => {
    const room = await ok(alex.request("POST", "/api/v1/channels", { name: "mention-room" }));
    const drop = await rule("role", "developer", "channel.members.add");
    try {
      mentions.length = 0;
      await ok(alex.request("POST", `/api/v1/conversations/${room.id}/messages`, { body: "@bolt help" }));
      expect(mentions).toHaveLength(0);
      const members = await ok(alex.request("GET", `/api/v1/channels/${room.id}/members`));
      expect(members.members.some((m: { id: string }) => m.id === boltId)).toBe(false);
    } finally {
      await drop();
    }
    mentions.length = 0;
    await ok(alex.request("POST", `/api/v1/conversations/${room.id}/messages`, { body: "@bolt help" }));
    expect(mentions).toHaveLength(1);
    expect(mentions[0]?.agentIds).toEqual([boltId]);
  });

  it("a message posted from a desktop session is stored with client_kind desktop", async () => {
    const res = await fetch(`${stack.baseUrl}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { origin: WEB_ORIGIN, "content-type": "application/json", "user-agent": ELECTRON_UA },
      body: JSON.stringify({ email: "alex@example.test", password: "another-long-password" }),
    });
    expect(res.status).toBe(200);
    const desktop = new TestClient(stack.baseUrl);
    for (const c of res.headers.getSetCookie()) {
      const [pair = ""] = c.split(";");
      const i = pair.indexOf("=");
      desktop.cookies.set(pair.slice(0, i), pair.slice(i + 1));
    }
    const general = (await ok(desktop.request("GET", "/api/v1/channels"))).channels.find(
      (c: { isDefault: boolean }) => c.isDefault,
    );
    const msg = await ok(
      desktop.request("POST", `/api/v1/conversations/${general.id}/messages`, { body: "from the app" }),
    );
    expect(msg.clientKind).toBe("desktop");
    const row = await su.query("select client_kind from app.messages where id = $1", [msg.id]);
    expect(row.rows[0].client_kind).toBe("desktop");
    const web = await ok(
      alex.request("POST", `/api/v1/conversations/${general.id}/messages`, { body: "from web" }),
    );
    expect(web.clientKind).toBe("web");
  });
});

describe("organization: permissions for the caller", () => {
  it("GET /me/permissions returns the role and the organization-scope set", async () => {
    const mine = await ok(admin.request("GET", "/api/v1/me/permissions"));
    expect(mine.role).toBe("admin");
    for (const p of [
      "member.manage",
      "provider.manage",
      "cell.manage",
      "channel.archive",
      "account.manage",
    ]) {
      expect(mine.permissions, p).toContain(p);
    }
    const dev = await ok(alex.request("GET", "/api/v1/me/permissions"));
    expect(dev.role).toBe("developer");
    expect(dev.permissions).toContain("work_session.create");
    expect(dev.permissions).toContain("channel.post");
    expect(dev.permissions).toContain("account.manage");
    expect(dev.permissions).not.toContain("provider.manage");
    expect((await new TestClient(stack.baseUrl).request("GET", "/api/v1/me/permissions")).status).toBe(401);
  });

  it("GET /members is decided by member.read and recorded as decided", async () => {
    const before = stack.built.authz.undecided.length;
    const list = await ok(alex.request("GET", "/api/v1/members"));
    expect(list.members.map((m: { userId: string }) => m.userId)).toContain(adminId);
    expect((await new TestClient(stack.baseUrl).request("GET", "/api/v1/members")).status).toBe(401);
    expect(stack.built.authz.undecided.slice(before)).toEqual([]);
    expect(stack.built.authz.routes.get("GET /api/v1/members")).toBe("user");
    expect(stack.built.authz.routes.get("GET /api/v1/me/permissions")).toBe("user");
    expect(stack.built.authz.routes.get("POST /api/v1/channels/:id/archive")).toBe("user");
    expect(stack.built.authz.routes.get("GET /health")).toBe("public");
  });
});

describe("every chat route is decided", () => {
  it("no chat route answered 2xx without a permission decision during this suite", () => {
    const chat = ["/api/v1/channels", "/api/v1/conversations", "/api/v1/messages", "/api/v1/test/chat"];
    expect(
      stack.built.authz.undecided.filter((u) => chat.some((prefix) => u.url.startsWith(prefix))),
    ).toEqual([]);
    const chatRoutes = [...stack.built.authz.routes].filter(([key]) =>
      chat.some((prefix) => key.split(" ")[1]?.startsWith(prefix)),
    );
    expect(chatRoutes.length).toBeGreaterThanOrEqual(17);
    for (const [key, mode] of chatRoutes) expect(mode, key).toBe("user");
  });
});
