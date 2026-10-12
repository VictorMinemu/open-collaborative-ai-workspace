import { randomUUID } from "node:crypto";
import { WS_AUTH_PROTOCOL_PREFIX, WS_PROTOCOL } from "@ocw/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack, WEB_ORIGIN } from "../../../testing";

/**
 * Phase 07.1-05 (BOARD-01, BOARD-02, BOARD-04): a board honours its channel's access exactly, over real PostgreSQL +
 * Redis. Org B's admin, an outsider of a private board and anyone on an archived board are turned away by the board
 * routes exactly as the channel turns them away (`readableBoard` / `writableBoard` in `access.ts` decide every refusal).
 */

const CELL_TOKEN = "ocw-test-cell-token-board-access-0123456789ab";

let stack: TestStack;
let su: pg.Client;
let admin: TestClient;
let alex: TestClient;
let eve: TestClient;
let orgId: string;
let adminId: string;
let alexId: string;

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
type Json = Record<string, any>;
type Res = { status: number; body: Record<string, unknown> | null };

async function ok(res: Promise<Res>, status = 200) {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as Json;
}

/** The refusal's `error` envelope, after checking its status. */
async function fails(res: Promise<Res>, status: number) {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return (r.body as Json).error as Json;
}

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
  const close = async () => {
    if (ws.readyState === WebSocket.CLOSED) return;
    await new Promise((resolve) => {
      ws.once("close", resolve);
      ws.close();
    });
  };
  return { ws, frames, waitFor, close };
}

const createBoard = async (as: TestClient, name: string, extra: Json = {}) =>
  ok(as.request("POST", "/api/v1/channels", { name, layout: "board", visibility: "public", ...extra }));
const snapshot = (as: TestClient, id: string) => ok(as.request("GET", `/api/v1/boards/${id}`));
const columnByName = (snap: Json, name: string) => snap.columns.find((c: Json) => c.name === name) as Json;
const cardsOf = (snap: Json, columnId: string) =>
  (snap.cards.find((c: Json) => c.columnId === columnId)?.cards ?? []) as Json[];

const newCard = (as: TestClient, boardId: string, description: string, extra: Json = {}) =>
  as.request("POST", `/api/v1/boards/${boardId}/cards`, {
    description,
    clientMessageId: randomUUID(),
    ...extra,
  });
const moveCard = (
  as: TestClient,
  boardId: string,
  card: Json,
  columnId: string,
  afterCardId: string | null = null,
) =>
  as.request("PATCH", `/api/v1/boards/${boardId}/cards/${card.messageId}`, {
    expectedVersion: card.version,
    move: { columnId, afterCardId },
  });

/** Every org-A row a board route could touch, to prove a refused call changed nothing. */
async function orgARows(boardId: string) {
  const q = async (sql: string, params: unknown[]) => (await su.query(sql, params)).rows;
  return {
    cards: await q("select * from app.board_cards where conversation_id = $1 order by message_id", [boardId]),
    columns: await q("select * from app.board_columns where conversation_id = $1 order by id", [boardId]),
    messages: await q(
      "select id, body, deleted_at from app.messages where conversation_id = $1 order by id",
      [boardId],
    ),
    conversations: await q("select id from app.conversations where organization_id = $1 order by id", [
      orgId,
    ]),
  };
}

beforeAll(async () => {
  stack = await startTestStack({ env: { OCW_CELL_TOKEN: CELL_TOKEN, OCW_MODEL_PROVIDER: "mock" } });
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
  adminId = setup.user.id;
  ({ client: alex, id: alexId } = await invite("alex@example.test", "Alex Kim"));
  const evil = await invite("eve@example.test", "Eve");
  eve = evil.client;
  await moveToOtherOrg(eve, evil.id);
}, 180_000);

afterAll(async () => {
  await su?.end();
  await stack?.stop();
});

// ---------------------------------------------------------------------------------------------------- Task 1

