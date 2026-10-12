import { randomUUID } from "node:crypto";
import { BoardCard, cardMessageBody } from "@ocw/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../../testing";

/**
 * Phase 07.1-06 (BOARD-05, BOARD-06, D-02, D-06, P-02, Pitfalls 5 and 9): card text edits over real PostgreSQL + Redis.
 * The tracer: Víctor retitles his card; the root message is rewritten through chat's edit path (history kept,
 * `message.updated`), then `board.card_upserted` follows. Then the title-source rules, a racing edit that recovers
 * through its 409, author-only text, and the generic message edit refusing card roots.
 */

let stack: TestStack;
let su: pg.Client;
let admin: TestClient;
let alex: TestClient;
let orgId: string;
let adminId: string;

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
type Json = Record<string, any>;

async function ok(res: Promise<{ status: number; body: Record<string, unknown> | null }>, status = 200) {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as Json;
}

const errorOf = (r: { body: Record<string, unknown> | null }) => (r.body as Json | null)?.error as Json;

/** A write as the application role inside tenant A: RLS stays in force (never the migrator or superuser). */
async function asApp(sql: string, params: unknown[]): Promise<number> {
  const c = new pg.Client({ connectionString: stack.db.appUrl });
  await c.connect();
  try {
    await c.query("begin");
    await c.query("select set_config('app.organization_id', $1, true)", [orgId]);
    const res = await c.query(sql, params);
    await c.query("commit");
    return res.rowCount ?? 0;
  } finally {
    await c.end();
  }
}

/** Durable events of a board's stream in seq order. */
async function streamOf(boardId: string): Promise<Array<{ seq: number; type: string; payload: Json }>> {
  const res = await su.query(
    "select seq::int as seq, type, payload from app.stream_events where stream_id = $1 order by seq",
    [`conv:${boardId}`],
  );
  return res.rows;
}

async function newBoard(name: string, visibility: "public" | "private" = "public") {
  const created = await ok(admin.request("POST", "/api/v1/channels", { name, layout: "board", visibility }));
  if (visibility === "public") await ok(alex.request("POST", `/api/v1/channels/${created.id}/join`));
  const snap = await ok(admin.request("GET", `/api/v1/boards/${created.id}`));
  return {
    id: created.id as string,
    columns: new Map<string, string>(snap.columns.map((c: Json) => [c.name, c.id])),
  };
}

const addCard = (as: TestClient, boardId: string, description: string, extra: Json = {}) =>
  ok(
    as.request("POST", `/api/v1/boards/${boardId}/cards`, {
      description,
      clientMessageId: randomUUID(),
      ...extra,
    }),
  );

const patch = (as: TestClient, boardId: string, messageId: string, body: Json) =>
  as.request("PATCH", `/api/v1/boards/${boardId}/cards/${messageId}`, body);

const cardIn = async (boardId: string, messageId: string): Promise<Json> => {
  const snap = await ok(admin.request("GET", `/api/v1/boards/${boardId}`));
  const card = (snap.cards as Json[])
    .flatMap((c) => c.cards as Json[])
    .find((c) => c.messageId === messageId);
  if (!card) throw new Error(`card ${messageId} not in the snapshot`);
  return card;
};

const rootBody = async (messageId: string): Promise<string> =>
  (await su.query("select body from app.messages where id = $1", [messageId])).rows[0].body;

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
  adminId = setup.user.id;
  const inv = await ok(
    admin.request("POST", "/api/v1/invitations", { email: "alex@example.test", role: "developer" }),
  );
  alex = new TestClient(stack.baseUrl);
  await ok(
    alex.request("POST", `/api/v1/invitations/${inv.id}/accept`, {
      name: "Alex Kim",
      password: "another-long-password",
    }),
  );
});

afterAll(async () => {
  await su?.end();
  await stack?.stop();
});

