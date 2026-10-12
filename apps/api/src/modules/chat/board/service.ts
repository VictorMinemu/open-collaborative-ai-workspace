import {
  BOARD_COLUMN_PAGE,
  type Board,
  type BoardCard,
  type BoardColumn,
  type BoardColumnCards,
  type BoardColumnRerankedEvent,
  type BoardFieldDef,
  type BoardFieldValues,
  type BoardSnapshot,
  type CreateBoardCardRequest,
  cardMessageBody,
  DEFAULT_BOARD_COLUMNS,
  EventTypes,
  type FieldValue,
  fieldValuesSchema,
  type Mention,
  renderCardTitle,
  type TemplateColumn,
  type UpdateBoardCardRequest,
} from "@ocw/contracts";
import { boardCards, boardColumns, boards, messages, type Tx } from "@ocw/db";
import { and, asc, eq, isNull, lte, ne, type SQL, sql } from "drizzle-orm";
import { badRequest, conflict, forbidden, HttpError, notFound } from "../../../lib/errors";
import { type Directory, loadDirectory } from "../directory";
import { resolveMentions } from "../mentions";
import { editMessage } from "../message-actions";
import {
  type ChatDeps,
  type ConversationRow,
  convTopic,
  iso,
  lockNextSeq,
  type MessageRow,
  type PostInput,
  type PostResult,
  postMessage,
  toMessage,
} from "../service";
import { freshKeys, keyBetween } from "./rank";

/**
 * Board channels (BOARD-01 … BOARD-06, D-01 … D-08). A board is a channel (`layout = 'board'`) with one `boards` row,
 * its columns and its cards; a card is the root message of an ordinary thread plus its `board_cards` row. Every board
 * writer first takes the conversation's stream lock (`lockNextSeq`), so writers of one board are serialised: two moves
 * never read the same neighbours (no equal ranks are minted), the per-board number never repeats, and each write's
 * `board.*` event lands on `conv:<id>` in commit order. Events go to `conv:<id>` only (P-06), never `org:` or `user:`;
 * audits carry ids, column ids, categories and versions, never titles, descriptions or field values.
 */

export type BoardRow = typeof boards.$inferSelect;
export type ColumnRow = typeof boardColumns.$inferSelect;
type CardRow = typeof boardCards.$inferSelect;

/** Who creates or moves a card. Agents (07.1-10) act on behalf of the human whose turn they answer. */
export type BoardAuthor =
  | { kind: "user"; id: string }
  | { kind: "agent"; id: string; onBehalfOfUserId: string };

const CARD_NOT_FOUND = "Card not found";

// ---------------------------------------------------------------- DTOs

export function toBoard(row: BoardRow): Board {
  return {
    conversationId: row.conversationId,
    templateId: row.templateId,
    prefix: row.prefix,
    namingRule: row.namingRule,
    fields: row.fields as BoardFieldDef[],
    version: row.version,
  };
}

export function toColumn(row: ColumnRow): BoardColumn {
  return {
    id: row.id,
    conversationId: row.conversationId,
    name: row.name,
    rank: row.rank,
    category: row.category,
    defaultWaitingOn: row.defaultWaitingOn,
  };
}

/** A card row joined with the root message fields its DTO needs (author, reply count, last reply). */
const cardSelect = {
  card: boardCards,
  authorKind: messages.authorKind,
  authorId: messages.authorId,
  replyCount: messages.replyCount,
  lastReplyAt: messages.lastReplyAt,
};
type CardJoin = {
  card: CardRow;
  authorKind: "user" | "agent" | "system";
  authorId: string | null;
  replyCount: number;
  lastReplyAt: unknown;
};

function toCard(r: CardJoin): BoardCard {
  const c = r.card;
  if (r.authorKind === "system" || !r.authorId)
    throw new Error("a board card's root has a user or agent author");
  return {
    messageId: c.messageId,
    conversationId: c.conversationId,
    columnId: c.columnId,
    rank: c.rank,
    waitingOn: c.waitingOn,
    title: c.title,
    titleSource: c.titleSource,
    description: c.description,
    number: c.number,
    fields: c.fields as BoardFieldValues,
    authorKind: r.authorKind,
    authorId: r.authorId,
    replyCount: r.replyCount,
    lastReplyAt: r.lastReplyAt == null ? null : iso(r.lastReplyAt),
    createdAt: iso(c.createdAt),
    movedAt: iso(c.movedAt),
    version: c.version,
  };
}

