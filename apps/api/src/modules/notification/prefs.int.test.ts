import { randomUUID } from "node:crypto";
import { badgeStyle, DEFAULT_NOTIFICATION_PREFS } from "@ocw/contracts";
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

async function channel(name: string, visibility: "public" | "private", joiners: TestClient[] = []) {
  const id = (await ok(ada.request("POST", "/api/v1/channels", { name, visibility }))).id as string;
  for (const j of joiners) await ok(j.request("POST", `/api/v1/channels/${id}/join`));
  return id;
}

beforeAll(async () => {
  stack = await startTestStack();
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
    expect(badgeStyle(row as Parameters<typeof badgeStyle>[0])).toBe("none");

    const m = await post(ada, designId, "@sam can you check them?");
    expect(await createdFor(m.id)).toMatchObject({ popup: false, notification: { kind: "mention" } });
    const list = await ok(sam.request("GET", "/api/v1/notifications?filter=mentions"));
    expect(list.items.map((n: Json) => n.messageId)).toContain(m.id);
    const after = await samRow(designId);
    expect(after.mentionCount).toBe(1);
    expect(badgeStyle(after as Parameters<typeof badgeStyle>[0])).toBe("mention");
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
