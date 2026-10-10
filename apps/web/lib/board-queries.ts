"use client";

import {
  type BoardCard,
  BoardCardUpsertedEvent,
  BoardColumnCards,
  BoardColumnRerankedEvent,
  type BoardSnapshot,
  BoardSnapshot as BoardSnapshotSchema,
  BoardUpdatedEvent,
  EventTypes,
  MessageDeletedEvent,
  ThreadUpdatedEvent,
} from "@ocw/contracts";
import type { TopicFrame } from "@ocw/realtime-client";
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, isApiError } from "./api";

/**
 * The browser's board cache (Phase 07.1, BOARD-02 … BOARD-04, D-03, D-05, P-06, P-11). One snapshot per board channel
 * (`GET /boards/:id`) is the single source the board view renders; live frames on `conv:<id>` patch it through
 * `applyBoardFrame`, idempotently: a frame already contained in the snapshot (`seq <= lastSeq`) is skipped, a card is
 * replaced only by a newer `version`. Cards in a column stay in rank order compared as JS strings, which is the
 * server's `COLLATE "C"` order. The browser never computes a rank: moves are intents the server places (07.1-03).
 */

export const boardKeys = {
  all: ["board"] as const,
  board: (convId: string) => ["board", convId] as const,
  columnPage: (convId: string, columnId: string) => ["board", convId, "column", columnId] as const,
};

function retryUnlessClientError(failureCount: number, err: unknown): boolean {
  if (isApiError(err) && err.status >= 400 && err.status < 500) return false;
  return failureCount < 2;
}

/** The board snapshot of a board channel. Live frames keep it current; a resync refetches it. */
export function useBoard(convId: string, opts: { enabled?: boolean } = {}) {
  return useQuery({
    enabled: opts.enabled ?? true,
    queryKey: boardKeys.board(convId),
    queryFn: ({ signal }) => api.get(`/api/v1/boards/${convId}`, { schema: BoardSnapshotSchema, signal }),
    retry: retryUnlessClientError,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 5 * 60_000,
  });
}

/**
 * "Show more cards" for a column with `hasMore` (P-11): `load()` fetches the page after `afterRank` (the rank of the
 * column's last loaded card) and merges it into the cached snapshot, so live frames keep patching one list. A
 * mutation, not a query: a refetched snapshot starts from the first page again, and the next "Show more cards" must
 * fetch, not answer from a cached page.
 */
export function useBoardColumnPage(convId: string, columnId: string, afterRank: string | null) {
  const qc = useQueryClient();
  const page = useMutation({
    mutationKey: boardKeys.columnPage(convId, columnId),
    mutationFn: (after: string | null) =>
      api.get(
        `/api/v1/boards/${convId}/columns/${columnId}/cards${after ? `?after=${encodeURIComponent(after)}` : ""}`,
        { schema: BoardColumnCards },
      ),
    onSuccess: (cards) => {
      qc.setQueryData<BoardSnapshot>(boardKeys.board(convId), (prev) =>
        prev ? mergeColumnPage(prev, cards) : prev,
      );
    },
  });
  return { ...page, load: () => page.mutate(afterRank) };
}

// ---------------------------------------------------------------- pure reducers

/** JS string order of fractional ranks (= `COLLATE "C"`); ties broken by id so the order is total. */
export function compareCards(
  a: Pick<BoardCard, "rank" | "messageId">,
  b: Pick<BoardCard, "rank" | "messageId">,
) {
  if (a.rank !== b.rank) return a.rank < b.rank ? -1 : 1;
  return a.messageId < b.messageId ? -1 : a.messageId > b.messageId ? 1 : 0;
}

/** Where a card is cached: its column entry index and its index inside it. */
export function findCard(
  s: BoardSnapshot,
  messageId: string,
): { col: number; at: number; card: BoardCard } | null {
  for (let col = 0; col < s.cards.length; col++) {
    const cards = s.cards[col]?.cards ?? [];
    const at = cards.findIndex((c) => c.messageId === messageId);
    const card = cards[at];
    if (card) return { col, at, card };
  }
  return null;
}

