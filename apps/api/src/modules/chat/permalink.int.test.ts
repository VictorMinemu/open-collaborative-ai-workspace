import { randomUUID } from "node:crypto";
import type { FastifyRequest } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";
import { createConversationAccess } from "./index";
import { getMessage } from "./service";

/**
 * CHAT-14 / CHAT-13 (04-03): permalink pages over the seq cursor. `around=<id>` centres a page on a top-level
 * message (a thread reply resolves to its root), `after=<seq>` pages forward until the live end. Hidden and
 * missing are indistinguishable (404, no details). Real PostgreSQL + Redis.
 */

let stack: TestStack;
let su: pg.Client;
let admin: TestClient;
let sam: TestClient;
let orgId: string;
let samId: string;
let channelId: string;
let otherChannelId: string;
let privateChannelId: string;
let privateMessageId: string;
let otherMessageId: string;
let replyId: string;
/** history[n] = the message "#n" (1-based; index 0 unused). */
const history: Array<{ id: string; seq: number }> = [];

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
type Json = Record<string, any>;

async function ok(res: Promise<{ status: number; body: Record<string, unknown> | null }>, status = 200) {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as Json;
}

const post = (as: TestClient, conv: string, body: string, extra: Json = {}) =>
  ok(as.request("POST", `/api/v1/conversations/${conv}/messages`, { body, ...extra }));
const page = (as: TestClient, conv: string, query: string) =>
  as.request("GET", `/api/v1/conversations/${conv}/messages?${query}`);
const bodies = (p: Json) => (p.messages as Json[]).map((m) => m.body);
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `#${from + i}`);

async function joinAs(email: string, name: string, role: "developer" | "standard") {
  const inv = await ok(admin.request("POST", "/api/v1/invitations", { email, role }));
  const c = new TestClient(stack.baseUrl);
  const acc = await ok(
    c.request("POST", `/api/v1/invitations/${inv.id}/accept`, { name, password: "another-long-password" }),
  );
  return [c, acc.user.id as string] as const;
}

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
  [sam, samId] = await joinAs("sam@example.test", "Sam Lee", "developer");

  channelId = (await ok(admin.request("POST", "/api/v1/channels", { name: "history" }))).id;
  await ok(sam.request("POST", `/api/v1/channels/${channelId}/join`));
  history.push({ id: "", seq: 0 });
  for (let n = 1; n <= 120; n++) {
    const m = await post(admin, channelId, `#${n}`);
    history.push({ id: m.id, seq: m.seq });
    // A thread on #40, so the stream has non-message events and replies between top-level messages.
    if (n === 40) replyId = (await post(sam, channelId, "reply to #40", { threadRootId: m.id })).id;
  }

  otherChannelId = (await ok(admin.request("POST", "/api/v1/channels", { name: "elsewhere" }))).id;
  otherMessageId = (await post(admin, otherChannelId, "not in history")).id;
  privateChannelId = (
    await ok(admin.request("POST", "/api/v1/channels", { name: "board", visibility: "private" }))
  ).id;
  privateMessageId = (await post(admin, privateChannelId, "salary review")).id;
}, 180_000);

afterAll(async () => {
  await su?.end();
  await stack?.stop();
});

