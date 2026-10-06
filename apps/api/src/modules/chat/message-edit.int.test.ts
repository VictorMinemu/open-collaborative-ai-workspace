import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentMention } from "../../lib/chat-agent-bridge";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";

/**
 * CHAT-06 (04-01): message edit and delete over real PostgreSQL + Redis. Versions are append-only, audit rows
 * carry ids and the version but never a body, `message.updated`/`message.deleted` reach the conversation
 * stream, and only the author (or, for delete, an admin where readable and never in a DM) may change one.
 */

let stack: TestStack;
let su: pg.Client;
let admin: TestClient;
let alex: TestClient;
let orgId: string;
let adminId: string;
let alexId: string;
let archieId: string;
let channelId: string;
const mentions: AgentMention[] = [];

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
type Json = Record<string, any>;

async function ok(res: Promise<{ status: number; body: Record<string, unknown> | null }>, status = 200) {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as Json;
}

const errorOf = (r: { body: Record<string, unknown> | null }) => (r.body as Json | null)?.error as Json;

const audit = async (action: string) =>
  (await su.query("select * from app.audit_events where action = $1 order by occurred_at", [action])).rows;

const versionsOf = async (messageId: string) =>
  (await su.query("select * from app.message_versions where message_id = $1 order by version", [messageId]))
    .rows;

async function lastEvent(conversationId: string, type: string): Promise<Json | undefined> {
  const res = await su.query(
    "select payload from app.stream_events where stream_id = $1 and type = $2 order by seq desc limit 1",
    [`conv:${conversationId}`, type],
  );
  return res.rows[0]?.payload;
}

/** Every key at any depth of a JSON value. */
function keysDeep(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) for (const x of v) keysDeep(x, out);
  else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      out.push(k);
      keysDeep(x, out);
    }
  }
  return out;
}

const post = (as: TestClient, conv: string, body: string, extra: Json = {}) =>
  ok(as.request("POST", `/api/v1/conversations/${conv}/messages`, { body, ...extra }));
const edit = (as: TestClient, id: string, body: string) =>
  as.request("PATCH", `/api/v1/messages/${id}`, { body });

beforeAll(async () => {
  stack = await startTestStack();
  su = new pg.Client({ connectionString: stack.db.superuserUrl });
  await su.connect();
  stack.built.core.chatAgent.onAgentMention(async (_tx, m) => {
    mentions.push(m);
  });

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
  await su.query(
    `insert into app.agents (id, organization_id, name, username, instructions, model_provider, model_id, status)
     values ($1, $2, 'Archie', 'archie', 'x', 'mock', 'mock-1', 'ready')`,
    [archieId, orgId],
  );

  channelId = (await ok(admin.request("POST", "/api/v1/channels", { name: "edits", visibility: "public" })))
    .id;
  await ok(alex.request("POST", `/api/v1/channels/${channelId}/join`));
});

afterAll(async () => {
  await su?.end();
  await stack?.stop();
});

