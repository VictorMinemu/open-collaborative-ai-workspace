import { randomUUID } from "node:crypto";
import { AgentMentionEvent } from "@ocw/contracts";
import { conversations } from "@ocw/db";
import { eq } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";
import { createPermissionService } from "../organization";
import { createBoardCard } from "./board/service";

/**
 * Phase 07.17 (D-07, D-17, D-18, PD-13, AFO-04): `@team` on channel posts is a stored, structural mention
 * `{ kind: "unit", id }`, resolved by the server for units the author (or a bot's turn human) may read, never in DMs,
 * group DMs or AI chats, after bots and people (precedence), at most three per bot message. It never reaches the cell's
 * mention list and never wakes a bot (ADR-0027, P4). Real PostgreSQL + Redis.
 */

const CELL_TOKEN = "ocw-test-cell-token-team-mentions-0123456789ab";
const ADMIN = {
  name: "Víctor Ruiz",
  email: "victor@example.test",
  password: "correct-horse-battery",
  orgName: "Autofy Labs",
};

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
type Json = Record<string, any>;

let stack: TestStack;
let su: pg.Client;
let admin: TestClient;
let ana: TestClient;
let orgId: string;
let anaId: string;
let benId: string;
let ordersId: string;
let scoutId: string;
let sam: TestClient;
let samId: string;
const unit: Record<string, string> = {};
const people: Record<string, string> = {};

async function ok(res: Promise<{ status: number; body: Record<string, unknown> | null }>, status = 200) {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as Json;
}

async function joinAs(email: string, name: string, role: "developer" | "standard") {
  const inv = await ok(admin.request("POST", "/api/v1/invitations", { email, role }));
  const c = new TestClient(stack.baseUrl);
  const acc = await ok(
    c.request("POST", `/api/v1/invitations/${inv.id}/accept`, { name, password: "another-long-password" }),
  );
  return [c, acc.user.id as string] as const;
}

const say = (c: TestClient, conversationId: string, body: string, extra: Json = {}) =>
  ok(c.request("POST", `/api/v1/conversations/${conversationId}/messages`, { body, ...extra }));

const storedMentions = async (messageId: string) =>
  (await su.query("select mentions from app.messages where id = $1", [messageId])).rows[0]
    ?.mentions as Json[];

/** `agent.mention.v1` events on this organization's cell stream (with their stream seq). */
const cellEvents = async (org = orgId) =>
  (
    await su.query(
      "select seq, payload from app.stream_events where stream_id = $1 and type = 'agent.mention.v1' order by seq",
      [`cell:${org}`],
    )
  ).rows.map((r): Json => ({ ...(r.payload as Json), seq: Number(r.seq) }));

const turnsFor = async (messageId: string) =>
  Number(
    (await su.query("select count(*)::int as n from app.agent_turns where message_id = $1", [messageId]))
      .rows[0].n,
  );

async function createUnit(
  kind: "department" | "team" | "project",
  name: string,
  parentId: string | null = null,
) {
  const u = await ok(admin.request("POST", "/api/v1/units", { kind, name, parentId }));
  return u as { id: string; handle: string };
}

beforeAll(async () => {
  stack = await startTestStack({ env: { OCW_CELL_TOKEN: CELL_TOKEN, OCW_MODEL_PROVIDER: "mock" } });
  su = new pg.Client({ connectionString: stack.db.superuserUrl });
  await su.connect();
  admin = new TestClient(stack.baseUrl);
  const setup = await ok(admin.request("POST", "/api/v1/setup", { token: TEST_SETUP_TOKEN, ...ADMIN }));
  orgId = setup.organization.id;
  [ana, anaId] = await joinAs("ana@example.test", "Ana Ruiz", "standard");
  [, benId] = await joinAs("ben@example.test", "Ben Ito", "standard");
  for (const name of ["cam", "dan", "eva"]) {
    const [, id] = await joinAs(`${name}@example.test`, name.toUpperCase(), "standard");
    people[name] = id;
  }
  [sam, samId] = await joinAs("sam@example.test", "Sam Lee", "standard");

  const it_ = await createUnit("department", "IT");
  unit.it = it_.id;
  for (const name of ["Logistics", "Ops", "Billing", "Support"]) {
    const u = await createUnit("team", name, it_.id);
    expect(u.handle).toBe(name.toLowerCase());
    unit[u.handle] = u.id;
  }
  const project = await createUnit("project", "Ops Project", unit.ops);
  expect(project.handle).toBe("ops-project");
  unit["ops-project"] = project.id;
  // A team whose handle equals a person's: `@ben` stays Ben (precedence agents → users → units, D-18).
  const benTeam = await createUnit("team", "Ben", it_.id);
  expect(benTeam.handle).toBe("ben");
  unit.benTeam = benTeam.id;

  const bot = await ok(
    admin.request("POST", "/api/v1/agents", {
      name: "Scout",
      username: "scout",
      instructions: "You are Scout.",
      modelProvider: "mock",
      modelId: "mock-1",
    }),
  );
  scoutId = bot.id;

  ordersId = (await ok(admin.request("POST", "/api/v1/channels", { name: "orders" }))).id;
  await ok(ana.request("POST", `/api/v1/channels/${ordersId}/join`, {}));
  await ok(admin.request("POST", `/api/v1/channels/${ordersId}/members`, { kind: "agent", id: scoutId }));
  await ok(sam.request("POST", `/api/v1/channels/${ordersId}/join`, {}));
  // Sam may not see the Ops team (an explicit deny on its subtree): the resolver denies `unit.read` there.
  await su.query(
    `insert into app.permission_rules (id, organization_id, scope_unit_id, subject_kind, subject_id, permission, effect)
     values ($1, $2, $3, 'user', $4, 'unit.read', 'deny')`,
    [randomUUID(), orgId, unit.ops, samId],
  );
}, 180_000);