/** Rank order in SQL equals JavaScript's sort: `COLLATE "C"`, ties broken by message id (deterministic). */
const cardOrder = [sql`${boardCards.rank} collate "C"`, asc(boardCards.messageId)];

/** One live card of `conversationId` (a tombstoned root is no card), optionally locked for the transaction. */
async function loadCard(
  tx: Tx,
  conversationId: string,
  messageId: string,
  lock = false,
): Promise<CardJoin | null> {
  const q = tx
    .select(cardSelect)
    .from(boardCards)
    .innerJoin(messages, eq(messages.id, boardCards.messageId))
    .where(
      and(
        eq(boardCards.messageId, messageId),
        eq(boardCards.conversationId, conversationId),
        isNull(messages.deletedAt),
      ),
    )
    .limit(1);
  const [row] = lock ? await q.for("update", { of: boardCards }) : await q;
  return row ?? null;
}

// ---------------------------------------------------------------- board creation

export interface BoardSettings {
  templateId: string | null;
  prefix: string | null;
  namingRule: string | null;
  fields: BoardFieldDef[];
  columns: TemplateColumn[];
}

/**
 * The `boards` row and its columns for a channel created with `layout: "board"`, in the channel's transaction (order:
 * board, then columns; the FKs are immediate). `null` settings = the default columns, no prefix, no naming rule.
 * Emits nothing: the channel creation announces the channel.
 */
export async function createBoard(
  tx: Tx,
  conv: ConversationRow,
  settings: BoardSettings | null,
): Promise<{ board: Board; columns: BoardColumn[] }> {
  const [board] = await tx
    .insert(boards)
    .values({
      conversationId: conv.id,
      organizationId: conv.organizationId,
      templateId: settings?.templateId ?? null,
      prefix: settings?.prefix ?? null,
      namingRule: settings?.namingRule ?? null,
      fields: settings?.fields ?? [],
    })
    .returning();
  if (!board) throw new Error("board insert returned no row");
  const cols = settings?.columns ?? DEFAULT_BOARD_COLUMNS;
  const keys = freshKeys(cols.length);
  const columns = await tx
    .insert(boardColumns)
    .values(
      cols.map((c, i) => ({
        organizationId: conv.organizationId,
        conversationId: conv.id,
        name: c.name,
        rank: keys[i] as string,
        category: c.category,
        defaultWaitingOn: c.defaultWaitingOn,
      })),
    )
    .returning();
  return {
    board: toBoard(board),
    columns: columns.map(toColumn).sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0)),
  };
}

/** A board's columns in rank order (`COLLATE "C"`, ties by id). */
export async function columnsOf(tx: Tx, conversationId: string): Promise<ColumnRow[]> {
  return tx
    .select()
    .from(boardColumns)
    .where(eq(boardColumns.conversationId, conversationId))
    .orderBy(sql`${boardColumns.rank} collate "C"`, asc(boardColumns.id));
}

// ---------------------------------------------------------------- reads

/**
 * The board as one snapshot (P-11): `lastSeq` is read FIRST, so anything committed after it reaches a subscriber that
 * starts at it; at most `BOARD_COLUMN_PAGE` cards per column (`hasMore` beyond); tombstoned roots are left out.
 */
export async function readBoardSnapshot(
  tx: Tx,
  deps: ChatDeps,
  conversationId: string,
): Promise<BoardSnapshot> {
  const lastSeq = await deps.realtime.lastSeq(tx, convTopic(conversationId));
  const [board] = await tx.select().from(boards).where(eq(boards.conversationId, conversationId)).limit(1);
  if (!board) throw badRequest("This channel is not a board", "not_a_board");
  const columns = await columnsOf(tx, conversationId);
  const rn =
    sql<number>`row_number() over (partition by ${boardCards.columnId} order by ${boardCards.rank} collate "C", ${boardCards.messageId})`
      .mapWith(Number)
      .as("rn");
  const ranked = tx
    .select({ messageId: boardCards.messageId, rn })
    .from(boardCards)
    .innerJoin(messages, eq(messages.id, boardCards.messageId))
    .where(and(eq(boardCards.conversationId, conversationId), isNull(messages.deletedAt)))
    .as("ranked");
  const rows = await tx
    .select(cardSelect)
    .from(boardCards)
    .innerJoin(messages, eq(messages.id, boardCards.messageId))
    .innerJoin(ranked, eq(ranked.messageId, boardCards.messageId))
    .where(lte(ranked.rn, BOARD_COLUMN_PAGE + 1))
    .orderBy(...cardOrder);
  const byColumn = new Map<string, BoardCard[]>();
  for (const r of rows) {
    const list = byColumn.get(r.card.columnId) ?? [];
    list.push(toCard(r));
    byColumn.set(r.card.columnId, list);
  }
  return {
    board: toBoard(board),
    columns: columns.map(toColumn),
    cards: columns.map((c) => {
      const list = byColumn.get(c.id) ?? [];
      return {
        columnId: c.id,
        cards: list.slice(0, BOARD_COLUMN_PAGE),
        hasMore: list.length > BOARD_COLUMN_PAGE,
      };
    }),
    lastSeq,
  };
}

