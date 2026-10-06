import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";

/**
 * CHAT-02 (04-08): the Threads view. `GET /threads` lists the threads a member started, replied to or was mentioned
 * in, newest reply first, with unread replies counted from `thread_reads`, only from conversations the resolver lets
 * them read (P-03). `POST /threads/:rootId/read` keeps the greatest mark and tells the member's other devices.
 * Also: the sidebar list DTOs carry `lastMessagePreview`.
 */

let stack: TestStack;
let su: pg.Client;
let admin: TestClient;
let sam: TestClient;
let alex: TestClient;
let samId: string;
let alexId: string;
let channelId: string;

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
type Json = Record<string, any>;

async function ok(res: Promise<{ status: number; body: Record<string, unknown> | null }>, status = 200) {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as Json;
}

const errorOf = (r: { body: Record<string, unknown> | null }) => (r.body as Json | null)?.error as Json;

async function invite(email: string, name: string): Promise<{ client: TestClient; id: string }> {
  const inv = await ok(admin.request("POST", "/api/v1/invitations", { email, role: "developer" }));
  const client = new TestClient(stack.baseUrl);
  const accepted = await ok(
    client.request("POST", `/api/v1/invitations/${inv.id}/accept`, {
      name,
      password: "another-long-password",
    }),
  );
  return { client, id: accepted.user.id };
}

const post = (as: TestClient, conv: string, body: string, threadRootId?: string) =>
  ok(
    as.request("POST", `/api/v1/conversations/${conv}/messages`, {
      body,
      ...(threadRootId ? { threadRootId } : {}),
    }),
  );

async function threadsOf(as: TestClient, query = ""): Promise<Json> {
  return ok(as.request("GET", `/api/v1/threads${query}`));
}

const markRead = (as: TestClient, rootId: string, seq: number) =>
  as.request("POST", `/api/v1/threads/${rootId}/read`, { seq });

async function events(topic: string, type: string): Promise<Json[]> {
  const res = await su.query(
    "select payload from app.stream_events where stream_id = $1 and type = $2 order by seq",
    [topic, type],
  );
  return res.rows.map((r) => r.payload);
}

beforeAll(async () => {
  stack = await startTestStack();
  su = new pg.Client({ connectionString: stack.db.superuserUrl });
  await su.connect();

  admin = new TestClient(stack.baseUrl);
  await ok(
    admin.request("POST", "/api/v1/setup", {
      token: TEST_SETUP_TOKEN,
      name: "Víctor Ruiz",
      email: "victor@example.test",
      password: "correct-horse-battery",
      orgName: "Autofy Labs",
    }),
  );
  ({ client: sam, id: samId } = await invite("sam@example.test", "Sam Lee"));
  ({ client: alex, id: alexId } = await invite("alex@example.test", "Alex Kim"));

  channelId = (await ok(admin.request("POST", "/api/v1/channels", { name: "eng", visibility: "public" }))).id;
  await ok(sam.request("POST", `/api/v1/channels/${channelId}/join`));
  await ok(alex.request("POST", `/api/v1/channels/${channelId}/join`));
});

afterAll(async () => {
  await su?.end();
  await stack?.stop();
});

