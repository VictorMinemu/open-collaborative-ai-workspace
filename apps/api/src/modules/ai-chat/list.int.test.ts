import { randomUUID } from "node:crypto";
import { AI_CHAT_TITLE_MAX, EventTypes } from "@ocw/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_SETUP_TOKEN, TestClient } from "../../testing";
import { type AiStack, seedPlan, startAiStack, subscribeTopic } from "../../testing-ai";
import { invite } from "../../testing-workzone";

/**
 * The member's AI chats (05-10, AICHAT-04, P-03): `GET /ai-chats` lists only the caller's own chats, newest activity
 * first with a keyset cursor, archived ones apart; `PATCH /ai-chats/:id` renames (a typed title is `user`, never
 * replaced by a generated one) and archives/unarchives (an archived chat refuses sends with 410 `chat_archived`).
 * Everyone else — another member, an admin, another organization — gets 404 and never sees a title.
 * Real PostgreSQL + Redis and the in-process fake model.
 */

let stack: AiStack;
let su: pg.Client;
let admin: TestClient;
let sam: TestClient;
let samId: string;
let alex: TestClient;
let orgId: string;

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
type Json = Record<string, any>;

const MOCK = { backend: "mock", provider: "mock", modelId: "mock-1" } as const;
const cid = () => `cm-${randomUUID()}`;

async function ok(res: Promise<{ status: number; body: Record<string, unknown> | null }>, status = 200) {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as Json;
}
const errorOf = (r: { body: Record<string, unknown> | null }) => (r.body as Json | null)?.error as Json;

const createChat = (as: TestClient, body: string) =>
  ok(as.request("POST", "/api/v1/ai-chats", { clientMessageId: cid(), body, model: MOCK }), 201);
const send = (as: TestClient, chatId: string, body: string) =>
  as.request("POST", `/api/v1/ai-chats/${chatId}/messages`, { clientMessageId: cid(), body, model: MOCK });
const patch = (as: TestClient, chatId: string, body: Json) =>
  as.request("PATCH", `/api/v1/ai-chats/${chatId}`, body);
const list = (as: TestClient, query = "") => ok(as.request("GET", `/api/v1/ai-chats${query}`));

