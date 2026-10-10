import { type BoardCard, type BoardSnapshot, EventTypes, type UpdateBoardCardRequest } from "@ocw/contracts";
import type { TopicFrame } from "@ocw/realtime-client";
import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it } from "vitest";
import { ApiRequestError } from "./api";
import { AT, BOARD, COL, COLUMNS, CONV, card, id, order, snapshot } from "./board-fixtures.test-util";
import {
  applyBoardFrame,
  boardAfterSeq,
  boardAnnouncement,
  boardKeys,
  type CardChangeEffects,
  changeBoardCard,
  placeCard,
  resyncBoard,
  rollbackWith,
  undoPlacement,
  upsertCard,
} from "./board-queries";

/**
 * The browser's board cache (07.1-04, BOARD-04, D-03, P-06, Pitfall 3): one dispatcher applies live frames to one
 * cached snapshot, idempotently and replay-safely; frames that are not the board's go back to the message handlers.
 */

let qc: QueryClient;
let seq = 10;

const ev = (type: string, data: unknown, at = ++seq): TopicFrame => ({
  op: "ev",
  topic: `conv:${CONV}`,
  seq: at,
  type,
  data,
});
const cached = () => qc.getQueryData<BoardSnapshot>(boardKeys.board(CONV));
const invalidated = () => qc.getQueryState(boardKeys.board(CONV))?.isInvalidated === true;

const A = card(1, { rank: "a0" });
const B = card(2, { rank: "a2", columnId: COL.progress });
const C = card(3, { rank: "a4", columnId: COL.progress });
const X = card(4, { rank: "a1", version: 2 });

beforeEach(() => {
  qc = new QueryClient();
  seq = 10;
  qc.setQueryData(boardKeys.board(CONV), snapshot([A, X, B, C]));
});

describe("applyBoardFrame: board.card_upserted (tracer)", () => {
  it("a newer card leaves its column and sits in the new one at its rank position", () => {
    const moved = { ...X, columnId: COL.progress, rank: "a3", version: 3 };
    expect(applyBoardFrame(qc, CONV, ev(EventTypes.boardCardUpserted, { card: moved }))).toBe(true);
    expect(order(cached())[COL.backlog]).toEqual([A.messageId]);
    expect(order(cached())[COL.progress]).toEqual([B.messageId, X.messageId, C.messageId]);
    expect(cached()?.cards[1]?.cards[1]).toEqual(moved);
  });

  it("the same frame again changes nothing (same object), and an older or equal version is ignored", () => {
    const frame = ev(EventTypes.boardCardUpserted, { card: { ...X, columnId: COL.done, version: 3 } });
    applyBoardFrame(qc, CONV, frame);
    const after = cached();
    expect(applyBoardFrame(qc, CONV, frame)).toBe(true);
    expect(cached()).toBe(after);
    const stale = ev(EventTypes.boardCardUpserted, { card: { ...X, columnId: COL.cancelled, version: 2 } });
    applyBoardFrame(qc, CONV, stale);
    expect(cached()).toBe(after);
    // Same version, different content (a replay racing a newer copy): the cached copy stays.
    const equal = ev(EventTypes.boardCardUpserted, { card: { ...X, columnId: COL.cancelled, version: 3 } });
    applyBoardFrame(qc, CONV, equal);
    expect(order(cached())[COL.done]).toEqual([X.messageId]);
    expect(order(cached())[COL.cancelled]).toEqual([]);
  });

  it('a new card joins its column in rank order (ranks compare like JS strings, COLLATE "C")', () => {
    const fresh = card(9, { columnId: COL.progress, rank: "Zz" });
    applyBoardFrame(qc, CONV, ev(EventTypes.boardCardUpserted, { card: fresh }));
    expect(order(cached())[COL.progress]).toEqual([fresh.messageId, B.messageId, C.messageId]);
  });

  it("a frame already contained in the snapshot (seq <= lastSeq) is ignored", () => {
    const before = cached();
    applyBoardFrame(qc, CONV, ev(EventTypes.boardCardUpserted, { card: { ...X, version: 9 } }, 10));
    expect(cached()).toBe(before);
  });

  it("a card of another conversation, a malformed payload or an unknown board event touches nothing", () => {
    const before = cached();
    const other = { ...X, conversationId: id(2), version: 9 };
    expect(applyBoardFrame(qc, CONV, ev(EventTypes.boardCardUpserted, { card: other }))).toBe(true);
    expect(applyBoardFrame(qc, CONV, ev(EventTypes.boardCardUpserted, { card: { title: 1 } }))).toBe(true);
    expect(applyBoardFrame(qc, CONV, ev("board.something_new", {}))).toBe(true);
    expect(cached()).toBe(before);
  });

  it("a card in a column the cache does not know yet refetches the board", () => {
    applyBoardFrame(
      qc,
      CONV,
      ev(EventTypes.boardCardUpserted, { card: { ...X, columnId: id(99), version: 3 } }),
    );
    expect(invalidated()).toBe(true);
  });

  it("in a column with more cards than loaded, a card ranked past the loaded ones waits for its page", () => {
    qc.setQueryData(boardKeys.board(CONV), (s: BoardSnapshot | undefined) =>
      s
        ? { ...s, cards: s.cards.map((c) => (c.columnId === COL.progress ? { ...c, hasMore: true } : c)) }
        : s,
    );
    applyBoardFrame(
      qc,
      CONV,
      ev(EventTypes.boardCardUpserted, { card: { ...X, columnId: COL.progress, rank: "b0", version: 3 } }),
    );
    expect(order(cached())[COL.backlog]).toEqual([A.messageId]);
    expect(order(cached())[COL.progress]).toEqual([B.messageId, C.messageId]);
  });

  it("without a cached board the frame is still the board's (the snapshot fetch will contain it)", () => {
    qc.removeQueries({ queryKey: boardKeys.board(CONV) });
    expect(applyBoardFrame(qc, CONV, ev(EventTypes.boardCardUpserted, { card: X }))).toBe(true);
    expect(cached()).toBeUndefined();
  });
});

