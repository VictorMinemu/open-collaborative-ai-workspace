import { randomUUID } from "node:crypto";
import { WS_AUTH_PROTOCOL_PREFIX, WS_PROTOCOL } from "@ocw/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack, WEB_ORIGIN } from "../../testing";
import { startTestStorage, type TestStorage } from "../../testing-storage";

/**
 * 04-07 Task 3 (D-01, P-03, T-04-07-01/06): only participants read a DM or a group DM. A non-participant admin
 * of the same organization, and another organization's admin, get the same bare 404 on every Phase 4 path that
 * can touch one (messages, threads, permalinks, edits, deletes, reactions, pins, saves, attachments, read
 * markers, channel routes) and see nothing in lists (DMs, Saved, search) or on the realtime `conv:` topic. The
 * participants keep full access. Real PostgreSQL + Redis + Garage.
 */

let storage: TestStorage;
let stack: TestStack;
let su: pg.Client;
let admin: TestClient;
let sam: TestClient;
let alex: TestClient;
let eve: TestClient; // admin of another organization
let orgId: string;
let setupAdminId: string;
let samId: string;
let alexId: string;
let helperId: string;

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
type Json = Record<string, any>;

/** A 1×1 PNG. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
const THUMBS = encodeURIComponent("👍");
const EYES = encodeURIComponent("👀");

async function ok(res: Promise<{ status: number; body: Record<string, unknown> | null }>, status = 200) {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as Json;
}

async function joinAs(email: string, name: string) {
  const inv = await ok(admin.request("POST", "/api/v1/invitations", { email, role: "developer" }));
  const c = new TestClient(stack.baseUrl);
  const acc = await ok(
    c.request("POST", `/api/v1/invitations/${inv.id}/accept`, { name, password: "another-long-password" }),
  );
  return [c, acc.user.id as string] as const;
}

/** A request that does not follow redirects (attachment routes answer 302). */
async function raw(client: TestClient, method: string, path: string) {
  const res = await fetch(`${stack.baseUrl}${path}`, {
    method,
    redirect: "manual",
    headers: { origin: WEB_ORIGIN, cookie: client.cookieHeader },
  });
  const text = await res.text();
  return { status: res.status, text };
}

/** Authenticated /ws socket that records every frame it receives. */
async function socketFor(client: TestClient) {
  const token = await client.token();
  const ws = new WebSocket(
    `${stack.baseUrl.replace("http", "ws")}/ws`,
    [WS_PROTOCOL, `${WS_AUTH_PROTOCOL_PREFIX}${token}`],
    { headers: { origin: WEB_ORIGIN } },
  );
  const frames: Json[] = [];
  ws.on("message", (data) => frames.push(JSON.parse(String(data)) as Json));
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  const waitFor = async (pred: (f: Json) => boolean, ms = 3000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const hit = frames.find(pred);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`no matching frame (got ${JSON.stringify(frames)})`);
  };
  return { ws, frames, waitFor };
}

/** Everything one direct conversation holds, created by its participants. */
interface Seeded {
  label: string;
  convId: string;
  /** A unique word in the first message (search must never find it for outsiders). */
  word: string;
  messageId: string;
  replyId: string;
  attachmentId: string;
}

async function seed(label: string, convId: string): Promise<Seeded> {
  const word = `zq${label}${randomUUID()
    .slice(0, 8)
    .replace(/[0-9-]/g, "x")}`;
  const m1 = await ok(
    sam.request("POST", `/api/v1/conversations/${convId}/messages`, { body: `the ${word} plan is ready` }),
  );
  const m2 = await ok(
    alex.request("POST", `/api/v1/conversations/${convId}/messages`, { body: "great, ship it" }),
  );
  await ok(alex.request("PUT", `/api/v1/messages/${m1.id}/reactions/${THUMBS}`));
  await ok(sam.request("PUT", `/api/v1/conversations/${convId}/pins/${m1.id}`));
  await ok(sam.request("PUT", `/api/v1/messages/${m1.id}/save`));
  const presign = await ok(
    sam.request("POST", `/api/v1/conversations/${convId}/attachments`, {
      filename: `${word}.png`,
      contentType: "image/png",
      size: PNG.length,
    }),
  );
  const put = await fetch(presign.upload.url, { method: "PUT", headers: presign.upload.headers, body: PNG });
  expect(put.status).toBe(200);
  await ok(sam.request("POST", `/api/v1/attachments/${presign.attachment.id}/complete`));
  // Linked to the message as Plan 04-12 will do on send, so every participant may open it.
  await su.query("update app.attachments set message_id = $1 where id = $2", [m1.id, presign.attachment.id]);
  return { label, convId, word, messageId: m1.id, replyId: m2.id, attachmentId: presign.attachment.id };
}

