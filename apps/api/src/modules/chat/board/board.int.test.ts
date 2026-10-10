import { randomUUID } from "node:crypto";
import { cardMessageBody, WS_AUTH_PROTOCOL_PREFIX, WS_PROTOCOL } from "@ocw/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack, WEB_ORIGIN } from "../../../testing";

/**
 * Phase 07.1-03 (BOARD-01, BOARD-02, BOARD-03, BOARD-04, BOARD-06): board channels over real PostgreSQL + Redis.
 * The tracer: Víctor creates a board channel, adds a card and moves it to "In progress"; a subscriber of the channel's
 * `conv:` stream receives the card's message and both board events. Then this plan's routes across tenants.
 */

let stack: TestStack;
let su: pg.Client;
let admin: TestClient;
let alex: TestClient;
let eve: TestClient;
let adminId: string;

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

/** Sign `client`'s user into a brand-new organization B as its admin. */
async function moveToOtherOrg(client: TestClient, userId: string): Promise<void> {
  const orgB = randomUUID();
  await su.query("insert into auth.organization (id, name, slug) values ($1, 'Evil', $2)", [
    orgB,
    `evil-${orgB}`,
  ]);
  await su.query("delete from auth.member where user_id = $1", [userId]);
  await su.query("delete from app.org_members where user_id = $1", [userId]);
  await su.query("insert into auth.member (organization_id, user_id, role) values ($1, $2, 'owner')", [
    orgB,
    userId,
  ]);
  await su.query(
    "insert into app.org_members (organization_id, user_id, display_name, role) values ($1, $2, 'Eve', 'admin')",
    [orgB, userId],
  );
  await su.query("update auth.session set active_organization_id = $1 where user_id = $2", [orgB, userId]);
  expect((await ok(client.request("GET", "/api/v1/me/permissions"))).role).toBe("admin");
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
  const waitFor = async (pred: (f: Json) => boolean, ms = 5000) => {
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

const createBoard = async (as: TestClient, name: string, extra: Json = {}) =>
  ok(as.request("POST", "/api/v1/channels", { name, layout: "board", visibility: "public", ...extra }));
const snapshot = (as: TestClient, id: string) => ok(as.request("GET", `/api/v1/boards/${id}`));
const columnByName = (snap: Json, name: string) => snap.columns.find((c: Json) => c.name === name) as Json;

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
  adminId = setup.user.id;
  ({ client: alex } = await invite("alex@example.test", "Alex Kim"));
  const evil = await invite("eve@example.test", "Eve");
  eve = evil.client;
  await moveToOtherOrg(eve, evil.id);
});

afterAll(async () => {
  await su?.end();
  await stack?.stop();
});