/** The next page of one column's cards, after `after` (a rank) in rank order (P-11). 404 for another board's column. */
export async function readColumnPage(
  tx: Tx,
  board: BoardRow,
  columnId: string,
  after: string | undefined,
): Promise<BoardColumnCards> {
  const [column] = await tx
    .select({ id: boardColumns.id })
    .from(boardColumns)
    .where(and(eq(boardColumns.id, columnId), eq(boardColumns.conversationId, board.conversationId)))
    .limit(1);
  if (!column) throw notFound("Column not found", "board_column_not_found");
  const rows = await tx
    .select(cardSelect)
    .from(boardCards)
    .innerJoin(messages, eq(messages.id, boardCards.messageId))
    .where(
      and(
        eq(boardCards.conversationId, board.conversationId),
        eq(boardCards.columnId, column.id),
        isNull(messages.deletedAt),
        after === undefined ? undefined : sql`${boardCards.rank} collate "C" > ${after} collate "C"`,
      ),
    )
    .orderBy(...cardOrder)
    .limit(BOARD_COLUMN_PAGE + 1);
  return {
    columnId: column.id,
    cards: rows.slice(0, BOARD_COLUMN_PAGE).map(toCard),
    hasMore: rows.length > BOARD_COLUMN_PAGE,
  };
}

// ---------------------------------------------------------------- placement (under the stream lock)

/**
 * The rank of a card landing in `columnId` after `afterCardId` (null = top; `"end"` or a card no longer in the column =
 * bottom). Reads the column's ranks in SQL order, never trusting a client. When the neighbours tie, are out of order or
 * are not valid keys (`keyBetween` → "rerank"), the column is rewritten with fresh keys in its current order with the
 * new card in its slot, and ONE `board.column_reranked` carries the other cards' new ranks (P-06, Pitfall 7); a
 * re-rank never changes a card's version. The caller holds the stream lock.
 */
async function placeInColumn(
  tx: Tx,
  deps: ChatDeps,
  conversationId: string,
  columnId: string,
  movingId: string | null,
  afterCardId: string | null | "end",
): Promise<string> {
  // Every row of the column (tombstoned roots too): their ranks still occupy the order, so no key is ever reused.
  const rows = await tx
    .select({ messageId: boardCards.messageId, rank: boardCards.rank })
    .from(boardCards)
    .where(
      and(
        eq(boardCards.conversationId, conversationId),
        eq(boardCards.columnId, columnId),
        movingId ? ne(boardCards.messageId, movingId) : undefined,
      ),
    )
    .orderBy(...cardOrder);
  let slot: number;
  if (afterCardId === null) slot = 0;
  else if (afterCardId === "end") slot = rows.length;
  else {
    const i = rows.findIndex((r) => r.messageId === afterCardId);
    slot = i === -1 ? rows.length : i + 1;
  }
  const key = keyBetween(rows[slot - 1]?.rank ?? null, rows[slot]?.rank ?? null);
  if (key !== "rerank") return key;

  const keys = freshKeys(rows.length + 1);
  const ranks: BoardColumnRerankedEvent["ranks"] = [];
  for (const [i, r] of rows.entries()) {
    const rank = keys[i < slot ? i : i + 1] as string;
    await tx.update(boardCards).set({ rank }).where(eq(boardCards.messageId, r.messageId));
    ranks.push({ messageId: r.messageId, rank });
  }
  const ev: BoardColumnRerankedEvent = { conversationId, columnId, ranks };
  await deps.realtime.appendEvent(tx, convTopic(conversationId), EventTypes.boardColumnReranked, ev);
  return keys[slot] as string;
}