function withoutCard(s: BoardSnapshot, messageId: string): BoardSnapshot {
  const found = findCard(s, messageId);
  if (!found) return s;
  return {
    ...s,
    cards: s.cards.map((c, i) =>
      i === found.col ? { ...c, cards: c.cards.filter((k) => k.messageId !== messageId) } : c,
    ),
  };
}

/** Inserts `card` into its column at its rank position (a hasMore column keeps cards past its last loaded one out). */
function insertByRank(s: BoardSnapshot, card: BoardCard): BoardSnapshot {
  return {
    ...s,
    cards: s.cards.map((col) => {
      if (col.columnId !== card.columnId) return col;
      const last = col.cards.at(-1);
      if (col.hasMore && last && compareCards(card, last) > 0) return col;
      const at = col.cards.findIndex((k) => compareCards(card, k) < 0);
      const cards = [...col.cards];
      cards.splice(at === -1 ? cards.length : at, 0, card);
      return { ...col, cards };
    }),
  };
}

/**
 * A card from the server (event or response): replaces a cached copy only when its version is newer, landing in its
 * (possibly new) column at its rank position. Returns the same snapshot object when nothing changes.
 */
export function upsertCard(s: BoardSnapshot, card: BoardCard): BoardSnapshot {
  if (card.conversationId !== s.board.conversationId) return s;
  const found = findCard(s, card.messageId);
  if (found && found.card.version >= card.version) return s;
  return insertByRank(found ? withoutCard(s, card.messageId) : s, card);
}

/** True when the snapshot has an entry for this column. */
export function hasColumn(s: BoardSnapshot, columnId: string): boolean {
  return s.cards.some((c) => c.columnId === columnId);
}

/**
 * `board.updated`: board settings and the full column list replace the cached ones; cached cards of surviving columns
 * stay, new columns start empty. `dropped` = a removed column still held cached cards (07.1-06 moves them server-side
 * and the client refetches, P-09).
 */
export function replaceColumns(
  s: BoardSnapshot,
  ev: BoardUpdatedEvent,
): { next: BoardSnapshot; dropped: boolean } {
  const kept = new Set(ev.columns.map((c) => c.id));
  const dropped = s.cards.some((c) => !kept.has(c.columnId) && c.cards.length > 0);
  const byId = new Map(s.cards.map((c) => [c.columnId, c]));
  return {
    next: {
      ...s,
      board: ev.board,
      columns: ev.columns,
      cards: ev.columns.map((c) => byId.get(c.id) ?? { columnId: c.id, cards: [], hasMore: false }),
    },
    dropped,
  };
}

/** `board.column_reranked`: new ranks for one column's cards, re-sorted; versions untouched (P-06). */
export function rerankColumn(s: BoardSnapshot, ev: BoardColumnRerankedEvent): BoardSnapshot {
  const ranks = new Map(ev.ranks.map((r) => [r.messageId, r.rank]));
  return {
    ...s,
    cards: s.cards.map((col) =>
      col.columnId !== ev.columnId
        ? col
        : {
            ...col,
            cards: col.cards
              .map((c) => {
                const rank = ranks.get(c.messageId);
                return rank === undefined || rank === c.rank ? c : { ...c, rank };
              })
              .sort(compareCards),
          },
    ),
  };
}

/** Patches one cached card in place (same position); the same snapshot when the card is not cached. */
function patchCard(s: BoardSnapshot, messageId: string, patch: (c: BoardCard) => BoardCard): BoardSnapshot {
  const found = findCard(s, messageId);
  if (!found) return s;
  return {
    ...s,
    cards: s.cards.map((col, i) =>
      i === found.col
        ? { ...col, cards: col.cards.map((c) => (c.messageId === messageId ? patch(c) : c)) }
        : col,
    ),
  };
}