describe("applyBoardFrame: board.updated and board.column_reranked", () => {
  it("board.updated replaces the board and the columns, keeping cached cards of surviving columns", () => {
    const renamed = COLUMNS.map((c) => (c.id === COL.done ? { ...c, name: "Closed" } : c));
    const added = {
      id: id(14),
      conversationId: CONV,
      name: "Waiting",
      rank: "a15",
      category: "started" as const,
      defaultWaitingOn: "customer" as const,
    };
    const columns = [renamed[0], renamed[1], added, renamed[2], renamed[3]].filter((c) => c !== undefined);
    const board = { ...BOARD, version: 2 };
    expect(
      applyBoardFrame(qc, CONV, ev(EventTypes.boardUpdated, { conversationId: CONV, board, columns })),
    ).toBe(true);
    expect(cached()?.board).toEqual(board);
    expect(cached()?.columns.map((c) => c.name)).toEqual([
      "Backlog",
      "In progress",
      "Waiting",
      "Closed",
      "Cancelled",
    ]);
    expect(cached()?.cards.map((c) => c.columnId)).toEqual(columns.map((c) => c.id));
    expect(order(cached())[COL.progress]).toEqual([B.messageId, C.messageId]);
    expect(order(cached())[id(14)]).toEqual([]);
    expect(invalidated()).toBe(false);
  });

  it("board.updated without a column that held cached cards refetches the board (P-09)", () => {
    const columns = COLUMNS.filter((c) => c.id !== COL.progress);
    expect(
      applyBoardFrame(qc, CONV, ev(EventTypes.boardUpdated, { conversationId: CONV, board: BOARD, columns })),
    ).toBe(true);
    expect(invalidated()).toBe(true);
  });

  it("board.updated for another conversation is ignored", () => {
    const before = cached();
    applyBoardFrame(
      qc,
      CONV,
      ev(EventTypes.boardUpdated, { conversationId: id(2), board: BOARD, columns: [] }),
    );
    expect(cached()).toBe(before);
  });

  it("board.column_reranked rewrites that column's ranks and re-sorts it, versions untouched", () => {
    const ranks = [
      { messageId: C.messageId, rank: "a1" },
      { messageId: B.messageId, rank: "a2" },
    ];
    expect(
      applyBoardFrame(
        qc,
        CONV,
        ev(EventTypes.boardColumnReranked, { conversationId: CONV, columnId: COL.progress, ranks }),
      ),
    ).toBe(true);
    const progress = cached()?.cards.find((c) => c.columnId === COL.progress)?.cards ?? [];
    expect(progress.map((c) => [c.messageId, c.rank, c.version])).toEqual([
      [C.messageId, "a1", 1],
      [B.messageId, "a2", 1],
    ]);
    expect(order(cached())[COL.backlog]).toEqual([A.messageId, X.messageId]);
  });
});

