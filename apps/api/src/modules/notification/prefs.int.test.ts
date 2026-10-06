import { randomUUID } from "node:crypto";
import { badgeStyle, DEFAULT_NOTIFICATION_PREFS, type ServerFrame } from "@ocw/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";

/**
 * CHAT-10 (04-11, D-02): notification preferences against real PostgreSQL + Redis. The server decides `popup` once
 * per notification from the stored prefs (DND, default level) and the membership (level, mute); the inbox and the
 * mention counts never depend on them. Prefs and per-conversation settings belong to the caller only (T-04-11-04).
 */

let stack: TestStack;
let su: pg.Client;
let ada: TestClient;
let sam: TestClient;
let bob: TestClient;
let eve: TestClient; // a member of another organization
let samId: string;
let designId: string;

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

const settings = (as: TestClient, conv: string, body: unknown) =>
  as.request("PUT", `/api/v1/conversations/${conv}/notification-settings`, body);

async function events(userId: string, type: string): Promise<Json[]> {
  const res = await su.query(
    "select payload from app.stream_events where stream_id = $1 and type = $2 order by seq",
    [`user:${userId}`, type],
  );
  return res.rows.map((r) => r.payload);
}

/** The `notification.created` event Sam received for one message. */
async function createdFor(messageId: string): Promise<Json | undefined> {
  return (await events(samId, "notification.created")).find((e) => e.notification.messageId === messageId);
}

async function samRow(id: string): Promise<Json> {
  const list = await ok(sam.request("GET", "/api/v1/channels"));
  return list.channels.find((c: Json) => c.id === id);
}

/** The sidebar badge of a channel row (CHAT-09/10). */
const styleOf = (row: Json) =>
  badgeStyle({
    level: row.notifyLevel,
    muted: row.muted,
    unreadCount: row.unreadCount,
    mentionCount: row.mentionCount,
  });

async function channel(name: string, visibility: "public" | "private", joiners: TestClient[] = []) {
  const id = (await ok(ada.request("POST", "/api/v1/channels", { name, visibility }))).id as string;
  for (const j of joiners) await ok(j.request("POST", `/api/v1/channels/${id}/join`));
  return id;
}

beforeAll(async () => {
  // A model provider so a personal bot can be created (its DM replies are the 04-09 open item).
  stack = await startTestStack({ env: { OCW_MODEL_PROVIDER: "mock" } });
  su = new pg.Client({ connectionString: stack.db.superuserUrl });
  await su.connect();

  ada = new TestClient(stack.baseUrl);
  await ok(
    ada.request("POST", "/api/v1/setup", {
      token: TEST_SETUP_TOKEN,
      name: "Ada Lovelace",
      email: "ada@example.test",
      password: "correct-horse-battery",
      orgName: "Autofy Labs",
    }),
  );
  [sam, samId] = await joinAs("sam@example.test", "Sam Lee");
  [bob] = await joinAs("bob@example.test", "Bob Stone");

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

  designId = await channel("design", "public", [sam]);
}, 240_000);

afterAll(async () => {
  await su?.end();
  await stack?.stop();
});

describe("mute (CHAT-10 tracer)", () => {
  it("GET /notification-prefs returns the defaults while the member has no row", async () => {
    expect(await ok(sam.request("GET", "/api/v1/notification-prefs"))).toEqual(DEFAULT_NOTIFICATION_PREFS);
    const rows = await su.query("select 1 from app.notification_prefs where user_id = $1", [samId]);
    expect(rows.rowCount).toBe(0);
  });

  it("muting #design answers the settings and tells Sam's other tabs on user:<sam>", async () => {
    const res = await ok(settings(sam, designId, { muted: true }));
    expect(res).toEqual({ level: "default", muted: true });
    const ev = (await events(samId, "notification_prefs.updated")).at(-1);
    expect(ev).toEqual({ conversationId: designId, settings: { level: "default", muted: true } });
  });

  it("a plain message in muted #design shows no badge; a mention still lands in the inbox without a pop-up", async () => {
    await post(ada, designId, "new icons are up");
    const row = await samRow(designId);
    expect(row).toMatchObject({ muted: true, notifyLevel: "default", mentionCount: 0 });
    expect(styleOf(row)).toBe("none");

    const m = await post(ada, designId, "@sam can you check them?");
    expect(await createdFor(m.id)).toMatchObject({ popup: false, notification: { kind: "mention" } });
    const list = await ok(sam.request("GET", "/api/v1/notifications?filter=mentions"));
    expect(list.items.map((n: Json) => n.messageId)).toContain(m.id);
    const after = await samRow(designId);
    expect(after.mentionCount).toBe(1);
    expect(styleOf(after)).toBe("mention");
  });

  it("unmuting makes the next mention pop up", async () => {
    expect(await ok(settings(sam, designId, { muted: false }))).toEqual({ level: "default", muted: false });
    const m = await post(ada, designId, "@sam one more");
    expect(await createdFor(m.id)).toMatchObject({ popup: true });
  });

  it("a member who has not joined gets 409 not_a_member; nothing changes", async () => {
    const r = await settings(bob, designId, { muted: true });
    expect(r.status).toBe(409);
    expect((r.body as Json).error.code).toBe("not_a_member");
  });

  it("a hidden conversation and another organization get 404", async () => {
    const secret = await channel(`secret-${randomUUID().slice(0, 6)}`, "private");
    expect((await settings(sam, secret, { muted: true })).status).toBe(404);
    expect((await settings(eve, designId, { muted: true })).status).toBe(404);
    expect((await settings(sam, randomUUID(), { muted: true })).status).toBe(404);
    const muted = await su.query(
      "select count(*)::int as n from app.conversation_members where conversation_id = $1 and muted",
      [secret],
    );
    expect(muted.rows[0].n).toBe(0);
  });

  it("invalid bodies are 400", async () => {
    expect((await settings(sam, designId, {})).status).toBe(400);
    expect((await settings(sam, designId, { level: "loud" })).status).toBe(400);
    expect((await sam.request("PUT", "/api/v1/notification-prefs", {})).status).toBe(400);
    expect((await sam.request("PUT", "/api/v1/notification-prefs", { defaultLevel: "loud" })).status).toBe(
      400,
    );
  });
});

