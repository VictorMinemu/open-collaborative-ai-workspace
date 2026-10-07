import { randomUUID } from "node:crypto";
import { EventTypes } from "@ocw/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_SETUP_TOKEN, TestClient } from "../../testing";
import {
  type AiStack,
  type ConvSubscription,
  seedPlan,
  startAiStack,
  subscribeTopic,
} from "../../testing-ai";
import { invite } from "../../testing-workzone";

/**
 * 06-08 (D-03, P-09, MULTI-01, MULTI-02): shared AI chats live where people look. A direct person grant notifies that
 * person once (`ai_chat_shared` on the notice row); team, department and organization grants notify nobody. Joined
 * shared chats carry `unreadCount` in the list and `POST /ai-chats/:id/read` moves the caller's cursor (joining a
 * unit/org grantee on first read). Mentions inside a shared chat notify readers only. Every participant's sidebar
 * hears `ai_chat.updated` with their own access (`emitChatUpdated`). The inbox lists AI chat notifications only while
 * the chat is readable. Real PostgreSQL + Redis, the in-process fake model; no real provider is ever called.
 *
 * Cast: Víctor (admin, owner), Alex and Sam (person grants), Riley (Backend team), Jo (no access), Ada (admin, no
 * grant).
 */

let stack: AiStack;
let su: pg.Client;
let victor: TestClient;
let alex: TestClient;
let sam: TestClient;
let riley: TestClient;
let jo: TestClient;
let ada: TestClient;
let victorId: string;
let alexId: string;
let samId: string;
let rileyId: string;
let joId: string;
let backendUnit: string;

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
type Json = Record<string, any>;