describe("GET /conversations/:id/messages?around= (CHAT-14)", () => {
  it("centres the page: floor(limit/2) older, the anchor, the rest newer, with both cursors", async () => {
    const p = await ok(page(sam, channelId, `around=${history[30]?.id}&limit=50`));
    expect(bodies(p)).toEqual(range(5, 54));
    expect(p.anchorId).toBe(history[30]?.id);
    expect(p.threadRootId ?? null).toBeNull();
    expect(p.nextBefore).toBe(history[5]?.seq);
    expect(p.nextAfter).toBe(history[54]?.seq);
    expect(p.lastSeq).toEqual(expect.any(Number));
    expect(p.lastSeq).toBeGreaterThanOrEqual(history[120]?.seq ?? Number.POSITIVE_INFINITY);
    // Ascending seq, top-level only.
    const seqs = (p.messages as Json[]).map((m) => m.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect((p.messages as Json[]).every((m) => m.threadId === null)).toBe(true);
    // The thread root carries its reply participants like the tail page does.
    const root = (p.messages as Json[]).find((m) => m.id === history[40]?.id);
    expect(root).toMatchObject({ replyCount: 1 });
    expect(root?.replyParticipants).toEqual([expect.objectContaining({ kind: "user", id: samId })]);
  });

  it("the oldest anchor has no older page; the newest has no newer page", async () => {
    const first = await ok(page(sam, channelId, `around=${history[1]?.id}&limit=50`));
    expect(bodies(first)).toEqual(range(1, 25));
    expect(first.nextBefore).toBeNull();
    expect(first.nextAfter).toBe(history[25]?.seq);
    expect(first.lastSeq).toEqual(expect.any(Number));

    const last = await ok(page(sam, channelId, `around=${history[120]?.id}&limit=50`));
    expect(bodies(last)).toEqual(range(95, 120));
    expect(last.nextBefore).toBe(history[95]?.seq);
    expect(last.nextAfter).toBeNull();
  });

  it("after=<seq> pages forward until nextAfter is null", async () => {
    const p1 = await ok(page(sam, channelId, `after=${history[54]?.seq}&limit=50`));
    expect(bodies(p1)).toEqual(range(55, 104));
    expect(p1.nextAfter).toBe(history[104]?.seq);
    expect(p1.lastSeq).toEqual(expect.any(Number));
    const p2 = await ok(page(sam, channelId, `after=${p1.nextAfter}&limit=50`));
    expect(bodies(p2)).toEqual(range(105, 120));
    expect(p2.nextAfter).toBeNull();
    expect(p2.lastSeq).toEqual(expect.any(Number));
  });

  it("the tail page and before= keep working and carry lastSeq", async () => {
    const tail = await ok(page(sam, channelId, "limit=50"));
    expect(bodies(tail)).toEqual(range(71, 120));
    expect(tail.lastSeq).toEqual(expect.any(Number));
    const older = await ok(page(sam, channelId, `before=${tail.nextBefore}&limit=50`));
    expect(bodies(older)).toEqual(range(21, 70));
    expect(older.lastSeq).toEqual(expect.any(Number));
  });

  it("a thread reply anchors on its root and names it as threadRootId", async () => {
    const p = await ok(page(sam, channelId, `around=${replyId}&limit=10`));
    expect(p.anchorId).toBe(history[40]?.id);
    expect(p.threadRootId).toBe(history[40]?.id);
    expect(bodies(p)).toEqual(range(35, 44));
    expect(bodies(p)).not.toContain("reply to #40");
  });

  it("a message of another conversation is not found", async () => {
    const r = await page(sam, channelId, `around=${otherMessageId}`);
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: { code: "not_found", message: "Message not found" } });
    const missing = await page(sam, channelId, `around=${randomUUID()}`);
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual(r.body);
  });

  it("more than one cursor is refused with invalid_page_query", async () => {
    for (const q of [
      `around=${history[30]?.id}&before=${history[60]?.seq}`,
      `around=${history[30]?.id}&after=${history[10]?.seq}`,
      `before=${history[60]?.seq}&after=${history[10]?.seq}`,
    ]) {
      const r = await page(sam, channelId, q);
      expect(r.status, q).toBe(400);
      expect((r.body as Json).error.code, q).toBe("invalid_page_query");
    }
  });

  it("a conversation the viewer cannot read answers exactly like a missing one (404, no details)", async () => {
    const hidden = await page(sam, privateChannelId, `around=${privateMessageId}`);
    const missing = await page(sam, randomUUID(), `around=${privateMessageId}`);
    expect(hidden.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(hidden.body).toEqual(missing.body);
    expect((hidden.body as Json).error.details).toBeUndefined();
    // Conflicting cursors on a hidden conversation still say nothing but 404.
    const conflicting = await page(sam, privateChannelId, `around=${privateMessageId}&before=5`);
    expect(conflicting.status).toBe(404);
    // after= on a hidden conversation too.
    expect((await page(sam, privateChannelId, "after=0")).status).toBe(404);
  });

  it("another organization finds neither the conversation nor the message", async () => {
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
    const req = {
      auth: { userId: userB, organizationId: orgB, sessionId: randomUUID(), clientKind: "web" },
    } as unknown as FastifyRequest;
    const access = createConversationAccess(stack.built.core);
    const { db } = stack.built.core;
    await expect(
      db.withTenant({ organizationId: orgB, userId: userB }, (tx) => access.readable(req, tx, channelId)),
    ).rejects.toMatchObject({ statusCode: 404, details: undefined });
    expect(
      await db.withTenant({ organizationId: orgB, userId: userB }, (tx) =>
        getMessage(tx, history[30]?.id ?? ""),
      ),
    ).toBeNull();
    expect(orgId).not.toBe(orgB);
  });
});