describe("GET /threads (CHAT-02)", () => {
  let started: Json;
  let repliedIn: Json;
  let mentionedInReply: Json;
  let mentionedInRoot: Json;
  let unrelated: Json;

  it("lists threads Sam started, replied in or was mentioned in, newest reply first, with unread replies", async () => {
    started = await post(sam, channelId, "Sam's question about the deploy");
    await post(admin, channelId, "answer one", started.id);
    await post(alex, channelId, "answer two", started.id);

    repliedIn = await post(admin, channelId, "Admin's plan");
    await post(sam, channelId, "Sam chimes in", repliedIn.id);
    await post(alex, channelId, "Alex follows up", repliedIn.id);

    mentionedInReply = await post(admin, channelId, "Retro notes");
    await post(alex, channelId, "@sam can you check this?", mentionedInReply.id);

    mentionedInRoot = await post(alex, channelId, "@sam the release checklist");
    await post(admin, channelId, "first reply", mentionedInRoot.id);

    unrelated = await post(admin, channelId, "Admin and Alex only");
    await post(alex, channelId, "no Sam here", unrelated.id);

    // A root without replies is not a thread yet.
    await post(sam, channelId, "lonely root");

    const list = await threadsOf(sam);
    expect(list.nextCursor).toBeNull();
    const ids = (list.threads as Json[]).map((t) => t.root.id);
    expect(ids).toEqual([mentionedInRoot.id, mentionedInReply.id, repliedIn.id, started.id]);
    const byId = new Map((list.threads as Json[]).map((t) => [t.root.id, t]));
    expect(byId.get(started.id)).toMatchObject({
      conversation: { id: channelId, kind: "channel", label: "#eng" },
      replyCount: 2,
      unreadReplies: 2,
      root: { body: "Sam's question about the deploy", saved: false, reactions: [] },
    });
    // Sam's own reply never counts as unread.
    expect(byId.get(repliedIn.id)?.unreadReplies).toBe(1);
    expect(byId.get(mentionedInReply.id)?.unreadReplies).toBe(1);
    expect(
      byId
        .get(started.id)
        ?.participants.map((p: Json) => p.id)
        .sort(),
    ).toEqual([alexId, (await ok(admin.request("GET", "/api/v1/me"))).user.id].sort());
    expect(byId.get(started.id)?.lastReplyAt).toEqual(expect.any(String));
    // The newest replies travel with the card (oldest → newest, at most 3).
    expect(byId.get(started.id)?.lastReplies.map((m: Json) => m.body)).toEqual(["answer one", "answer two"]);
  });

  it("another member's threads never appear; deleted replies are not unread", async () => {
    const alexIds = ((await threadsOf(alex)).threads as Json[]).map((t) => t.root.id);
    expect(alexIds).toContain(unrelated.id);
    expect(((await threadsOf(sam)).threads as Json[]).map((t) => t.root.id)).not.toContain(unrelated.id);

    const extra = await post(alex, channelId, "oops", started.id);
    expect(((await threadsOf(sam)).threads as Json[])[0]).toMatchObject({
      root: { id: started.id },
      unreadReplies: 3,
    });
    await ok(alex.request("DELETE", `/api/v1/messages/${extra.id}`));
    const after = ((await threadsOf(sam)).threads as Json[]).find((t) => t.root.id === started.id);
    expect(after?.unreadReplies).toBe(2);
  });

  it("POST /threads/:rootId/read keeps the greatest mark, emits thread.read on user:<me> and zeroes unread", async () => {
    const thread = await ok(sam.request("GET", `/api/v1/messages/${started.id}/thread`));
    const lastSeq = Math.max(...(thread.replies as Json[]).map((r) => r.seq));
    expect(await ok(markRead(sam, started.id, lastSeq))).toEqual({ ok: true });
    expect(await ok(markRead(sam, started.id, 1))).toEqual({ ok: true });
    const row = (
      await su.query(
        "select last_read_seq from app.thread_reads where user_id = $1 and root_message_id = $2",
        [samId, started.id],
      )
    ).rows[0];
    expect(Number(row?.last_read_seq)).toBe(lastSeq);
    const evs = (await events(`user:${samId}`, "thread.read")).filter((e) => e.rootId === started.id);
    expect(evs.at(-1)).toEqual({ rootId: started.id, lastReadSeq: lastSeq });
    expect(evs.every((e) => e.lastReadSeq === lastSeq)).toBe(true);
    const listed = ((await threadsOf(sam)).threads as Json[]).find((t) => t.root.id === started.id);
    expect(listed?.unreadReplies).toBe(0);
    // Only Sam's stream hears it.
    expect((await events(`user:${alexId}`, "thread.read")).some((e) => e.rootId === started.id)).toBe(false);

    // A new reply after the mark is unread again.
    await post(admin, channelId, "one more", started.id);
    expect(
      ((await threadsOf(sam)).threads as Json[]).find((t) => t.root.id === started.id)?.unreadReplies,
    ).toBe(1);
  });

  it("read marks: a reply id, an unknown id, a hidden thread or another organization's root are 404", async () => {
    const reply = await post(admin, channelId, "a reply", started.id);
    expect((await markRead(sam, reply.id, 1)).status).toBe(404);
    expect((await markRead(sam, randomUUID(), 1)).status).toBe(404);

    const orgB = randomUUID();
    await su.query("insert into auth.organization (id, name, slug) values ($1, 'B', $2)", [
      orgB,
      `b-${orgB}`,
    ]);
    const conv = randomUUID();
    const msg = randomUUID();
    await su.query(
      "insert into app.conversations (id, organization_id, kind, name, slug, visibility) values ($1, $2, 'channel', 'x', 'x', 'public')",
      [conv, orgB],
    );
    await su.query(
      "insert into app.messages (id, organization_id, conversation_id, seq, author_kind, author_id, body, reply_count) values ($1, $2, $3, 1, 'user', $4, 'secret', 1)",
      [msg, orgB, conv, samId],
    );
    const cross = await markRead(sam, msg, 5);
    expect(cross.status).toBe(404);
    expect(JSON.stringify(cross.body)).not.toContain("secret");
  });

  it("threads in a private channel the member left disappear", async () => {
    const priv = (
      await ok(admin.request("POST", "/api/v1/channels", { name: "secret-room", visibility: "private" }))
    ).id as string;
    await ok(admin.request("POST", `/api/v1/channels/${priv}/members`, { kind: "user", id: samId }));
    const root = await post(sam, priv, "private thought");
    await post(admin, priv, "private answer", root.id);
    expect(((await threadsOf(sam)).threads as Json[]).map((t) => t.root.id)).toContain(root.id);
    await ok(sam.request("POST", `/api/v1/channels/${priv}/leave`));
    expect(((await threadsOf(sam)).threads as Json[]).map((t) => t.root.id)).not.toContain(root.id);
    const hidden = await markRead(sam, root.id, 1);
    expect(hidden.status).toBe(404);
  });

  it("pages with an opaque cursor over 35 threads; a forged cursor is 400", async () => {
    const paged = (
      await ok(admin.request("POST", "/api/v1/channels", { name: "paging", visibility: "public" }))
    ).id as string;
    await ok(alex.request("POST", `/api/v1/channels/${paged}/join`));
    for (let i = 0; i < 35; i += 1) {
      const root = await post(alex, paged, `paged root ${i}`);
      await post(admin, paged, `reply ${i}`, root.id);
    }
    const first = await threadsOf(alex, "?limit=30");
    expect(first.threads).toHaveLength(30);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await threadsOf(alex, `?limit=30&cursor=${encodeURIComponent(first.nextCursor)}`);
    const all = [...first.threads, ...second.threads].map((t: Json) => t.root.id);
    expect(new Set(all).size).toBe(all.length);
    expect(all.filter((id) => id).length).toBeGreaterThanOrEqual(35);
    expect(second.nextCursor).toBeNull();
    // Newest reply first across both pages.
    const times = [...first.threads, ...second.threads].map((t: Json) => Date.parse(t.lastReplyAt));
    expect([...times].sort((a, b) => b - a)).toEqual(times);

    const forged = await alex.request("GET", "/api/v1/threads?cursor=not-a-cursor");
    expect(forged.status).toBe(400);
    expect(errorOf(forged).code).toBe("invalid_cursor");
  });
});

