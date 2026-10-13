import { randomUUID } from "node:crypto";
import { BoardCard } from "@ocw/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../../testing";

/**
 * Phase 07.1-03 Task 2 (BOARD-03, D-05, D-06, T-07.1-03-03): two people moving cards at once converge without lost
 * moves. Real PostgreSQL + Redis, real concurrent HTTP requests (`Promise.all`). Ranks are minted only by the server
 * after the conversation's stream lock; a stale version is 409 with the current card; a tie or a corrupt order
 * re-ranks the column with one event; numbers never repeat. Direct writes use the `app` role in tenant A (RLS on).
 */

let stack: TestStack;
let su: pg.Client;
let admin: TestClient;
let alex: TestClient;
let orgId: string;

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
type Json = Record<string, any>;

async function ok(res: Promise<{ status: number; body: Record<string, unknown> | null }>, status = 200) {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as Json;
}

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

const byRank = (a: { rank: string; id: string }, b: { rank: string; id: string }) =>
  a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/** The board's card order per column as replayed from its events alone (what a live client converges to). */
async function replayed(boardId: string): Promise<Map<string, string[]>> {
  const state = new Map<string, { id: string; columnId: string; rank: string }>();
  for (const ev of await streamOf(boardId)) {
    if (ev.type === "board.card_upserted") {
      const c = ev.payload.card;
      state.set(c.messageId, { id: c.messageId, columnId: c.columnId, rank: c.rank });
    } else if (ev.type === "board.column_reranked") {
      for (const r of ev.payload.ranks) {
        const s = state.get(r.messageId);
        if (s) state.set(r.messageId, { ...s, rank: r.rank });
      }
    }
  }
  const out = new Map<string, string[]>();
  for (const s of [...state.values()].sort(byRank))
    out.set(s.columnId, [...(out.get(s.columnId) ?? []), s.id]);
  return out;
}