describe("board routes across tenants (BOARD-04, T-07.1-05-01)", () => {
  type Ids = { boardId: string; columnId: string; messageId: string; unitId: string };
  /**
   * Every board route of 07.1-03 plus `POST /channels` naming org A's unit, called by org B's admin with org A's ids.
   * 07.1-14's route-coverage guard mirrors this table.
   */
  const BOARD_ACCESS_CROSS_TENANT_ROUTES: ReadonlyArray<{
    name: string;
    code?: string;
    call: (c: TestClient, ids: Ids) => Promise<Res>;
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
    {
      name: "POST /channels (board in org A's unit)",
      code: "unit_not_found",
      call: (c, i) =>
        c.request("POST", "/api/v1/channels", { name: "planted-board", layout: "board", unitId: i.unitId }),
    },
  ];

  let ids: Ids;

  beforeAll(async () => {
    const unit = await ok(
      admin.request("POST", "/api/v1/units", { kind: "department", name: "Intake", parentId: null }),
    );
    const created = await createBoard(admin, "intake", { unitId: unit.id });
    const snap = await snapshot(admin, created.id);
    const card = await ok(newCard(admin, created.id, "Order 1 for Acme"));
    ids = {
      boardId: created.id,
      columnId: columnByName(snap, "Done").id,
      messageId: card.messageId,
      unitId: unit.id,
    };
  });

  it.each(BOARD_ACCESS_CROSS_TENANT_ROUTES)(
    "org B's admin gets 404 on $name and org A's rows are unchanged",
    async (route) => {
      const before = await orgARows(ids.boardId);
      const res = await route.call(eve, ids);
      expect(res.status, route.name).toBe(404);
      if (route.code) expect((res.body as Json).error.code).toBe(route.code);
      expect(JSON.stringify(res.body)).not.toContain("Acme");
      expect(await orgARows(ids.boardId)).toEqual(before);
      // Org B got nothing either: no board, no card, no channel.
      const leaked = await su.query(
        "select count(*)::int as n from app.conversations where organization_id <> $1 and name = 'planted-board'",
        [orgId],
      );
      expect(leaked.rows[0].n).toBe(0);
    },
  );
});

describe("a private board (BOARD-01, T-07.1-05-01, T-07.1-05-03)", () => {
  it("Alex, not a member, gets 404 and his conv: subscription is refused; once Víctor adds him he reads, creates and moves", async () => {
    const board = await createBoard(admin, "hr-cases", { visibility: "private" });
    const snap = await snapshot(admin, board.id);
    const backlog = columnByName(snap, "Backlog");
    const inProgress = columnByName(snap, "In progress");
    const card = await ok(newCard(admin, board.id, "Salary review for Kim"));

    // Hidden = missing: the same bare 404 a channel gives, on every board route.
    const refused = [
      await alex.request("GET", `/api/v1/boards/${board.id}`),
      await alex.request("GET", `/api/v1/boards/${board.id}/columns/${backlog.id}/cards`),
      await newCard(alex, board.id, "Planted"),
      await moveCard(alex, board.id, card, inProgress.id),
    ];
    for (const r of refused) {
      expect(r.status).toBe(404);
      expect(JSON.stringify(r.body)).not.toContain("Salary");
    }
    const channelRefusal = await alex.request("GET", `/api/v1/channels/${board.id}`);
    expect(channelRefusal.status).toBe(404);
    expect(((refused[0] as Res).body as Json).error.code).toBe((channelRefusal.body as Json).error.code);

    const owner = await socketFor(admin);
    const spy = await socketFor(alex);
    try {
      owner.ws.send(JSON.stringify({ op: "sub", topic: `conv:${board.id}` }));
      await owner.waitFor((f) => f.op === "subscribed" && f.topic === `conv:${board.id}`);
      spy.ws.send(JSON.stringify({ op: "sub", topic: `conv:${board.id}`, afterSeq: 0 }));
      expect(await spy.waitFor((f) => f.op === "err")).toMatchObject({
        op: "err",
        code: "forbidden",
        topic: `conv:${board.id}`,
      });
      await ok(newCard(admin, board.id, "Promotion for Lee"));
      await owner.waitFor(
        (f) => f.op === "ev" && f.type === "board.card_upserted" && JSON.stringify(f).includes("Lee"),
      );
      await new Promise((r) => setTimeout(r, 300));
      expect(spy.frames.some((f) => f.topic === `conv:${board.id}` && f.op !== "err")).toBe(false);
      expect(JSON.stringify(spy.frames)).not.toContain("Salary");
    } finally {
      await owner.close();
      await spy.close();
    }

    await ok(admin.request("POST", `/api/v1/channels/${board.id}/members`, { kind: "user", id: alexId }));

    const seen = await snapshot(alex, board.id);
    expect(cardsOf(seen, backlog.id).map((c) => c.messageId)).toContain(card.messageId);
    const own = await ok(newCard(alex, board.id, "Onboarding for Alex's new hire"));
    expect(own).toMatchObject({ authorId: alexId, columnId: backlog.id });
    const moved = await ok(moveCard(alex, board.id, card, inProgress.id));
    expect(moved).toMatchObject({ messageId: card.messageId, columnId: inProgress.id, version: 2 });

    const member = await socketFor(alex);
    try {
      member.ws.send(JSON.stringify({ op: "sub", topic: `conv:${board.id}`, afterSeq: seen.lastSeq }));
      await member.waitFor((f) => f.op === "subscribed" && f.topic === `conv:${board.id}`);
      expect(member.frames.some((f) => f.op === "err")).toBe(false);
    } finally {
      await member.close();
    }
  });

  it("an admin who is not a member of someone else's private board gets the same 404 (no peeking)", async () => {
    const board = await createBoard(alex, "alex-private", { visibility: "private" });
    const card = await ok(newCard(alex, board.id, "Personal backlog"));
    const snap = await snapshot(alex, board.id);
    expect((await admin.request("GET", `/api/v1/boards/${board.id}`)).status).toBe(404);
    expect((await newCard(admin, board.id, "Planted")).status).toBe(404);
    expect((await moveCard(admin, board.id, card, columnByName(snap, "Done").id)).status).toBe(404);
  });
});

