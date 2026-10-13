import { randomUUID } from "node:crypto";
import { BoardUpdatedEvent } from "@ocw/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../../testing";

/**
 * Phase 07.1-06 Task 3 (BOARD-01, BOARD-04, D-07, D-08, P-09): the channel's owner or an admin (`channel.update`)
 * configures a board's columns, over real PostgreSQL + Redis. Every change emits exactly one `board.updated` with the
 * full ordered column list and is audited without names; limits, safe deletion and every route across tenants.
 */

let stack: TestStack;
let su: pg.Client;
let admin: TestClient;
let alex: TestClient;
let ada: TestClient;
let nora: TestClient;
let eve: TestClient;
let alexId: string;

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
type Json = Record<string, any>;

async function ok(res: Promise<{ status: number; body: Record<string, unknown> | null }>, status = 200) {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as Json;
}

const errorOf = (r: { body: Record<string, unknown> | null }) => (r.body as Json | null)?.error as Json;

async function invite(email: string, name: string, role: "developer" | "admin" = "developer") {
  const inv = await ok(admin.request("POST", "/api/v1/invitations", { email, role }));
  const client = new TestClient(stack.baseUrl);
  const accepted = await ok(
    client.request("POST", `/api/v1/invitations/${inv.id}/accept`, {
      name,
      password: "another-long-password",
    }),
  );
  return { client, id: accepted.user.id as string };
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

async function newBoard(name: string, visibility: "public" | "private" = "public") {
  const created = await ok(admin.request("POST", "/api/v1/channels", { name, layout: "board", visibility }));
  if (visibility === "public") await ok(alex.request("POST", `/api/v1/channels/${created.id}/join`));
  return created.id as string;
}

const snapshot = (boardId: string) => ok(admin.request("GET", `/api/v1/boards/${boardId}`));
const idOf = (snap: Json, name: string) =>
  (snap.columns as Json[]).find((c) => c.name === name)?.id as string;
const names = (snap: Json) => (snap.columns as Json[]).map((c) => c.name);

const createColumn = (as: TestClient, boardId: string, body: Json) =>
  as.request("POST", `/api/v1/boards/${boardId}/columns`, body);
const updateColumn = (as: TestClient, boardId: string, columnId: string, body: Json) =>
  as.request("PATCH", `/api/v1/boards/${boardId}/columns/${columnId}`, body);
const deleteColumn = (as: TestClient, boardId: string, columnId: string, moveCardsTo?: string) =>
  as.request(
    "DELETE",
    `/api/v1/boards/${boardId}/columns/${columnId}${moveCardsTo ? `?moveCardsTo=${moveCardsTo}` : ""}`,
  );

const addCard = (boardId: string, description: string, columnId?: string) =>
  ok(
    admin.request("POST", `/api/v1/boards/${boardId}/cards`, {
      description,
      clientMessageId: randomUUID(),
      ...(columnId ? { columnId } : {}),
    }),
  );

const boardEvents = async (boardId: string) =>
  (
    await su.query(
      "select type, payload from app.stream_events where stream_id = $1 and type = 'board.updated' order by seq",
      [`conv:${boardId}`],
    )
  ).rows as Json[];

const columnAudits = async (boardId: string) =>
  (
    await su.query(
      "select action, metadata from app.audit_events where action like 'board.column.%' and metadata->>'conversationId' = $1 order by occurred_at",
      [boardId],
    )
  ).rows as Json[];

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
  ({ client: alex, id: alexId } = await invite("alex@example.test", "Alex Kim"));
  ({ client: ada } = await invite("ada@example.test", "Ada Admin", "admin"));
  ({ client: nora } = await invite("nora@example.test", "Nora Outsider"));
  const evil = await invite("eve@example.test", "Eve");
  eve = evil.client;
  await moveToOtherOrg(eve, evil.id);
});

afterAll(async () => {
  await su?.end();
  await stack?.stop();
});