/**
 * Every Phase 4 route that can touch a direct conversation, as (method, path, body?) for one seeded
 * conversation. The inbox (Plan 09) is not a per-conversation route: `expectAbsentFromLists` covers
 * `GET /notifications`, and "the inbox" cases below cover `POST /notifications/read`.
 */
function routesFor(s: Seeded): Array<{
  name: string;
  method: string;
  path: string;
  body?: Json;
  raw?: true;
  /** What a non-participant gets: always a bare 404 (hidden = missing). */
  outsider: 404;
}> {
  const c = s.convId;
  const m = s.messageId;
  const a = s.attachmentId;
  return [
    {
      outsider: 404,
      name: "GET messages (latest)",
      method: "GET",
      path: `/api/v1/conversations/${c}/messages`,
    },
    {
      outsider: 404,
      name: "GET messages (around)",
      method: "GET",
      path: `/api/v1/conversations/${c}/messages?around=${m}`,
    },
    {
      outsider: 404,
      name: "GET messages (after)",
      method: "GET",
      path: `/api/v1/conversations/${c}/messages?after=0`,
    },
    { outsider: 404, name: "GET thread", method: "GET", path: `/api/v1/messages/${m}/thread` },
    {
      outsider: 404,
      name: "POST message",
      method: "POST",
      path: `/api/v1/conversations/${c}/messages`,
      body: { body: "hi" },
    },
    {
      outsider: 404,
      name: "PATCH message",
      method: "PATCH",
      path: `/api/v1/messages/${m}`,
      body: { body: "edited by admin" },
    },
    { outsider: 404, name: "DELETE message", method: "DELETE", path: `/api/v1/messages/${m}` },
    { outsider: 404, name: "PUT reaction", method: "PUT", path: `/api/v1/messages/${m}/reactions/${EYES}` },
    {
      outsider: 404,
      name: "DELETE reaction",
      method: "DELETE",
      path: `/api/v1/messages/${m}/reactions/${THUMBS}`,
    },
    { outsider: 404, name: "GET pins", method: "GET", path: `/api/v1/conversations/${c}/pins` },
    { outsider: 404, name: "PUT pin", method: "PUT", path: `/api/v1/conversations/${c}/pins/${s.replyId}` },
    { outsider: 404, name: "DELETE pin", method: "DELETE", path: `/api/v1/conversations/${c}/pins/${m}` },
    { outsider: 404, name: "PUT save", method: "PUT", path: `/api/v1/messages/${m}/save` },
    { outsider: 404, name: "DELETE save", method: "DELETE", path: `/api/v1/messages/${m}/save` },
    {
      outsider: 404,
      name: "POST read marker",
      method: "POST",
      path: `/api/v1/conversations/${c}/read`,
      body: { seq: 1 },
    },
    {
      outsider: 404,
      name: "presign upload",
      method: "POST",
      path: `/api/v1/conversations/${c}/attachments`,
      body: { filename: "x.png", contentType: "image/png", size: PNG.length },
    },
    { outsider: 404, name: "complete upload", method: "POST", path: `/api/v1/attachments/${a}/complete` },
    {
      outsider: 404,
      name: "attachment preview",
      method: "GET",
      path: `/api/v1/attachments/${a}/preview`,
      raw: true,
    },
    {
      outsider: 404,
      name: "attachment large",
      method: "GET",
      path: `/api/v1/attachments/${a}/large`,
      raw: true,
    },
    {
      outsider: 404,
      name: "attachment download",
      method: "GET",
      path: `/api/v1/attachments/${a}/download`,
      raw: true,
    },
    { outsider: 404, name: "GET channel", method: "GET", path: `/api/v1/channels/${c}` },
    { outsider: 404, name: "GET channel members", method: "GET", path: `/api/v1/channels/${c}/members` },
    {
      outsider: 404,
      name: "POST channel member",
      method: "POST",
      path: `/api/v1/channels/${c}/members`,
      body: { kind: "user", id: samId },
    },
    { outsider: 404, name: "POST join", method: "POST", path: `/api/v1/channels/${c}/join` },
  ];
}