afterAll(async () => {
  await su?.end();
  await stack?.stop();
});

describe("team mentions by a person (07.17 PD-13)", () => {
  it("@logistics in a channel is stored as a unit mention and returned by the API", async () => {
    const msg = await say(ana, ordersId, "@logistics can you check?");
    expect(msg.mentions).toEqual([{ kind: "unit", id: unit.logistics }]);
    expect(await storedMentions(msg.id)).toEqual([{ kind: "unit", id: unit.logistics }]);
    const page = await ok(ana.request("GET", `/api/v1/conversations/${ordersId}/messages`));
    const listed = (page.messages as Json[]).find((m) => m.id === msg.id);
    expect(listed?.mentions).toEqual([{ kind: "unit", id: unit.logistics }]);
    // A team mention alone wakes no bot (ADR-0027): no turn, no cell event.
    expect(await turnsFor(msg.id)).toBe(0);
    expect((await cellEvents()).some((e) => e.message.id === msg.id)).toBe(false);
  });

  it("the same text in a DM stores no unit mention (D-07, E16)", async () => {
    const dm = await ok(ana.request("POST", "/api/v1/dms", { participants: [{ kind: "user", id: benId }] }));
    const msg = await say(ana, dm.id, "@logistics can you check?");
    expect(msg.mentions).toEqual([]);
    expect(await storedMentions(msg.id)).toEqual([]);
  });

  it("precedence: @ben is Ben, a project never resolves, a department does (D-18, E16)", async () => {
    const msg = await say(ana, ordersId, "@ben @ops-project @it @logistics");
    expect(msg.mentions).toEqual([
      { kind: "user", id: benId },
      { kind: "unit", id: unit.it },
      { kind: "unit", id: unit.logistics },
    ]);
  });

  it("a mentioned bot gets its turn, and its event carries only people and bots (P4)", async () => {
    const msg = await say(ana, ordersId, "@scout and @logistics, have a look");
    expect(msg.mentions).toEqual([
      { kind: "agent", id: scoutId },
      { kind: "unit", id: unit.logistics },
    ]);
    const ev = (await cellEvents()).find((e) => e.message.id === msg.id);
    expect(ev, "no delivery for the bot").toBeDefined();
    expect(ev?.message.mentions).toEqual([{ kind: "agent", id: scoutId }]);
    expect(ev?.message.author.id).toBe(anaId);
    expect(AgentMentionEvent.safeParse(ev).success).toBe(true);
    expect(await turnsFor(msg.id)).toBe(1);
  });
});

/** Scout's post through `postAgentMessageIn` (what the Agent Channel API calls), for the turn's human when given. */
async function botPost(
  conversationId: string,
  body: string,
  onBehalfOfUserId?: string,
  threadRootId?: string,
) {
  const { core } = stack.built;
  const posted = await core.db.withTenant({ organizationId: orgId, userId: null }, (tx) =>
    core.chatAgent.postAgentMessageIn(tx, {
      agentId: scoutId,
      conversationId,
      threadRootId: threadRootId ?? null,
      body,
      idempotencyKey: randomUUID(),
      ...(onBehalfOfUserId ? { onBehalfOfUserId } : {}),
    }),
  );
  return posted.messageId;
}

/** Scout's board card (what `agent-channel/board.ts` calls for a turn of `onBehalfOfUserId`). */
async function botCard(boardId: string, description: string, onBehalfOfUserId: string) {
  const { core } = stack.built;
  return core.db.withTenant({ organizationId: orgId, userId: null }, async (tx) => {
    const [conv] = await tx.select().from(conversations).where(eq(conversations.id, boardId));
    const made = await createBoardCard(
      tx,
      { audit: core.audit, realtime: core.realtime },
      {
        conv: conv!,
        author: { kind: "agent", id: scoutId, onBehalfOfUserId },
        input: { title: "Bot card", description, clientMessageId: `board:${randomUUID()}` },
        clientKind: "agent",
        perms: createPermissionService(core),
      },
    );
    return made.result.row.id;
  });
}

const ids = (...handles: string[]) => handles.map((h) => ({ kind: "unit", id: unit[h] }));