describe("card text edits (tracer, BOARD-05, P-02)", () => {
  it("Víctor retitles his card: the root message is edited with history, then the card is upserted", async () => {
    const b = await newBoard("pumps");
    const card = await addCard(admin, b.id, "Broken pump\nPump 3 leaks");
    expect(card).toMatchObject({ title: "Broken pump", titleSource: "heuristic", version: 1 });
    const oldBody = await rootBody(card.messageId);

    const edited = await ok(
      patch(admin, b.id, card.messageId, { expectedVersion: 1, title: "Pump 3 replaced" }),
    );
    expect(BoardCard.parse(edited)).toMatchObject({
      messageId: card.messageId,
      title: "Pump 3 replaced",
      titleSource: "user",
      description: "Broken pump\nPump 3 leaks",
      version: 2,
    });
    expect(await cardIn(b.id, card.messageId)).toEqual(edited);

    // The root message carries the card's new text; its old body is in the append-only history.
    expect(await rootBody(card.messageId)).toBe(
      cardMessageBody({
        title: "Pump 3 replaced",
        description: "Broken pump\nPump 3 leaks",
        fields: {},
        defs: [],
      }),
    );
    const versions = (
      await su.query(
        "select version, kind, body, edited_by from app.message_versions where message_id = $1",
        [card.messageId],
      )
    ).rows;
    expect(versions).toEqual([{ version: 1, kind: "edit", body: oldBody, edited_by: adminId }]);
    const msg = (await su.query("select edited_at from app.messages where id = $1", [card.messageId]))
      .rows[0];
    expect(msg.edited_at).not.toBeNull();

    // message.updated, then board.card_upserted at version 2, on the channel's stream.
    const evs = (await streamOf(b.id)).filter(
      (e) => e.type === "message.updated" || e.type === "board.card_upserted",
    );
    expect(evs.map((e) => [e.type, e.payload.card?.version ?? null])).toEqual([
      ["board.card_upserted", 1],
      ["message.updated", null],
      ["board.card_upserted", 2],
    ]);
    expect(evs[1]?.payload.message).toMatchObject({
      id: card.messageId,
      body: await rootBody(card.messageId),
    });
    expect(evs[2]?.payload.card).toMatchObject({ title: "Pump 3 replaced", version: 2 });

    // Audited by ids and booleans, never the text.
    const audits = (
      await su.query(
        "select action, metadata from app.audit_events where action in ('board.card.updated', 'message.edited') and resource_id = $1",
        [card.messageId],
      )
    ).rows as Json[];
    expect(audits.map((a) => a.action).sort()).toEqual(["board.card.updated", "message.edited"]);
    expect(audits.find((a) => a.action === "board.card.updated")?.metadata).toMatchObject({
      conversationId: b.id,
      messageId: card.messageId,
      titleChanged: true,
      descriptionChanged: false,
      fieldsChanged: false,
      version: 2,
    });
    const text = JSON.stringify(audits);
    expect(text).not.toContain("Pump 3 replaced");
    expect(text).not.toContain("Broken pump");
  });
});

const RULE = "{prefix}-{seq:0000} · {field:customer} · {summary}";
const CUSTOMER = [{ key: "customer", label: "Customer", type: "text", required: false }];

