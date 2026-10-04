import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuthContext } from "../../core";
import type { AgentMention } from "../../lib/chat-agent-bridge";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";
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
    admin.request("POST", "/api/v1/invitations", { email: "alex@example.test", role: "member" }),
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
      "insert into app.org_members (organization_id, user_id, display_name, role) values ($1, $2, 'Eve', 'owner')",
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