describe("team mentions on every channel write path (07.17 PD-13, D-17)", () => {
  let boardId: string;

  beforeAll(async () => {
    boardId = (
      await ok(
        admin.request("POST", "/api/v1/channels", {
          name: "ops-board",
          layout: "board",
          visibility: "public",
        }),
      )
    ).id;
    await ok(ana.request("POST", `/api/v1/channels/${boardId}/join`, {}));
    await ok(admin.request("POST", `/api/v1/channels/${boardId}/members`, { kind: "agent", id: scoutId }));
  });

  it("a standard member's thread reply resolves @logistics (A-02: unit.read by default)", async () => {
    const root = await say(ana, ordersId, "a root");
    const reply = await say(ana, ordersId, "@logistics over to you", { threadRootId: root.id });
    expect(reply.threadId).toBe(root.id);
    expect(await storedMentions(reply.id)).toEqual(ids("logistics"));
  });

  it("a person's board card resolves @logistics in its description, and a text edit re-resolves it", async () => {
    const card = await ok(
      ana.request("POST", `/api/v1/boards/${boardId}/cards`, {
        title: "Late pallets",
        description: "@logistics please check",
        clientMessageId: randomUUID(),
      }),
    );
    expect(await storedMentions(card.messageId)).toEqual(ids("logistics"));
    await ok(
      ana.request("PATCH", `/api/v1/boards/${boardId}/cards/${card.messageId}`, {
        expectedVersion: card.version,
        description: "@billing please check",
      }),
    );
    expect(await storedMentions(card.messageId)).toEqual(ids("billing"));
  });

  it("a bot's post keeps the first three teams and every person (D-17, E15)", async () => {
    const body = "@logistics @ops @billing @support done @ana @ben @cam @dan @eva";
    const id = await botPost(ordersId, body, anaId);
    expect(await storedMentions(id)).toEqual([
      ...ids("logistics", "ops", "billing"),
      { kind: "user", id: anaId },
      { kind: "user", id: benId },
      { kind: "user", id: people.cam },
      { kind: "user", id: people.dan },
      { kind: "user", id: people.eva },
    ]);
  });

  it("a bot's units are decided for its turn's human: Sam cannot read Ops (T-07.17-07-01)", async () => {
    const id = await botPost(ordersId, "@ops and @logistics", samId);
    expect(await storedMentions(id)).toEqual(ids("logistics"));
    // Sam's own post: the same rule.
    const own = await say(sam, ordersId, "@ops and @logistics");
    expect(own.mentions).toEqual(ids("logistics"));
  });

  it("a bot post without a turn's human resolves no unit; its people still resolve", async () => {
    const id = await botPost(ordersId, "@logistics fyi @ana");
    expect(await storedMentions(id)).toEqual([{ kind: "user", id: anaId }]);
  });

  it("a bot's thread reply and board card resolve units under the same cap", async () => {
    const root = await say(ana, ordersId, "another root");
    const reply = await botPost(ordersId, "@support done", anaId, root.id);
    expect(await storedMentions(reply)).toEqual(ids("support"));
    const card = await botCard(boardId, "@logistics @ops @billing @support @it", anaId);
    expect(await storedMentions(card)).toEqual(ids("logistics", "ops", "billing"));
  });

  it("a bot's @channel sets no broadcast (P7) and notifies nobody as one", async () => {
    const id = await botPost(ordersId, "@channel heads up @logistics", anaId);
    expect(await storedMentions(id)).toEqual(ids("logistics"));
    const broadcast = await su.query(
      "select count(*)::int as n from app.notifications where message_id = $1 and kind in ('channel','here')",
      [id],
    );
    expect(broadcast.rows[0].n).toBe(0);
  });

  it("an edit follows the text: adding @logistics stores it, removing it drops it", async () => {
    const msg = await say(ana, ordersId, "hello");
    const added = await ok(ana.request("PATCH", `/api/v1/messages/${msg.id}`, { body: "hello @logistics" }));
    expect(added.mentions).toEqual(ids("logistics"));
    expect(await storedMentions(msg.id)).toEqual(ids("logistics"));
    await ok(ana.request("PATCH", `/api/v1/messages/${msg.id}`, { body: "hello" }));
    expect(await storedMentions(msg.id)).toEqual([]);
  });

  it("the bot's body in its DM with Ana, a group DM and an AI chat store no unit mention (E16)", async () => {
    const dm = await ok(
      ana.request("POST", "/api/v1/dms", { participants: [{ kind: "agent", id: scoutId }] }),
    );
    const inDm = await botPost(dm.id, "@logistics @ops done", anaId);
    expect(await storedMentions(inDm)).toEqual([]);

    const group = await ok(
      ana.request("POST", "/api/v1/dms", {
        participants: [
          { kind: "user", id: benId },
          { kind: "user", id: people.cam },
        ],
      }),
    );
    const inGroup = await say(ana, group.id, "@logistics @ben");
    expect(inGroup.mentions).toEqual([{ kind: "user", id: benId }]);

    const chat = await ok(
      ana.request("POST", "/api/v1/ai-chats", {
        clientMessageId: randomUUID(),
        body: "@logistics status?",
        model: { backend: "mock", provider: "mock", modelId: "mock-1" },
      }),
      201,
    );
    expect(chat.userMessage.mentions).toEqual([]);
    expect(await storedMentions(chat.userMessage.id)).toEqual([]);
  });
});
