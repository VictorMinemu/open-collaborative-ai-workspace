"use client";

import {
  BOARD_COLUMN_NAME_MAX,
  BOARD_MAX_COLUMNS,
  type BoardCard,
  BoardCard as BoardCardSchema,
  BoardCardUpsertedEvent,
  type BoardColumnCategory,
  type BoardFieldDef,
  type BoardSnapshot,
  BoardUpdatedEvent,
  ChannelSummary,
  type FieldValue,
  type UpdateBoardCardRequest,
  type WaitingOn,
} from "@ocw/contracts";
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { api, errorMessage, isApiError, type Schema } from "./api";
import { boardKeys, conflictCard, findCard, replaceColumns, upsertCard } from "./board-queries";
import { applyMessageDeleted, chatKeys, deleteMessage, useChannels } from "./chat-queries";

/**
 * Board management in the browser (07.1-11; BOARD-01, BOARD-05, BOARD-06; D-07, P-02, P-09): columns (add, edit,
 * reorder, delete with a move target), card text edits by the card's author and card deletion. Builds on the 07.1-04
 * board cache (`board-queries.ts`, imported, never edited here). The UI only mirrors what the viewer may do; the API
 * decides every request (`channel.update` for columns, the human author for card text, the author or
 * `message.delete_any` for a delete).
 */

// ---------------------------------------------------------------- copy (07.1-UI-SPEC Copywriting)

export const COLUMN_COPY = {
  nameRequired: "Give the column a name",
  nameTooLong: "Keep it under 60 characters",
  exists: (name: string) => `A column named “${name}” already exists`,
  limit: `A board can have up to ${BOARD_MAX_COLUMNS} columns`,
  lastColumn: "A board needs at least one column",
} as const;

export const CARD_EDIT_COPY = {
  conflict: "This card changed while you were editing.",
  reload: "Reload card",
  notAuthor: "Only the person who created this card can edit its text.",
  invalidFields: "Check the highlighted fields.",
  needsText: "Add a title or a description",
  titleTooLong: "Keep the title under 200 characters",
  /** A typed title cannot go back to an automatic one (the API has no such change). */
  typedTitleRequired: "A typed title can't be left empty",
  hintTyped: "Typed titles are never changed automatically.",
  hintAutomatic: "Automatic title, updates with the description and fields.",
  /** The author of a card past the loaded page who is no longer a member (the API would refuse the edit). */
  joinToEdit: "Join the channel to edit this card.",
} as const;

/** The UI-SPEC copy for a column request the API refused; the API's own message otherwise. */
export function columnErrorMessage(err: unknown, name: string): string {
  if (isApiError(err, 409) && err.code === "board_column_exists") return COLUMN_COPY.exists(name);
  if (isApiError(err, 409) && err.code === "board_columns_limit") return COLUMN_COPY.limit;
  if (isApiError(err, 409) && err.code === "board_last_column") return COLUMN_COPY.lastColumn;
  return errorMessage(err);
}

/** In-place validation of a column name against the board's other columns (case-insensitive, P-09). */
export function columnNameError(
  name: string,
  columns: ReadonlyArray<{ id: string; name: string }>,
  selfId: string | null,
): string | null {
  const n = name.trim();
  if (!n) return COLUMN_COPY.nameRequired;
  if (n.length > BOARD_COLUMN_NAME_MAX) return COLUMN_COPY.nameTooLong;
  const taken = columns.some((c) => c.id !== selfId && c.name.trim().toLowerCase() === n.toLowerCase());
  return taken ? COLUMN_COPY.exists(n) : null;
}

// ---------------------------------------------------------------- columns

/**
 * A column route's answer (`BoardUpdatedEvent`) applied to the cached board, unless the cache already holds a newer
 * board version. The same `board.updated` frame arrives on `conv:<id>` and is then a no-op. `refetch` = cards moved
 * server-side (a deleted column's cards), which no per-card event announces (P-09): the snapshot is reloaded.
 */
