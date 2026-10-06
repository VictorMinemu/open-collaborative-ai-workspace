import { randomUUID } from "node:crypto";
import { WS_AUTH_PROTOCOL_PREFIX, WS_PROTOCOL } from "@ocw/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { AgentMention } from "../../lib/chat-agent-bridge";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack, WEB_ORIGIN } from "../../testing";
import { createOnlineSet } from "../realtime";

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

/** Authenticated /ws socket (being connected is what puts a member in the online set). */
async function socketFor(client: TestClient) {
  const token = await client.token();
  const ws = new WebSocket(
    `${stack.baseUrl.replace("http", "ws")}/ws`,
    [WS_PROTOCOL, `${WS_AUTH_PROTOCOL_PREFIX}${token}`],
    { headers: { origin: WEB_ORIGIN } },
  );
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  return ws;
}

async function until(fn: () => Promise<boolean>, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`condition not met within ${ms} ms`);
}

const onlineNow = () => createOnlineSet(stack.built.core.bus).onlineUserIds(orgId);

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

describe("DMs, groups and threads (CHAT-08)", () => {
  it("a DM notifies the other person", async () => {
    const dm = await ok(ada.request("POST", "/api/v1/dms", { participants: [{ kind: "user", id: samId }] }));
    const m = await post(ada, dm.id, "lunch at 1?");
    expect(await rowsFor(samId, m.id)).toMatchObject([{ kind: "dm", actor_id: adaId }]);
    expect(await rowsFor(adaId, m.id)).toEqual([]);
    const [ev] = (await events(samId, "notification.created")).filter(
      (e) => e.notification.messageId === m.id,
    );
    // DMs notify at the default level (popup), labelled with the other person's name.
    expect(ev).toMatchObject({
      popup: true,
      notification: { conversation: { kind: "dm", label: "Ada Lovelace" } },
    });
  });

  it("a group message notifies every other person", async () => {
    const g = await ok(
      ada.request("POST", "/api/v1/dms", {
        participants: [
          { kind: "user", id: samId },
          { kind: "user", id: alexId },
        ],
      }),
    );
    const m = await post(sam, g.id, "standup notes are in");
    expect((await rowsFor(adaId, m.id))[0]?.kind).toBe("group_dm");
    expect((await rowsFor(alexId, m.id))[0]?.kind).toBe("group_dm");
    expect(await rowsFor(samId, m.id)).toEqual([]);
  });

  it("a thread reply notifies the root author and earlier repliers, once each, never its author", async () => {
    const ch = await channel(`threads-${randomUUID().slice(0, 6)}`, "public", [sam, alex, bob]);
    const root = await post(sam, ch, "what should we name the release?");
    const r1 = await post(alex, ch, "Aurora", root.id);
    expect(await rowsFor(samId, r1.id)).toMatchObject([{ kind: "thread_reply", thread_root_id: root.id }]);
    await post(sam, ch, "nice", root.id);
    const r3 = await post(bob, ch, "Borealis", root.id);
    expect((await rowsFor(samId, r3.id)).map((r) => r.kind)).toEqual(["thread_reply"]);
    expect((await rowsFor(alexId, r3.id)).map((r) => r.kind)).toEqual(["thread_reply"]);
    expect(await rowsFor(bobId, r3.id)).toEqual([]);
    expect(await rowsFor(adaId, r3.id)).toEqual([]);
    const list = await inbox(alex, "?filter=all");
    expect(list.items.find((n: Json) => n.messageId === r3.id)).toMatchObject({
      kind: "thread_reply",
      threadRootId: root.id,
    });
    // The Mentions filter leaves thread replies out.
    expect((await inbox(alex, "?filter=mentions")).items.some((n: Json) => n.messageId === r3.id)).toBe(
      false,
    );
  });
});