describe("applyBoardFrame: frames the message handlers also need", () => {
  it("message.deleted of a card root removes the card and returns false", () => {
    const frame = ev(EventTypes.messageDeleted, {
      messageId: B.messageId,
      conversationId: CONV,
      threadId: null,
      deletedAt: AT,
      replyCount: 0,
    });
    expect(applyBoardFrame(qc, CONV, frame)).toBe(false);
    expect(order(cached())[COL.progress]).toEqual([C.messageId]);
  });

  it("message.deleted of a reply leaves the board alone", () => {
    const before = cached();
    const frame = ev(EventTypes.messageDeleted, {
      messageId: id(500),
      conversationId: CONV,
      threadId: B.messageId,
      deletedAt: AT,
      replyCount: 0,
    });
    expect(applyBoardFrame(qc, CONV, frame)).toBe(false);
    expect(cached()).toBe(before);
  });

  it("thread.updated of a card root sets its reply count and last reply, returns false", () => {
    const later = "2026-10-08T10:00:00.000Z";
    const frame = ev(EventTypes.threadUpdated, {
      rootId: B.messageId,
      replyCount: 3,
      lastReplyAt: later,
      replyParticipants: [],
    });
    expect(applyBoardFrame(qc, CONV, frame)).toBe(false);
    const b = cached()?.cards.find((c) => c.columnId === COL.progress)?.cards[0];
    expect(b).toMatchObject({ messageId: B.messageId, replyCount: 3, lastReplyAt: later, version: 1 });
  });

  it("message.created and ephemeral frames are not the board's and leave it untouched", () => {
    const before = cached();
    expect(applyBoardFrame(qc, CONV, ev(EventTypes.messageCreated, { message: {} }))).toBe(false);
    expect(
      applyBoardFrame(qc, CONV, { op: "eph", topic: `conv:${CONV}`, type: "user.typing", data: {} }),
    ).toBe(false);
    expect(cached()).toBe(before);
  });
});

describe("one subscription, one cursor (Pitfall 3)", () => {
  it("boardAfterSeq is the lower of both cursors, unknown until both are known", () => {
    expect(boardAfterSeq(12, 9)).toBe(9);
    expect(boardAfterSeq(9, 12)).toBe(9);
    expect(boardAfterSeq(0, 4)).toBe(0);
    expect(boardAfterSeq(undefined, 9)).toBeUndefined();
    expect(boardAfterSeq(12, undefined)).toBeUndefined();
  });

  it("a resync refetches the board", () => {
    resyncBoard(qc, CONV);
    expect(invalidated()).toBe(true);
  });
});