describe("lastMessagePreview on sidebar lists", () => {
  it("channels and DMs carry the latest top-level, non-deleted message (≤ 140 chars, one line)", async () => {
    const room = (
      await ok(admin.request("POST", "/api/v1/channels", { name: "preview", visibility: "public" }))
    ).id as string;
    const empty = ((await ok(admin.request("GET", "/api/v1/channels"))).channels as Json[]).find(
      (c) => c.id === room,
    );
    expect(empty?.lastMessagePreview).toBeNull();

    await post(admin, room, "first message");
    const long = `line one\n\nline   two ${"x".repeat(200)}`;
    await post(admin, room, long);
    const root = await post(admin, room, "thread root");
    await post(admin, room, "a reply never previews", root.id);
    await ok(admin.request("DELETE", `/api/v1/messages/${root.id}`));
    const preview = ((await ok(admin.request("GET", "/api/v1/channels"))).channels as Json[]).find(
      (c) => c.id === room,
    )?.lastMessagePreview as string;
    // The deleted root still has a reply, so it stays as a tombstone: the preview skips it.
    expect(preview.startsWith("line one line two xxx")).toBe(true);
    expect(preview.length).toBe(140);

    const dm = await ok(sam.request("POST", "/api/v1/dms", { participants: [{ kind: "user", id: alexId }] }));
    expect(dm.lastMessagePreview).toBeNull();
    await post(alex, dm.id, "hey Sam");
    const dms = (await ok(sam.request("GET", "/api/v1/dms"))).dms as Json[];
    expect(dms.find((d) => d.id === dm.id)?.lastMessagePreview).toBe("hey Sam");
  });
});