describe("PATCH /messages/:id (edit)", () => {
  let messageId: string;

  it("the author edits: new body, editedAt, an append-only version, message.updated and an audit row", async () => {
    const original = await post(admin, channelId, "Deploy at 9");
    messageId = original.id;
    expect(original.editedAt).toBeNull();

    const edited = await ok(edit(admin, messageId, "Deploy at 10, not 9"));
    expect(edited).toMatchObject({ id: messageId, body: "Deploy at 10, not 9", seq: original.seq });
    expect(edited.editedAt).toEqual(expect.any(String));
    expect(edited.deletedAt ?? null).toBeNull();

    const versions = await versionsOf(messageId);
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({
      version: 1,
      kind: "edit",
      body: "Deploy at 9",
      edited_by_kind: "user",
      edited_by: adminId,
      organization_id: orgId,
    });

    const ev = await lastEvent(channelId, "message.updated");
    expect(ev?.message).toMatchObject({ id: messageId, body: "Deploy at 10, not 9" });
    expect(ev?.message.editedAt).toEqual(expect.any(String));
    for (const viewerField of ["reactions", "pinned", "saved"]) {
      expect(Object.keys(ev?.message ?? {}), viewerField).not.toContain(viewerField);
    }

    const rows = await audit("message.edited");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ resource_type: "message", resource_id: messageId, actor_id: adminId });
    expect(rows[0].metadata).toEqual({ messageId, conversationId: channelId, version: 1 });
    expect(keysDeep(rows[0].metadata)).not.toContain("body");

    // The list snapshot shows the edit.
    const page = await ok(alex.request("GET", `/api/v1/conversations/${channelId}/messages`));
    expect(page.messages.find((m: Json) => m.id === messageId)).toMatchObject({
      body: "Deploy at 10, not 9",
      editedAt: edited.editedAt,
    });
  });

  it("a second edit is version 2; an unchanged body adds no version", async () => {
    await ok(edit(admin, messageId, "Deploy at 11"));
    await ok(edit(admin, messageId, "Deploy at 11"));
    const versions = await versionsOf(messageId);
    expect(versions.map((v) => [v.version, v.body])).toEqual([
      [1, "Deploy at 9"],
      [2, "Deploy at 10, not 9"],
    ]);
    expect((await audit("message.edited")).map((r) => r.metadata.version)).toEqual([1, 2]);
  });

  it("mentions are re-resolved from the new body, and an edit never triggers a bot", async () => {
    const msg = await post(admin, channelId, "no mentions yet");
    const before = mentions.length;
    const withAlex = await ok(edit(admin, msg.id, "ping @alex"));
    expect(withAlex.mentions).toEqual([{ kind: "user", id: alexId }]);
    const withBot = await ok(edit(admin, msg.id, "ping @alex and @archie"));
    expect(withBot.mentions).toEqual(
      expect.arrayContaining([
        { kind: "user", id: alexId },
        { kind: "agent", id: archieId },
      ]),
    );
    // Pitfall 8: no delivery, and the bot is not auto-added to the channel by an edit.
    expect(mentions.length).toBe(before);
    const captured = await ok(admin.request("GET", "/api/v1/test/chat/mentions"));
    expect(captured.mentions.filter((m: Json) => m.messageId === msg.id)).toEqual([]);
    const members = await ok(admin.request("GET", `/api/v1/channels/${channelId}/members`));
    expect(members.members.some((m: Json) => m.kind === "agent")).toBe(false);
  });

  it("another member gets 403 not_author, and nothing changes", async () => {
    const r = await edit(alex, messageId, "hijacked");
    expect(r.status).toBe(403);
    expect(errorOf(r).code).toBe("not_author");
    const row = (await su.query("select body from app.messages where id = $1", [messageId])).rows[0];
    expect(row.body).toBe("Deploy at 11");
    expect(await versionsOf(messageId)).toHaveLength(2);
  });

  it("a non-member of a private channel gets 404; a missing id is 404 too", async () => {
    const secret = (
      await ok(admin.request("POST", "/api/v1/channels", { name: "secret-edits", visibility: "private" }))
    ).id;
    const msg = await post(admin, secret, "private plan");
    const hidden = await edit(alex, msg.id, "peek");
    expect(hidden.status).toBe(404);
    expect(errorOf(hidden).details).toBeUndefined();
    expect((await edit(admin, randomUUID(), "nothing")).status).toBe(404);
  });

  it("an archived channel answers 410 channel_archived", async () => {
    const old = (await ok(admin.request("POST", "/api/v1/channels", { name: "old-edits" }))).id;
    const msg = await post(admin, old, "before archiving");
    await ok(admin.request("POST", `/api/v1/channels/${old}/archive`));
    const r = await edit(admin, msg.id, "after archiving");
    expect(r.status).toBe(410);
    expect(errorOf(r).code).toBe("channel_archived");
  });

  it("a thread reply can be edited and the thread view shows the new body", async () => {
    const root = await post(admin, channelId, "thread root");
    const reply = await post(alex, channelId, "first reply", { threadRootId: root.id });
    const edited = await ok(edit(alex, reply.id, "first reply (fixed)"));
    expect(edited).toMatchObject({ threadId: root.id, body: "first reply (fixed)" });
    const thread = await ok(admin.request("GET", `/api/v1/messages/${root.id}/thread`));
    expect(thread.replies.map((r: Json) => r.body)).toEqual(["first reply (fixed)"]);
    expect(thread.replies[0].editedAt).toEqual(expect.any(String));
    const ev = await lastEvent(channelId, "message.updated");
    expect(ev?.message).toMatchObject({ id: reply.id, threadId: root.id });
  });

  it("refuses an empty body", async () => {
    expect((await edit(admin, messageId, "   ")).status).toBe(400);
  });
});