export function applyColumnsResponse(
  qc: QueryClient,
  convId: string,
  ev: BoardUpdatedEvent,
  { refetch = false }: { refetch?: boolean } = {},
): void {
  const key = boardKeys.board(convId);
  const cur = qc.getQueryData<BoardSnapshot>(key);
  if (cur && cur.board.version <= ev.board.version) {
    const { next, dropped } = replaceColumns(cur, ev);
    qc.setQueryData<BoardSnapshot>(key, next);
    if (dropped) refetch = true;
  }
  if (refetch) void qc.invalidateQueries({ queryKey: key });
}

export type NewColumn = {
  name: string;
  category: BoardColumnCategory;
  defaultWaitingOn: WaitingOn | null;
  /** Absent = last. */
  afterColumnId?: string | null;
};

/** `POST /boards/:id/columns` (`channel.update`); the new column is appended at the end unless placed. */
export function useCreateBoardColumn(convId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: NewColumn) =>
      api.post(`/api/v1/boards/${convId}/columns`, { body, schema: BoardUpdatedEvent }),
    onSuccess: (ev) => applyColumnsResponse(qc, convId, ev),
  });
}

export type ColumnChange = {
  columnId: string;
  name?: string;
  category?: BoardColumnCategory;
  defaultWaitingOn?: WaitingOn | null;
  /** null = first; absent = keep the place. */
  afterColumnId?: string | null;
};

/** `PATCH /boards/:id/columns/:columnId`: rename, recategorise, default waiting state, reorder. */
export function useUpdateBoardColumn(convId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ columnId, ...body }: ColumnChange) =>
      api.patch(`/api/v1/boards/${convId}/columns/${columnId}`, { body, schema: BoardUpdatedEvent }),
    onSuccess: (ev) => applyColumnsResponse(qc, convId, ev),
  });
}

/** `DELETE /boards/:id/columns/:columnId`; a column holding cards needs `moveCardsTo` (P-09). */
export function useDeleteBoardColumn(convId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ columnId, moveCardsTo }: { columnId: string; moveCardsTo?: string | null }) =>
      api.del(
        `/api/v1/boards/${convId}/columns/${columnId}${moveCardsTo ? `?moveCardsTo=${encodeURIComponent(moveCardsTo)}` : ""}`,
        { schema: BoardUpdatedEvent },
      ),
    onSuccess: (ev, { moveCardsTo }) => applyColumnsResponse(qc, convId, ev, { refetch: !!moveCardsTo }),
  });
}

/** Where a column goes when it moves one place left or right: the `afterColumnId` of the PATCH, or undefined at an end. */
export function neighbourMove(
  columns: ReadonlyArray<{ id: string }>,
  columnId: string,
  direction: "left" | "right",
): { afterColumnId: string | null } | undefined {
  const at = columns.findIndex((c) => c.id === columnId);
  if (at === -1) return undefined;
  if (direction === "left") {
    if (at === 0) return undefined;
    return { afterColumnId: columns[at - 2]?.id ?? null };
  }
  const next = columns[at + 1];
  return next ? { afterColumnId: next.id } : undefined;
}

// ---------------------------------------------------------------- card text (P-02: the human author only)

const CardResponse: Schema<BoardCard> = {
  parse(data: unknown): BoardCard {
    const direct = BoardCardSchema.safeParse(data);
    return direct.success ? direct.data : BoardCardUpsertedEvent.parse(data).card;
  },
};

/** The card editor's form state. `title` empty = keep (an automatic title stays automatic). */
export type CardDraft = {
  title: string;
  description: string;
  values: Record<string, FieldValue | undefined>;
};

/** The form state of a card as stored. Automatic titles start empty: the placeholder previews them. */
export function draftOf(
  card: Pick<BoardCard, "title" | "titleSource" | "description" | "fields">,
): CardDraft {
  return {
    title: card.titleSource === "user" ? card.title : "",
    description: card.description,
    values: { ...card.fields },
  };
}