const PLAN_MODEL = { backend: "chatgpt_plan", provider: "openai", modelId: "gpt-6-astra" } as const;
const cid = () => `cm-${randomUUID()}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function ok(res: Promise<{ status: number; body: Record<string, unknown> | null }>, status = 200) {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as Json;
}

const createChat = (as: TestClient, body: string) =>
  as.request("POST", "/api/v1/ai-chats", { clientMessageId: cid(), body, model: PLAN_MODEL });
const send = (as: TestClient, chatId: string, body: string, extra: Json = {}) =>
  as.request("POST", `/api/v1/ai-chats/${chatId}/messages`, {
    clientMessageId: cid(),
    body,
    model: PLAN_MODEL,
    ...extra,
  });
const grant = (as: TestClient, chatId: string, subject: Json, level: "chat" | "view" = "chat") =>
  as.request("POST", `/api/v1/ai-chats/${chatId}/grants`, { subject, level });
const markRead = (as: TestClient, chatId: string, seq: number) =>
  as.request("POST", `/api/v1/ai-chats/${chatId}/read`, { seq });

async function settled(generationId: string, timeoutMs = 20_000): Promise<Json> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const g = (await su.query("select * from app.ai_generations where id = $1", [generationId])).rows[0];
    if (g && g.status !== "running") return g;
    if (Date.now() > until) throw new Error(`generation ${generationId} still running`);
    await sleep(50);
  }
}

/** Waits until nothing runs in the chat (a queued turn may follow the first one). */
async function idle(chatId: string, timeoutMs = 20_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const n = (
      await su.query(
        "select count(*)::int as n from app.ai_generations where conversation_id = $1 and status = 'running'",
        [chatId],
      )
    ).rows[0].n;
    if (n === 0) return;
    if (Date.now() > until) throw new Error(`chat ${chatId} still generating`);
    await sleep(50);
  }
}

/** The chat's title once the first answer's auto title landed (it replaces the heuristic one). */
async function autoTitled(chatId: string, timeoutMs = 10_000): Promise<string> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const r = (
      await su.query(
        "select c.name, a.title_source from app.conversations c join app.ai_chats a on a.conversation_id = c.id where c.id = $1",
        [chatId],
      )
    ).rows[0];
    if (r?.title_source === "auto") return r.name as string;
    if (Date.now() > until) throw new Error(`chat ${chatId} never got its auto title`);
    await sleep(50);
  }
}

async function meId(client: TestClient): Promise<string> {
  return ((await ok(client.request("GET", "/api/v1/me"))).user as Json).id as string;
}

const notificationsOf = async (userId: string, chatId: string) =>
  (
    await su.query(
      "select kind, message_id, actor_kind, actor_id, read_at from app.notifications where user_id = $1 and conversation_id = $2 order by created_at, id",
      [userId, chatId],
    )
  ).rows as Array<{
    kind: string;
    message_id: string;
    actor_kind: string;
    actor_id: string | null;
    read_at: Date | null;
  }>;

const notificationCount = async (chatId: string) =>
  (await su.query("select count(*)::int as n from app.notifications where conversation_id = $1", [chatId]))
    .rows[0].n as number;

const lastNotice = async (chatId: string) =>
  (
    await su.query(
      "select id, seq, body from app.messages where conversation_id = $1 and author_kind = 'system' order by seq desc limit 1",
      [chatId],
    )
  ).rows[0] as { id: string; seq: string; body: string };

const memberIds = async (chatId: string) =>
  (
    await su.query(
      "select member_id from app.conversation_members where conversation_id = $1 and member_kind = 'user'",
      [chatId],
    )
  ).rows.map((r) => r.member_id as string);

const lastSeqOf = async (chatId: string) =>
  Number(
    (
      await su.query("select coalesce(max(seq), 0) as s from app.messages where conversation_id = $1", [
        chatId,
      ])
    ).rows[0].s,
  );

const listed = async (as: TestClient, scope: "mine" | "shared", chatId: string) =>
  ((await ok(as.request("GET", `/api/v1/ai-chats?scope=${scope}`))).chats as Json[]).find(
    (c) => c.id === chatId,
  );

const inbox = async (as: TestClient, filter: "all" | "mentions" = "all") =>
  ok(as.request("GET", `/api/v1/notifications?filter=${filter}`));

/** `ai_chat.updated` payloads of one chat on a `user:` subscription. */
const updatesOf = (s: ConvSubscription, chatId: string) =>
  s
    .durable(EventTypes.aiChatUpdated)
    .map((f) => (f.data as Json).chat as Json)
    .filter((c) => c.id === chatId);

beforeAll(async () => {
  stack = await startAiStack();
  su = new pg.Client({ connectionString: stack.db.superuserUrl });
  await su.connect();
  victor = new TestClient(stack.baseUrl);
  await ok(
    victor.request("POST", "/api/v1/setup", {
      token: TEST_SETUP_TOKEN,
      name: "Víctor Ruiz",
      email: "victor@example.test",
      password: "correct-horse-battery",
      orgName: "Autofy Labs",
    }),
  );
  victorId = await meId(victor);
  ({ client: alex, userId: alexId } = await invite(
    stack,
    victor,
    "alex@example.test",
    "Alex Kim",
    "developer",
  ));
  ({ client: sam, userId: samId } = await invite(
    stack,
    victor,
    "sam@example.test",
    "Sam Rivera",
    "standard",
  ));
  ({ client: riley, userId: rileyId } = await invite(
    stack,
    victor,
    "riley@example.test",
    "Riley Park",
    "developer",
  ));
  ({ client: jo, userId: joId } = await invite(stack, victor, "jo@example.test", "Jo Marsh", "standard"));
  ({ client: ada } = await invite(stack, victor, "ada@example.test", "Ada Admin", "admin"));
  for (const c of [victor, alex, sam, riley]) await seedPlan(c);
  const engineering = (
    await ok(
      victor.request("POST", "/api/v1/units", { kind: "department", name: "Engineering", parentId: null }),
    )
  ).id as string;
  backendUnit = (
    await ok(
      victor.request("POST", "/api/v1/units", { kind: "team", name: "Backend", parentId: engineering }),
    )
  ).id as string;
  await ok(victor.request("POST", `/api/v1/units/${backendUnit}/members`, { userId: rileyId }));
}, 180_000);

afterAll(async () => {
  await su?.end();
  await stack?.stop();
});

describe("tracer: Víctor shares with Alex — notification, Shared with me, unread, read marker", () => {
  let chatId: string;
  let title: string;
  let alexUser: ConvSubscription;

  it("a person grant notifies Alex once: ai_chat_shared on the notice row, live on user:<alex>, titled", async () => {
    const first = await ok(createChat(victor, "Design the payments ledger"), 201);
    chatId = first.chat.id;
    expect((await settled(first.generation.id)).status).toBe("completed");
    title = await autoTitled(chatId);
    alexUser = await subscribeTopic(stack.baseUrl, alex, `user:${alexId}`);

    await ok(grant(victor, chatId, { kind: "user", id: alexId }), 201);
    const notice = await lastNotice(chatId);
    expect(notice.body).toBe("Víctor Ruiz shared this chat with Alex Kim · Can chat");
    expect(await notificationsOf(alexId, chatId)).toEqual([
      {
        kind: "ai_chat_shared",
        message_id: notice.id,
        actor_kind: "user",
        actor_id: victorId,
        read_at: null,
      },
    ]);

    await alexUser.waitFor(() => alexUser.durable(EventTypes.notificationCreated).length > 0);
    const created = alexUser.durable(EventTypes.notificationCreated)[0]!.data as Json;
    expect(created.notification).toMatchObject({
      kind: "ai_chat_shared",
      messageId: notice.id,
      threadRootId: null,
      actor: { kind: "user", id: victorId, displayName: "Víctor Ruiz" },
      conversation: { id: chatId, kind: "ai_chat", label: title, name: title },
      readAt: null,
    });
    // Ids and the actor only are stored (Phase 4 rule): no body column exists to fill.
    const columns = (await su.query("select * from app.notifications limit 0")).fields.map((f) => f.name);
    expect(columns).not.toContain("body");
  });

  it("a level change (re-grant) adds no second notification; Alex's inbox lists it under Mentions and All", async () => {
    await ok(grant(victor, chatId, { kind: "user", id: alexId }, "view"));
    await ok(grant(victor, chatId, { kind: "user", id: alexId }, "chat"));
    expect(await notificationsOf(alexId, chatId)).toHaveLength(1);
    for (const filter of ["all", "mentions"] as const) {
      const box = await inbox(alex, filter);
      const item = (box.items as Json[]).find((n) => n.conversation.id === chatId);
      expect(item).toMatchObject({
        kind: "ai_chat_shared",
        actor: { id: victorId, displayName: "Víctor Ruiz" },
        conversation: { kind: "ai_chat", label: title },
      });
      expect(box.unreadCount).toBe(1);
    }
  });

  it("team and organization grants notify nobody individually", async () => {
    const other = await ok(createChat(victor, "Org wide retro notes"), 201);
    await settled(other.generation.id);
    await ok(grant(victor, other.chat.id, { kind: "unit", id: backendUnit }), 201);
    await ok(grant(victor, other.chat.id, { kind: "org" }, "view"), 201);
    expect(await notificationCount(other.chat.id)).toBe(0);

    // The main chat: Sam by name (notified), the Backend team (nobody).
    await ok(grant(victor, chatId, { kind: "user", id: samId }), 201);
    await ok(grant(victor, chatId, { kind: "unit", id: backendUnit }), 201);
    expect(await notificationsOf(samId, chatId)).toHaveLength(1);
    expect(await notificationsOf(rileyId, chatId)).toEqual([]);
    expect(await notificationCount(chatId)).toBe(2);
  });

  it("Víctor writes twice → Alex's Shared with me shows unreadCount 2; the owner's shared chat carries his own", async () => {
    await ok(send(victor, chatId, "First note for the team", { askAi: false }), 202);
    await ok(send(victor, chatId, "Second note for the team", { askAi: false }), 202);
    expect((await listed(alex, "shared", chatId))?.unreadCount).toBe(2);
    expect((await listed(victor, "mine", chatId))?.unreadCount).toBe(0);
  });

  it("Víctor's solo chats never carry unreadCount", async () => {
    const solo = await ok(createChat(victor, "Private scratchpad"), 201);
    await settled(solo.generation.id);
    const row = await listed(victor, "mine", solo.chat.id);
    expect(row).toBeDefined();
    expect(row).not.toHaveProperty("unreadCount");
    expect(await notificationCount(solo.chat.id)).toBe(0);
  });

  it("POST /ai-chats/:id/read → 204, conversation.read on user:<alex>, unread 0 and the share notification read", async () => {
    const seq = await lastSeqOf(chatId);
    const res = await markRead(alex, chatId, seq);
    expect(res.status).toBe(204);
    await alexUser.waitFor(() =>
      alexUser.durable(EventTypes.conversationRead).some((f) => (f.data as Json).conversationId === chatId),
    );
    const ev = alexUser
      .durable(EventTypes.conversationRead)
      .filter((f) => (f.data as Json).conversationId === chatId)
      .at(-1)!.data as Json;
    expect(ev).toMatchObject({ conversationId: chatId, lastReadSeq: seq, unreadCount: 0, mentionCount: 0 });
    expect((await listed(alex, "shared", chatId))?.unreadCount).toBe(0);
    expect((await inbox(alex)).unreadCount).toBe(0);
    // Monotonic: an older seq never moves the cursor back.
    expect((await markRead(alex, chatId, 1)).status).toBe(204);
    const cursor = (
      await su.query(
        "select last_read_seq from app.conversation_members where conversation_id = $1 and member_id = $2",
        [chatId, alexId],
      )
    ).rows[0].last_read_seq;
    expect(Number(cursor)).toBe(seq);
  });

  it("Riley (Backend, no row yet) marking read joins him; his unread then counts", async () => {
    expect(await memberIds(chatId)).not.toContain(rileyId);
    const before = await listed(riley, "shared", chatId);
    expect(before).toBeDefined();
    expect(before).not.toHaveProperty("unreadCount");
    expect((await markRead(riley, chatId, await lastSeqOf(chatId))).status).toBe(204);
    expect(await memberIds(chatId)).toContain(rileyId);
    expect((await listed(riley, "shared", chatId))?.unreadCount).toBe(0);
    await ok(send(victor, chatId, "One more for everyone", { askAi: false }), 202);
    expect((await listed(riley, "shared", chatId))?.unreadCount).toBe(1);
  });

  it("the read marker never joins someone who cannot read the chat (hidden 404, no row)", async () => {
    for (const who of [jo, ada]) expect((await markRead(who, chatId, 1)).status).toBe(404);
    expect(await memberIds(chatId)).not.toContain(joId);
    expect((await alex.request("POST", `/api/v1/ai-chats/${chatId}/read`, { seq: -1 })).status).toBe(400);
  });

  it("an @mention of Sam notifies Sam (mention); a mention of Jo, who cannot read, notifies nobody", async () => {
    const toSam = await ok(send(victor, chatId, "@sam please review the ledger", { askAi: false }), 202);
    const samRows = await notificationsOf(samId, chatId);
    expect(samRows.filter((r) => r.kind === "mention")).toEqual([
      expect.objectContaining({ message_id: toSam.userMessage.id, actor_id: victorId }),
    ]);
    const toJo = await ok(send(victor, chatId, "@jo can you check this?", { askAi: false }), 202);
    expect(
      (
        await su.query("select count(*)::int as n from app.notifications where message_id = $1", [
          toJo.userMessage.id,
        ])
      ).rows[0].n,
    ).toBe(0);
    expect(await notificationsOf(joId, chatId)).toEqual([]);
    // Alex is not mentioned: nothing new for him.
    expect(await notificationsOf(alexId, chatId)).toHaveLength(1);
  });

  it("after a revoke Alex's inbox drops the chat's notifications and their unread count", async () => {
    await ok(send(victor, chatId, "@alex one last thing", { askAi: false }), 202);
    const before = await inbox(alex);
    expect((before.items as Json[]).filter((n) => n.conversation.id === chatId).length).toBe(2);
    expect(before.unreadCount).toBe(1);
    const grants = (await ok(victor.request("GET", `/api/v1/ai-chats/${chatId}/grants`))).grants as Json[];
    const alexGrant = grants.find((g) => g.subject.kind === "user" && g.subject.id === alexId)!;
    expect((await victor.request("DELETE", `/api/v1/ai-chats/${chatId}/grants/${alexGrant.id}`)).status).toBe(
      204,
    );
    const after = await inbox(alex);
    expect((after.items as Json[]).filter((n) => n.conversation.id === chatId)).toEqual([]);
    expect(after.unreadCount).toBe(0);
    expect((await inbox(alex, "mentions")).unreadCount).toBe(0);
    alexUser.close();
  });
});

describe("every participant's sidebar follows the shared chat live, each with their own access", () => {
  let chatId: string;
  let victorUser: ConvSubscription;
  let alexUser: ConvSubscription;
  let samUser: ConvSubscription;
  let rileyUser: ConvSubscription;
  const SUMMARY_ONLY = ["settings", "tools", "viewerCan", "instructions", "usePersonalInstructions"];

  /** Waits until each subscription holds an update of the chat matching `pred`; returns the latest per person. */
  async function everyoneHears(pred: (c: Json) => boolean): Promise<Json[]> {
    const subs = [victorUser, alexUser, samUser];
    for (const s of subs) await s.waitFor(() => updatesOf(s, chatId).some(pred), 15_000);
    return subs.map((s) => updatesOf(s, chatId).filter(pred).at(-1) as Json);
  }

  it("setup: a draft shared with Alex, Sam (by name) and Backend (Riley never joins); Víctor asks first", async () => {
    chatId = (await ok(victor.request("POST", "/api/v1/ai-chats/drafts", {}), 201)).id;
    await ok(grant(victor, chatId, { kind: "user", id: alexId }), 201);
    await ok(grant(victor, chatId, { kind: "user", id: samId }), 201);
    await ok(grant(victor, chatId, { kind: "unit", id: backendUnit }), 201);
    victorUser = await subscribeTopic(stack.baseUrl, victor, `user:${victorId}`);
    alexUser = await subscribeTopic(stack.baseUrl, alex, `user:${alexId}`);
    samUser = await subscribeTopic(stack.baseUrl, sam, `user:${samId}`);
    rileyUser = await subscribeTopic(stack.baseUrl, riley, `user:${rileyId}`);
    const first = await ok(send(victor, chatId, "Plan the quarterly offsite agenda"), 201);
    await settled(first.generation.id);
  });

  it("the auto title reaches all three", async () => {
    const [v, a, s] = await everyoneHears((c) => c.titleSource === "auto");
    expect(v).toMatchObject({ access: "owner", shared: true, owner: { id: victorId } });
    expect(a).toMatchObject({ access: "chat", shared: true, owner: { id: victorId } });
    expect(s).toMatchObject({ access: "chat", shared: true, owner: { id: victorId } });
    expect(new Set([v!.title, a!.title, s!.title]).size).toBe(1);
  });

  it("Alex asks: generating true for Víctor (owner), Alex and Sam (chat), then false at finalize", async () => {
    const mark = updatesOf(victorUser, chatId).length;
    const res = await ok(send(alex, chatId, "What should day two look like?"), 201);
    const started = await everyoneHears((c) => c.generating === true && c.lastActivityAt !== undefined);
    expect(started.map((c) => c.access)).toEqual(["owner", "chat", "chat"]);
    await settled(res.generation.id);
    await idle(chatId);
    const [v, a, s] = await everyoneHears((c) => c.generating === false);
    expect([v!.access, a!.access, s!.access]).toEqual(["owner", "chat", "chat"]);
    // The last update each person heard says nothing runs any more.
    for (const sub of [victorUser, alexUser, samUser]) {
      await sub.waitFor(() => updatesOf(sub, chatId).at(-1)?.generating === false, 15_000);
    }
    expect(updatesOf(victorUser, chatId).length).toBeGreaterThan(mark);
    // Alex and Sam count the answer (and Víctor's view keeps its own count): unread is per recipient.
    expect(updatesOf(samUser, chatId).at(-1)!.unreadCount).toBeGreaterThan(0);
  });

  it("a rename by Víctor reaches all three", async () => {
    await ok(victor.request("PATCH", `/api/v1/ai-chats/${chatId}`, { title: "Offsite, final plan" }));
    const heard = await everyoneHears((c) => c.title === "Offsite, final plan" && c.titleSource === "user");
    expect(heard.map((c) => c.access)).toEqual(["owner", "chat", "chat"]);
  });

  it("a regenerate reaches all three (generating again)", async () => {
    const before = [victorUser, alexUser, samUser].map((s) => updatesOf(s, chatId).length);
    const res = await ok(victor.request("POST", `/api/v1/ai-chats/${chatId}/regenerate`, {}), 201);
    await settled(res.generation.id);
    const subs = [victorUser, alexUser, samUser];
    for (const [i, s] of subs.entries()) {
      await s.waitFor(
        () =>
          updatesOf(s, chatId)
            .slice(before[i])
            .some((c) => c.generating === true),
        15_000,
      );
    }
  });

  it("no summary carries owner-only settings; Riley (Backend, never joined) heard nothing", async () => {
    for (const s of [victorUser, alexUser, samUser]) {
      for (const c of updatesOf(s, chatId)) for (const key of SUMMARY_ONLY) expect(c).not.toHaveProperty(key);
    }
    await sleep(300);
    expect(updatesOf(rileyUser, chatId)).toEqual([]);
  });

  it("a solo chat still emits only to its owner, with the Phase 5 payload", async () => {
    const solo = await ok(createChat(victor, "Just for me: draft the budget"), 201);
    await settled(solo.generation.id);
    await victorUser.waitFor(
      () => updatesOf(victorUser, solo.chat.id).some((c) => c.generating === false),
      15_000,
    );
    for (const c of updatesOf(victorUser, solo.chat.id)) {
      expect(c).not.toHaveProperty("access");
      expect(c).not.toHaveProperty("unreadCount");
    }
    await sleep(300);
    for (const s of [alexUser, samUser, rileyUser]) expect(updatesOf(s, solo.chat.id)).toEqual([]);
    for (const s of [victorUser, alexUser, samUser, rileyUser]) s.close();
  });
});
