import type { Board, BoardCard, BoardColumn, BoardSnapshot } from "@ocw/contracts";

/** Shared fixtures for the board cache and primitive tests (07.1-04). Not a test file itself. */

export const id = (n: number) => `0199a000-0000-7000-8000-${String(n).padStart(12, "0")}`;

export const CONV = id(1);
export const COL = { backlog: id(10), progress: id(11), done: id(12), cancelled: id(13) } as const;
export const AUTHOR = id(20);
export const AT = "2026-10-08T09:00:00.000Z";

export const BOARD: Board = {
  conversationId: CONV,
  templateId: null,
  prefix: "EXP",
  namingRule: "{prefix}-{seq:0000} · {summary}",
  fields: [],
  version: 1,
};

export const COLUMNS: BoardColumn[] = [
  {
    id: COL.backlog,
    conversationId: CONV,
    name: "Backlog",
    rank: "a0",
    category: "backlog",
    defaultWaitingOn: null,
  },
  {
    id: COL.progress,
    conversationId: CONV,
    name: "In progress",
    rank: "a1",
    category: "started",
    defaultWaitingOn: null,
  },
  { id: COL.done, conversationId: CONV, name: "Done", rank: "a2", category: "done", defaultWaitingOn: null },
  {
    id: COL.cancelled,
    conversationId: CONV,
    name: "Cancelled",
    rank: "a3",
    category: "cancelled",
    defaultWaitingOn: null,
  },
];

export function card(n: number, over: Partial<BoardCard> = {}): BoardCard {
  return {
    messageId: id(100 + n),
    conversationId: CONV,
    columnId: COL.backlog,
    rank: `a${n}`,
    waitingOn: "none",
    title: `Card ${n}`,
    titleSource: "heuristic",
    description: "",
    number: n,
    fields: {},
    authorKind: "user",
    authorId: AUTHOR,
    replyCount: 0,
    lastReplyAt: null,
    createdAt: AT,
    movedAt: AT,
    version: 1,
    ...over,
  };
}

/** A snapshot whose columns hold `cards` (each card goes to its `columnId`, kept in the given order). */
export function snapshot(cards: BoardCard[], over: Partial<BoardSnapshot> = {}): BoardSnapshot {
  return {
    board: BOARD,
    columns: COLUMNS,
    cards: COLUMNS.map((c) => ({
      columnId: c.id,
      cards: cards.filter((k) => k.columnId === c.id),
      hasMore: false,
    })),
    lastSeq: 10,
    ...over,
  };
}

/** Message ids per column, in order. */
export function order(s: BoardSnapshot | undefined): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const col of s?.cards ?? []) out[col.columnId] = col.cards.map((c) => c.messageId);
  return out;
}
