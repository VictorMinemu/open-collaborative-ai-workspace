import { randomUUID } from "node:crypto";
import { MODULE_CATALOG, type ModuleId } from "@ocw/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_SETUP_TOKEN, TestClient } from "./testing";
import { type AiStack, seedPlan, startAiStack } from "./testing-ai";
import { invite } from "./testing-workzone";

/**
 * Phase 07.3 (ADR-0024, ACCESS-03): a module is turned off by ordinary catalog deny rows written through the existing
 * rules API, and the API then refuses it on every direct path. AI chats: the readable set (`chat/access.ts`) decides
 * `ai_chat.read`, so a denied member loses her own chats by URL, the chats shared with her, AI chat search hits and AI
 * chat notifications; a plain `ai_chat.use` deny keeps today's semantics. Work Zone and Bots: the routes' own resolver
 * decisions refuse a denied member and a denied admin, device hygiene stays, and a department-wide row reaches the
 * members of its teams only. Real PostgreSQL + Redis, the in-process fake model; no real provider is ever called (later
 * messages are sent with `askAi: false`).
 *
 * Cast: Víctor (admin, setup), Ada (second admin), Dana (developer), Sam (standard), Riley (developer, Backend team
 * under Engineering), Olga (developer, Sales department).
 */

let stack: AiStack;
let su: pg.Client;
let victor: TestClient;
let dana: TestClient;
let sam: TestClient;
let ada: TestClient;
let riley: TestClient;
let olga: TestClient;
let danaId: string;
let samId: string;
let adaId: string;
let olgaId: string;
let engineeringId: string;
let teamBotId: string;

const CELL_TOKEN = "ocw-test-cell-token-module-access-0123456789";

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
type Json = Record<string, any>;
type Res = { status: number; body: Record<string, unknown> | null };

const PLAN_MODEL = { backend: "chatgpt_plan", provider: "openai", modelId: "gpt-6-astra" } as const;
const cid = () => `cm-${randomUUID()}`;

async function ok(res: Promise<Res>, status = 200) {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as Json;
}

async function fails(res: Promise<Res>, status: number) {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return (r.body as Json).error as { code: string; message: string; details?: Json };
}

/**
 * One deny row per catalog pattern of `module` for a user (or everyone), optionally scoped to a unit, through
 * `POST /permission-rules`; returns the ids.
 */
async function denyModule(module: ModuleId, subject: string | "everyone", scopeUnitId: string | null = null) {
  const ids: string[] = [];
  for (const permission of MODULE_CATALOG[module].patterns) {
    const rule = await ok(
      victor.request("POST", "/api/v1/permission-rules", {
        ...(scopeUnitId ? { scopeUnitId } : {}),
        ...(subject === "everyone"
          ? { subjectKind: "everyone" }
          : { subjectKind: "user", subjectId: subject }),
        permission,
        effect: "deny",
      }),
    );
    ids.push(rule.id as string);
  }
  return ids;
}

async function deleteRules(ids: readonly string[]) {
  for (const id of ids) await ok(victor.request("DELETE", `/api/v1/permission-rules/${id}`));
}

const myPermissions = async (c: TestClient) =>
  (await ok(c.request("GET", "/api/v1/me/permissions"))).permissions as string[];

/** An AI chat with one answered message (the in-process fake model), so lists, search and notifications see it. */
async function chatWithMessage(owner: TestClient, body: string): Promise<string> {
  const created = await ok(
    owner.request("POST", "/api/v1/ai-chats", { clientMessageId: cid(), body, model: PLAN_MODEL }),
    201,
  );
  await settled(created.generation.id as string);
  return created.chat.id as string;
}