/** 404 with no details, and nothing of the conversation in the body. */
async function expectHidden(client: TestClient, s: Seeded) {
  for (const r of routesFor(s)) {
    const res = r.raw
      ? await raw(client, r.method, r.path)
      : await client.request(r.method, r.path, r.body).then((x) => ({
          status: x.status,
          text: JSON.stringify(x.body),
        }));
    expect(res.status, `${s.label}: ${r.name}`).toBe(r.outsider);
    expect(res.text, `${s.label}: ${r.name}`).not.toContain(s.word);
    expect(res.text, `${s.label}: ${r.name}`).not.toContain('"details"');
    expect(res.text, `${s.label}: ${r.name}`).not.toMatch(/Sam Lee|Alex Kim/);
  }
}

/** The caller's lists (DMs, Saved, search) never surface `s`. */
async function expectAbsentFromLists(client: TestClient, s: Seeded) {
  const dms = (await ok(client.request("GET", "/api/v1/dms"))).dms as Json[];
  expect(
    dms.some((d) => d.id === s.convId),
    `${s.label}: GET /dms`,
  ).toBe(false);
  const saved = await ok(client.request("GET", "/api/v1/saved"));
  expect(JSON.stringify(saved), `${s.label}: GET /saved`).not.toContain(s.convId);
  const hits = await ok(client.request("GET", `/api/v1/search/messages?q=${s.word}`));
  expect(hits.hits, `${s.label}: search`).toEqual([]);
  const inConv = await ok(client.request("GET", `/api/v1/search/messages?q=${s.word}&in=${s.convId}`));
  expect(inConv.hits, `${s.label}: search in`).toEqual([]);
  const overview = await ok(client.request("GET", `/api/v1/search?q=${s.word}`));
  expect(overview.messages, `${s.label}: overview`).toEqual([]);
  // The inbox (CHAT-08): both filters, and the unread count, never come from someone else's conversation.
  for (const filter of ["all", "mentions"]) {
    const inbox = await ok(client.request("GET", `/api/v1/notifications?filter=${filter}`));
    expect(JSON.stringify(inbox), `${s.label}: GET /notifications ${filter}`).not.toContain(s.convId);
    expect(JSON.stringify(inbox), `${s.label}: GET /notifications ${filter}`).not.toContain(s.word);
    expect(inbox.unreadCount, `${s.label}: inbox count ${filter}`).toBe(0);
  }
  for (const q of ["sam", "alex", "helper", "lee"]) {
    const channels = await ok(client.request("GET", `/api/v1/search/channels?q=${q}`));
    expect(JSON.stringify(channels), `${s.label}: search channels ${q}`).not.toContain(s.convId);
  }
}

/** A `sub` to `conv:<id>` is refused and no event of the conversation ever arrives. */
async function expectNoRealtime(client: TestClient, s: Seeded) {
  const owner = await socketFor(sam);
  const spy = await socketFor(client);
  try {
    owner.ws.send(JSON.stringify({ op: "sub", topic: `conv:${s.convId}` }));
    await owner.waitFor((f) => f.op === "subscribed" && f.topic === `conv:${s.convId}`);
    spy.ws.send(JSON.stringify({ op: "sub", topic: `conv:${s.convId}`, afterSeq: 0 }));
    expect(await spy.waitFor((f) => f.op === "err")).toMatchObject({
      op: "err",
      code: "forbidden",
      topic: `conv:${s.convId}`,
    });
    const live = `live ${s.word} update`;
    await ok(sam.request("POST", `/api/v1/conversations/${s.convId}/messages`, { body: live }));
    await owner.waitFor((f) => f.op === "ev" && JSON.stringify(f).includes(live));
    await new Promise((r) => setTimeout(r, 300));
    expect(spy.frames.some((f) => f.topic === `conv:${s.convId}` && f.op !== "err")).toBe(false);
    expect(JSON.stringify(spy.frames)).not.toContain(s.word);
  } finally {
    owner.ws.close();
    spy.ws.close();
  }
}

let human: Seeded;
let group: Seeded;

