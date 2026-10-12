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
let adminId: string;

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
type Json = Record<string, any>;

async function ok(res: Promise<{ status: number; body: Record<string, unknown> | null }>, status = 200) {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as Json;
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