async function settled(generationId: string, timeoutMs = 20_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const g = (await su.query("select status from app.ai_generations where id = $1", [generationId])).rows[0];
    if (g && g.status !== "running") return;
    if (Date.now() > until) throw new Error(`generation ${generationId} still running`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const send = (as: TestClient, chatId: string, body: string) =>
  as.request("POST", `/api/v1/ai-chats/${chatId}/messages`, {
    clientMessageId: cid(),
    body,
    model: PLAN_MODEL,
    askAi: false,
  });

const grant = (owner: TestClient, chatId: string, userId: string, level: "chat" | "view") =>
  ok(
    owner.request("POST", `/api/v1/ai-chats/${chatId}/grants`, {
      subject: { kind: "user", id: userId },
      level,
    }),
    201,
  );

const listIds = async (as: TestClient, scope: "mine" | "shared") =>
  ((await ok(as.request("GET", `/api/v1/ai-chats?scope=${scope}`))).chats as Json[]).map(
    (c) => c.id as string,
  );

/** AI chat conversations a search for `q` surfaces (message hits and the overview's AI chats group). */
async function aiChatHits(as: TestClient, q: string): Promise<string[]> {
  const overview = await ok(as.request("GET", `/api/v1/search?q=${encodeURIComponent(q)}`));
  const messages = await ok(as.request("GET", `/api/v1/search/messages?q=${encodeURIComponent(q)}`));
  return [
    ...((overview.messages as Json[]) ?? [])
      .filter((h) => h.conversation.kind === "ai_chat")
      .map((h) => h.conversation.id),
    ...((overview.aiChats as Json[] | undefined) ?? []).map((c) => c.id),
    ...((messages.hits as Json[]) ?? [])
      .filter((h) => h.conversation.kind === "ai_chat")
      .map((h) => h.conversation.id),
  ] as string[];
}

/** `app.notifications` rows of one user for one message. */
const notificationRows = async (userId: string, messageId: string) =>
  (
    await su.query("select kind from app.notifications where user_id = $1 and message_id = $2", [
      userId,
      messageId,
    ])
  ).rows as Array<{ kind: string }>;

/** `notification.created` events on `user:<id>` for one message. */
const notificationEvents = async (userId: string, messageId: string) =>
  (
    await su.query(
      `select payload from app.stream_events
        where stream_id = $1 and type = 'notification.created' and payload->'notification'->>'messageId' = $2`,
      [`user:${userId}`, messageId],
    )
  ).rows as Json[];

const aiChatInboxItems = async (as: TestClient) =>
  ((await ok(as.request("GET", "/api/v1/notifications?filter=all"))).items as Json[]).filter(
    (n) => n.conversation.kind === "ai_chat",
  );

beforeAll(async () => {
  stack = await startAiStack({ env: { OCW_CELL_TOKEN: CELL_TOKEN } });
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
  ({ client: dana, userId: danaId } = await invite(
    stack,
    victor,
    "dana@example.test",
    "Dana Dev",
    "developer",
  ));
  ({ client: sam, userId: samId } = await invite(
    stack,
    victor,
    "sam@example.test",
    "Sam Rivera",
    "standard",
  ));
  ({ client: ada, userId: adaId } = await invite(stack, victor, "ada@example.test", "Ada Admin", "admin"));
  const { client: rileyClient, userId: rileyId } = await invite(
    stack,
    victor,
    "riley@example.test",
    "Riley Park",
    "developer",
  );
  riley = rileyClient;
  const { client: olgaClient, userId: olgaUserId } = await invite(
    stack,
    victor,
    "olga@example.test",
    "Olga Sales",
    "developer",
  );
  olga = olgaClient;
  olgaId = olgaUserId;
  for (const c of [dana, sam]) await seedPlan(c);

  engineeringId = (
    await ok(
      victor.request("POST", "/api/v1/units", { kind: "department", name: "Engineering", parentId: null }),
    )
  ).id as string;
  const backendId = (
    await ok(
      victor.request("POST", "/api/v1/units", { kind: "team", name: "Backend", parentId: engineeringId }),
    )
  ).id as string;
  const salesId = (
    await ok(victor.request("POST", "/api/v1/units", { kind: "department", name: "Sales", parentId: null }))
  ).id as string;
  await ok(victor.request("POST", `/api/v1/units/${backendId}/members`, { userId: rileyId }));
  await ok(victor.request("POST", `/api/v1/units/${salesId}/members`, { userId: olgaId }));

  teamBotId = (
    await ok(
      victor.request("POST", "/api/v1/agents", {
        name: "Archie",
        username: "archie",
        instructions: "You are Archie.",
        modelProvider: "mock",
        modelId: "mock-1",
      }),
    )
  ).id as string;
}, 180_000);

afterAll(async () => {
  await su?.end();
  await stack?.stop();
});

describe("AI chats module off (ai_chat.read at the readable set)", () => {
  let danaChat: string;
  let samChat: string;
  let ruleIds: string[];

  it("setup and positive control: Dana reads, lists, finds and is notified about her AI chats", async () => {
    danaChat = await chatWithMessage(dana, "Zanzibar ledger reconciliation plan");
    await grant(dana, danaChat, samId, "chat");
    samChat = await chatWithMessage(sam, "Offsite agenda for the quarter");
    await grant(sam, samChat, danaId, "view");

    await ok(dana.request("GET", `/api/v1/ai-chats/${danaChat}`));
    await ok(dana.request("GET", `/api/v1/ai-chats/${samChat}`));
    expect(await listIds(dana, "mine")).toContain(danaChat);
    expect(await listIds(dana, "shared")).toContain(samChat);
    expect(await aiChatHits(dana, "Zanzibar")).toContain(danaChat);
    expect(await myPermissions(dana)).toEqual(expect.arrayContaining(["ai_chat.read", "ai_chat.use"]));

    // Sam's message in Dana's chat that mentions her: one notification row and one live event for Dana.
    const sent = await ok(send(sam, danaChat, "@dana the ledger numbers are in"), 202);
    const messageId = sent.userMessage.id as string;
    expect(await notificationRows(danaId, messageId)).toEqual([{ kind: "mention" }]);
    expect(await notificationEvents(danaId, messageId)).toHaveLength(1);
    expect((await aiChatInboxItems(dana)).map((n) => n.conversation.id)).toContain(danaChat);
  });

  it("the catalog rows for Dana are ordinary deny rules written through POST /permission-rules", async () => {
    ruleIds = await denyModule("ai_chats", danaId);
    expect(ruleIds).toHaveLength(MODULE_CATALOG.ai_chats.patterns.length);
    const rules = (await ok(victor.request("GET", "/api/v1/permission-rules"))).rules as Json[];
    for (const permission of MODULE_CATALOG.ai_chats.patterns) {
      expect(rules).toContainEqual(
        expect.objectContaining({
          scopeUnitId: null,
          subjectKind: "user",
          subjectId: danaId,
          permission,
          tool: null,
          effect: "deny",
        }),
      );
    }
  });

  it("Dana's own chat by URL is the same 404 as a missing chat", async () => {
    const own = await fails(dana.request("GET", `/api/v1/ai-chats/${danaChat}`), 404);
    const missing = await fails(dana.request("GET", `/api/v1/ai-chats/${randomUUID()}`), 404);
    expect(own).toEqual(missing);
    await fails(dana.request("GET", `/api/v1/ai-chats/${samChat}`), 404);
  });

  it("both lists are empty and search finds no AI chat", async () => {
    expect(await listIds(dana, "mine")).toEqual([]);
    expect(await listIds(dana, "shared")).toEqual([]);
    expect(await aiChatHits(dana, "Zanzibar")).toEqual([]);
    expect(await aiChatHits(dana, "Offsite")).toEqual([]);
  });

  it("GET /me/permissions mirrors the rows: no ai_chat grain at all", async () => {
    const held = await myPermissions(dana);
    expect(held.filter((p) => p.startsWith("ai_chat."))).toEqual([]);
    expect(held).toContain("channel.read");
  });

  it("a new mention in her chat writes no notification and no live event; the inbox lists no AI chat", async () => {
    const sent = await ok(send(sam, danaChat, "@dana one more question about the ledger"), 202);
    const messageId = sent.userMessage.id as string;
    expect(await notificationRows(danaId, messageId)).toEqual([]);
    expect(await notificationEvents(danaId, messageId)).toEqual([]);
    expect(await aiChatInboxItems(dana)).toEqual([]);
  });

  it("Sam is unaffected", async () => {
    await ok(sam.request("GET", `/api/v1/ai-chats/${danaChat}`));
    expect(await listIds(sam, "shared")).toContain(danaChat);
    expect(await listIds(sam, "mine")).toContain(samChat);
    expect(await myPermissions(sam)).toEqual(expect.arrayContaining(["ai_chat.read", "ai_chat.use"]));
  });

  it("after the rows are deleted Dana reads both chats again", async () => {
    await deleteRules(ruleIds);
    await ok(dana.request("GET", `/api/v1/ai-chats/${danaChat}`));
    await ok(dana.request("GET", `/api/v1/ai-chats/${samChat}`));
    expect(await listIds(dana, "mine")).toContain(danaChat);
    expect(await listIds(dana, "shared")).toContain(samChat);
    expect(await aiChatHits(dana, "Zanzibar")).toContain(danaChat);
  });

  it("regression pin: a plain ai_chat.use deny still lets Dana read the chat Sam shared (research Gap 1)", async () => {
    const rule = await ok(
      victor.request("POST", "/api/v1/permission-rules", {
        subjectKind: "user",
        subjectId: danaId,
        permission: "ai_chat.use",
        effect: "deny",
      }),
    );
    try {
      await ok(dana.request("GET", `/api/v1/ai-chats/${samChat}`));
      expect(await listIds(dana, "shared")).toContain(samChat);
      const held = await myPermissions(dana);
      expect(held).toContain("ai_chat.read");
      expect(held).not.toContain("ai_chat.use");
    } finally {
      await deleteRules([rule.id as string]);
    }
  });
});

describe("Work Zone module off: direct calls refused, device hygiene kept", () => {
  it("positive control: Dana (developer) lists sessions and may pair", async () => {
    await ok(dana.request("GET", "/api/v1/work-sessions"));
    expect(await myPermissions(dana)).toEqual(
      expect.arrayContaining(["work_session.read", "work_session.create", "device.pair", "device.read"]),
    );
  });

  it("with the Work Zone rows on Dana every Work Zone call is 403; GET /devices stays 200", async () => {
    const ids = await denyModule("work_zone", danaId);
    try {
      const list = await fails(dana.request("GET", "/api/v1/work-sessions"), 403);
      expect(list.details).toMatchObject({
        permission: "work_session.read",
        layer: "user",
        reason: "denied_by_rule",
      });
      const create = await fails(
        dana.request("POST", "/api/v1/work-sessions", { projectId: randomUUID() }),
        403,
      );
      expect(create.details).toMatchObject({ permission: "work_session.create", layer: "user" });
      const pair = await fails(dana.request("POST", "/api/v1/devices/enrollments"), 403);
      expect(pair.details).toMatchObject({ permission: "device.pair", layer: "user" });
      await ok(dana.request("GET", "/api/v1/devices"));
      const held = await myPermissions(dana);
      expect(held.filter((p) => p.startsWith("work_session."))).toEqual([]);
      expect(held).not.toContain("device.pair");
      expect(held).toContain("device.read");
    } finally {
      await deleteRules(ids);
    }
    await ok(dana.request("GET", "/api/v1/work-sessions"));
  });

  it("deny beats admin: the same rows on Ada (admin) refuse her too", async () => {
    await ok(ada.request("GET", "/api/v1/work-sessions"));
    const ids = await denyModule("work_zone", adaId);
    try {
      const err = await fails(ada.request("GET", "/api/v1/work-sessions"), 403);
      expect(err.details).toMatchObject({ permission: "work_session.read", layer: "user" });
      await fails(ada.request("POST", "/api/v1/devices/enrollments"), 403);
      await ok(ada.request("GET", "/api/v1/devices"));
      const held = await myPermissions(ada);
      expect(held).not.toContain("work_session.read");
      // Governance and hygiene stay with the admin.
      expect(held).toEqual(
        expect.arrayContaining(["work_zone.manage", "device.revoke", "unit.modules.manage"]),
      );
      // Víctor, the other admin, is untouched.
      await ok(victor.request("GET", "/api/v1/work-sessions"));
    } finally {
      await deleteRules(ids);
    }
    await ok(ada.request("GET", "/api/v1/work-sessions"));
  });

  it("unit inheritance: Engineering-wide rows refuse Riley (Backend) and leave Olga (Sales) at 200", async () => {
    const ids = await denyModule("work_zone", "everyone", engineeringId);
    try {
      const err = await fails(riley.request("GET", "/api/v1/work-sessions"), 403);
      expect(err.details).toMatchObject({
        permission: "work_session.read",
        layer: "unit",
        reason: "denied_by_rule",
        unitId: engineeringId,
      });
      expect(await myPermissions(riley)).not.toContain("work_session.read");
      await ok(olga.request("GET", "/api/v1/work-sessions"));
      expect(await myPermissions(olga)).toContain("work_session.read");
      // Members of no Engineering unit (Dana, the admins) are untouched.
      await ok(dana.request("GET", "/api/v1/work-sessions"));
      await ok(victor.request("GET", "/api/v1/work-sessions"));
    } finally {
      await deleteRules(ids);
    }
    await ok(riley.request("GET", "/api/v1/work-sessions"));
  });
});

describe("Bots module off: the organization team bot disappears for the denied member", () => {
  const listedBots = async (as: TestClient) =>
    ((await ok(as.request("GET", "/api/v1/agents"))).agents as Json[]).map((a) => a.id as string);

  it("with the Bots rows on Dana GET /agents omits the team bot and GET /agents/:id is 404; Sam keeps it", async () => {
    expect(await listedBots(dana)).toContain(teamBotId);
    await ok(dana.request("GET", `/api/v1/agents/${teamBotId}`));
    const ids = await denyModule("bots", danaId);
    try {
      expect(await listedBots(dana)).not.toContain(teamBotId);
      // Hidden reads exactly like missing: same status, code and message (no existence oracle, 07.3-01 open item 5).
      const missingId = randomUUID();
      expect(await fails(dana.request("GET", `/api/v1/agents/${teamBotId}`), 404)).toEqual(
        await fails(dana.request("GET", `/api/v1/agents/${missingId}`), 404),
      );
      expect(await fails(dana.request("POST", `/api/v1/agents/${teamBotId}/dm`), 404)).toEqual(
        await fails(dana.request("POST", `/api/v1/agents/${missingId}/dm`), 404),
      );
      const held = await myPermissions(dana);
      for (const p of ["bot.read", "bot.create_personal", "bot.internet", "bot.tool.use"])
        expect(held).not.toContain(p);
      expect(await listedBots(sam)).toContain(teamBotId);
      expect(await myPermissions(sam)).toContain("bot.read");
    } finally {
      await deleteRules(ids);
    }
    expect(await listedBots(dana)).toContain(teamBotId);
  });

  it("deny beats admin: the Bots rows on Ada hide the team bot from her too", async () => {
    const ids = await denyModule("bots", adaId);
    try {
      expect(await listedBots(ada)).not.toContain(teamBotId);
      await fails(ada.request("GET", `/api/v1/agents/${teamBotId}`), 404);
      const held = await myPermissions(ada);
      expect(held).not.toContain("bot.read");
      expect(held).toContain("bot.manage");
    } finally {
      await deleteRules(ids);
    }
  });
});