describe("placeCard (optimistic, index only)", () => {
  const D = card(5, { columnId: COL.done, rank: "a1" });
  const E = card(6, { columnId: COL.done, rank: "a3" });
  const base = () => snapshot([A, X, B, C, D, E]);

  it("puts the card right after afterCardId in the target column and takes it out of its own", () => {
    const s = base();
    const next = placeCard(s, X.messageId, { columnId: COL.done, afterCardId: D.messageId });
    expect(order(next)[COL.backlog]).toEqual([A.messageId]);
    expect(order(next)[COL.done]).toEqual([D.messageId, X.messageId, E.messageId]);
    const placed = next.cards.find((c) => c.columnId === COL.done)?.cards[1];
    expect(placed).toMatchObject({ columnId: COL.done, rank: X.rank, version: X.version });
  });

  it("afterCardId null lands at the top; a card that is not in the target column lands at the bottom", () => {
    expect(
      order(placeCard(base(), X.messageId, { columnId: COL.done, afterCardId: null }))[COL.done],
    ).toEqual([X.messageId, D.messageId, E.messageId]);
    expect(
      order(placeCard(base(), X.messageId, { columnId: COL.done, afterCardId: B.messageId }))[COL.done],
    ).toEqual([D.messageId, E.messageId, X.messageId]);
  });

  it("reorders inside one column", () => {
    expect(
      order(placeCard(base(), C.messageId, { columnId: COL.progress, afterCardId: null }))[COL.progress],
    ).toEqual([C.messageId, B.messageId]);
  });

  it("never mutates its input", () => {
    const s = base();
    const copy = structuredClone(s);
    placeCard(s, X.messageId, { columnId: COL.done, afterCardId: D.messageId });
    expect(s).toEqual(copy);
  });

  it("entering a column with a default waiting state takes it, like the server (P-09)", () => {
    const s = snapshot([A, X, B, C], {
      columns: COLUMNS.map((c) => (c.id === COL.done ? { ...c, defaultWaitingOn: "customer" as const } : c)),
    });
    const next = placeCard(s, X.messageId, { columnId: COL.done, afterCardId: null });
    expect(next.cards.find((c) => c.columnId === COL.done)?.cards[0]?.waitingOn).toBe("customer");
  });

  it("an unknown card or column changes nothing", () => {
    const s = base();
    expect(placeCard(s, id(999), { columnId: COL.done, afterCardId: null })).toBe(s);
    expect(placeCard(s, X.messageId, { columnId: id(999), afterCardId: null })).toBe(s);
  });
});

describe("rollbackWith and undoPlacement", () => {
  it("rollbackWith restores the snapshot before the move, then applies the server's card", () => {
    const before = snapshot([A, X, B, C]);
    expect(rollbackWith(before)).toBe(before);
    const server = { ...X, columnId: COL.done, rank: "a0", version: 3 };
    const next = rollbackWith(before, server);
    expect(order(next)[COL.backlog]).toEqual([A.messageId]);
    expect(order(next)[COL.done]).toEqual([X.messageId]);
  });

  it("undoPlacement puts the card back by rank and keeps live changes that arrived meanwhile", () => {
    const placed = placeCard(snapshot([A, X, B, C]), X.messageId, { columnId: COL.done, afterCardId: null });
    const live = upsertCard(placed, { ...C, columnId: COL.cancelled, version: 2 });
    const undone = undoPlacement(live, X);
    expect(order(undone)[COL.backlog]).toEqual([A.messageId, X.messageId]);
    expect(order(undone)[COL.done]).toEqual([]);
    expect(order(undone)[COL.cancelled]).toEqual([C.messageId]);
  });

  it("undoPlacement keeps a newer server copy of the card itself", () => {
    const placed = placeCard(snapshot([A, X, B, C]), X.messageId, { columnId: COL.done, afterCardId: null });
    const newer = upsertCard(placed, { ...X, columnId: COL.cancelled, version: 3 });
    expect(undoPlacement(newer, X)).toBe(newer);
  });
});