/** Audit fields for the actor of a board write: a user defaults to the transaction context; an agent is explicit. */
function actorAudit(actor: BoardAuthor) {
  return actor.kind === "agent"
    ? {
        actorKind: "agent" as const,
        actorId: actor.id,
        agentId: actor.id,
        userId: actor.onBehalfOfUserId,
        clientKind: "agent",
      }
    : {};
}

// ---------------------------------------------------------------- cards

export interface CreateBoardCardArgs {
  conv: ConversationRow;
  author: BoardAuthor;
  input: CreateBoardCardRequest;
  clientKind: PostInput["clientKind"];
  sessionId?: string | null;
}

/**
 * Posts a card (BOARD-02, BOARD-06, P-07): under the stream lock, a retry of the same `clientMessageId` answers the
 * existing card (`created: false`, no number consumed); otherwise the target column (default: the first `backlog`
 * column, else the first column), the field values (`invalid_field_values`), the next per-board number on a prefixed
 * board, the title (typed = `user`; else the naming rule, else the first line = `heuristic`), the root message through
 * `postMessage` (`thread_id` null, body = `cardMessageBody`), the card at the bottom of its column, one
 * `board.card_upserted` and the `board.card.created` audit. The caller runs the message side effects when `created`.
 */
export async function createBoardCard(
  tx: Tx,
  deps: ChatDeps,
  args: CreateBoardCardArgs,
): Promise<{ card: BoardCard; created: boolean; result: PostResult }> {
  const { conv, author, input } = args;
  await lockNextSeq(tx, convTopic(conv.id));
  const dir = await loadDirectory(tx);

  const [existing] = await tx
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.authorKind, author.kind),
        eq(messages.authorId, author.id),
        eq(messages.clientMessageId, input.clientMessageId),
      ),
    )
    .limit(1);
  if (existing) {
    const prior = existing.conversationId === conv.id ? await loadCard(tx, conv.id, existing.id) : null;
    if (!prior) {
      throw conflict("This clientMessageId was already used for another message", "client_message_id_reused");
    }
    return {
      card: toCard(prior),
      created: false,
      result: { row: existing, message: toMessage(existing, dir), created: false, root: null },
    };
  }

  const [board] = await tx.select().from(boards).where(eq(boards.conversationId, conv.id)).for("update");
  if (!board) throw badRequest("This channel is not a board", "not_a_board");
  const columns = await columnsOf(tx, conv.id);
  const column = input.columnId
    ? columns.find((c) => c.id === input.columnId)
    : (columns.find((c) => c.category === "backlog") ?? columns[0]);
  if (!column) throw badRequest("That column is not on this board", "invalid_column");

  const defs = board.fields as BoardFieldDef[];
  const parsed = fieldValuesSchema(defs).safeParse(input.fields ?? {});
  if (!parsed.success) {
    throw new HttpError(400, "invalid_field_values", "Some field values are not valid", parsed.error.issues);
  }
  const fields = parsed.data;

  let number: number | null = null;
  if (board.prefix !== null) {
    const [next] = await tx
      .update(boards)
      .set({ lastNumber: sql`${boards.lastNumber} + 1` })
      .where(eq(boards.conversationId, conv.id))
      .returning({ lastNumber: boards.lastNumber });
    number = next?.lastNumber ?? null;
  }
  const title =
    input.title ??
    renderCardTitle(board.namingRule, {
      prefix: board.prefix,
      number,
      description: input.description,
      fields,
    });
  const body = cardMessageBody({ title, description: input.description, fields, defs });

  const result = await postMessage(tx, deps, dir, {
    conv,
    author: { kind: author.kind, id: author.id },
    body,
    mentions: resolveMentions(body, dir),
    threadRootId: null,
    clientMessageId: input.clientMessageId,
    clientKind: args.clientKind,
    sessionId: args.sessionId ?? null,
  });
  const rank = await placeInColumn(tx, deps, conv.id, column.id, null, "end");
  const [row] = await tx
    .insert(boardCards)
    .values({
      messageId: result.row.id,
      organizationId: conv.organizationId,
      conversationId: conv.id,
      columnId: column.id,
      rank,
      waitingOn: input.waitingOn ?? column.defaultWaitingOn ?? "none",
      title,
      titleSource: input.title ? "user" : "heuristic",
      description: input.description,
      number,
      fields,
    })
    .returning();
  if (!row) throw new Error("card insert returned no row");
  const card = toCard({
    card: row,
    authorKind: result.row.authorKind,
    authorId: result.row.authorId,
    replyCount: result.row.replyCount,
    lastReplyAt: result.row.lastReplyAt,
  });
  await deps.realtime.appendEvent(tx, convTopic(conv.id), EventTypes.boardCardUpserted, { card });
  await deps.audit.record(tx, {
    action: "board.card.created",
    resourceType: "message",
    resourceId: card.messageId,
    ...actorAudit(author),
    ...(author.kind === "user" ? { sessionId: args.sessionId ?? null } : {}),
    metadata: {
      conversationId: conv.id,
      messageId: card.messageId,
      columnId: column.id,
      category: column.category,
      number,
      version: card.version,
    },
  });
  return { card, created: true, result };
}