const norm = (def: BoardFieldDef, v: FieldValue | undefined): FieldValue => {
  if (v === undefined || v === null || v === "") return null;
  return typeof v === "string" && def.type === "text" ? v.trim() || null : v;
};

/**
 * The PATCH body of a card edit: only what changed, with `expectedVersion` (07.1-06). A title is sent only when one is
 * typed and differs from the card's, so description and field edits never turn an automatic title into a typed one and
 * never touch a typed one (BOARD-06). Fields: only changed keys, `null` clears one. Null = nothing changed.
 */
export function cardEditRequest(
  card: Pick<BoardCard, "title" | "titleSource" | "description" | "fields" | "version">,
  draft: CardDraft,
  defs: readonly BoardFieldDef[],
): UpdateBoardCardRequest | null {
  const out: UpdateBoardCardRequest = { expectedVersion: card.version };
  const title = draft.title.trim();
  if (title && !(card.titleSource === "user" && title === card.title)) out.title = title;
  const description = draft.description.trim();
  if (description !== card.description.trim()) out.description = description;
  const fields: Record<string, FieldValue> = {};
  for (const def of defs) {
    const next = norm(def, draft.values[def.key]);
    const prev = norm(def, card.fields[def.key]);
    if (next !== prev && !(Number.isNaN(next) && Number.isNaN(prev))) fields[def.key] = next;
  }
  if (Object.keys(fields).length > 0) out.fields = fields;
  return Object.keys(out).length > 1 ? out : null;
}

/** Why a card edit failed, for the dialog: a 409 carries the current card for "Reload card". */
export type CardEditFailure =
  | { kind: "conflict"; card: BoardCard | null }
  | { kind: "notAuthor" }
  | { kind: "invalidFields" }
  | { kind: "other"; message: string };

export function cardEditFailure(err: unknown): CardEditFailure {
  if (isApiError(err, 409)) return { kind: "conflict", card: conflictCard(err) };
  if (isApiError(err, 403) && err.code === "not_author") return { kind: "notAuthor" };
  if (isApiError(err, 400) && err.code === "invalid_field_values") return { kind: "invalidFields" };
  return { kind: "other", message: errorMessage(err) };
}

/** `PATCH /boards/:id/cards/:messageId` with text changes; the answer joins the cached board. */
export function useEditBoardCard(convId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ messageId, body }: { messageId: string; body: UpdateBoardCardRequest }) =>
      api.patch(`/api/v1/boards/${convId}/cards/${messageId}`, { body, schema: CardResponse }),
    onSuccess: (card) => applyCard(qc, convId, card),
  });
}

/**
 * What a top-level message of a board is, for the Messages view's "Edit message" (07.1 fix): `card` when the loaded
 * board holds it (the card editor), `message` when it cannot be a card (a reply, or every column is fully loaded and
 * none holds it: the inline editor), `unknown` when a column has more cards than its loaded page or the board is not
 * loaded yet (ask the API with `fetchBoardCard` before choosing).
 */
export type CardRootKind = "card" | "message" | "unknown";

export function cardRootKind(
  s: BoardSnapshot | undefined,
  m: { id: string; threadId: string | null },
): CardRootKind {
  if (m.threadId !== null) return "message";
  if (!s) return "unknown";
  if (findCard(s, m.id)) return "card";
  return s.cards.some((c) => c.hasMore) ? "unknown" : "message";
}

/** `GET /boards/:id/cards/:messageId`: the card, or null when that message is not a card of this board (404). */
export async function fetchBoardCard(convId: string, messageId: string): Promise<BoardCard | null> {
  try {
    return await api.get(`/api/v1/boards/${convId}/cards/${messageId}`, { schema: CardResponse });
  } catch (err) {
    if (isApiError(err, 404) && err.code === "card_not_found") return null;
    throw err;
  }
}