describe("a typed title is never replaced (BOARD-06, D-06, Pitfall 9)", () => {
  it("a heuristic title follows description and field edits until a title is typed; then it never changes", async () => {
    const b = await newBoard("expedientes");
    await asApp(
      "update app.boards set prefix = 'EXP', naming_rule = $1, fields = $2::jsonb where conversation_id = $3",
      [RULE, JSON.stringify(CUSTOMER), b.id],
    );
    let card = await addCard(admin, b.id, "Broken pump\nsecond line", { fields: { customer: "Acme" } });
    expect(card).toMatchObject({
      title: "EXP-0001 · Acme · Broken pump",
      titleSource: "heuristic",
      number: 1,
    });

    card = await ok(
      patch(admin, b.id, card.messageId, {
        expectedVersion: card.version,
        description: "Leaking valve\nmore",
      }),
    );
    expect(card).toMatchObject({
      title: "EXP-0001 · Acme · Leaking valve",
      titleSource: "heuristic",
      version: 2,
    });
    card = await ok(
      patch(admin, b.id, card.messageId, { expectedVersion: card.version, fields: { customer: "Globex" } }),
    );
    expect(card).toMatchObject({
      title: "EXP-0001 · Globex · Leaking valve",
      titleSource: "heuristic",
      fields: { customer: "Globex" },
      version: 3,
    });
    expect(await rootBody(card.messageId)).toBe(
      cardMessageBody({
        title: card.title,
        description: "Leaking valve\nmore",
        fields: card.fields,
        defs: CUSTOMER as never,
      }),
    );

    card = await ok(
      patch(admin, b.id, card.messageId, { expectedVersion: card.version, title: "Valve case" }),
    );
    expect(card).toMatchObject({ title: "Valve case", titleSource: "user", version: 4 });
    card = await ok(
      patch(admin, b.id, card.messageId, { expectedVersion: card.version, description: "Gasket\nnew" }),
    );
    card = await ok(
      patch(admin, b.id, card.messageId, { expectedVersion: card.version, fields: { customer: "Initech" } }),
    );
    expect(card).toMatchObject({
      title: "Valve case",
      titleSource: "user",
      description: "Gasket\nnew",
      fields: { customer: "Initech" },
      number: 1,
      version: 6,
    });
    expect(await rootBody(card.messageId)).toBe(
      cardMessageBody({
        title: "Valve case",
        description: "Gasket\nnew",
        fields: { customer: "Initech" },
        defs: CUSTOMER as never,
      }),
    );
    // A null value clears a field; an unknown key or a non-text value is refused.
    card = await ok(
      patch(admin, b.id, card.messageId, { expectedVersion: card.version, fields: { customer: null } }),
    );
    expect(card).toMatchObject({ title: "Valve case", fields: { customer: null }, version: 7 });
    const unknown = await patch(admin, b.id, card.messageId, {
      expectedVersion: card.version,
      fields: { region: "EU" },
    });
    expect(unknown.status).toBe(400);
    expect(errorOf(unknown).code).toBe("invalid_field_values");

    // A card created with a typed title keeps it through every later edit.
    let typed = await addCard(admin, b.id, "First line", { title: "Typed", fields: { customer: "Acme" } });
    expect(typed).toMatchObject({ title: "Typed", titleSource: "user", number: 2 });
    typed = await ok(
      patch(admin, b.id, typed.messageId, { expectedVersion: 1, description: "Another\nline" }),
    );
    typed = await ok(
      patch(admin, b.id, typed.messageId, { expectedVersion: 2, fields: { customer: "Globex" } }),
    );
    expect(typed).toMatchObject({ title: "Typed", titleSource: "user", version: 3 });
  });

  it("racing title and description edits: one 409 carries the fresh card, its retry succeeds, the typed title wins", async () => {
    const b = await newBoard("race");
    const titleEdit = { title: "Valve case 2" };
    const descriptionEdit = { description: "New first line\nmore" };
    const expectFinal = async (messageId: string, version: number) => {
      const final = await cardIn(b.id, messageId);
      expect(final).toMatchObject({
        title: "Valve case 2",
        titleSource: "user",
        description: "New first line\nmore",
        version,
      });
      expect(await rootBody(messageId)).toBe(
        cardMessageBody({ title: "Valve case 2", description: "New first line\nmore", fields: {}, defs: [] }),
      );
    };
    /** The loser retries once with the version its 409 body carries and its original change. */
    const retry = async (
      messageId: string,
      res: { status: number; body: Record<string, unknown> | null },
      change: Json,
    ) => {
      expect(res.status).toBe(409);
      expect(errorOf(res).code).toBe("board_card_version_conflict");
      const fresh = BoardCard.parse(errorOf(res).details.card);
      expect(fresh.messageId).toBe(messageId);
      return ok(patch(admin, b.id, messageId, { expectedVersion: fresh.version, ...change }));
    };

    // Both at once.
    const raced = await addCard(admin, b.id, "Valve\nold text");
    const v = raced.version as number;
    const [a, d] = await Promise.all([
      patch(admin, b.id, raced.messageId, { expectedVersion: v, ...titleEdit }),
      patch(admin, b.id, raced.messageId, { expectedVersion: v, ...descriptionEdit }),
    ]);
    expect([a.status, d.status].sort()).toEqual([200, 409]);
    if (a.status === 409) await retry(raced.messageId, a, titleEdit);
    else await retry(raced.messageId, d, descriptionEdit);
    await expectFinal(raced.messageId, v + 2);

    // Both orders, deterministically: the second PATCH carries the same stale version.
    for (const [first, second] of [
      [titleEdit, descriptionEdit],
      [descriptionEdit, titleEdit],
    ] as const) {
      const c = await addCard(admin, b.id, "Valve\nold text");
      await ok(patch(admin, b.id, c.messageId, { expectedVersion: c.version, ...first }));
      const stale = await patch(admin, b.id, c.messageId, { expectedVersion: c.version, ...second });
      expect(errorOf(stale).details.card.version).toBe(c.version + 1);
      await retry(c.messageId, stale, second);
      await expectFinal(c.messageId, c.version + 2);
    }
  });
});