/** A card root's text edit, for the caller's edit observers (notifications of newly mentioned people). */
export interface CardTextEdit {
  row: MessageRow;
  previousMentions: Mention[];
  dir: Directory;
}

export interface UpdateBoardCardArgs {
  conv: ConversationRow;
  messageId: string;
  actor: BoardAuthor;
  input: UpdateBoardCardRequest;
  sessionId?: string | null;
  /** Runs in the transaction right after the root message was rewritten (the route calls chat's edit observers). */
  onTextEdited?: (tx: Tx, edit: CardTextEdit) => Promise<void>;
}

const sameValues = (a: Record<string, unknown>, b: Record<string, unknown>) => {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) if ((a[k] ?? null) !== (b[k] ?? null)) return false;
  return true;
};

/**
 * Moves a card, sets its waiting state and edits its text (BOARD-03, BOARD-05, BOARD-06, D-05, D-06, P-02, P-09), under
 * the stream lock: the card is locked; text (title, description, fields) belongs to the card's human author alone
 * (403 `not_author`, the Phase 4 rule: nobody, admins included, edits someone else's words; agents never edit text);
 * a stale `expectedVersion` is 409 `board_card_version_conflict` whose `details.card` is the current card (the client
 * applies it and retries); the rank comes from `placeInColumn`; entering a column with a default waiting state applies
 * it unless the request names one.
 *
 * Titles (Pitfall 9): a typed `title` is stored as `user` and is never replaced afterwards; a description or field
 * edit recomputes the title from the board's naming rule (or the description's first line) in the same UPDATE, guarded
 * by `title_source <> 'user'` in SQL, so it can never overwrite a typed title. When the card's text changed, the root
 * message is rewritten through chat's `editMessage` (append-only history, `message.updated`, `message.edited`) with
 * `cardMessageBody`, so search and the Messages view follow the board. Then `version + 1`, one `board.card_upserted`,
 * and the `board.card.moved` and/or `board.card.updated` audits (ids, categories, versions and booleans; never text).
 */
