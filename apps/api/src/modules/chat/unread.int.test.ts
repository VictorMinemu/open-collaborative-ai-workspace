import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";

/**
 * CHAT-09 (04-10, D-07, P-07): unread and mention badges over real PostgreSQL + Redis. Unread counts top-level,
 * live messages from others after the member's read cursor (never `streams.last_seq`, Pitfall 1), capped at 100;
 * mentions count the member's unread mention-like notifications of top-level messages. Reading (both routes)
 * clears the matching notifications, and every read or mark-unread reaches the member's other tabs and devices
 * as `conversation.read` on `user:<me>` (Pitfall 2).
 */

let stack: TestStack;
let su: pg.Client;
let ada: TestClient;
let sam: TestClient;
let alex: TestClient;
let eve: TestClient; // a member of another organization
let adaId: string;
let samId: string;
let alexId: string;
let generalId: string;
let randomId: string;

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

async function channel(name: string, visibility: "public" | "private", joiners: TestClient[] = []) {
  const id = (await ok(ada.request("POST", "/api/v1/channels", { name, visibility }))).id as string;
  for (const j of joiners) await ok(j.request("POST", `/api/v1/channels/${id}/join`));
  return id;
}

/** The caller's snapshot of one channel (GET /channels), or undefined when it is not listed. */
async function channelOf(as: TestClient, id: string): Promise<Json | undefined> {
  return (await ok(as.request("GET", "/api/v1/channels"))).channels.find((c: Json) => c.id === id);
}
async function countsOf(as: TestClient, id: string) {
  const c = await channelOf(as, id);
  return { unreadCount: c?.unreadCount, mentionCount: c?.mentionCount };
}
async function dmCountsOf(as: TestClient, id: string) {
  const d = (await ok(as.request("GET", "/api/v1/dms"))).dms.find((x: Json) => x.id === id);
  return { unreadCount: d?.unreadCount, mentionCount: d?.mentionCount };
}

async function events(userId: string, type: string): Promise<Json[]> {
  const res = await su.query(
    "select payload from app.stream_events where stream_id = $1 and type = $2 order by seq",
    [`user:${userId}`, type],
  );
  return res.rows.map((r) => r.payload);
}

async function unreadNotifications(userId: string, conversationId: string): Promise<Json[]> {
  const res = await su.query(
    "select * from app.notifications where user_id = $1 and conversation_id = $2 and read_at is null",
    [userId, conversationId],
  );
  return res.rows;
}

const latestSeq = async (conversationId: string) =>
  Number(
    (
      await su.query(
        "select coalesce(max(seq), 0) as n from app.messages where conversation_id = $1 and thread_id is null",
        [conversationId],
      )
    ).rows[0].n,
  );

const read = (as: TestClient, id: string, seq: number) =>
  as.request("POST", `/api/v1/channels/${id}/read`, { seq });

beforeAll(async () => {
  stack = await startTestStack();
  su = new pg.Client({ connectionString: stack.db.superuserUrl });
  await su.connect();

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
  adaId = setup.user.id;
  [sam, samId] = await joinAs("sam@example.test", "Sam Lee");
  [alex, alexId] = await joinAs("alex@example.test", "Alex Kim");

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
  // Sam's #general starts read (the setup and joins posted nothing there, but be explicit).
  await ok(read(sam, generalId, await latestSeq(generalId)));
  randomId = await channel("random", "public", [sam]);
}, 240_000);

afterAll(async () => {
  await su?.end();
  await stack?.stop();
});