/**
 * The author's "Edit message" on the top-level messages of a board (07.1 fix): a card root always opens the card
 * editor, never the inline editor the API refuses (400 `board_card_use_board`), even when the card is past its column's
 * loaded page. `editorFor(m)` answers MessageList's per-message override: the card editor for a cached card (null when
 * the viewer cannot post), undefined (the inline editor) for a message that cannot be a card, and otherwise a lookup
 * that asks the API and then opens the card editor or falls back to the inline editor. `editingCard` follows the
 * cached copy of the card while the board holds it. Only for board channels.
 */
export function useCardRootEditor(convId: string, board: BoardSnapshot | undefined, canPost: boolean) {
  const [editing, setEditing] = useState<{ id: string; fetched: BoardCard | null } | null>(null);
  const openCached = useCallback((m: { id: string }) => setEditing({ id: m.id, fetched: null }), []);
  const lookUp = useCallback(
    (m: { id: string }, inline: () => void) => {
      fetchBoardCard(convId, m.id).then(
        (card) => {
          if (!card) inline();
          else if (!canPost) toast.error(CARD_EDIT_COPY.joinToEdit);
          else setEditing({ id: card.messageId, fetched: card });
        },
        (err) => toast.error(errorMessage(err)),
      );
    },
    [convId, canPost],
  );
  const editorFor = (m: { id: string; threadId: string | null }) => {
    const kind = cardRootKind(board, m);
    if (kind === "card") return canPost ? openCached : null;
    return kind === "unknown" ? lookUp : undefined;
  };
  const editingCard = editing ? ((board && findCard(board, editing.id)?.card) ?? editing.fetched) : null;
  const close = useCallback(() => setEditing(null), []);
  return { editorFor, editingCard, close };
}

/** A server card (an edit's answer or a 409's current card) into the cached board. */
export function applyCard(qc: QueryClient, convId: string, card: BoardCard): void {
  qc.setQueryData<BoardSnapshot>(boardKeys.board(convId), (cur) => (cur ? upsertCard(cur, card) : cur));
}

/** The board without one card (a deleted card root); the same snapshot when it is not cached. */
export function removeCard(s: BoardSnapshot, messageId: string): BoardSnapshot {
  const found = findCard(s, messageId);
  if (!found) return s;
  return {
    ...s,
    cards: s.cards.map((c, i) =>
      i === found.col ? { ...c, cards: c.cards.filter((k) => k.messageId !== messageId) } : c,
    ),
  };
}

/**
 * Deleting a card is deleting its root message (`DELETE /messages/:id`: the author or `message.delete_any`). The tile
 * leaves the board at once; the thread caches get the tombstone; other viewers get the same through `message.deleted`.
 */
export function useDeleteBoardCard(convId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (card: Pick<BoardCard, "messageId" | "replyCount">) => deleteMessage(card.messageId),
    onSuccess: (_ok, card) => {
      qc.setQueryData<BoardSnapshot>(boardKeys.board(convId), (cur) =>
        cur ? removeCard(cur, card.messageId) : cur,
      );
      applyMessageDeleted(qc, {
        messageId: card.messageId,
        conversationId: convId,
        threadId: null,
        deletedAt: new Date().toISOString(),
        replyCount: card.replyCount,
      });
    },
  });
}

// ---------------------------------------------------------------- the viewer's rights on a board channel

/**
 * The channel's `viewerCan` and archive state, read from the channel caches the channel view already fills (the list,
 * else the single-channel query); never a request of its own beyond the shared channel list.
 */
export function useBoardChannelAccess(convId: string): {
  canManage: boolean;
  canDeleteAny: boolean;
  archived: boolean;
} {
  const list = useChannels();
  const single = useQuery({
    queryKey: chatKeys.channel(convId),
    queryFn: ({ signal }) => api.get(`/api/v1/channels/${convId}`, { schema: ChannelSummary, signal }),
    enabled: false,
  });
  const channel = list.data?.channels.find((c) => c.id === convId) ?? single.data;
  const can = channel?.viewerCan ?? [];
  const archived = !!channel?.archivedAt;
  return {
    canManage: can.includes("channel.update") && !archived,
    canDeleteAny: can.includes("message.delete_any") && !archived,
    archived,
  };
}