describe("member rights on a board (BOARD-01, T-07.1-05-02)", () => {
  let unitId: string;
  let support: string;
  let elsewhere: string;
  let columns: { backlog: string; inProgress: string; done: string };

  beforeAll(async () => {
    unitId = (
      await ok(
        admin.request("POST", "/api/v1/units", { kind: "department", name: "Support", parentId: null }),
      )
    ).id;
    support = (await createBoard(admin, "support", { unitId })).id;
    elsewhere = (await createBoard(admin, "elsewhere")).id;
    await ok(alex.request("POST", `/api/v1/channels/${support}/join`, {}));
    await ok(alex.request("POST", `/api/v1/channels/${elsewhere}/join`, {}));
    const snap = await snapshot(admin, support);
    columns = {
      backlog: columnByName(snap, "Backlog").id,
      inProgress: columnByName(snap, "In progress").id,
      done: columnByName(snap, "Done").id,
    };
  });

  it("a plain member creates and moves cards, including Víctor's (`channel.post`)", async () => {
    const mine = await ok(newCard(alex, support, "Printer on floor 2"));
    expect(mine).toMatchObject({ authorId: alexId, authorKind: "user", columnId: columns.backlog });
    const victors = await ok(newCard(admin, support, "VPN drops at night"));
    expect(victors.authorId).toBe(adminId);
    expect(await ok(moveCard(alex, support, mine, columns.inProgress))).toMatchObject({ version: 2 });
    expect(await ok(moveCard(alex, support, victors, columns.done))).toMatchObject({
      version: 2,
      columnId: columns.done,
    });
  });

  it("an explicit rule denying Alex `channel.post` in the board's unit: 403 on create and update, the snapshot still reads", async () => {
    const card = await ok(newCard(admin, support, "Laptop for the new hire"));
    const rule = await ok(
      admin.request("POST", "/api/v1/permission-rules", {
        scopeUnitId: unitId,
        subjectKind: "user",
        subjectId: alexId,
        permission: "channel.post",
        effect: "deny",
      }),
    );
    try {
      const before = await orgARows(support);
      const created = await fails(newCard(alex, support, "Denied card"), 403);
      expect(created.details).toMatchObject({ permission: "channel.post", ruleId: rule.id });
      const moved = await fails(moveCard(alex, support, card, columns.done), 403);
      expect(moved.details).toMatchObject({ permission: "channel.post", ruleId: rule.id });
      expect(await orgARows(support)).toEqual(before);
      // Same decision as the channel's message route.
      await fails(alex.request("POST", `/api/v1/conversations/${support}/messages`, { body: "hello" }), 403);

      const snap = await snapshot(alex, support);
      expect(cardsOf(snap, columns.backlog).map((c) => c.messageId)).toContain(card.messageId);
      // The rule is scoped to the unit: a board outside it, and Víctor inside it, are unaffected.
      await ok(newCard(alex, elsewhere, "Still allowed here"));
      await ok(moveCard(admin, support, card, columns.done));
    } finally {
      await ok(admin.request("DELETE", `/api/v1/permission-rules/${rule.id}`));
    }
    await ok(newCard(alex, support, "Allowed again"));
  });

  it("a description with @channel needs `channel.mention_all` and the one-per-minute gate, like a message", async () => {
    const rule = await ok(
      admin.request("POST", "/api/v1/permission-rules", {
        subjectKind: "user",
        subjectId: alexId,
        permission: "channel.mention_all",
        effect: "deny",
      }),
    );
    try {
      const card = await fails(newCard(alex, elsewhere, "Outage\n@channel the VPN is down"), 403);
      expect(card.details).toMatchObject({ permission: "channel.mention_all" });
      const viaTitle = await fails(newCard(alex, elsewhere, "Outage", { title: "@here VPN down" }), 403);
      expect(viaTitle.details).toMatchObject({ permission: "channel.mention_all" });
      const msg = await fails(
        alex.request("POST", `/api/v1/conversations/${elsewhere}/messages`, {
          body: "@channel the VPN is down",
        }),
        403,
      );
      expect(msg.details).toMatchObject({ permission: "channel.mention_all" });
      // No broadcast, no permission needed.
      await ok(newCard(alex, elsewhere, "Outage\nthe VPN is down"));
    } finally {
      await ok(admin.request("DELETE", `/api/v1/permission-rules/${rule.id}`));
    }

    const clientMessageId = randomUUID();
    const first = await ok(newCard(alex, elsewhere, "Outage\n@channel the VPN is down", { clientMessageId }));
    const second = await fails(newCard(alex, elsewhere, "Outage\n@channel still down"), 429);
    expect(second.code).toBe("mention_all_rate_limited");
    // The caller's own retry answers the card, not the limit.
    expect(
      await ok(newCard(alex, elsewhere, "Outage\n@channel the VPN is down", { clientMessageId })),
    ).toEqual(first);
    // The gate is the channel's: a message is refused in the same window.
    const msg = await fails(
      admin.request("POST", `/api/v1/conversations/${elsewhere}/messages`, { body: "@channel all clear" }),
      429,
    );
    expect(msg.code).toBe("mention_all_rate_limited");
  });
});