export async function updateBoardCard(tx: Tx, deps: ChatDeps, args: UpdateBoardCardArgs): Promise<BoardCard> {
  const { conv, messageId, actor, input } = args;
  const textEdit = input.title !== undefined || input.description !== undefined || input.fields !== undefined;
  await lockNextSeq(tx, convTopic(conv.id));
  const current = await loadCard(tx, conv.id, messageId, true);
  if (!current) throw notFound(CARD_NOT_FOUND, "card_not_found");
  if (textEdit && (actor.kind !== "user" || current.authorKind !== "user" || current.authorId !== actor.id)) {
    throw forbidden("Only the author can edit this message", "not_author");
  }
  if (current.card.version !== input.expectedVersion) {
    throw new HttpError(
      409,
      "board_card_version_conflict",
      `The card is at version ${current.card.version}, not ${input.expectedVersion}`,
      { card: toCard(current) },
    );
  }

  const before = current.card;
  const columns = await columnsOf(tx, conv.id);
  const fromColumn = columns.find((c) => c.id === before.columnId);
  let toColumn = fromColumn;
  let rank = before.rank;
  let waitingOn = before.waitingOn;
  if (input.move) {
    const { columnId, afterCardId } = input.move;
    toColumn = columns.find((c) => c.id === columnId);
    if (!toColumn) throw badRequest("That column is not on this board", "invalid_column");
    rank = await placeInColumn(tx, deps, conv.id, toColumn.id, before.messageId, afterCardId);
    if (toColumn.id !== before.columnId && toColumn.defaultWaitingOn !== null) {
      waitingOn = toColumn.defaultWaitingOn;
    }
  }
  if (input.waitingOn !== undefined) waitingOn = input.waitingOn;

  // Card text: the board's field definitions validate the merged values (a key set to null clears it).
  let board: BoardRow | null = null;
  const beforeFields = before.fields as Record<string, FieldValue>;
  let fields = beforeFields;
  const description = input.description ?? before.description;
  let titleSet: { title: string | SQL; titleSource?: "user" } | null = null;
  if (textEdit) {
    const [found] = await tx.select().from(boards).where(eq(boards.conversationId, conv.id)).limit(1);
    board = found ?? null;
    if (!board) throw badRequest("This channel is not a board", "not_a_board");
    if (input.fields !== undefined) {
      const parsed = fieldValuesSchema(board.fields as BoardFieldDef[]).safeParse({
        ...beforeFields,
        ...input.fields,
      });
      if (!parsed.success) {
        throw new HttpError(
          400,
          "invalid_field_values",
          "Some field values are not valid",
          parsed.error.issues,
        );
      }
      fields = parsed.data;
    }
    if (input.title !== undefined) {
      titleSet = { title: input.title, titleSource: "user" };
    } else {
      const recomputed = renderCardTitle(board.namingRule, {
        prefix: board.prefix,
        number: before.number,
        description,
        fields,
      });
      // Never replaces a typed title, even one written after this request read the card (Pitfall 9).
      titleSet = {
        title: sql`case when ${boardCards.titleSource} <> 'user' then ${recomputed} else ${boardCards.title} end`,
      };
    }
  }

  const [row] = await tx
    .update(boardCards)
    .set({
      columnId: toColumn?.id ?? before.columnId,
      rank,
      waitingOn,
      version: sql`${boardCards.version} + 1`,
      updatedAt: sql`now()`,
      ...(input.move ? { movedAt: sql`now()` } : {}),
      ...(textEdit ? { description, fields, ...titleSet } : {}),
    })
    .where(and(eq(boardCards.messageId, before.messageId), eq(boardCards.version, before.version)))
    .returning();
  if (!row) throw new Error("locked card changed under the stream lock");

  if (textEdit && board && actor.kind === "user") {
    const dir = await loadDirectory(tx);
    const [message] = await tx
      .select()
      .from(messages)
      .where(eq(messages.id, before.messageId))
      .limit(1)
      .for("update");
    if (!message) throw new Error("a card's root message is missing");
    const body = cardMessageBody({
      title: row.title,
      description: row.description,
      fields: row.fields as BoardFieldValues,
      defs: board.fields as BoardFieldDef[],
    });
    if (body !== message.body) {
      const edit = await editMessage(tx, deps, dir, {
        message,
        body,
        editor: { kind: "user", id: actor.id },
      });
      await args.onTextEdited?.(tx, { row: edit.row, previousMentions: edit.previousMentions, dir });
    }
  }

  const card = toCard({ ...current, card: row });
  await deps.realtime.appendEvent(tx, convTopic(conv.id), EventTypes.boardCardUpserted, { card });
  const audit = {
    resourceType: "message",
    resourceId: card.messageId,
    ...actorAudit(actor),
    ...(actor.kind === "user" && args.sessionId !== undefined ? { sessionId: args.sessionId } : {}),
  };
  const ids = { conversationId: conv.id, messageId: card.messageId };
  if (input.move || !textEdit) {
    await deps.audit.record(tx, {
      ...audit,
      action: input.move ? "board.card.moved" : "board.card.updated",
      metadata: {
        ...ids,
        fromColumnId: before.columnId,
        toColumnId: card.columnId,
        fromCategory: fromColumn?.category ?? null,
        toCategory: toColumn?.category ?? null,
        waitingOnChanged: before.waitingOn !== card.waitingOn,
        version: card.version,
      },
    });
  }
  if (textEdit) {
    await deps.audit.record(tx, {
      ...audit,
      action: "board.card.updated",
      metadata: {
        ...ids,
        titleChanged: before.title !== card.title,
        titleSource: card.titleSource,
        descriptionChanged: before.description !== card.description,
        fieldsChanged: !sameValues(beforeFields, card.fields),
        waitingOnChanged: before.waitingOn !== card.waitingOn,
        version: card.version,
      },
    });
  }
  return card;
}