describe("Víctor configures his board's columns (BOARD-01, P-09)", () => {
  it("adds, renames, recategorises, sets and clears a default waiting state and reorders, one board.updated each", async () => {
    const boardId = await newBoard("cases");
    const snap = await snapshot(boardId);
    const inProgress = idOf(snap, "In progress");

    const created = BoardUpdatedEvent.parse(
      await ok(
        createColumn(admin, boardId, {
          name: "Waiting for parts",
          category: "started",
          defaultWaitingOn: "customer",
          afterColumnId: inProgress,
        }),
      ),
    );
    expect(created.columns.map((c) => c.name)).toEqual([
      "Backlog",
      "In progress",
      "Waiting for parts",
      "Done",
      "Cancelled",
    ]);
    const col = created.columns.find((c) => c.name === "Waiting for parts");
    expect(col).toMatchObject({ category: "started", defaultWaitingOn: "customer", conversationId: boardId });
    const colId = col?.id as string;
    expect(names(await snapshot(boardId))).toEqual(created.columns.map((c) => c.name));
    expect(created.board.version).toBe(2);

    const renamed = await ok(updateColumn(admin, boardId, colId, { name: "Parts" }));
    expect(renamed.columns.find((c: Json) => c.id === colId)).toMatchObject({
      name: "Parts",
      category: "started",
    });
    const recat = await ok(
      updateColumn(admin, boardId, colId, { category: "backlog", defaultWaitingOn: null }),
    );
    expect(recat.columns.find((c: Json) => c.id === colId)).toMatchObject({
      category: "backlog",
      defaultWaitingOn: null,
    });
    const nobody = await ok(updateColumn(admin, boardId, colId, { defaultWaitingOn: "none" }));
    expect(nobody.columns.find((c: Json) => c.id === colId)).toMatchObject({ defaultWaitingOn: "none" });
    const first = await ok(updateColumn(admin, boardId, colId, { afterColumnId: null }));
    expect(first.columns.map((c: Json) => c.name)).toEqual([
      "Parts",
      "Backlog",
      "In progress",
      "Done",
      "Cancelled",
    ]);
    const ranks = first.columns.map((c: Json) => c.rank as string);
    expect([...ranks].sort()).toEqual(ranks);
    // Renaming to its own name in another case is no conflict.
    await ok(updateColumn(admin, boardId, colId, { name: "PARTS" }));

    const evs = await boardEvents(boardId);
    expect(evs).toHaveLength(6);
    expect(evs.map((e) => e.payload.board.version)).toEqual([2, 3, 4, 5, 6, 7]);
    expect(evs.at(-1)?.payload.columns.map((c: Json) => c.name)).toEqual([
      "PARTS",
      "Backlog",
      "In progress",
      "Done",
      "Cancelled",
    ]);
    expect(
      (
        await su.query(
          "select count(*)::int as n from app.stream_events where type = 'board.updated' and stream_id not like 'conv:%'",
        )
      ).rows[0].n,
    ).toBe(0);

    const audits = await columnAudits(boardId);
    expect(audits.map((a) => a.action)).toEqual([
      "board.column.created",
      "board.column.updated",
      "board.column.updated",
      "board.column.updated",
      "board.column.updated",
      "board.column.updated",
    ]);
    expect(audits[0]?.metadata).toMatchObject({
      columnId: colId,
      category: "started",
      defaultWaitingOn: "customer",
    });
    expect(audits[2]?.metadata).toMatchObject({
      fromCategory: "started",
      toCategory: "backlog",
      toDefaultWaitingOn: null,
    });
    const text = JSON.stringify(audits);
    expect(text).not.toContain("Waiting for parts");
    expect(text).not.toMatch(/Parts|PARTS/);
  });

  it("only the owner or an admin manages columns; a member gets 403, a non-member of a private board 404", async () => {
    const boardId = await newBoard("perms");
    const snap = await snapshot(boardId);
    const done = idOf(snap, "Done");
    const cancelled = idOf(snap, "Cancelled");
    for (const res of [
      await createColumn(alex, boardId, { name: "Mine", category: "started" }),
      await updateColumn(alex, boardId, done, { name: "Finished" }),
      await deleteColumn(alex, boardId, cancelled),
    ]) {
      expect(res.status).toBe(403);
    }
    // An org admin who is not the channel's owner: `channel.update`.
    await ok(createColumn(ada, boardId, { name: "Review", category: "started" }));
    await ok(updateColumn(ada, boardId, done, { name: "Shipped" }));
    await ok(deleteColumn(ada, boardId, cancelled));
    expect(names(await snapshot(boardId))).toEqual(["Backlog", "In progress", "Shipped", "Review"]);

    const priv = await newBoard("private-cases", "private");
    await ok(admin.request("POST", `/api/v1/channels/${priv}/members`, { kind: "user", id: alexId }));
    const privDone = idOf(await snapshot(priv), "Done");
    const asMember = await updateColumn(alex, priv, privDone, { name: "Closed" });
    expect(asMember.status).toBe(403);
    for (const res of [
      await createColumn(nora, priv, { name: "Peek", category: "started" }),
      await updateColumn(nora, priv, privDone, { name: "Peek" }),
      await deleteColumn(nora, priv, privDone),
    ]) {
      expect(res.status).toBe(404);
    }
    expect(names(await snapshot(priv))).toEqual(["Backlog", "In progress", "Done", "Cancelled"]);
  });

  it("names are unique ignoring case, at most 20 columns, names up to 60 characters", async () => {
    const boardId = await newBoard("limits");
    const dup = await createColumn(admin, boardId, { name: "done", category: "done" });
    expect(dup.status).toBe(409);
    expect(errorOf(dup).code).toBe("board_column_exists");
    const backlog = idOf(await snapshot(boardId), "Backlog");
    const renameDup = await updateColumn(admin, boardId, backlog, { name: "DONE" });
    expect(renameDup.status).toBe(409);
    expect(errorOf(renameDup).code).toBe("board_column_exists");

    const long = await createColumn(admin, boardId, { name: "x".repeat(61), category: "started" });
    expect(long.status).toBe(400);
    for (let i = 5; i <= 20; i++)
      await ok(createColumn(admin, boardId, { name: `Step ${i}`, category: "started" }));
    expect((await snapshot(boardId)).columns).toHaveLength(20);
    const over = await createColumn(admin, boardId, { name: "Step 21", category: "started" });
    expect(over.status).toBe(409);
    expect(errorOf(over).code).toBe("board_columns_limit");

    const self = await updateColumn(admin, boardId, backlog, { afterColumnId: backlog });
    expect(self.status).toBe(400);
    const elsewhere = await updateColumn(admin, boardId, backlog, { afterColumnId: randomUUID() });
    expect(elsewhere.status).toBe(400);
    expect((await updateColumn(admin, boardId, randomUUID(), { name: "Ghost" })).status).toBe(404);
  });

  it("deletes an empty column; a non-empty one only with moveCardsTo (bottom of the target, in order); never the last", async () => {
    const boardId = await newBoard("deletes");
    const other = await newBoard("other-board");
    const otherDone = idOf(await snapshot(other), "Done");
    let snap = await snapshot(boardId);
    const inProgress = idOf(snap, "In progress");
    const done = idOf(snap, "Done");
    const cancelled = idOf(snap, "Cancelled");

    await ok(deleteColumn(admin, boardId, cancelled));
    const before = (await boardEvents(boardId)).length;

    const d1 = await addCard(boardId, "Done already", done);
    const cards = [
      await addCard(boardId, "First", inProgress),
      await addCard(boardId, "Second", inProgress),
      await addCard(boardId, "Third", inProgress),
    ];

    const refused = await deleteColumn(admin, boardId, inProgress);
    expect(refused.status).toBe(409);
    expect(errorOf(refused).code).toBe("board_column_not_empty");
    for (const bad of [inProgress, otherDone]) {
      const res = await deleteColumn(admin, boardId, inProgress, bad);
      expect(res.status).toBe(400);
    }

    const deleted = await ok(deleteColumn(admin, boardId, inProgress, done));
    expect(deleted.columns.map((c: Json) => c.name)).toEqual(["Backlog", "Done"]);
    snap = await snapshot(boardId);
    const doneCards = (snap.cards as Json[]).find((c) => c.columnId === done)?.cards as Json[];
    expect(doneCards.map((c) => c.messageId)).toEqual([d1.messageId, ...cards.map((c) => c.messageId)]);
    for (const c of doneCards.slice(1)) expect(c.version).toBe(2);
    expect(doneCards[0]?.version).toBe(1);
    // One board.updated for the delete, no per-card event.
    const evs = await boardEvents(boardId);
    expect(evs.length - before).toBe(1);
    const audit = (await columnAudits(boardId)).at(-1);
    expect(audit).toMatchObject({
      action: "board.column.deleted",
      metadata: { columnId: inProgress, category: "started", movedCardsTo: done, movedCards: 3 },
    });
    expect(JSON.stringify(audit)).not.toContain("First");

    const backlog = idOf(snap, "Backlog");
    await ok(deleteColumn(admin, boardId, backlog));
    const last = await deleteColumn(admin, boardId, done, undefined);
    expect(last.status).toBe(409);
    expect(errorOf(last).code).toBe("board_last_column");
  });
});