/** A "Show more cards" page merged into its column: unknown cards appended in rank order, newer cached copies kept. */
export function mergeColumnPage(s: BoardSnapshot, page: BoardColumnCards): BoardSnapshot {
  if (!hasColumn(s, page.columnId)) return s;
  return {
    ...s,
    cards: s.cards.map((col) => {
      if (col.columnId !== page.columnId) return col;
      const known = new Set(col.cards.map((c) => c.messageId));
      const extra = page.cards.filter((c) => !known.has(c.messageId) && !findCard(s, c.messageId));
      return { ...col, cards: [...col.cards, ...extra].sort(compareCards), hasMore: page.hasMore };
    }),
  };
}

// ---------------------------------------------------------------- live frames

/**
 * The single-subscription cursor (Pitfall 3): the realtime client keeps one cursor per topic and a later subscribe
 * with a lower `afterSeq` does not replay, so a board channel subscribes once, after both the messages page and the
 * board snapshot are loaded, from the lower of their cursors. Reducers are idempotent, so replaying a frame one of
 * the two already contains is harmless.
 */
export function boardAfterSeq(messagesLastSeq?: number, boardLastSeq?: number): number | undefined {
  if (messagesLastSeq === undefined || boardLastSeq === undefined) return undefined;
  return Math.min(messagesLastSeq, boardLastSeq);
}

/** `onResync` of the board channel's subscription: the gap is too large to replay, so refetch the snapshot. */
export function resyncBoard(qc: QueryClient, convId: string): void {
  void qc.invalidateQueries({ queryKey: boardKeys.board(convId) });
}

/**
 * Applies one `conv:<id>` frame to the cached board of `convId`. Returns true for `board.*` frames (fully handled
 * here, nothing else needs them) and false for every other frame, which goes on to the existing message handlers:
 * `message.deleted` of a card root removes the card and `thread.updated` of a card root sets its reply count, and both
 * still return false. Payloads that do not parse are ignored (T-07.1-04-04).
 */
export function applyBoardFrame(qc: QueryClient, convId: string, frame: TopicFrame): boolean {
  if (frame.op !== "ev") return false;
  const isBoard = frame.type.startsWith("board.");
  const key = boardKeys.board(convId);
  const snap = qc.getQueryData<BoardSnapshot>(key);
  // Not loaded: the snapshot, when it arrives, contains this frame. Already contained: nothing to do.
  if (!snap || frame.seq <= snap.lastSeq) return isBoard;
  const set = (next: BoardSnapshot) => {
    if (next !== snap) qc.setQueryData<BoardSnapshot>(key, next);
  };

  switch (frame.type) {
    case EventTypes.boardCardUpserted: {
      const parsed = BoardCardUpsertedEvent.safeParse(frame.data);
      if (!parsed.success || parsed.data.card.conversationId !== convId) break;
      const { card } = parsed.data;
      if (!hasColumn(snap, card.columnId)) {
        // A column this cache has not seen yet (its board.updated is behind us): the snapshot knows better.
        void qc.invalidateQueries({ queryKey: key });
        break;
      }
      set(upsertCard(snap, card));
      break;
    }
    case EventTypes.boardUpdated: {
      const parsed = BoardUpdatedEvent.safeParse(frame.data);
      if (!parsed.success || parsed.data.conversationId !== convId) break;
      const { next, dropped } = replaceColumns(snap, parsed.data);
      set(next);
      if (dropped) void qc.invalidateQueries({ queryKey: key });
      break;
    }
    case EventTypes.boardColumnReranked: {
      const parsed = BoardColumnRerankedEvent.safeParse(frame.data);
      if (!parsed.success || parsed.data.conversationId !== convId) break;
      set(rerankColumn(snap, parsed.data));
      break;
    }
    case EventTypes.messageDeleted: {
      const parsed = MessageDeletedEvent.safeParse(frame.data);
      if (parsed.success && parsed.data.threadId === null && parsed.data.conversationId === convId) {
        set(withoutCard(snap, parsed.data.messageId));
      }
      break;
    }
    case EventTypes.threadUpdated: {
      const parsed = ThreadUpdatedEvent.safeParse(frame.data);
      if (parsed.success) {
        const { rootId, replyCount, lastReplyAt } = parsed.data;
        set(patchCard(snap, rootId, (c) => ({ ...c, replyCount, lastReplyAt })));
      }
      break;
    }
  }
  return isBoard;
}