describe("card text belongs to its author (P-02, T-07.1-06-01)", () => {
  it("someone else edits no text but moves the card and sets its waiting state; admins included; agent cards for nobody", async () => {
    const b = await newBoard("ownership");
    const done = b.columns.get("Done") as string;
    const mine = await addCard(admin, b.id, "Víctor's case");
    for (const change of [{ title: "Hijacked" }, { description: "Hijacked" }, { fields: {} }]) {
      const res = await patch(alex, b.id, mine.messageId, { expectedVersion: 1, ...change });
      expect(res.status, JSON.stringify(change)).toBe(403);
      expect(errorOf(res).code).toBe("not_author");
    }
    const moved = await ok(
      patch(alex, b.id, mine.messageId, { expectedVersion: 1, move: { columnId: done, afterCardId: null } }),
    );
    expect(moved).toMatchObject({ columnId: done, version: 2, title: "Víctor's case" });
    const waiting = await ok(
      patch(alex, b.id, mine.messageId, { expectedVersion: 2, waitingOn: "customer" }),
    );
    expect(waiting).toMatchObject({ waitingOn: "customer", version: 3 });

    // The org admin cannot edit Alex's words either.
    const alexCard = await addCard(alex, b.id, "Alex's case");
    const byAdmin = await patch(admin, b.id, alexCard.messageId, { expectedVersion: 1, title: "Rewritten" });
    expect(byAdmin.status).toBe(403);
    expect(errorOf(byAdmin).code).toBe("not_author");

    // An agent-authored card's text is editable by nobody.
    const agentId = randomUUID();
    await su.query(
      `insert into app.agents (id, organization_id, name, username, instructions, model_provider, model_id, status)
       values ($1, $2, 'Archie', 'archie', 'x', 'mock', 'mock-1', 'ready')`,
      [agentId, orgId],
    );
    const agentCard = await addCard(admin, b.id, "Filed by the agent");
    await su.query("update app.messages set author_kind = 'agent', author_id = $1 where id = $2", [
      agentId,
      agentCard.messageId,
    ]);
    for (const as of [admin, alex]) {
      const res = await patch(as, b.id, agentCard.messageId, { expectedVersion: 1, title: "Mine now" });
      expect(res.status).toBe(403);
      expect(errorOf(res).code).toBe("not_author");
    }
    const untouched = await cardIn(b.id, agentCard.messageId);
    expect(untouched).toMatchObject({
      title: "Filed by the agent",
      version: 1,
      authorKind: "agent",
      authorId: agentId,
    });
    expect(
      (
        await su.query("select count(*)::int as n from app.message_versions where message_id = $1", [
          agentCard.messageId,
        ])
      ).rows[0].n,
    ).toBe(0);
  });
});