/** Ephemeral frames Sam's `user:` stream carries while `fn` runs (they are never stored). */
async function ephemeralFor(userId: string, fn: () => Promise<void>): Promise<Json[]> {
  const frames: ServerFrame[] = [];
  const off = await stack.built.core.realtime.listen(`user:${userId}`, (f) => frames.push(f));
  try {
    await fn();
    await new Promise((r) => setTimeout(r, 400));
  } finally {
    await off();
  }
  return frames.filter((f) => f.op === "eph").map((f) => f as Json);
}

const prefs = (as: TestClient, body: unknown) => ok(as.request("PUT", "/api/v1/notification-prefs", body));
const hourFromNow = () => new Date(Date.now() + 3_600_000).toISOString();

describe("do not disturb, levels and level-all events (CHAT-10)", () => {
  let room: string;
  const fresh = async () => {
    room = await channel(`room-${randomUUID().slice(0, 6)}`, "public", [sam]);
    return room;
  };

  it("DND silences every new notification until it passes, and is announced to Sam's devices", async () => {
    await fresh();
    const until = hourFromNow();
    expect(await prefs(sam, { dndUntil: until })).toMatchObject({ dndUntil: until });
    expect((await events(samId, "notification_prefs.updated")).at(-1)).toMatchObject({
      prefs: { dndUntil: until, defaultLevel: "mentions" },
    });
    expect(await ok(sam.request("GET", "/api/v1/notification-prefs"))).toMatchObject({ dndUntil: until });
    const quiet = await post(ada, room, "@sam during focus time");
    expect(await createdFor(quiet.id)).toMatchObject({ popup: false });
    // A DM too: DND wins over every level.
    const dm = await ok(ada.request("POST", "/api/v1/dms", { participants: [{ kind: "user", id: samId }] }));
    const dmQuiet = await post(ada, dm.id, "ping");
    expect(await createdFor(dmQuiet.id)).toMatchObject({ popup: false });

    await prefs(sam, { dndUntil: new Date(Date.now() - 1_000).toISOString() });
    const loud = await post(ada, room, "@sam focus time is over");
    expect(await createdFor(loud.id)).toMatchObject({ popup: true });
    await prefs(sam, { dndUntil: null });
  });

  it("mentions only: a dot badge; mentions, @channel and thread replies pop, plain messages do not", async () => {
    await fresh();
    expect(await ok(settings(sam, room, { level: "mentions" }))).toEqual({ level: "mentions", muted: false });
    const eph = await ephemeralFor(samId, async () => {
      await post(ada, room, "plain update");
    });
    expect(eph.filter((f) => f.type === "message.notify")).toEqual([]);
    const row = await samRow(room);
    expect(row).toMatchObject({ notifyLevel: "mentions", unreadCount: 1, mentionCount: 0 });
    expect(styleOf(row)).toBe("dot");

    const m = await post(ada, room, "@sam a mention");
    expect(await createdFor(m.id)).toMatchObject({ popup: true });
    const all = await post(ada, room, "@channel heads up");
    expect(await createdFor(all.id)).toMatchObject({ popup: true, notification: { kind: "channel" } });
    const root = await post(sam, room, "my question");
    const reply = await post(ada, room, "an answer", root.id);
    expect(await createdFor(reply.id)).toMatchObject({ popup: true, notification: { kind: "thread_reply" } });
  });

  it("nothing: never pops, but still records the row and counts the mention", async () => {
    await fresh();
    await ok(settings(sam, room, { level: "nothing" }));
    const m = await post(ada, room, "@sam still counts");
    expect(await createdFor(m.id)).toMatchObject({ popup: false });
    const row = await samRow(room);
    expect(row.mentionCount).toBe(1);
    const list = await ok(sam.request("GET", "/api/v1/notifications?filter=mentions"));
    expect(list.items.map((n: Json) => n.messageId)).toContain(m.id);
  });

  it("all: each plain top-level message from someone else is an ephemeral message.notify, never a stored event", async () => {
    await fresh();
    await ok(settings(sam, room, { level: "all" }));
    let plain: Json = {};
    let mention: Json = {};
    const eph = await ephemeralFor(samId, async () => {
      plain = await post(ada, room, "**ship** it today");
      mention = await post(ada, room, "@sam and you review it");
      const root = await post(sam, room, "my own message");
      await post(ada, room, "a reply in a thread", root.id);
    });
    const notify = eph.filter((f) => f.type === "message.notify");
    expect(notify).toHaveLength(1);
    expect(notify[0]).toMatchObject({
      topic: `user:${samId}`,
      data: {
        conversation: { id: room, kind: "channel", label: expect.stringContaining("room-") },
        messageId: plain.id,
        actor: { kind: "user", displayName: "Ada Lovelace" },
        snippet: "ship it today",
      },
    });
    // The mention got its own notification (and pops); no second, ephemeral one.
    expect(await createdFor(mention.id)).toMatchObject({ popup: true });
    const stored = await su.query(
      "select count(*)::int as n from app.stream_events where type = 'message.notify'",
    );
    expect(stored.rows[0].n).toBe(0);
  });

  it("all: nothing while muted or in DND, and nothing for people who did not opt in", async () => {
    await fresh();
    await ok(settings(sam, room, { level: "all", muted: true }));
    let eph = await ephemeralFor(samId, async () => {
      await post(ada, room, "muted plain");
    });
    expect(eph.filter((f) => f.type === "message.notify")).toEqual([]);

    await ok(settings(sam, room, { muted: false }));
    await prefs(sam, { dndUntil: hourFromNow() });
    eph = await ephemeralFor(samId, async () => {
      await post(ada, room, "dnd plain");
    });
    expect(eph.filter((f) => f.type === "message.notify")).toEqual([]);
    await prefs(sam, { dndUntil: null });

    // Bob is in the channel on the default level (mentions): no message.notify for him.
    await ok(bob.request("POST", `/api/v1/channels/${room}/join`));
    const bobId = (await ok(bob.request("GET", "/api/v1/me"))).user.id as string;
    eph = await ephemeralFor(bobId, async () => {
      await post(ada, room, "for everyone");
    });
    expect(eph.filter((f) => f.type === "message.notify")).toEqual([]);
  });

  it("a default level of all makes channels on default behave as all", async () => {
    await fresh();
    expect(await prefs(sam, { defaultLevel: "all" })).toMatchObject({ defaultLevel: "all" });
    let plain: Json = {};
    const eph = await ephemeralFor(samId, async () => {
      plain = await post(ada, room, "default is loud now");
    });
    expect(eph.filter((f) => f.type === "message.notify").map((f) => f.data.messageId)).toEqual([plain.id]);
    await prefs(sam, { defaultLevel: "mentions" });
  });

  it("DMs on default always notify, whatever the default channel level", async () => {
    await prefs(sam, { defaultLevel: "nothing" });
    const dm = await ok(ada.request("POST", "/api/v1/dms", { participants: [{ kind: "user", id: samId }] }));
    const m = await post(ada, dm.id, "are you around?");
    expect(await createdFor(m.id)).toMatchObject({ popup: true, notification: { kind: "dm" } });
    await prefs(sam, { defaultLevel: "mentions" });
  });

  it("a bot's replies in Sam's own bot DM stay quiet by default (still in the inbox); a mention or level all pops", async () => {
    const created = await ok(sam.request("POST", "/api/v1/agents/personal", {}));
    const botId = created.agent.id as string;
    const dmId = created.dmId as string;
    const reply = (body: string) =>
      ok(
        ada.request("POST", "/api/v1/test/chat/agent-reply", {
          agentId: botId,
          conversationId: dmId,
          body,
          idempotencyKey: randomUUID(),
        }),
      );
    const quiet = await reply("Here is the summary you asked for.");
    expect(await createdFor(quiet.messageId)).toMatchObject({
      popup: false,
      notification: { kind: "dm", actor: { kind: "agent", id: botId } },
    });
    const loud = await reply("@sam the build failed, you may want to look");
    expect(await createdFor(loud.messageId)).toMatchObject({
      popup: true,
      notification: { kind: "mention" },
    });
    await ok(settings(sam, dmId, { level: "all" }));
    const opted = await reply("Another update.");
    expect(await createdFor(opted.messageId)).toMatchObject({ popup: true });
  });
});