describe("@channel and @here (CHAT-08, Pitfall 6, P-11)", () => {
  it("@channel notifies every other human member", async () => {
    const ch = await channel(`all-${randomUUID().slice(0, 6)}`, "public", [sam, alex]);
    const m = await post(ada, ch, "@channel the deploy window opens now");
    expect((await rowsFor(samId, m.id))[0]?.kind).toBe("channel");
    expect((await rowsFor(alexId, m.id))[0]?.kind).toBe("channel");
    expect(await rowsFor(bobId, m.id)).toEqual([]);
    expect(await rowsFor(adaId, m.id)).toEqual([]);
    expect(
      (await su.query("select count(*)::int as n from app.notifications where message_id = $1", [m.id]))
        .rows[0].n,
    ).toBe(2);
  });

  it("a second @channel in the same channel within a minute is refused (429) and posts nothing", async () => {
    const ch = await channel(`limit-${randomUUID().slice(0, 6)}`, "public", [sam]);
    await post(ada, ch, "@channel first");
    const again = await ada.request("POST", `/api/v1/conversations/${ch}/messages`, { body: "@here second" });
    expect(again.status).toBe(429);
    expect((again.body as Json).error.code).toBe("mention_all_rate_limited");
    const n = (await su.query("select count(*)::int as n from app.messages where conversation_id = $1", [ch]))
      .rows[0].n;
    expect(n).toBe(1);
    // Ordinary messages still post.
    await post(ada, ch, "no broadcast here");
    // A retry of the same message (same clientMessageId) returns it instead of hitting the limit.
    const ch2 = await channel(`retry-${randomUUID().slice(0, 6)}`, "public", [sam]);
    const clientMessageId = randomUUID();
    const sent = await ok(
      ada.request("POST", `/api/v1/conversations/${ch2}/messages`, {
        body: "@channel once",
        clientMessageId,
      }),
    );
    const retried = await ok(
      ada.request("POST", `/api/v1/conversations/${ch2}/messages`, {
        body: "@channel once",
        clientMessageId,
      }),
    );
    expect(retried.id).toBe(sent.id);
  });

  it("@here notifies only members online now (an away socket and an offline member get nothing)", async () => {
    const ch = await channel(`here-${randomUUID().slice(0, 6)}`, "public", [sam, alex, bob]);
    const samWs = await socketFor(sam);
    const alexWs = await socketFor(alex);
    try {
      alexWs.send(JSON.stringify({ op: "presence", state: "away" }));
      await until(async () => {
        const on = await onlineNow();
        return on.has(samId) && !on.has(alexId) && !on.has(bobId);
      });
      const m = await post(ada, ch, "@here quick sync in 5?");
      expect((await rowsFor(samId, m.id))[0]?.kind).toBe("here");
      expect(await rowsFor(alexId, m.id)).toEqual([]);
      expect(await rowsFor(bobId, m.id)).toEqual([]);
    } finally {
      samWs.close();
      alexWs.close();
    }
  });

  it("the online set follows sockets: away and back, and close leaves it", async () => {
    const ws = await socketFor(bob);
    await until(async () => (await onlineNow()).has(bobId));
    ws.send(JSON.stringify({ op: "presence", state: "away" }));
    await until(async () => !(await onlineNow()).has(bobId));
    ws.send(JSON.stringify({ op: "presence", state: "online" }));
    await until(async () => (await onlineNow()).has(bobId));
    ws.close();
    await until(async () => !(await onlineNow()).has(bobId));
  });

  it("a deny rule on channel.mention_all refuses the post with 403 and creates no message", async () => {
    const ch = await channel(`deny-${randomUUID().slice(0, 6)}`, "public", [sam, alex]);
    const rule = await ok(
      ada.request("POST", "/api/v1/permission-rules", {
        subjectKind: "user",
        subjectId: alexId,
        permission: "channel.mention_all",
        effect: "deny",
      }),
    );
    try {
      const res = await alex.request("POST", `/api/v1/conversations/${ch}/messages`, {
        body: "@channel hello",
      });
      expect(res.status).toBe(403);
      expect((res.body as Json).error.details).toMatchObject({ permission: "channel.mention_all" });
      const n = (
        await su.query("select count(*)::int as n from app.messages where conversation_id = $1", [ch])
      ).rows[0].n;
      expect(n).toBe(0);
      // The channel permissions the web reads no longer offer it to Alex.
      const summary = await ok(alex.request("GET", `/api/v1/channels/${ch}`));
      expect(summary.viewerCan).not.toContain("channel.mention_all");
      expect((await ok(sam.request("GET", `/api/v1/channels/${ch}`))).viewerCan).toContain(
        "channel.mention_all",
      );
      // Ordinary posts still work.
      await post(alex, ch, "hello without a broadcast");
    } finally {
      await ok(ada.request("DELETE", `/api/v1/permission-rules/${rule.id}`));
    }
  });

  it("@channel never wakes a bot and never notifies one; inside code it notifies nobody", async () => {
    const ch = await channel(`bots-${randomUUID().slice(0, 6)}`, "public", [sam]);
    await ok(ada.request("POST", `/api/v1/channels/${ch}/members`, { kind: "agent", id: archieId }));
    const before = mentions.length;
    const m = await post(ada, ch, "@channel heads up");
    expect(mentions.slice(before).filter((x) => x.messageId === m.id)).toEqual([]);
    expect(await rowsFor(archieId)).toEqual([]);
    expect((await rowsFor(samId, m.id))[0]?.kind).toBe("channel");

    const ch2 = await channel(`code-${randomUUID().slice(0, 6)}`, "public", [sam]);
    const code = await post(ada, ch2, "type `@channel` to ping everyone\n```\n@here\n```");
    expect(await rowsFor(samId, code.id)).toEqual([]);
  });

  it("a mention beats @channel for the same person (one row, kind mention)", async () => {
    const ch = await channel(`both-${randomUUID().slice(0, 6)}`, "public", [sam, alex]);
    const m = await post(ada, ch, "@channel and especially @sam");
    expect((await rowsFor(samId, m.id)).map((r) => r.kind)).toEqual(["mention"]);
    expect((await rowsFor(alexId, m.id)).map((r) => r.kind)).toEqual(["channel"]);
  });
});