describe("board channels (tracer)", () => {
  it("Víctor creates a board, adds a card and moves it to In progress; the channel's stream carries both board events", async () => {
    const created = await createBoard(admin, "cases");
    expect(created).toMatchObject({ name: "cases", layout: "board", isMember: true, visibility: "public" });
    const boardId = created.id as string;

    const list = await ok(admin.request("GET", "/api/v1/channels"));
    const byName = new Map(list.channels.map((c: Json) => [c.name, c]));
    expect(byName.get("cases")).toMatchObject({ layout: "board" });
    expect(byName.get("general")).toMatchObject({ layout: "text" });
    // A board is seen like any channel by other members.
    const alexList = await ok(alex.request("GET", "/api/v1/channels"));
    expect(alexList.channels.find((c: Json) => c.id === boardId)).toMatchObject({ layout: "board" });

    const snap = await snapshot(admin, boardId);
    expect(snap.board).toMatchObject({
      conversationId: boardId,
      templateId: null,
      prefix: null,
      namingRule: null,
      fields: [],
      version: 1,
    });
    expect(snap.columns.map((c: Json) => [c.name, c.category])).toEqual([
      ["Backlog", "backlog"],
      ["In progress", "started"],
      ["Done", "done"],
      ["Cancelled", "cancelled"],
    ]);
    const ranks = snap.columns.map((c: Json) => c.rank as string);
    expect([...ranks].sort()).toEqual(ranks);
    expect(new Set(ranks).size).toBe(4);
    expect(snap.cards.map((c: Json) => [c.columnId, c.cards, c.hasMore])).toEqual(
      snap.columns.map((c: Json) => [c.id, [], false]),
    );
    expect(typeof snap.lastSeq).toBe("number");
    const backlog = columnByName(snap, "Backlog");
    const inProgress = columnByName(snap, "In progress");

    const spy = await socketFor(admin);
    try {
      spy.ws.send(JSON.stringify({ op: "sub", topic: `conv:${boardId}`, afterSeq: snap.lastSeq }));
      await spy.waitFor((f) => f.op === "subscribed" && f.topic === `conv:${boardId}`);

      const clientMessageId = randomUUID();
      const request = { description: "Broken pump\nPump 3 leaks", clientMessageId };
      const card = await ok(admin.request("POST", `/api/v1/boards/${boardId}/cards`, request));
      expect(card).toMatchObject({
        conversationId: boardId,
        columnId: backlog.id,
        title: "Broken pump",
        titleSource: "heuristic",
        description: "Broken pump\nPump 3 leaks",
        number: null,
        waitingOn: "none",
        authorKind: "user",
        authorId: adminId,
        replyCount: 0,
        lastReplyAt: null,
        version: 1,
      });
      const root = (
        await su.query("select thread_id, body from app.messages where id = $1", [card.messageId])
      ).rows[0];
      expect(root.thread_id).toBeNull();
      expect(root.body).toBe(
        cardMessageBody({ title: "Broken pump", description: request.description, fields: {}, defs: [] }),
      );

      // A retry answers the same card: one message, one card.
      const again = await ok(admin.request("POST", `/api/v1/boards/${boardId}/cards`, request));
      expect(again).toEqual(card);
      const msgs = await su.query(
        "select count(*)::int as n from app.messages where client_message_id = $1",
        [clientMessageId],
      );
      expect(msgs.rows[0].n).toBe(1);
      expect(
        (
          await su.query("select count(*)::int as n from app.board_cards where conversation_id = $1", [
            boardId,
          ])
        ).rows[0].n,
      ).toBe(1);

      const moved = await ok(
        admin.request("PATCH", `/api/v1/boards/${boardId}/cards/${card.messageId}`, {
          expectedVersion: 1,
          move: { columnId: inProgress.id, afterCardId: null },
        }),
      );
      expect(moved).toMatchObject({ messageId: card.messageId, columnId: inProgress.id, version: 2 });

      const after = await snapshot(admin, boardId);
      const inProgressCards = after.cards.find((c: Json) => c.columnId === inProgress.id).cards;
      expect(inProgressCards.map((c: Json) => c.messageId)).toEqual([card.messageId]);

      await spy.waitFor(
        (f) => f.op === "ev" && f.type === "board.card_upserted" && f.data.card.version === 2,
      );
      const evs = spy.frames.filter((f) => f.op === "ev" && f.topic === `conv:${boardId}`);
      expect(evs.map((f) => [f.type, f.data.card?.version ?? null])).toEqual([
        ["message.created", null],
        ["board.card_upserted", 1],
        ["board.card_upserted", 2],
      ]);
      const seqs = evs.map((f) => f.seq as number);
      expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
      expect(evs[0]?.data.message.id).toBe(card.messageId);
      expect(evs[2]?.data.card.columnId).toBe(inProgress.id);
    } finally {
      spy.ws.close();
    }

    // No board event leaks to the organization's or a user's stream (a private board would leak titles).
    const leaked = await su.query(
      "select count(*)::int as n from app.stream_events where type like 'board.%' and stream_id not like 'conv:%'",
    );
    expect(leaked.rows[0].n).toBe(0);

    const audits = (
      await su.query(
        `select action, metadata from app.audit_events
          where action in ('channel.created', 'board.card.created', 'board.card.moved') order by occurred_at`,
      )
    ).rows as Json[];
    const createdAudit = audits.find((a) => a.action === "channel.created" && a.metadata.name === "cases");
    expect(createdAudit?.metadata).toMatchObject({ layout: "board", templateId: null });
    expect(audits.filter((a) => a.action === "board.card.created")).toHaveLength(1);
    expect(audits.find((a) => a.action === "board.card.moved")?.metadata).toMatchObject({
      conversationId: boardId,
      fromColumnId: backlog.id,
      toColumnId: inProgress.id,
      fromCategory: "backlog",
      toCategory: "started",
      version: 2,
    });
    const text = JSON.stringify(audits);
    expect(text).not.toContain("Broken pump");
    expect(text).not.toContain("Pump 3");
  });

  it("text channels are unchanged and a template is refused until templates exist", async () => {
    const text = await ok(admin.request("POST", "/api/v1/channels", { name: "plain", visibility: "public" }));
    expect(text.layout).toBe("text");
    const boardsRow = await su.query("select count(*)::int as n from app.boards where conversation_id = $1", [
      text.id,
    ]);
    expect(boardsRow.rows[0].n).toBe(0);
    const notABoard = await admin.request("GET", `/api/v1/boards/${text.id}`);
    expect(notABoard.status).toBe(400);
    expect(errorOf(notABoard).code).toBe("not_a_board");

    const withTemplate = await admin.request("POST", "/api/v1/channels", {
      name: "templated",
      layout: "board",
      templateId: randomUUID(),
    });
    expect(withTemplate.status).toBe(400);
    expect(errorOf(withTemplate).code).toBe("template_not_available");
    const none = await su.query("select count(*)::int as n from app.conversations where name = 'templated'");
    expect(none.rows[0].n).toBe(0);
  });
});