beforeAll(async () => {
  storage = await startTestStorage();
  stack = await startTestStack({ env: { ...storage.env, OCW_MODEL_PROVIDER: "mock" } });
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
  setupAdminId = setup.user.id;
  [sam, samId] = await joinAs("sam@example.test", "Sam Lee");
  [alex, alexId] = await joinAs("alex@example.test", "Alex Kim");
  helperId = (
    await ok(
      admin.request("POST", "/api/v1/agents", {
        name: "Helper",
        username: "helper",
        instructions: "You are Helper.",
        modelProvider: "mock",
        modelId: "mock-1",
      }),
    )
  ).id;

  // Eve: an admin of another organization, with a real session there (joined org A, then moved by the
  // superuser, then signed in again so her session's active organization is org B).
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
  const eveMe = await ok(eve.request("GET", "/api/v1/me"));
  expect(eveMe.organization.id).toBe(orgB);
  expect(eveMe.organization.id).not.toBe(orgId);
  expect(eveMe.organization.role).toBe("admin");

  const dm = await ok(sam.request("POST", "/api/v1/dms", { participants: [{ kind: "user", id: alexId }] }));
  const grp = await ok(
    sam.request("POST", "/api/v1/dms", {
      participants: [
        { kind: "user", id: alexId },
        { kind: "agent", id: helperId },
      ],
    }),
  );
  human = await seed("dm", dm.id);
  group = await seed("group", grp.id);
}, 240_000);

afterAll(async () => {
  await su?.end();
  await stack?.stop();
  await storage?.stop();
});

describe("a non-participant admin of the same organization (D-01)", () => {
  it("gets a bare 404 on every route of a human DM", async () => {
    await expectHidden(admin, human);
  });

  it("gets a bare 404 on every route of a group DM", async () => {
    await expectHidden(admin, group);
  });

  it("never finds them in GET /dms, GET /saved or search", async () => {
    await expectAbsentFromLists(admin, human);
    await expectAbsentFromLists(admin, group);
  });

  it("is refused on the conv: topic and receives no event (human DM and group)", async () => {
    await expectNoRealtime(admin, human);
    await expectNoRealtime(admin, group);
  });

  it("changed nothing: no message, edit, reaction, pin, save or member came from the attempts", async () => {
    for (const s of [human, group]) {
      const bodies = (
        await su.query("select body, deleted_at from app.messages where conversation_id = $1", [s.convId])
      ).rows as Json[];
      expect(bodies.some((b) => b.body === "hi" || b.body === "edited by admin")).toBe(false);
      expect(bodies.every((b) => b.deleted_at === null)).toBe(true);
      const reactions = (
        await su.query("select emoji from app.message_reactions where message_id = $1", [s.messageId])
      ).rows.map((r) => r.emoji);
      expect(reactions).toEqual(["👍"]);
      const pins = (
        await su.query("select message_id from app.message_pins where conversation_id = $1", [s.convId])
      ).rows;
      expect(pins).toEqual([{ message_id: s.messageId }]);
      const members = (
        await su.query("select count(*)::int as n from app.conversation_members where conversation_id = $1", [
          s.convId,
        ])
      ).rows[0].n;
      expect(members).toBe(s === human ? 2 : 3);
    }
  });
});

describe("another organization's admin (T-04-07-06)", () => {
  it("gets the same bare 404s on both conversations", async () => {
    await expectHidden(eve, human);
    await expectHidden(eve, group);
  });

  it("finds nothing in lists or search and is refused on the conv: topic", async () => {
    await expectAbsentFromLists(eve, human);
    await expectAbsentFromLists(eve, group);
    await expectNoRealtime(eve, group);
  });
});