describe("archived boards and text channels (BOARD-01, T-07.1-05-02)", () => {
  it("an archived board reads (snapshot and column page) but every write is 410 channel_archived", async () => {
    const board = await createBoard(admin, "old-cases");
    const card = await ok(newCard(admin, board.id, "Closed case"));
    const snap = await snapshot(admin, board.id);
    const done = columnByName(snap, "Done");
    await ok(admin.request("POST", `/api/v1/channels/${board.id}/archive`));

    const after = await snapshot(admin, board.id);
    expect(cardsOf(after, card.columnId).map((c) => c.messageId)).toEqual([card.messageId]);
    await ok(admin.request("GET", `/api/v1/boards/${board.id}/columns/${done.id}/cards`));
    const before = await orgARows(board.id);
    expect((await fails(newCard(admin, board.id, "Reopened"), 410)).code).toBe("channel_archived");
    expect((await fails(moveCard(admin, board.id, card, done.id), 410)).code).toBe("channel_archived");
    expect(
      (
        await fails(
          admin.request("PATCH", `/api/v1/boards/${board.id}/cards/${card.messageId}`, {
            expectedVersion: 1,
            waitingOn: "customer",
          }),
          410,
        )
      ).code,
    ).toBe("channel_archived");
    expect(await orgARows(board.id)).toEqual(before);
  });

  it("a text channel is 400 not_a_board on the snapshot, the column page, create and update", async () => {
    const text = await ok(
      admin.request("POST", "/api/v1/channels", { name: "plain-talk", visibility: "public" }),
    );
    const msg = await ok(
      admin.request("POST", `/api/v1/conversations/${text.id}/messages`, { body: "hello" }),
    );
    const refusals = [
      await admin.request("GET", `/api/v1/boards/${text.id}`),
      await admin.request("GET", `/api/v1/boards/${text.id}/columns/${randomUUID()}/cards`),
      await newCard(admin, text.id, "Not a board"),
      await admin.request("PATCH", `/api/v1/boards/${text.id}/cards/${msg.id}`, {
        expectedVersion: 1,
        waitingOn: "us",
      }),
    ];
    for (const r of refusals) {
      expect(r.status).toBe(400);
      expect((r.body as Json).error.code).toBe("not_a_board");
    }
    const cards = await su.query(
      "select count(*)::int as n from app.board_cards where conversation_id = $1",
      [text.id],
    );
    expect(cards.rows[0].n).toBe(0);
  });

  it("a hidden text channel is a bare 404, never not_a_board (the layout is no existence oracle)", async () => {
    const hidden = await ok(
      admin.request("POST", "/api/v1/channels", { name: "board-room", visibility: "private" }),
    );
    for (const r of [
      await alex.request("GET", `/api/v1/boards/${hidden.id}`),
      await newCard(alex, hidden.id, "Probe"),
      await alex.request("GET", `/api/v1/boards/${randomUUID()}`),
    ]) {
      expect(r.status).toBe(404);
      expect(JSON.stringify(r.body)).not.toContain("not_a_board");
    }
  });
});