describe("board routes across tenants (BOARD-04, T-07.1-03-01)", () => {
  /** Every route of this plan, called by org B's admin with org A's ids. */
  const CROSS_TENANT_ROUTES: ReadonlyArray<{
    name: string;
    call: (
      c: TestClient,
      ids: { boardId: string; columnId: string; messageId: string },
    ) => Promise<{
      status: number;
      body: Record<string, unknown> | null;
    }>;
  }> = [
    { name: "GET /boards/:id", call: (c, i) => c.request("GET", `/api/v1/boards/${i.boardId}`) },
    {
      name: "GET /boards/:id/columns/:columnId/cards",
      call: (c, i) => c.request("GET", `/api/v1/boards/${i.boardId}/columns/${i.columnId}/cards`),
    },
    {
      name: "POST /boards/:id/cards",
      call: (c, i) =>
        c.request("POST", `/api/v1/boards/${i.boardId}/cards`, {
          description: "Planted",
          clientMessageId: randomUUID(),
        }),
    },
    {
      name: "PATCH /boards/:id/cards/:messageId",
      call: (c, i) =>
        c.request("PATCH", `/api/v1/boards/${i.boardId}/cards/${i.messageId}`, {
          expectedVersion: 1,
          move: { columnId: i.columnId, afterCardId: null },
        }),
    },
  ];

  it("org B's admin gets 404 on every board route and org A's rows are unchanged", async () => {
    const created = await createBoard(admin, "orders");
    const boardId = created.id as string;
    const snap = await snapshot(admin, boardId);
    const done = columnByName(snap, "Done");
    const card = await ok(
      admin.request("POST", `/api/v1/boards/${boardId}/cards`, {
        description: "Order 1",
        clientMessageId: randomUUID(),
      }),
    );
    const before = (
      await su.query("select * from app.board_cards where conversation_id = $1 order by message_id", [
        boardId,
      ])
    ).rows;
    const messagesBefore = (
      await su.query("select count(*)::int as n from app.messages where conversation_id = $1", [boardId])
    ).rows[0].n;

    for (const route of CROSS_TENANT_ROUTES) {
      const res = await route.call(eve, { boardId, columnId: done.id, messageId: card.messageId });
      expect(res.status, route.name).toBe(404);
      expect(JSON.stringify(res.body), route.name).not.toContain("Order 1");
    }

    const after = (
      await su.query("select * from app.board_cards where conversation_id = $1 order by message_id", [
        boardId,
      ])
    ).rows;
    expect(after).toEqual(before);
    expect(
      (await su.query("select count(*)::int as n from app.messages where conversation_id = $1", [boardId]))
        .rows[0].n,
    ).toBe(messagesBefore);
  });
});
