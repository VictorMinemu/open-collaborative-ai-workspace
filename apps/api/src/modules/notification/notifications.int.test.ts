import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentMention } from "../../lib/chat-agent-bridge";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";

/**
 * CHAT-08 (04-09): the Notification module against real PostgreSQL + Redis. Rows hold ids and the actor only
 * (Pitfall 9), are written in the message transaction for readable recipients (P-03), announce themselves on the
 * recipient's durable `user:` stream (P-04), and the inbox re-checks access and computes snippets at read time.
 */

let stack: TestStack;
let su: pg.Client;
let ada: TestClient;
let sam: TestClient;
let alex: TestClient;
let bob: TestClient;
let eve: TestClient; // a member of another organization
let orgId: string;
let adaId: string;
let samId: string;
let alexId: string;
let bobId: string;
let archieId: string;
let generalId: string;
const mentions: AgentMention[] = [];

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
type Json = Record<string, any>;

async function ok(res: Promise<{ status: number; body: Record<string, unknown> | null }>, status = 200) {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as Json;
}

async function joinAs(email: string, name: string) {
  const inv = await ok(ada.request("POST", "/api/v1/invitations", { email, role: "developer" }));
  const c = new TestClient(stack.baseUrl);
  const acc = await ok(
    c.request("POST", `/api/v1/invitations/${inv.id}/accept`, { name, password: "another-long-password" }),
  );
  return [c, acc.user.id as string] as const;
}

const post = (as: TestClient, conv: string, body: string, threadRootId?: string) =>
  ok(
    as.request("POST", `/api/v1/conversations/${conv}/messages`, {
      body,
      ...(threadRootId ? { threadRootId } : {}),
    }),
  );

const inbox = (as: TestClient, query = "") => ok(as.request("GET", `/api/v1/notifications${query}`));

async function rowsFor(userId: string, messageId?: string): Promise<Json[]> {
  const res = await su.query(
    `select * from app.notifications where user_id = $1 ${messageId ? "and message_id = $2" : ""} order by created_at`,
    messageId ? [userId, messageId] : [userId],
  );
  return res.rows;
}

async function events(userId: string, type: string): Promise<Json[]> {
  const res = await su.query(
    "select payload from app.stream_events where stream_id = $1 and type = $2 order by seq",
    [`user:${userId}`, type],
  );
  return res.rows.map((r) => r.payload);
}

async function channel(name: string, visibility: "public" | "private", joiners: TestClient[] = []) {
  const id = (await ok(ada.request("POST", "/api/v1/channels", { name, visibility }))).id as string;
  for (const j of joiners) await ok(j.request("POST", `/api/v1/channels/${id}/join`));
  return id;
}

beforeAll(async () => {
  stack = await startTestStack();
  su = new pg.Client({ connectionString: stack.db.superuserUrl });
  await su.connect();
  stack.built.core.chatAgent.onAgentMention(async (_tx, m) => {
    mentions.push(m);
  });

  ada = new TestClient(stack.baseUrl);
  const setup = await ok(
    ada.request("POST", "/api/v1/setup", {
      token: TEST_SETUP_TOKEN,
      name: "Ada Lovelace",
      email: "ada@example.test",
      password: "correct-horse-battery",
      orgName: "Autofy Labs",
    }),
  );
  orgId = setup.organization.id;
  adaId = setup.user.id;
  [sam, samId] = await joinAs("sam@example.test", "Sam Lee");
  [alex, alexId] = await joinAs("alex@example.test", "Alex Kim");
  [bob, bobId] = await joinAs("bob@example.test", "Bob Stone");

  archieId = randomUUID();
  await su.query(
    `insert into app.agents (id, organization_id, name, username, instructions, model_provider, model_id, status)
     values ($1, $2, 'Archie', 'archie', 'x', 'mock', 'mock-1', 'ready')`,
    [archieId, orgId],
  );

  // Eve: a member of another organization with a real session there.
  const [, eveId] = await joinAs("eve@example.test", "Eve Other");
  const orgB = randomUUID();
  await su.query("insert into auth.organization (id, name, slug) values ($1, 'Other Org', $2)", [
    orgB,
    `other-${orgB}`,
  ]);
  await su.query("update auth.member set organization_id = $1, role = 'admin' where user_id = $2", [
    orgB,
    eveId,
  ]);
  await su.query("update app.org_members set organization_id = $1, role = 'admin' where user_id = $2", [
    orgB,
    eveId,
  ]);
  await su.query("delete from auth.session where user_id = $1", [eveId]);
  eve = new TestClient(stack.baseUrl);
  await ok(
    eve.request("POST", "/api/auth/sign-in/email", {
      email: "eve@example.test",
      password: "another-long-password",
    }),
  );

  const list = await ok(ada.request("GET", "/api/v1/channels"));
  generalId = list.channels.find((c: Json) => c.name === "general").id;
}, 240_000);