describe("counts are messages, not stream seq (CHAT-09 tracer, P-07, Pitfall 1)", () => {
  const ids: string[] = [];
  let root: Json;

  it("three top-level messages from Ada: Sam sees unreadCount 3, mentionCount 0, plus his level and mute", async () => {
    for (const body of ["one", "two", "three"]) ids.push((await post(ada, randomId, body)).id);
    root = { id: ids[0] };
    const c = await channelOf(sam, randomId);
    expect(c).toMatchObject({ unreadCount: 3, mentionCount: 0, notifyLevel: "default", muted: false });
    // The author's own messages never count for her.
    expect(await countsOf(ada, randomId)).toEqual({ unreadCount: 0, mentionCount: 0 });
  });

  it("a reaction, an edit, a thread reply and a member joining leave unreadCount at 3", async () => {
    await ok(ada.request("PUT", `/api/v1/messages/${ids[1]}/reactions/${encodeURIComponent("👍")}`));
    expect((await countsOf(sam, randomId)).unreadCount).toBe(3);
    await ok(ada.request("PATCH", `/api/v1/messages/${ids[2]}`, { body: "three (edited)" }));
    expect((await countsOf(sam, randomId)).unreadCount).toBe(3);
    await post(ada, randomId, "a reply in the thread", root.id);
    expect((await countsOf(sam, randomId)).unreadCount).toBe(3);
    await ok(alex.request("POST", `/api/v1/channels/${randomId}/join`));
    expect((await countsOf(sam, randomId)).unreadCount).toBe(3);
    // The stream moved well past three events: the badge never derives from it.
    const c = await channelOf(sam, randomId);
    expect(c?.lastSeq).toBeGreaterThan(3 + (c?.lastReadSeq ?? 0));
  });

  it("Ada deleting one makes it 2; Sam's own messages never count", async () => {
    await ok(ada.request("DELETE", `/api/v1/messages/${ids[1]}`));
    expect((await countsOf(sam, randomId)).unreadCount).toBe(2);
    await post(sam, randomId, "my own message");
    expect((await countsOf(sam, randomId)).unreadCount).toBe(2);
  });

  it("150 messages show 100 (UNREAD_CAP)", async () => {
    const busy = await channel("busy", "public", [sam]);
    for (let i = 0; i < 150; i++) await post(ada, busy, `message ${i}`);
    expect(await countsOf(sam, busy)).toEqual({ unreadCount: 100, mentionCount: 0 });
  }, 120_000);

  it("a mention in #general gives mentionCount 1 there; a thread-reply notification does not count", async () => {
    await post(ada, generalId, "hi @sam, can you look?");
    expect(await countsOf(sam, generalId)).toEqual({ unreadCount: 1, mentionCount: 1 });
    // Sam starts a thread in #random; Ada's reply notifies him as a thread reply, which is not a mention.
    const samRoot = await post(sam, randomId, "thread by sam");
    await post(ada, randomId, "answering in the thread", samRoot.id);
    const kinds = (
      await su.query("select kind from app.notifications where user_id = $1 and conversation_id = $2", [
        samId,
        randomId,
      ])
    ).rows.map((r) => r.kind);
    expect(kinds).toContain("thread_reply");
    expect((await countsOf(sam, randomId)).mentionCount).toBe(0);
    // A mention inside a thread reply belongs to the thread (Threads and Mentions views), not the channel badge.
    await post(ada, randomId, "@sam see above", samRoot.id);
    expect((await countsOf(sam, randomId)).mentionCount).toBe(0);
  });

  it("DMs and groups report the same fields: every DM message from the other person is a mention-like count", async () => {
    const dm = await ok(ada.request("POST", "/api/v1/dms", { participants: [{ kind: "user", id: samId }] }));
    await post(ada, dm.id, "hey Sam");
    await post(ada, dm.id, "are you there?");
    expect(await dmCountsOf(sam, dm.id)).toEqual({ unreadCount: 2, mentionCount: 2 });
    expect(await dmCountsOf(ada, dm.id)).toEqual({ unreadCount: 0, mentionCount: 0 });
    const group = await ok(
      ada.request("POST", "/api/v1/dms", {
        participants: [
          { kind: "user", id: samId },
          { kind: "user", id: alexId },
        ],
      }),
    );
    await post(alex, group.id, "group hello");
    expect(await dmCountsOf(sam, group.id)).toEqual({ unreadCount: 1, mentionCount: 1 });
    const d = (await ok(sam.request("GET", "/api/v1/dms"))).dms.find((x: Json) => x.id === dm.id);
    expect(d).toMatchObject({ notifyLevel: "default", muted: false });
  });
});