async function newBoard(name: string): Promise<{ id: string; columns: Map<string, string> }> {
  const created = await ok(admin.request("POST", "/api/v1/channels", { name, layout: "board" }));
  await ok(alex.request("POST", `/api/v1/channels/${created.id}/join`));
  const snap = await ok(admin.request("GET", `/api/v1/boards/${created.id}`));
  return { id: created.id, columns: new Map(snap.columns.map((c: Json) => [c.name, c.id])) };
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

const snapshot = (boardId: string) => ok(admin.request("GET", `/api/v1/boards/${boardId}`));

/** Card ids per column in snapshot order. */
const orderOf = (snap: Json) =>
  new Map<string, string[]>(
    snap.cards
      .filter((c: Json) => c.cards.length > 0)
      .map((c: Json) => [c.columnId, c.cards.map((k: Json) => k.messageId)]),
  );

const cardsOf = (snap: Json): Json[] => snap.cards.flatMap((c: Json) => c.cards);

/** Deterministic PRNG (mulberry32), so the randomized rounds replay identically. */
function rng(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

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

describe("board concurrency (BOARD-03, D-05)", () => {
  it('(a) ranks come back in JavaScript sort order (COLLATE "C"), from the snapshot and the column page', async () => {
    const b = await newBoard("order");
    const backlog = b.columns.get("Backlog") as string;
    const ranks = ["a1", "Zz", "a0V", "A0", "a0"];
    const ids: string[] = [];
    for (const [i] of ranks.entries()) ids.push((await addCard(admin, b.id, `Card ${i}`)).messageId);
    for (const [i, rank] of ranks.entries()) {
      expect(await asApp("update app.board_cards set rank = $1 where message_id = $2", [rank, ids[i]])).toBe(
        1,
      );
    }
    const snap = await snapshot(b.id);
    const got = snap.cards.find((c: Json) => c.columnId === backlog).cards.map((c: Json) => c.rank);
    expect(got).toEqual([...ranks].sort());
    expect(got).toEqual(["A0", "Zz", "a0", "a0V", "a1"]);
    const page = await ok(admin.request("GET", `/api/v1/boards/${b.id}/columns/${backlog}/cards`));
    expect(page.cards.map((c: Json) => c.rank)).toEqual(got);
    const after = await ok(admin.request("GET", `/api/v1/boards/${b.id}/columns/${backlog}/cards?after=Zz`));
    expect(after.cards.map((c: Json) => c.rank)).toEqual(["a0", "a0V", "a1"]);
  });

  it("(b) two people dropping different cards into the same slot both land, with distinct ranks", async () => {
    const b = await newBoard("same-slot");
    const inProgress = b.columns.get("In progress") as string;
    const a = await addCard(admin, b.id, "A");
    const x = await addCard(admin, b.id, "X");
    const y = await addCard(alex, b.id, "Y");
    await ok(
      patch(admin, b.id, a.messageId, {
        expectedVersion: 1,
        move: { columnId: inProgress, afterCardId: null },
      }),
    );

    const [rx, ry] = await Promise.all([
      patch(admin, b.id, x.messageId, {
        expectedVersion: 1,
        move: { columnId: inProgress, afterCardId: a.messageId },
      }),
      patch(alex, b.id, y.messageId, {
        expectedVersion: 1,
        move: { columnId: inProgress, afterCardId: a.messageId },
      }),
    ]);
    expect([rx.status, ry.status]).toEqual([200, 200]);
    const cx = rx.body as Json;
    const cy = ry.body as Json;
    expect(cx.rank).not.toBe(cy.rank);
    expect([cx.columnId, cy.columnId]).toEqual([inProgress, inProgress]);

    const snap = await snapshot(b.id);
    const order = orderOf(snap).get(inProgress) ?? [];
    expect(order).toHaveLength(3);
    expect(order[0]).toBe(a.messageId);
    expect(cardsOf(snap)).toHaveLength(3);
    // The snapshot order of X and Y equals the order of their events' ranks.
    const evs = (await streamOf(b.id)).filter(
      (e) =>
        e.type === "board.card_upserted" &&
        e.payload.card.version === 2 &&
        [x.messageId, y.messageId].includes(e.payload.card.messageId),
    );
    expect(evs).toHaveLength(2);
    const byEvents = evs
      .map((e) => ({ id: e.payload.card.messageId as string, rank: e.payload.card.rank as string }))
      .sort(byRank)
      .map((e) => e.id);
    expect(order.slice(1)).toEqual(byEvents);
  });

  it("(b) ten rounds of six parallel moves across three columns: every card once, snapshot = replayed events", async () => {
    const b = await newBoard("rounds");
    const targets = ["Backlog", "In progress", "Done"].map((n) => b.columns.get(n) as string);
    const ids: string[] = [];
    for (let i = 0; i < 9; i += 1)
      ids.push((await addCard(i % 2 ? alex : admin, b.id, `Round card ${i}`)).messageId);
    const rand = rng(7031);
    for (let round = 0; round < 10; round += 1) {
      const snap = await snapshot(b.id);
      const cards = new Map<string, Json>(cardsOf(snap).map((c) => [c.messageId, c]));
      const order = orderOf(snap);
      const movers = [...ids].sort(() => rand() - 0.5).slice(0, 6);
      const results = await Promise.all(
        movers.map((id, i) => {
          const columnId = targets[Math.floor(rand() * targets.length)] as string;
          const there = (order.get(columnId) ?? []).filter((c) => c !== id);
          const pick = Math.floor(rand() * (there.length + 1));
          const afterCardId = pick === there.length ? null : (there[pick] as string);
          return patch(i % 2 ? alex : admin, b.id, id, {
            expectedVersion: cards.get(id)?.version,
            move: { columnId, afterCardId },
          });
        }),
      );
      expect(
        results.map((r) => r.status),
        `round ${round}`,
      ).toEqual(Array(6).fill(200));
      const after = await snapshot(b.id);
      const seen = cardsOf(after).map((c) => c.messageId);
      expect([...seen].sort()).toEqual([...ids].sort());
      expect(orderOf(after)).toEqual(await replayed(b.id));
      for (const [, list] of orderOf(after)) {
        const ranks = list.map((id) => cardsOf(after).find((c) => c.messageId === id)?.rank as string);
        expect(new Set(ranks).size).toBe(ranks.length);
      }
    }
  });

  it("(c) two moves of the same card: one wins, the other gets 409 with the current card and recovers", async () => {
    const b = await newBoard("same-card");
    const done = b.columns.get("Done") as string;
    const inProgress = b.columns.get("In progress") as string;
    const card = await addCard(admin, b.id, "Contested");
    const moves = {
      admin: { columnId: done, afterCardId: null },
      alex: { columnId: inProgress, afterCardId: null },
    };
    const [ra, rb] = await Promise.all([
      patch(admin, b.id, card.messageId, { expectedVersion: 1, move: moves.admin }),
      patch(alex, b.id, card.messageId, { expectedVersion: 1, move: moves.alex }),
    ]);
    expect([ra.status, rb.status].sort()).toEqual([200, 409]);
    const [winner, loser, loserClient, loserMove] =
      ra.status === 200 ? [ra, rb, alex, moves.alex] : [rb, ra, admin, moves.admin];
    // The 409 envelope carries the current card in `error.details.card` (the web applies it without a refetch).
    const err = (loser.body as Json).error;
    expect(loser.status).toBe(409);
    expect(err.code).toBe("board_card_version_conflict");
    expect(BoardCard.safeParse(err.details.card).success).toBe(true);
    expect(err.details.card).toEqual(winner.body);
    expect(err.details.card.version).toBe(2);
    expect(cardsOf(await snapshot(b.id)).find((c) => c.messageId === card.messageId)).toEqual(
      err.details.card,
    );

    const retried = await ok(
      patch(loserClient, b.id, card.messageId, {
        expectedVersion: err.details.card.version,
        move: loserMove,
      }),
    );
    expect(retried).toMatchObject({ columnId: loserMove.columnId, version: 3 });
    const final = cardsOf(await snapshot(b.id)).find((c) => c.messageId === card.messageId);
    expect(final).toMatchObject({ columnId: loserMove.columnId, version: 3 });
  });

  it("(d) a tie re-ranks the column once, strictly increasing, without bumping any other card's version", async () => {
    const b = await newBoard("rerank");
    const backlog = b.columns.get("Backlog") as string;
    const p = await addCard(admin, b.id, "P");
    const q = await addCard(admin, b.id, "Q");
    const r = await addCard(admin, b.id, "R");
    await asApp("update app.board_cards set rank = 'a1' where message_id = any($1::uuid[])", [
      [p.messageId, q.messageId],
    ]);
    await asApp("update app.board_cards set rank = 'a2' where message_id = $1", [r.messageId]);
    const [first, second] = [p.messageId, q.messageId].sort();
    const before = (await streamOf(b.id)).filter((e) => e.type === "board.column_reranked").length;

    const moved = await ok(
      patch(admin, b.id, r.messageId, {
        expectedVersion: 1,
        move: { columnId: backlog, afterCardId: first },
      }),
    );
    expect(moved.version).toBe(2);
    const reranks = (await streamOf(b.id)).filter((e) => e.type === "board.column_reranked");
    expect(reranks.length - before).toBe(1);
    expect(reranks.at(-1)?.payload).toMatchObject({ conversationId: b.id, columnId: backlog });

    const list = (await snapshot(b.id)).cards.find((c: Json) => c.columnId === backlog).cards as Json[];
    expect(list.map((c) => c.messageId)).toEqual([first, r.messageId, second]);
    const ranks = list.map((c) => c.rank as string);
    expect([...ranks].sort()).toEqual(ranks);
    expect(new Set(ranks).size).toBe(3);
    expect(list.filter((c) => c.messageId !== r.messageId).map((c) => c.version)).toEqual([1, 1]);
    // The event's ranks are exactly the other cards' new ranks.
    const evRanks = new Map(
      ((reranks.at(-1)?.payload.ranks ?? []) as Json[]).map((x) => [x.messageId, x.rank]),
    );
    for (const c of list.filter((k) => k.messageId !== r.messageId))
      expect(evRanks.get(c.messageId)).toBe(c.rank);
  });

  it("(e) eight parallel creates on a prefixed board get numbers 1..8 without gaps or duplicates", async () => {
    const b = await newBoard("expedientes");
    await asApp("update app.boards set prefix = 'EXP', naming_rule = $1 where conversation_id = $2", [
      "{prefix}-{seq:0000} · {summary}",
      b.id,
    ]);
    const cards = await Promise.all(
      Array.from({ length: 8 }, (_, i) => addCard(i % 2 ? alex : admin, b.id, `Case ${i}\nmore detail`)),
    );
    expect(cards.map((c) => c.number).sort((x, y) => x - y)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    for (const c of cards) {
      expect(c.title).toBe(`EXP-${String(c.number).padStart(4, "0")} · ${c.description.split("\n")[0]}`);
      expect(c.titleSource).toBe("heuristic");
    }
    const typed = await addCard(admin, b.id, "Leaking valve", { title: "Valve" });
    expect(typed).toMatchObject({ title: "Valve", titleSource: "user", number: 9 });
    const counter = await su.query("select last_number from app.boards where conversation_id = $1", [b.id]);
    expect(counter.rows[0].last_number).toBe(9);
  });

  it("(f) entering a column with a default waiting state applies it; null keeps it; an explicit one wins", async () => {
    const b = await newBoard("waiting");
    const done = b.columns.get("Done") as string;
    const inProgress = b.columns.get("In progress") as string;
    expect(
      await asApp("update app.board_columns set default_waiting_on = 'customer' where id = $1", [done]),
    ).toBe(1);
    const w = await addCard(admin, b.id, "Waiting card");
    expect(w.waitingOn).toBe("none");
    const toDone = await ok(
      patch(admin, b.id, w.messageId, { expectedVersion: 1, move: { columnId: done, afterCardId: null } }),
    );
    expect(toDone.waitingOn).toBe("customer");
    const toProgress = await ok(
      patch(alex, b.id, w.messageId, {
        expectedVersion: 2,
        move: { columnId: inProgress, afterCardId: null },
      }),
    );
    expect(toProgress.waitingOn).toBe("customer");
    const explicit = await ok(
      patch(admin, b.id, w.messageId, {
        expectedVersion: 3,
        move: { columnId: done, afterCardId: null },
        waitingOn: "us",
      }),
    );
    expect(explicit).toMatchObject({ columnId: done, waitingOn: "us", version: 4 });
    const waitingOnly = await ok(patch(alex, b.id, w.messageId, { expectedVersion: 4, waitingOn: "none" }));
    expect(waitingOnly).toMatchObject({ columnId: done, waitingOn: "none", version: 5 });
  });
});