describe("boardAnnouncement (UI-SPEC screen-reader copy)", () => {
  const title = "Broken pump";
  it("returns the exact strings", () => {
    expect(boardAnnouncement("menuMove", { title, column: "Done" })).toBe("Moved “Broken pump” to Done.");
    expect(boardAnnouncement("moveTop", { title, column: "Done" })).toBe(
      "Moved “Broken pump” to the top of Done.",
    );
    expect(boardAnnouncement("moveBottom", { title, column: "Done" })).toBe(
      "Moved “Broken pump” to the bottom of Done.",
    );
    expect(boardAnnouncement("rollback", { title, column: "Backlog" })).toBe(
      "“Broken pump” couldn't be moved and is back in Backlog.",
    );
    expect(boardAnnouncement("conflict", { title })).toBe(
      "Someone else changed “Broken pump”. Showing the latest.",
    );
    expect(boardAnnouncement("waiting", { title, waitingOn: "customer" })).toBe(
      "“Broken pump” is now waiting on the customer.",
    );
    expect(boardAnnouncement("waiting", { title, waitingOn: "us" })).toBe(
      "“Broken pump” is now waiting on us.",
    );
    expect(boardAnnouncement("waiting", { title, waitingOn: "both" })).toBe(
      "“Broken pump” is now waiting on both.",
    );
    expect(boardAnnouncement("waiting", { title, waitingOn: "none" })).toBe(
      "“Broken pump” is no longer waiting on anyone.",
    );
  });
});

