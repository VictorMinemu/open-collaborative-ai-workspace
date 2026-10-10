"use client";

import {
  type BoardCard,
  type BoardCardMove,
  BoardCard as BoardCardSchema,
  BoardCardUpsertedEvent,
  BoardColumnCards,
  BoardColumnRerankedEvent,
  type BoardFieldValues,
  type BoardSnapshot,
  BoardSnapshot as BoardSnapshotSchema,
  BoardUpdatedEvent,
  EventTypes,
  MessageDeletedEvent,
  ThreadUpdatedEvent,
  type UpdateBoardCardRequest,
  type WaitingOn,
} from "@ocw/contracts";
import type { TopicFrame } from "@ocw/realtime-client";
import {
  type QueryClient,
  useMutation,
  useMutationState,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { ApiRequestError, api, errorMessage, isApiError, type Schema } from "./api";

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

// ---------------------------------------------------------------- moves and waiting changes (D-05, UI-SPEC)

/**
 * Optimistic placement of a move intent, by index only (the browser never mints a rank; the server places the card and
 * its `board.card_upserted` or PATCH response brings the real rank): the card leaves its column and lands right after
 * `afterCardId` in the target column, at the top for null, at the bottom when that card is not there. Entering a
 * column with a default waiting state takes it, like the server does (P-09). The input snapshot is never mutated.
 */
export function placeCard(s: BoardSnapshot, messageId: string, move: BoardCardMove): BoardSnapshot {
  const found = findCard(s, messageId);
  if (!found || !hasColumn(s, move.columnId)) return s;
  const target = s.columns.find((c) => c.id === move.columnId);
  const entering = found.card.columnId !== move.columnId;
  const waitingOn =
    entering && target?.defaultWaitingOn != null ? target.defaultWaitingOn : found.card.waitingOn;
  const placed: BoardCard = { ...found.card, columnId: move.columnId, waitingOn };
  const without = withoutCard(s, messageId);
  return {
    ...without,
    cards: without.cards.map((col) => {
      if (col.columnId !== move.columnId) return col;
      const after =
        move.afterCardId === null ? -1 : col.cards.findIndex((c) => c.messageId === move.afterCardId);
      const at = move.afterCardId === null ? 0 : after === -1 ? col.cards.length : after + 1;
      const cards = [...col.cards];
      cards.splice(at, 0, placed);
      return { ...col, cards };
    }),
  };
}

/** Optimistic waiting state of one card (same position). */
export function setWaitingOn(s: BoardSnapshot, messageId: string, waitingOn: WaitingOn): BoardSnapshot {
  return patchCard(s, messageId, (c) => (c.waitingOn === waitingOn ? c : { ...c, waitingOn }));
}

/**
 * The board as if an optimistic change of `original` had never happened, keeping every live change that arrived
 * meanwhile: the cached copy goes back to `original`'s column, rank position and waiting state, unless the server
 * already sent a newer version of the card (that copy is the truth and stays).
 */
export function undoPlacement(s: BoardSnapshot, original: BoardCard): BoardSnapshot {
  const found = findCard(s, original.messageId);
  if (found && found.card.version > original.version) return s;
  if (!hasColumn(s, original.columnId)) return withoutCard(s, original.messageId);
  return insertByRank(withoutCard(s, original.messageId), original);
}

/**
 * Rollback after a failed move or waiting change: `snapshotBefore` (the board without the optimistic change), then the
 * server's current card when the API sent one (409 `board_card_version_conflict`), placed by its version and rank.
 */
export function rollbackWith(snapshotBefore: BoardSnapshot, serverCard?: BoardCard | null): BoardSnapshot {
  return serverCard ? upsertCard(snapshotBefore, serverCard) : snapshotBefore;
}

export type BoardAnnouncementEvent =
  | "menuMove"
  | "moveTop"
  | "moveBottom"
  | "waiting"
  | "rollback"
  | "conflict"
  | "updateFailed";

const WAITING_PHRASE: Record<Exclude<WaitingOn, "none">, string> = {
  us: "us",
  customer: "the customer",
  both: "both",
};

/**
 * The polite live-region copy for the viewer's own actions (07.1-UI-SPEC Copywriting › Screen-reader announcements).
 * Other people's live changes are applied silently and never announced.
 */
export function boardAnnouncement(
  event: BoardAnnouncementEvent,
  ctx: { title: string; column?: string; waitingOn?: WaitingOn },
): string {
  const t = `“${ctx.title}”`;
  const column = ctx.column ?? "";
  switch (event) {
    case "menuMove":
      return `Moved ${t} to ${column}.`;
    case "moveTop":
      return `Moved ${t} to the top of ${column}.`;
    case "moveBottom":
      return `Moved ${t} to the bottom of ${column}.`;
    case "waiting":
      return !ctx.waitingOn || ctx.waitingOn === "none"
        ? `${t} is no longer waiting on anyone.`
        : `${t} is now waiting on ${WAITING_PHRASE[ctx.waitingOn]}.`;
    case "rollback":
      return `${t} couldn't be moved and is back in ${column}.`;
    case "conflict":
      return `Someone else changed ${t}. Showing the latest.`;
    case "updateFailed":
      return `Couldn't update ${t}. Try again.`;
  }
}

/** Toast copy for the outcomes of a card change (07.1-UI-SPEC Copywriting › Moves, rollback, conflicts). */
export const BOARD_TOAST = {
  conflict: "Someone else changed this card. Showing the latest.",
  archived: "This channel is archived. Cards can't be changed.",
  moveFailed: (title: string, column: string) => `Couldn't move “${title}”. It's back in ${column}.`,
  updateFailed: (title: string) => `Couldn't update “${title}”. Try again.`,
  notMember: (channel: string) => `Join #${channel} to move cards.`,
};

/** A PATCH or POST answer: the card itself, or `{ card }`. */
const CardResponse: Schema<BoardCard> = {
  parse(data: unknown): BoardCard {
    const direct = BoardCardSchema.safeParse(data);
    return direct.success ? direct.data : BoardCardUpsertedEvent.parse(data).card;
  },
};

/** The current card a 409 `board_card_version_conflict` carries (`error.details.card` or `error.details`), if any. */
export function conflictCard(err: unknown): BoardCard | null {
  if (!(err instanceof ApiRequestError)) return null;
  const details = err.details as { card?: unknown } | undefined;
  const parsed = BoardCardSchema.safeParse(details?.card ?? details);
  return parsed.success ? parsed.data : null;
}

/** One change of one card, as the board view and the card strip send it. */
export type CardChange = {
  messageId: string;
  move?: BoardCardMove;
  waitingOn?: WaitingOn;
  /** Which control sent a move; "drag" moves are announced by the drag and drop live region, not here. */
  via?: "menu" | "top" | "bottom" | "drag";
};

export type CardChangeResult =
  | { ok: true; card: BoardCard }
  | { ok: false; reason: "missing" | "conflict" | "archived" | "forbidden" | "failed" };

export interface CardChangeEffects {
  send: (messageId: string, body: UpdateBoardCardRequest) => Promise<BoardCard>;
  toast: { neutral: (message: string) => void; error: (message: string, description?: string) => void };
  announce?: ((text: string) => void) | undefined;
  /** Enables the "Join #channel" copy for a 403. */
  channelName?: string | undefined;
}

/**
 * A move or waiting change (D-05, 07.1-UI-SPEC Optimistic moves): `placeCard` / `setWaitingOn` at once, one PATCH with
 * the cached `expectedVersion`, then the server's card. On failure the change is undone (`undoPlacement` →
 * `rollbackWith`) and the outcome toasted and announced: 409 applies the server's current card (neutral toast), 410
 * says the channel is archived, anything else says the card is back where it was.
 */
export async function changeBoardCard(
  qc: QueryClient,
  convId: string,
  change: CardChange,
  fx: CardChangeEffects,
): Promise<CardChangeResult> {
  const key = boardKeys.board(convId);
  const snap = qc.getQueryData<BoardSnapshot>(key);
  const original = snap ? findCard(snap, change.messageId)?.card : undefined;
  if (!snap || !original) return { ok: false, reason: "missing" };
  const columnName = (id: string) => snap.columns.find((c) => c.id === id)?.name ?? "";
  const title = original.title;

  qc.setQueryData<BoardSnapshot>(key, (cur) => {
    if (!cur) return cur;
    const moved = change.move ? placeCard(cur, change.messageId, change.move) : cur;
    return change.waitingOn !== undefined ? setWaitingOn(moved, change.messageId, change.waitingOn) : moved;
  });

  try {
    const card = await fx.send(change.messageId, {
      expectedVersion: original.version,
      ...(change.move ? { move: change.move } : {}),
      ...(change.waitingOn !== undefined ? { waitingOn: change.waitingOn } : {}),
    });
    qc.setQueryData<BoardSnapshot>(key, (cur) => (cur ? upsertCard(cur, card) : cur));
    const target = columnName(card.columnId);
    if (change.move && change.via && change.via !== "drag") {
      const event = change.via === "top" ? "moveTop" : change.via === "bottom" ? "moveBottom" : "menuMove";
      fx.announce?.(boardAnnouncement(event, { title, column: target }));
    } else if (!change.move && change.waitingOn !== undefined) {
      fx.announce?.(boardAnnouncement("waiting", { title, waitingOn: card.waitingOn }));
    }
    return { ok: true, card };
  } catch (err) {
    const server = isApiError(err, 409) ? conflictCard(err) : null;
    qc.setQueryData<BoardSnapshot>(key, (cur) =>
      cur ? rollbackWith(undoPlacement(cur, original), server) : cur,
    );
    const back = columnName(original.columnId);
    const isMove = change.move !== undefined;
    if (isApiError(err, 409)) {
      if (!server) void qc.invalidateQueries({ queryKey: key });
      fx.toast.neutral(BOARD_TOAST.conflict);
      fx.announce?.(boardAnnouncement("conflict", { title }));
      return { ok: false, reason: "conflict" };
    }
    if (isApiError(err, 410)) {
      fx.toast.error(BOARD_TOAST.archived);
      fx.announce?.(BOARD_TOAST.archived);
      return { ok: false, reason: "archived" };
    }
    if (isApiError(err, 403) && fx.channelName) {
      fx.toast.error(BOARD_TOAST.notMember(fx.channelName));
      fx.announce?.(BOARD_TOAST.notMember(fx.channelName));
      return { ok: false, reason: "forbidden" };
    }
    if (isMove) {
      fx.toast.error(BOARD_TOAST.moveFailed(title, back), errorMessage(err));
      fx.announce?.(boardAnnouncement("rollback", { title, column: back }));
    } else {
      fx.toast.error(BOARD_TOAST.updateFailed(title), errorMessage(err));
      fx.announce?.(boardAnnouncement("updateFailed", { title }));
    }
    return { ok: false, reason: "failed" };
  }
}

const updateKey = (convId: string) => ["board", convId, "update"] as const;

/**
 * Moves and waiting changes of a board's cards (`changeBoardCard` with the PATCH, sonner toasts and the caller's
 * polite live region). Pending changes are visible through `usePendingCardIds`.
 */
export function useUpdateBoardCard(
  convId: string,
  opts: { announce?: (text: string) => void; channelName?: string } = {},
) {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: updateKey(convId),
    mutationFn: (change: CardChange) =>
      changeBoardCard(qc, convId, change, {
        send: (messageId, body) =>
          api.patch(`/api/v1/boards/${convId}/cards/${messageId}`, { body, schema: CardResponse }),
        toast: {
          neutral: (message) => toast(message),
          error: (message, description) => toast.error(message, description ? { description } : undefined),
        },
        announce: opts.announce,
        channelName: opts.channelName,
      }),
  });
}

/** Cards with a change in flight (`aria-busy` on their tiles). */
export function usePendingCardIds(convId: string): string[] {
  return useMutationState({
    filters: { mutationKey: updateKey(convId), status: "pending" },
    select: (m) => (m.state.variables as CardChange | undefined)?.messageId ?? "",
  }).filter(Boolean);
}

/** A new card's request; `clientMessageId` defaults to a fresh id per call (pass one to retry idempotently). */
export type NewBoardCard = {
  title?: string;
  description?: string;
  columnId?: string;
  waitingOn?: WaitingOn;
  fields?: BoardFieldValues;
  clientMessageId?: string;
};

function newClientId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** `POST /boards/:id/cards`; the server's card joins the cached board (its event is then a no-op, same version). */
export function useCreateBoardCard(convId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ clientMessageId, description, ...rest }: NewBoardCard) =>
      api.post(`/api/v1/boards/${convId}/cards`, {
        body: { ...rest, description: description ?? "", clientMessageId: clientMessageId ?? newClientId() },
        schema: CardResponse,
      }),
    onSuccess: (card) => {
      qc.setQueryData<BoardSnapshot>(boardKeys.board(convId), (cur) => (cur ? upsertCard(cur, card) : cur));
    },
  });
}