afterAll(async () => {
  await su?.end();
  await stack?.stop();
});

describe("mentions (CHAT-08 tracer)", () => {
  let first: Json;
  let notificationId: string;

  it("Ada mentions Sam: one ids-only row and one notification.created on user:<sam>", async () => {
    first = await post(ada, generalId, "hi @sam");
    const rows = await rowsFor(samId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      user_id: samId,
      kind: "mention",
      conversation_id: generalId,
      message_id: first.id,
      thread_root_id: null,
      actor_kind: "user",
      actor_id: adaId,
      read_at: null,
    });
    notificationId = rows[0]?.id;
    // No body or snippet column exists (Pitfall 9).
    const cols = (
      await su.query(
        "select column_name from information_schema.columns where table_schema = 'app' and table_name = 'notifications'",
      )
    ).rows.map((r) => r.column_name);
    expect(cols).not.toContain("body");
    expect(cols).not.toContain("snippet");

    const created = await events(samId, "notification.created");
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      popup: true,
      notification: {
        id: notificationId,
        kind: "mention",
        messageId: first.id,
        conversation: { id: generalId, label: "#general", kind: "channel" },
        actor: { kind: "user", id: adaId, displayName: "Ada Lovelace" },
        snippet: "hi @sam",
        readAt: null,
      },
    });
    // Ada notified nobody else, and never herself.
    expect(await rowsFor(adaId)).toEqual([]);
    expect(await rowsFor(alexId)).toEqual([]);
  });

  it("snippets are one line of at most 140 characters", async () => {
    const long = await post(ada, generalId, `@sam ${"word ".repeat(80)}\n\nend`);
    const [ev] = (await events(samId, "notification.created")).filter(
      (e) => e.notification.messageId === long.id,
    );
    expect(ev?.notification.snippet.length).toBeLessThanOrEqual(140);
    expect(ev?.notification.snippet).not.toContain("\n");
    expect(ev?.notification.snippet.startsWith("@sam word word")).toBe(true);
  });

  it("GET /notifications lists it for Sam with the conversation label and the unread count", async () => {
    const list = await inbox(sam, "?filter=mentions");
    expect(list.unreadCount).toBe(2);
    const item = list.items.find((n: Json) => n.id === notificationId);
    expect(item).toMatchObject({
      kind: "mention",
      messageId: first.id,
      conversation: { id: generalId, label: "#general" },
      actor: { id: adaId, displayName: "Ada Lovelace" },
      snippet: "hi @sam",
      readAt: null,
    });
    // Newest first.
    expect(list.items[0].id).not.toBe(notificationId);
    expect(list.nextCursor).toBeNull();
    // Ada's own inbox is empty.
    const mine = await inbox(ada);
    expect(mine).toMatchObject({ items: [], unreadCount: 0, nextCursor: null });
  });

  it("pages with an opaque keyset cursor and refuses a bad one", async () => {
    const page1 = await inbox(sam, "?limit=1");
    expect(page1.items).toHaveLength(1);
    expect(page1.nextCursor).toEqual(expect.any(String));
    const page2 = await inbox(sam, `?limit=1&cursor=${encodeURIComponent(page1.nextCursor)}`);
    expect(page2.items).toHaveLength(1);
    expect(page2.items[0].id).not.toBe(page1.items[0].id);
    const bad = await sam.request("GET", "/api/v1/notifications?cursor=nope");
    expect(bad.status).toBe(400);
    expect((bad.body as Json).error.code).toBe("invalid_cursor");
  });

  it("POST /notifications/read marks one read and tells Sam's other devices the new count", async () => {
    await ok(sam.request("POST", "/api/v1/notifications/read", { ids: [notificationId] }));
    const [row] = await rowsFor(samId, first.id);
    expect(row?.read_at).not.toBeNull();
    const read = await events(samId, "notification.read");
    expect(read.at(-1)).toEqual({ ids: [notificationId], unreadCount: 1 });
    expect((await inbox(sam)).unreadCount).toBe(1);
  });

  it("{all:true} marks every one read", async () => {
    await post(alex, generalId, "@sam one more");
    expect((await inbox(sam)).unreadCount).toBe(2);
    await ok(sam.request("POST", "/api/v1/notifications/read", { all: true }));
    expect((await inbox(sam)).unreadCount).toBe(0);
    expect((await rowsFor(samId)).every((r) => r.read_at !== null)).toBe(true);
    expect((await events(samId, "notification.read")).at(-1)).toEqual({ all: true, unreadCount: 0 });
  });

  it("a mention of someone who cannot read the private channel creates nothing", async () => {
    const board = await channel(`board-${randomUUID().slice(0, 6)}`, "private");
    const m = await post(ada, board, "@sam you should not see this");
    expect(await rowsFor(samId, m.id)).toEqual([]);
    expect(JSON.stringify(await events(samId, "notification.created"))).not.toContain(m.id);
  });

  it("a bot mention still dispatches the bot exactly as before and never notifies the bot", async () => {
    const before = mentions.length;
    const m = await post(ada, generalId, "@archie summarise this for @sam");
    const fresh = mentions.slice(before);
    expect(fresh).toHaveLength(1);
    expect(fresh[0]).toMatchObject({ messageId: m.id, agentIds: [archieId], delivery: "thread" });
    expect(await rowsFor(archieId)).toEqual([]);
    expect(await rowsFor(samId, m.id)).toHaveLength(1);
  });

  it("a bot reply that mentions someone notifies them, attributed to the bot", async () => {
    const root = await post(ada, generalId, "@archie who is on call?");
    const reply = await ok(
      ada.request("POST", "/api/v1/test/chat/agent-reply", {
        agentId: archieId,
        conversationId: generalId,
        threadRootId: root.id,
        body: "@bob is on call this week",
        idempotencyKey: randomUUID(),
      }),
    );
    const [row] = await rowsFor(bobId, reply.messageId);
    expect(row).toMatchObject({ kind: "mention", actor_kind: "agent", actor_id: archieId });
    // Ada started the thread: the bot's reply notifies her as a thread participant.
    expect((await rowsFor(adaId, reply.messageId))[0]).toMatchObject({ kind: "thread_reply" });
    const list = await inbox(bob);
    expect(list.items[0]).toMatchObject({
      actor: { kind: "agent", id: archieId, displayName: "Archie" },
      threadRootId: root.id,
    });
  });

  it("another organization lists nothing and cannot mark org A's notifications", async () => {
    const list = await inbox(eve);
    expect(list).toMatchObject({ items: [], unreadCount: 0 });
    const [row] = await rowsFor(bobId);
    await su.query("update app.notifications set read_at = null where id = $1", [row?.id]);
    await ok(eve.request("POST", "/api/v1/notifications/read", { ids: [row?.id] }));
    const [after] = (await su.query("select read_at from app.notifications where id = $1", [row?.id])).rows;
    expect(after.read_at).toBeNull();
  });
});