async function settled(generationId: string, timeoutMs = 15_000): Promise<Json> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const g = (await su.query("select * from app.ai_generations where id = $1", [generationId])).rows[0];
    if (g && g.status !== "running") return g;
    if (Date.now() > until) throw new Error(`generation ${generationId} still running`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Every page of the caller's list (`limit` per page), following `nextCursor`. */
async function allPages(as: TestClient, extra = "", limit = 2): Promise<Json[]> {
  const out: Json[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 50; i++) {
    const q = `?limit=${limit}${extra}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const page = await list(as, q);
    expect(page.chats.length).toBeLessThanOrEqual(limit);
    out.push(...page.chats);
    cursor = page.nextCursor;
    if (!cursor) return out;
  }
  throw new Error("too many pages");
}

const auditsOf = async (action: string, resourceId: string) =>
  (
    await su.query(
      "select * from app.audit_events where action = $1 and resource_id = $2 order by occurred_at",
      [action, resourceId],
    )
  ).rows as Json[];

const samChats: string[] = [];
let alexChat: string;

beforeAll(async () => {
  stack = await startAiStack();
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
  ({ client: sam, userId: samId } = await invite(stack, admin, "sam@example.test", "Sam Rivera", "standard"));
  ({ client: alex } = await invite(stack, admin, "alex@example.test", "Alex Kim", "standard"));
  await seedPlan(sam);
  for (const text of [
    "Alpha plan for the launch",
    "Bravo budget review",
    "Charlie hiring",
    "Delta notes",
    "Echo",
  ]) {
    const created = await createChat(sam, text);
    await settled(created.generation.id);
    samChats.push(created.chat.id);
  }
  const theirs = await createChat(alex, "Alex private thoughts");
  await settled(theirs.generation.id);
  alexChat = theirs.chat.id;
  // Distinct activity times, oldest first, so the order is deterministic.
  for (const [i, id] of samChats.entries()) {
    await su.query(
      "update app.ai_chats set last_activity_at = now() - make_interval(mins => $2::int) where conversation_id = $1",
      [id, 60 - i * 10],
    );
  }
});

afterAll(async () => {
  await su?.end();
  await stack?.stop();
});

describe("GET /ai-chats: the caller's own chats, newest activity first (AICHAT-04)", () => {
  it("pages of 2 follow the keyset cursor with no duplicates or gaps; only Sam's chats", async () => {
    const chats = await allPages(sam);
    const ids = chats.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([...samChats].reverse());
    expect(ids).not.toContain(alexChat);
    for (const c of chats) {
      expect(c).toMatchObject({
        archived: false,
        generating: false,
        lastModel: MOCK,
        lastModelLabel: "Mock (E2E)",
      });
      expect(typeof c.title).toBe("string");
    }
    const times = chats.map((c) => Date.parse(c.lastActivityAt));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it("a malformed cursor is 400; Alex and the admin list none of Sam's chats", async () => {
    const bad = await sam.request("GET", "/api/v1/ai-chats?cursor=not-a-cursor");
    expect(bad.status).toBe(400);
    const alexIds = (await allPages(alex)).map((c) => c.id);
    expect(alexIds).toEqual([alexChat]);
    const adminList = await list(admin);
    expect(adminList.chats).toEqual([]);
    const texts = JSON.stringify([alexIds, adminList]);
    expect(texts).not.toContain("Alpha plan");
  });
});

describe("PATCH /ai-chats/:id (owner only)", () => {
  it("a title Sam types is stored as 'user', announced on user:<sam> and audited without the text", async () => {
    const chatId = samChats[0] as string;
    const user = await subscribeTopic(stack.baseUrl, sam, `user:${samId}`);
    const res = await ok(patch(sam, chatId, { title: "  Launch plan, final  " }));
    expect(res).toMatchObject({
      id: chatId,
      title: "Launch plan, final",
      titleSource: "user",
      archived: false,
    });
    expect(res.settings).toBeDefined();
    const row = (
      await su.query(
        "select c.name, a.title_source from app.conversations c join app.ai_chats a on a.conversation_id = c.id where c.id = $1",
        [chatId],
      )
    ).rows[0];
    expect(row).toEqual({ name: "Launch plan, final", title_source: "user" });
    await user.waitFor(() =>
      user
        .durable(EventTypes.aiChatUpdated)
        .some(
          (f) => (f.data as Json).chat.id === chatId && (f.data as Json).chat.title === "Launch plan, final",
        ),
    );
    user.close();
    const [audit] = await auditsOf("ai_chat.renamed", chatId);
    expect(audit?.metadata).toEqual({ conversationId: chatId });
    expect(JSON.stringify(audit)).not.toContain("Launch plan");
  });

  it("an empty, blank or overlong title is 400; nothing to update is 400", async () => {
    const chatId = samChats[1] as string;
    for (const title of ["", "   ", "x".repeat(AI_CHAT_TITLE_MAX + 1)]) {
      expect((await patch(sam, chatId, { title })).status).toBe(400);
    }
    expect((await patch(sam, chatId, {})).status).toBe(400);
    expect((await patch(sam, chatId, { title: "x".repeat(AI_CHAT_TITLE_MAX) })).status).toBe(200);
  });

  it("archive hides it from the default list, refuses sends with 410, and unarchive restores it", async () => {
    const chatId = samChats[2] as string;
    const archived = await ok(patch(sam, chatId, { archived: true }));
    expect(archived).toMatchObject({ id: chatId, archived: true });
    const conv = (await su.query("select archived_at from app.conversations where id = $1", [chatId]))
      .rows[0];
    expect(conv.archived_at).not.toBeNull();
    expect((await allPages(sam)).map((c) => c.id)).not.toContain(chatId);
    const onlyArchived = await allPages(sam, "&archived=true");
    expect(onlyArchived.map((c) => c.id)).toEqual([chatId]);
    expect(onlyArchived[0]).toMatchObject({ archived: true });

    const refused = await send(sam, chatId, "Still there?");
    expect(refused.status).toBe(410);
    expect(errorOf(refused).code).toBe("chat_archived");
    const regen = await sam.request("POST", `/api/v1/ai-chats/${chatId}/regenerate`, {});
    expect(regen.status).toBe(410);
    expect(errorOf(regen).code).toBe("chat_archived");
    // The snapshot still opens (read-only in the web).
    const snap = await ok(sam.request("GET", `/api/v1/ai-chats/${chatId}`));
    expect(snap.chat.archived).toBe(true);

    const restored = await ok(patch(sam, chatId, { archived: false }));
    expect(restored.archived).toBe(false);
    expect((await allPages(sam)).map((c) => c.id)).toContain(chatId);
    expect(await allPages(sam, "&archived=true")).toEqual([]);
    const sent = await ok(send(sam, chatId, "Back again"), 201);
    await settled(sent.generation.id);

    expect(await auditsOf("ai_chat.archived", chatId)).toHaveLength(1);
    expect(await auditsOf("ai_chat.unarchived", chatId)).toHaveLength(1);
    // Archiving twice is idempotent: no second audit row.
    await ok(patch(sam, chatId, { archived: false }));
    expect(await auditsOf("ai_chat.unarchived", chatId)).toHaveLength(1);
  });

  it("Alex, the admin and another organization get 404 and change nothing", async () => {
    const chatId = samChats[3] as string;
    const before = (await su.query("select name, archived_at from app.conversations where id = $1", [chatId]))
      .rows[0];
    for (const as of [alex, admin]) {
      const r = await patch(as, chatId, { title: "Mine now", archived: true });
      expect(r.status).toBe(404);
      expect(JSON.stringify(r.body)).not.toContain(before.name);
    }
    // An admin of another organization.
    const email = `eve-${randomUUID().slice(0, 8)}@example.test`;
    const inv = await ok(admin.request("POST", "/api/v1/invitations", { email, role: "standard" }));
    const eve = new TestClient(stack.baseUrl);
    const accepted = await ok(
      eve.request("POST", `/api/v1/invitations/${inv.id}/accept`, {
        name: "Eve",
        password: "eve-long-password-1",
      }),
    );
    const eveId: string = accepted.user.id;
    const orgB = randomUUID();
    await su.query("insert into auth.organization (id, name, slug) values ($1, 'Evil', $2)", [
      orgB,
      `evil-${orgB}`,
    ]);
    await su.query("delete from auth.member where user_id = $1", [eveId]);
    await su.query("delete from app.org_members where user_id = $1", [eveId]);
    await su.query("insert into auth.member (organization_id, user_id, role) values ($1, $2, 'owner')", [
      orgB,
      eveId,
    ]);
    await su.query(
      "insert into app.org_members (organization_id, user_id, display_name, role) values ($1, $2, 'Eve', 'admin')",
      [orgB, eveId],
    );
    await su.query("update auth.session set active_organization_id = $1 where user_id = $2", [orgB, eveId]);
    expect((await patch(eve, chatId, { archived: true })).status).toBe(404);
    expect((await list(eve)).chats).toEqual([]);

    const after = (await su.query("select name, archived_at from app.conversations where id = $1", [chatId]))
      .rows[0];
    expect(after).toEqual(before);
    expect(orgId).not.toBe(orgB);
  });

  it("a generated title never replaces a typed one", async () => {
    const created = await createChat(sam, "Typed title wins over the generated one");
    await ok(patch(sam, created.chat.id, { title: "Mine" }));
    await settled(created.generation.id);
    await new Promise((r) => setTimeout(r, 800));
    const row = (
      await su.query(
        "select c.name, a.title_source from app.conversations c join app.ai_chats a on a.conversation_id = c.id where c.id = $1",
        [created.chat.id],
      )
    ).rows[0];
    expect(row).toEqual({ name: "Mine", title_source: "user" });
  });
});