describe("the generic message edit cannot desync a card (Pitfall 5)", () => {
  it("PATCH /messages/:id refuses a card root, even for its author; replies in the card's thread edit as before", async () => {
    const b = await newBoard("generic");
    const card = await addCard(admin, b.id, "Root text");
    const before = await rootBody(card.messageId);
    const refused = await admin.request("PATCH", `/api/v1/messages/${card.messageId}`, { body: "Desynced" });
    expect(refused.status).toBe(400);
    expect(errorOf(refused).code).toBe("board_card_use_board");
    expect(await rootBody(card.messageId)).toBe(before);
    expect(await cardIn(b.id, card.messageId)).toMatchObject({ title: "Root text", version: 1 });

    // Not the author: still the Phase 4 answer first.
    const notMine = await alex.request("PATCH", `/api/v1/messages/${card.messageId}`, { body: "Desynced" });
    expect(notMine.status).toBe(403);
    expect(errorOf(notMine).code).toBe("not_author");

    const reply = await ok(
      admin.request("POST", `/api/v1/conversations/${b.id}/messages`, {
        body: "First reply",
        threadRootId: card.messageId,
      }),
    );
    const edited = await ok(admin.request("PATCH", `/api/v1/messages/${reply.id}`, { body: "Edited reply" }));
    expect(edited).toMatchObject({ id: reply.id, body: "Edited reply" });
  });
});

describe("deleting a card root while its text is edited (07.1-14, WINDOWS #103)", () => {
  /** Backends of this database waiting on a heavyweight lock (a row lock wait shows as `Lock`). */
  const lockWaiters = async (): Promise<number> =>
    (
      await su.query(
        `select count(*)::int as n from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock' and pid <> pg_backend_pid()`,
      )
    ).rows[0].n;

  async function until(fn: () => Promise<boolean>, ms = 10_000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await fn()) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`condition not met within ${ms} ms`);
  }

  it("the delete queues behind the edit on the stream lock: both answer 200, nobody deadlocks", async () => {
    const b = await newBoard("racing-delete");
    const card = await addCard(admin, b.id, "Broken pump\nPump 3 leaks");

    // Hold the board's stream row so both requests queue on it in a known order: the edit first, then the delete.
    // Before the fix the delete took the message row first and the stream second (the edit's reverse order), so
    // releasing the stream let the edit take it and wait for the message the delete held: a deadlock, one 500.
    const holder = new pg.Client({ connectionString: stack.db.superuserUrl });
    await holder.connect();
    try {
      await holder.query("begin");
      await holder.query("select last_seq from app.streams where id = $1 for update", [`conv:${b.id}`]);

      const edit = patch(admin, b.id, card.messageId, { expectedVersion: 1, title: "Pump 3 replaced" });
      await until(async () => (await lockWaiters()) >= 1);
      const del = admin.request("DELETE", `/api/v1/messages/${card.messageId}`);
      await until(async () => (await lockWaiters()) >= 2);
      await holder.query("commit");

      const [edited, deleted] = await Promise.all([edit, del]);
      expect(edited.status, JSON.stringify(edited.body)).toBe(200);
      expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
    } finally {
      await holder.end();
    }

    // The edit landed first (history kept), then the delete tombstoned the root and the card left the board.
    const versions = await su.query(
      "select version, kind from app.message_versions where message_id = $1 order by version",
      [card.messageId],
    );
    expect(versions.rows.map((r) => r.kind)).toEqual(["edit", "delete"]);
    const snap = await ok(admin.request("GET", `/api/v1/boards/${b.id}`));
    expect(JSON.stringify(snap)).not.toContain(card.messageId);
  });
});
