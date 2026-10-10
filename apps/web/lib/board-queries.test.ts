import { type BoardSnapshot, EventTypes } from "@ocw/contracts";
import type { TopicFrame } from "@ocw/realtime-client";
import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it } from "vitest";
import { AT, BOARD, COL, COLUMNS, CONV, card, id, order, snapshot } from "./board-fixtures.test-util";
import { applyBoardFrame, boardAfterSeq, boardKeys, resyncBoard } from "./board-queries";

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