describe("the participants keep full access", () => {
  it("read messages (latest, around, after), the thread view, pins, Saved and search", async () => {
    for (const s of [human, group]) {
      for (const who of [sam, alex]) {
        const page = await ok(who.request("GET", `/api/v1/conversations/${s.convId}/messages`));
        expect(page.messages.map((m: Json) => m.id)).toContain(s.messageId);
        await ok(who.request("GET", `/api/v1/conversations/${s.convId}/messages?around=${s.messageId}`));
        await ok(who.request("GET", `/api/v1/conversations/${s.convId}/messages?after=0`));
        const thread = await ok(who.request("GET", `/api/v1/messages/${s.messageId}/thread`));
        expect(thread.root.id).toBe(s.messageId);
        expect(thread.replies).toEqual([]);
        const pins = await ok(who.request("GET", `/api/v1/conversations/${s.convId}/pins`));
        expect(pins.pins.map((p: Json) => p.message.id)).toEqual([s.messageId]);
        const hits = await ok(who.request("GET", `/api/v1/search/messages?q=${s.word}`));
        expect(hits.hits.map((h: Json) => h.messageId)).toContain(s.messageId);
        const dms = (await ok(who.request("GET", "/api/v1/dms"))).dms as Json[];
        expect(dms.some((d) => d.id === s.convId)).toBe(true);
      }
      const saved = await ok(sam.request("GET", "/api/v1/saved"));
      expect(JSON.stringify(saved)).toContain(s.messageId);
    }
  });

  it("react, pin, save, mark read, upload and open the attachment", async () => {
    for (const s of [human, group]) {
      await ok(sam.request("PUT", `/api/v1/messages/${s.messageId}/reactions/${EYES}`));
      await ok(alex.request("PUT", `/api/v1/conversations/${s.convId}/pins/${s.replyId}`));
      await ok(alex.request("PUT", `/api/v1/messages/${s.replyId}/save`));
      await ok(alex.request("POST", `/api/v1/conversations/${s.convId}/read`, { seq: 1 }));
      await ok(
        alex.request("POST", `/api/v1/conversations/${s.convId}/attachments`, {
          filename: "y.png",
          contentType: "image/png",
          size: PNG.length,
        }),
      );
      for (const who of [sam, alex]) {
        expect((await raw(who, "GET", `/api/v1/attachments/${s.attachmentId}/download`)).status).toBe(302);
        expect((await raw(who, "GET", `/api/v1/attachments/${s.attachmentId}/preview`)).status).toBe(302);
      }
    }
  });

  it("subscribe to conv: and edit and delete their own messages", async () => {
    const socket = await socketFor(alex);
    try {
      socket.ws.send(JSON.stringify({ op: "sub", topic: `conv:${group.convId}` }));
      await socket.waitFor((f) => f.op === "subscribed" && f.topic === `conv:${group.convId}`);
    } finally {
      socket.ws.close();
    }
    for (const s of [human, group]) {
      await ok(sam.request("PATCH", `/api/v1/messages/${s.messageId}`, { body: `the ${s.word} plan, v2` }));
      await ok(alex.request("DELETE", `/api/v1/messages/${s.replyId}`));
    }
  });
});

describe("the inbox (CHAT-08, T-04-09-01/05)", () => {
  it("participants are notified of each other's messages; outsiders' inboxes stay empty", async () => {
    const alexInbox = await ok(alex.request("GET", "/api/v1/notifications?filter=all"));
    const kinds = new Set(
      (alexInbox.items as Json[])
        .filter((n) => n.messageId === human.messageId || n.messageId === group.messageId)
        .map((n) => n.kind),
    );
    expect(kinds).toEqual(new Set(["dm", "group_dm"]));
    for (const outsider of [admin, eve]) {
      const list = await ok(outsider.request("GET", "/api/v1/notifications?filter=all"));
      expect(JSON.stringify(list)).not.toContain(human.convId);
      expect(JSON.stringify(list)).not.toContain(group.convId);
    }
  });

  it("marking someone else's notification read changes nothing (200, same count, no event)", async () => {
    const [row] = (
      await su.query(
        "select id from app.notifications where user_id = $1 and message_id = $2 and read_at is null",
        [alexId, human.messageId],
      )
    ).rows as Json[];
    expect(row?.id).toBeTruthy();
    const before = await ok(alex.request("GET", "/api/v1/notifications?filter=all"));
    const events = async (userId: string) =>
      Number(
        (
          await su.query(
            "select count(*)::int as n from app.stream_events where stream_id = $1 and type = 'notification.read'",
            [`user:${userId}`],
          )
        ).rows[0].n,
      );
    const adminEvents = await events(setupAdminId);
    for (const outsider of [admin, eve]) {
      await ok(outsider.request("POST", "/api/v1/notifications/read", { ids: [row?.id] }));
      await ok(outsider.request("POST", "/api/v1/notifications/read", { all: true }));
    }
    const [after] = (await su.query("select read_at from app.notifications where id = $1", [row?.id]))
      .rows as Json[];
    expect(after?.read_at).toBeNull();
    expect((await ok(alex.request("GET", "/api/v1/notifications?filter=all"))).unreadCount).toBe(
      before.unreadCount,
    );
    expect(await events(setupAdminId)).toBe(adminEvents);
  });
});