describe("column routes across tenants and on archived boards (BOARD-04)", () => {
  /** Every column route, called with org A's ids. */
  const COLUMN_ROUTES: ReadonlyArray<{
    name: string;
    call: (
      c: TestClient,
      ids: { boardId: string; columnId: string; targetId: string },
    ) => Promise<{
      status: number;
      body: Record<string, unknown> | null;
    }>;
  }> = [
    {
      name: "POST /boards/:id/columns",
      call: (c, i) => createColumn(c, i.boardId, { name: "Planted", category: "started" }),
    },
    {
      name: "PATCH /boards/:id/columns/:columnId",
      call: (c, i) => updateColumn(c, i.boardId, i.columnId, { name: "Planted", afterColumnId: null }),
    },
    {
      name: "DELETE /boards/:id/columns/:columnId",
      call: (c, i) => deleteColumn(c, i.boardId, i.columnId, i.targetId),
    },
  ];

  it("org B's admin gets 404 on every column route and org A's board is unchanged", async () => {
    const boardId = await newBoard("orders");
    const snap = await snapshot(boardId);
    const ids = { boardId, columnId: idOf(snap, "Cancelled"), targetId: idOf(snap, "Done") };
    await addCard(boardId, "Order 1", ids.columnId);
    const rows = async () =>
      (await su.query("select * from app.board_columns where conversation_id = $1 order by id", [boardId]))
        .rows;
    const before = await rows();
    for (const route of COLUMN_ROUTES) {
      const res = await route.call(eve, ids);
      expect(res.status, route.name).toBe(404);
      expect(JSON.stringify(res.body), route.name).not.toContain("Cancelled");
    }
    expect(await rows()).toEqual(before);
    expect((await boardEvents(boardId)).length).toBe(0);
  });

  it("an archived board answers 410 on every column route", async () => {
    const boardId = await newBoard("archived-board");
    const snap = await snapshot(boardId);
    const ids = { boardId, columnId: idOf(snap, "Cancelled"), targetId: idOf(snap, "Done") };
    await ok(admin.request("POST", `/api/v1/channels/${boardId}/archive`));
    for (const route of COLUMN_ROUTES) {
      const res = await route.call(admin, ids);
      expect(res.status, route.name).toBe(410);
      expect(errorOf(res).code).toBe("channel_archived");
    }
  });
});