describe("changeBoardCard: optimistic intent, rollback, conflict (D-05)", () => {
  type Sent = { messageId: string; body: UpdateBoardCardRequest };

  function effects(answer: (sent: Sent) => Promise<BoardCard>) {
    const sent: Sent[] = [];
    const toasts: string[] = [];
    const announced: string[] = [];
    let seenDuringRequest: BoardSnapshot | undefined;
    const fx: CardChangeEffects = {
      send: (messageId, body) => {
        sent.push({ messageId, body });
        seenDuringRequest = cached();
        return answer({ messageId, body });
      },
      toast: {
        neutral: (m) => toasts.push(`neutral: ${m}`),
        error: (m, d) => toasts.push(`error: ${m}${d ? ` (${d})` : ""}`),
      },
      announce: (t) => announced.push(t),
    };
    return { fx, sent, toasts, announced, during: () => seenDuringRequest };
  }

  const toDone = { columnId: COL.done, afterCardId: null };

  it("places at once, sends the intent with the cached version (never a rank), applies the server card, announces", async () => {
    const t = effects(async () => ({ ...X, columnId: COL.done, rank: "a0", version: 3 }));
    const result = await changeBoardCard(
      qc,
      CONV,
      { messageId: X.messageId, move: toDone, via: "menu" },
      t.fx,
    );
    expect(t.sent).toEqual([{ messageId: X.messageId, body: { expectedVersion: 2, move: toDone } }]);
    expect(order(t.during())[COL.done]).toEqual([X.messageId]);
    expect(result).toMatchObject({ ok: true, card: { version: 3 } });
    expect(order(cached())[COL.done]).toEqual([X.messageId]);
    expect(cached()?.cards.find((c) => c.columnId === COL.done)?.cards[0]?.rank).toBe("a0");
    expect(t.announced).toEqual(["Moved “Card 4” to Done."]);
    expect(t.toasts).toEqual([]);
  });

  it("drag moves are not announced here (the drag and drop live region does it)", async () => {
    const t = effects(async () => ({ ...X, columnId: COL.done, version: 3 }));
    await changeBoardCard(qc, CONV, { messageId: X.messageId, move: toDone, via: "drag" }, t.fx);
    expect(t.announced).toEqual([]);
  });

  it("a waiting change is optimistic and announced", async () => {
    const t = effects(async () => ({ ...X, waitingOn: "customer", version: 3 }));
    await changeBoardCard(qc, CONV, { messageId: X.messageId, waitingOn: "customer" }, t.fx);
    expect(t.sent[0]?.body).toEqual({ expectedVersion: 2, waitingOn: "customer" });
    expect(t.during()?.cards[0]?.cards[1]?.waitingOn).toBe("customer");
    expect(t.announced).toEqual(["“Card 4” is now waiting on the customer."]);
  });

  it("409: rolls back, applies the server's current card, neutral toast, announces the conflict", async () => {
    const current = { ...X, columnId: COL.cancelled, rank: "a0", version: 5 };
    const t = effects(async () => {
      throw new ApiRequestError(409, "board_card_version_conflict", "Card changed", { card: current });
    });
    const result = await changeBoardCard(
      qc,
      CONV,
      { messageId: X.messageId, move: toDone, via: "menu" },
      t.fx,
    );
    expect(result).toEqual({ ok: false, reason: "conflict" });
    expect(order(cached())[COL.done]).toEqual([]);
    expect(order(cached())[COL.backlog]).toEqual([A.messageId]);
    expect(order(cached())[COL.cancelled]).toEqual([X.messageId]);
    expect(t.toasts).toEqual(["neutral: Someone else changed this card. Showing the latest."]);
    expect(t.announced).toEqual(["Someone else changed “Card 4”. Showing the latest."]);
  });

  it("409 without a card in the body: rolls back and refetches the board", async () => {
    const t = effects(async () => {
      throw new ApiRequestError(409, "board_card_version_conflict", "Card changed");
    });
    await changeBoardCard(qc, CONV, { messageId: X.messageId, move: toDone }, t.fx);
    expect(order(cached())[COL.backlog]).toEqual([A.messageId, X.messageId]);
    expect(invalidated()).toBe(true);
  });

  it("other failures roll back, toast.error with the API message and announce the rollback", async () => {
    const t = effects(async () => {
      throw new ApiRequestError(500, "internal", "Boom");
    });
    const result = await changeBoardCard(
      qc,
      CONV,
      { messageId: X.messageId, move: toDone, via: "menu" },
      t.fx,
    );
    expect(result).toEqual({ ok: false, reason: "failed" });
    expect(order(cached())[COL.backlog]).toEqual([A.messageId, X.messageId]);
    expect(order(cached())[COL.done]).toEqual([]);
    expect(t.toasts).toEqual(["error: Couldn't move “Card 4”. It's back in Backlog. (Boom)"]);
    expect(t.announced).toEqual(["“Card 4” couldn't be moved and is back in Backlog."]);
  });

  it("a failed waiting change rolls back with its own copy", async () => {
    const t = effects(async () => {
      throw new ApiRequestError(0, "network_error", "Can't reach the server");
    });
    await changeBoardCard(qc, CONV, { messageId: X.messageId, waitingOn: "us" }, t.fx);
    expect(cached()?.cards[0]?.cards[1]?.waitingOn).toBe("none");
    expect(t.toasts[0]).toMatch(/^error: Couldn't update “Card 4”\. Try again\./);
    expect(t.announced).toEqual(["Couldn't update “Card 4”. Try again."]);
  });

  it("410: rolls back and says the channel is archived", async () => {
    const t = effects(async () => {
      throw new ApiRequestError(410, "channel_archived", "Archived");
    });
    expect(await changeBoardCard(qc, CONV, { messageId: X.messageId, move: toDone }, t.fx)).toEqual({
      ok: false,
      reason: "archived",
    });
    expect(order(cached())[COL.backlog]).toEqual([A.messageId, X.messageId]);
    expect(t.toasts).toEqual(["error: This channel is archived. Cards can't be changed."]);
  });

  it("403 with a channel name asks to join", async () => {
    const t = effects(async () => {
      throw new ApiRequestError(403, "forbidden", "No");
    });
    t.fx.channelName = "cases";
    await changeBoardCard(qc, CONV, { messageId: X.messageId, move: toDone }, t.fx);
    expect(t.toasts).toEqual(["error: Join #cases to move cards."]);
  });

  it("a live move of another card during the request survives the rollback", async () => {
    const t = effects(async () => {
      applyBoardFrame(
        qc,
        CONV,
        ev(EventTypes.boardCardUpserted, { card: { ...B, columnId: COL.done, version: 2 } }),
      );
      throw new ApiRequestError(500, "internal", "Boom");
    });
    await changeBoardCard(qc, CONV, { messageId: X.messageId, move: toDone }, t.fx);
    expect(order(cached())[COL.done]).toEqual([B.messageId]);
    expect(order(cached())[COL.backlog]).toEqual([A.messageId, X.messageId]);
  });

  it("an uncached card sends nothing", async () => {
    const t = effects(async () => X);
    expect(await changeBoardCard(qc, CONV, { messageId: id(999), move: toDone }, t.fx)).toEqual({
      ok: false,
      reason: "missing",
    });
    expect(t.sent).toEqual([]);
  });
});