describe("edits and lost access (Pitfalls 8 and 9, P-05)", () => {
  it("an edit notifies only the members it newly mentions", async () => {
    const ch = await channel(`edits-${randomUUID().slice(0, 6)}`, "public", [sam, alex]);
    const m = await post(ada, ch, "hi");
    expect(await rowsFor(samId, m.id)).toEqual([]);
    await ok(ada.request("PATCH", `/api/v1/messages/${m.id}`, { body: "hi @sam" }));
    expect((await rowsFor(samId, m.id)).map((r) => r.kind)).toEqual(["mention"]);
    const samEvents = async () =>
      (await events(samId, "notification.created")).filter((e) => e.notification.messageId === m.id);
    expect(await samEvents()).toHaveLength(1);
    expect((await samEvents())[0]?.notification.snippet).toBe("hi @sam");

    await ok(ada.request("PATCH", `/api/v1/messages/${m.id}`, { body: "hi @sam @alex" }));
    expect((await rowsFor(samId, m.id)).map((r) => r.kind)).toEqual(["mention"]);
    expect(await samEvents()).toHaveLength(1);
    expect((await rowsFor(alexId, m.id)).map((r) => r.kind)).toEqual(["mention"]);
    // The snippet is computed from the current body.
    const item = (await inbox(sam)).items.find((n: Json) => n.messageId === m.id);
    expect(item?.snippet).toBe("hi @sam @alex");
  });

  it("an edit never notifies @channel or @here", async () => {
    const ch = await channel(`edit-all-${randomUUID().slice(0, 6)}`, "public", [sam, alex]);
    const m = await post(ada, ch, "deploy at noon");
    await ok(ada.request("PATCH", `/api/v1/messages/${m.id}`, { body: "@channel deploy at noon" }));
    await ok(ada.request("PATCH", `/api/v1/messages/${m.id}`, { body: "@here deploy at noon" }));
    const n = (
      await su.query("select count(*)::int as n from app.notifications where message_id = $1", [m.id])
    ).rows[0].n;
    expect(n).toBe(0);
  });

  it("losing access to a private channel hides its notifications (and the count); regaining it shows them again", async () => {
    const secret = await channel(`secret-${randomUUID().slice(0, 6)}`, "private");
    await ok(ada.request("POST", `/api/v1/channels/${secret}/members`, { kind: "user", id: samId }));
    await ok(sam.request("POST", "/api/v1/notifications/read", { all: true }));
    const m = await post(ada, secret, "@sam the board deck is ready");
    const before = await inbox(sam);
    expect(before.items.some((n: Json) => n.messageId === m.id)).toBe(true);
    expect(before.unreadCount).toBe(1);

    await ok(ada.request("DELETE", `/api/v1/channels/${secret}/members/user/${samId}`));
    const after = await inbox(sam);
    expect(after.items.some((n: Json) => n.messageId === m.id)).toBe(false);
    expect(JSON.stringify(after)).not.toContain("board deck");
    expect(after.unreadCount).toBe(0);
    expect((await inbox(sam, "?filter=mentions")).unreadCount).toBe(0);
    // The row itself is kept (ids only); only what Sam may read is listed.
    expect(await rowsFor(samId, m.id)).toHaveLength(1);

    await ok(ada.request("POST", `/api/v1/channels/${secret}/members`, { kind: "user", id: samId }));
    const again = await inbox(sam);
    expect(again.items.some((n: Json) => n.messageId === m.id)).toBe(true);
    expect(again.unreadCount).toBe(1);
  });

  it("a removed member is no longer notified", async () => {
    const secret = await channel(`gone-${randomUUID().slice(0, 6)}`, "private");
    await ok(ada.request("POST", `/api/v1/channels/${secret}/members`, { kind: "user", id: alexId }));
    await ok(ada.request("DELETE", `/api/v1/channels/${secret}/members/user/${alexId}`));
    const m = await post(ada, secret, "@alex are you still here?");
    expect(await rowsFor(alexId, m.id)).toEqual([]);
  });

  it("a deleted message's notification is no longer listed", async () => {
    const m = await post(ada, generalId, "@sam temporary note");
    expect((await inbox(sam)).items.some((n: Json) => n.messageId === m.id)).toBe(true);
    await ok(ada.request("DELETE", `/api/v1/messages/${m.id}`));
    const list = await inbox(sam);
    expect(list.items.some((n: Json) => n.messageId === m.id)).toBe(false);
    expect(JSON.stringify(list)).not.toContain("temporary note");
  });
});