describe("reading clears counts and notifications on every device (Pitfall 2)", () => {
  it("POST /channels/:id/read: 0/0, conversation.read on user:<sam>, the mentions become read with notification.read", async () => {
    expect((await unreadNotifications(samId, generalId)).length).toBe(1);
    const seq = await latestSeq(generalId);
    await ok(read(sam, generalId, seq));
    expect(await countsOf(sam, generalId)).toEqual({ unreadCount: 0, mentionCount: 0 });
    const ev = (await events(samId, "conversation.read"))
      .filter((e) => e.conversationId === generalId)
      .at(-1);
    expect(ev).toMatchObject({
      conversationId: generalId,
      lastReadSeq: seq,
      unreadCount: 0,
      mentionCount: 0,
    });
    expect(await unreadNotifications(samId, generalId)).toEqual([]);
    const readEv = (await events(samId, "notification.read")).at(-1);
    expect(readEv?.ids).toHaveLength(1);
    expect(typeof readEv?.unreadCount).toBe("number");
  });

  it("reading part of a conversation clears only what was read", async () => {
    const a = await post(ada, generalId, "@sam first");
    const b = await post(ada, generalId, "@sam second");
    expect(await countsOf(sam, generalId)).toEqual({ unreadCount: 2, mentionCount: 2 });
    await ok(read(sam, generalId, a.seq));
    expect(await countsOf(sam, generalId)).toEqual({ unreadCount: 1, mentionCount: 1 });
    const left = await unreadNotifications(samId, generalId);
    expect(left.map((n) => n.message_id)).toEqual([b.id]);
  });

  it("re-reading an already-read edit-upgraded mention clears it (the cursor does not move, the mention does)", async () => {
    const seq = await latestSeq(generalId);
    await ok(read(sam, generalId, seq));
    const old = await post(ada, generalId, "plain words");
    await ok(read(sam, generalId, old.seq));
    await ok(ada.request("PATCH", `/api/v1/messages/${old.id}`, { body: "plain words @sam" }));
    expect(await countsOf(sam, generalId)).toEqual({ unreadCount: 0, mentionCount: 1 });
    await ok(read(sam, generalId, old.seq));
    expect(await countsOf(sam, generalId)).toEqual({ unreadCount: 0, mentionCount: 0 });
  });

  it("a read that changes nothing announces nothing", async () => {
    const before = (await events(samId, "conversation.read")).length;
    await ok(read(sam, generalId, 1));
    expect((await events(samId, "conversation.read")).length).toBe(before);
  });

  it("POST /conversations/:id/read on a DM: 0/0, conversation.read, dm notifications read", async () => {
    const dm = (await ok(sam.request("GET", "/api/v1/dms"))).dms.find(
      (x: Json) => x.counterpart.kind === "user" && x.counterpart.id === adaId,
    );
    await ok(sam.request("POST", `/api/v1/conversations/${dm.id}/read`, { seq: await latestSeq(dm.id) }));
    expect(await dmCountsOf(sam, dm.id)).toEqual({ unreadCount: 0, mentionCount: 0 });
    expect(await unreadNotifications(samId, dm.id)).toEqual([]);
    const ev = (await events(samId, "conversation.read")).filter((e) => e.conversationId === dm.id).at(-1);
    expect(ev).toMatchObject({ unreadCount: 0, mentionCount: 0 });
  });

  it("reading a thread clears that thread's notifications (replies and mentions in it)", async () => {
    const thread = (
      await su.query(
        "select distinct thread_root_id from app.notifications where user_id = $1 and conversation_id = $2 and thread_root_id is not null and read_at is null",
        [samId, randomId],
      )
    ).rows[0]?.thread_root_id as string;
    expect(thread).toBeTruthy();
    const last = Number(
      (await su.query("select max(seq) as n from app.messages where thread_id = $1", [thread])).rows[0].n,
    );
    await ok(sam.request("POST", `/api/v1/threads/${thread}/read`, { seq: last }));
    const left = (await unreadNotifications(samId, randomId)).filter((n) => n.thread_root_id === thread);
    expect(left).toEqual([]);
  });
});

describe("counts never leak (T-04-10-01)", () => {
  it("a public channel Sam has not joined reports 0/0, even with a mention of him in it", async () => {
    const lobby = await channel("lobby", "public");
    await post(ada, lobby, "@sam come join us");
    expect((await unreadNotifications(samId, lobby)).length).toBe(1);
    const c = await channelOf(sam, lobby);
    expect(c).toMatchObject({ isMember: false, unreadCount: 0, mentionCount: 0 });
  });

  it("a private channel Sam is not in is neither listed nor readable", async () => {
    const secret = await channel("secret", "private");
    await post(ada, secret, "quiet");
    expect(await channelOf(sam, secret)).toBeUndefined();
    await ok(read(sam, secret, 1), 404);
    await ok(sam.request("POST", `/api/v1/conversations/${secret}/read`, { seq: 1 }), 404);
  });

  it("org B: another organization's member gets 404 and none of these counts", async () => {
    await ok(read(eve, randomId, 1), 404);
    await ok(eve.request("POST", `/api/v1/conversations/${randomId}/read`, { seq: 1 }), 404);
    const theirs = await ok(eve.request("GET", "/api/v1/channels"));
    expect(theirs.channels.some((c: Json) => c.id === randomId || c.id === generalId)).toBe(false);
  });
});

describe("the Threads view counts every unread thread, not only the first page (04-08 open item)", () => {
  it("GET /threads?limit=2 reports unreadThreads over all of the member's threads; reading one drops it", async () => {
    const room = await channel("threads-room", "public", [sam]);
    const roots: Json[] = [];
    for (const i of [1, 2, 3]) {
      const r = await post(sam, room, `sam's topic ${i}`);
      await post(ada, room, `ada answers ${i}`, r.id);
      roots.push(r);
    }
    const page = await ok(sam.request("GET", "/api/v1/threads?limit=2"));
    expect(page.threads).toHaveLength(2);
    expect(page.unreadThreads).toBeGreaterThanOrEqual(3);
    const before = page.unreadThreads as number;
    const first = roots[0] as Json;
    const last = Number(
      (await su.query("select max(seq) as n from app.messages where thread_id = $1", [first.id])).rows[0].n,
    );
    await ok(sam.request("POST", `/api/v1/threads/${first.id}/read`, { seq: last }));
    expect((await ok(sam.request("GET", "/api/v1/threads?limit=2"))).unreadThreads).toBe(before - 1);
    // Later pages do not repeat the total.
    const next = await ok(
      sam.request("GET", `/api/v1/threads?limit=2&cursor=${encodeURIComponent(page.nextCursor)}`),
    );
    expect(next.unreadThreads).toBeUndefined();
  });
});
