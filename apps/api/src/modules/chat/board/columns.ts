import {
  BOARD_MAX_COLUMNS,
  type BoardColumnRerankedEvent,
  BoardUpdatedEvent,
  CreateBoardColumnRequest,
  DeleteBoardColumnQuery,
  EventTypes,
  Id,
  UpdateBoardColumnRequest,
} from "@ocw/contracts";
import { boardCards, boardColumns, boards, messages, type Tx } from "@ocw/db";
import { and, asc, count, desc, eq, isNull, ne, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { type App, authOf, tenant } from "../../../core";
import { badRequest, conflict, gone, notFound } from "../../../lib/errors";
import { channelResource } from "../../organization";
import { type ChatDeps, type ConversationRow, convTopic, lockNextSeq } from "../service";
import { type BoardGuardCtx, readableBoard } from "./access";
import { freshKeys, keyBetween, keysAfter } from "./rank";
import { type ColumnRow, columnsOf, toBoard, toColumn } from "./service";

/**
 * Column management (BOARD-01, D-07, D-08, P-09): the channel's owner or an admin (`channel.update`, the same decision
 * as editing the channel) adds, renames, recategorises, reorders and deletes columns and sets their default waiting
 * state (`null` = "Keep as is"). Every route resolves the board through `readableBoard` (hidden = missing = 404,
 * another organization's ids do not exist under RLS), then `channel.update`, then 410 on an archived board. Every write
 * takes the conversation's stream lock first, like every other board writer, so column ranks and card moves never
 * interleave; each change bumps the board's version and emits exactly one `board.updated` (board + full ordered column
 * list) on `conv:<id>`, and is audited `board.column.created|updated|deleted` with ids, categories and counts only.
 */

const BoardParams = z.object({ conversationId: Id });
const BoardColumnParams = z.object({ conversationId: Id, columnId: Id });
const COLUMN_NOT_FOUND = "Column not found";

/** The board when the caller may manage its columns, with the stream lock taken. */
async function manageableBoard(
  req: FastifyRequest,
  tx: Tx,
  ctx: BoardGuardCtx,
  conversationId: string,
): Promise<ConversationRow> {
  const { conv, facts } = await readableBoard(req, tx, ctx, conversationId);
  await ctx.perms.assertCan(req, tx, "channel.update", channelResource(facts));
  if (conv.archivedAt) throw gone("This channel is archived", "channel_archived");
  await lockNextSeq(tx, convTopic(conv.id));
  return conv;
}

/** 409 when another column of the board already has this name, ignoring case (the unique index's `lower(name)`). */
async function assertNameFree(tx: Tx, conversationId: string, name: string, exceptId: string | null) {
  const [taken] = await tx
    .select({ id: boardColumns.id })
    .from(boardColumns)
    .where(
      and(
        eq(boardColumns.conversationId, conversationId),
        sql`lower(${boardColumns.name}) = lower(${name})`,
        exceptId ? ne(boardColumns.id, exceptId) : undefined,
      ),
    )
    .limit(1);
  if (taken) throw conflict("A column with this name already exists on this board", "board_column_exists");
}

/**
 * The rank of a column landing after `afterColumnId` among `others` (in order; undefined = last, null = first). A tie
 * or an exhausted key rewrites the other columns with fresh keys; the `board.updated` that follows carries them all.
 */
async function columnRank(
  tx: Tx,
  others: ColumnRow[],
  afterColumnId: string | null | undefined,
): Promise<string> {
  let slot: number;
  if (afterColumnId === undefined) slot = others.length;
  else if (afterColumnId === null) slot = 0;
  else {
    const i = others.findIndex((c) => c.id === afterColumnId);
    if (i === -1) throw badRequest("That column is not on this board", "invalid_column");
    slot = i + 1;
  }
  const key = keyBetween(others[slot - 1]?.rank ?? null, others[slot]?.rank ?? null);
  if (key !== "rerank") return key;
  const keys = freshKeys(others.length + 1);
  for (const [i, c] of others.entries()) {
    await tx
      .update(boardColumns)
      .set({ rank: keys[i < slot ? i : i + 1] as string, updatedAt: sql`now()` })
      .where(eq(boardColumns.id, c.id));
  }
  return keys[slot] as string;
}

/** Bumps the board's version and emits the one `board.updated` of this change. */
async function announce(tx: Tx, deps: ChatDeps, conversationId: string): Promise<BoardUpdatedEvent> {
  const [board] = await tx
    .update(boards)
    .set({ version: sql`${boards.version} + 1`, updatedAt: sql`now()` })
    .where(eq(boards.conversationId, conversationId))
    .returning();
  if (!board) throw new Error("board row missing under the stream lock");
  const ev: BoardUpdatedEvent = {
    conversationId,
    board: toBoard(board),
    columns: (await columnsOf(tx, conversationId)).map(toColumn),
  };
  await deps.realtime.appendEvent(tx, convTopic(conversationId), EventTypes.boardUpdated, ev);
  return ev;
}

export function registerColumnRoutes(app: App, ctx: BoardGuardCtx & { deps: ChatDeps }): void {
  const { core, deps } = ctx;
  const tags = ["chat"];
  const user = { config: { authz: "user" as const }, preHandler: core.identity.requireUser };

  app.post(
    "/boards/:conversationId/columns",
    {
      ...user,
      schema: {
        tags,
        params: BoardParams,
        body: CreateBoardColumnRequest,
        response: { 200: BoardUpdatedEvent },
      },
    },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        const auth = authOf(req);
        const conv = await manageableBoard(req, tx, ctx, req.params.conversationId);
        const columns = await columnsOf(tx, conv.id);
        if (columns.length >= BOARD_MAX_COLUMNS) {
          throw conflict(`A board has at most ${BOARD_MAX_COLUMNS} columns`, "board_columns_limit");
        }
        const { name, category, defaultWaitingOn, afterColumnId } = req.body;
        await assertNameFree(tx, conv.id, name, null);
        const rank = await columnRank(tx, columns, afterColumnId);
        const [row] = await tx
          .insert(boardColumns)
          .values({
            organizationId: conv.organizationId,
            conversationId: conv.id,
            name,
            rank,
            category,
            defaultWaitingOn,
          })
          .returning();
        if (!row) throw new Error("column insert returned no row");
        const ev = await announce(tx, deps, conv.id);
        await deps.audit.record(tx, {
          action: "board.column.created",
          resourceType: "conversation",
          resourceId: conv.id,
          sessionId: auth.sessionId,
          metadata: {
            conversationId: conv.id,
            columnId: row.id,
            category,
            defaultWaitingOn,
            boardVersion: ev.board.version,
          },
        });
        return ev;
      }),
  );

  app.patch(
    "/boards/:conversationId/columns/:columnId",
    {
      ...user,
      schema: {
        tags,
        params: BoardColumnParams,
        body: UpdateBoardColumnRequest,
        response: { 200: BoardUpdatedEvent },
      },
    },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        const auth = authOf(req);
        const conv = await manageableBoard(req, tx, ctx, req.params.conversationId);
        const columns = await columnsOf(tx, conv.id);
        const column = columns.find((c) => c.id === req.params.columnId);
        if (!column) throw notFound(COLUMN_NOT_FOUND, "board_column_not_found");
        const { name, category, defaultWaitingOn, afterColumnId } = req.body;
        if (afterColumnId === column.id) throw badRequest("A column cannot follow itself", "invalid_column");
        if (name !== undefined) await assertNameFree(tx, conv.id, name, column.id);
        const rank =
          afterColumnId === undefined
            ? column.rank
            : await columnRank(
                tx,
                columns.filter((c) => c.id !== column.id),
                afterColumnId,
              );
        await tx
          .update(boardColumns)
          .set({
            rank,
            ...(name !== undefined ? { name } : {}),
            ...(category !== undefined ? { category } : {}),
            ...(defaultWaitingOn !== undefined ? { defaultWaitingOn } : {}),
            updatedAt: sql`now()`,
          })
          .where(eq(boardColumns.id, column.id));
        const ev = await announce(tx, deps, conv.id);
        await deps.audit.record(tx, {
          action: "board.column.updated",
          resourceType: "conversation",
          resourceId: conv.id,
          sessionId: auth.sessionId,
          metadata: {
            conversationId: conv.id,
            columnId: column.id,
            renamed: name !== undefined && name !== column.name,
            fromCategory: column.category,
            toCategory: category ?? column.category,
            fromDefaultWaitingOn: column.defaultWaitingOn,
            toDefaultWaitingOn: defaultWaitingOn === undefined ? column.defaultWaitingOn : defaultWaitingOn,
            moved: afterColumnId !== undefined,
            boardVersion: ev.board.version,
          },
        });
        return ev;
      }),
  );

  app.delete(
    "/boards/:conversationId/columns/:columnId",
    {
      ...user,
      schema: {
        tags,
        params: BoardColumnParams,
        querystring: DeleteBoardColumnQuery,
        response: { 200: BoardUpdatedEvent },
      },
    },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        const auth = authOf(req);
        const conv = await manageableBoard(req, tx, ctx, req.params.conversationId);
        const columns = await columnsOf(tx, conv.id);
        const column = columns.find((c) => c.id === req.params.columnId);
        if (!column) throw notFound(COLUMN_NOT_FOUND, "board_column_not_found");
        const { moveCardsTo } = req.query;
        const target = moveCardsTo === undefined ? undefined : columns.find((c) => c.id === moveCardsTo);
        if (moveCardsTo !== undefined && (!target || target.id === column.id)) {
          throw badRequest("Move the cards to another column of this board", "invalid_column");
        }
        if (columns.length === 1) throw conflict("A board keeps at least one column", "board_last_column");

        const [live] = await tx
          .select({ n: count() })
          .from(boardCards)
          .innerJoin(messages, eq(messages.id, boardCards.messageId))
          .where(and(eq(boardCards.columnId, column.id), isNull(messages.deletedAt)));
        const moved = Number(live?.n ?? 0);
        if (moved > 0 && !target) {
          throw conflict("Move this column's cards to another column first", "board_column_not_empty");
        }

        // Every card row of the column (a tombstoned root too: it still references the column) goes to the bottom
        // of the target in its order; a column holding only tombstones hands them to the first remaining column.
        const rows = await tx
          .select({ messageId: boardCards.messageId })
          .from(boardCards)
          .where(eq(boardCards.columnId, column.id))
          .orderBy(sql`${boardCards.rank} collate "C"`, asc(boardCards.messageId));
        const dest = target ?? columns.find((c) => c.id !== column.id);
        if (rows.length > 0 && dest) {
          const [last] = await tx
            .select({ rank: boardCards.rank })
            .from(boardCards)
            .where(eq(boardCards.columnId, dest.id))
            .orderBy(desc(sql`${boardCards.rank} collate "C"`), desc(boardCards.messageId))
            .limit(1);
          let keys = keysAfter(last?.rank ?? null, rows.length);
          if (keys === "rerank") {
            // The target's keys are exhausted: fresh keys for its cards (one board.column_reranked), then ours.
            const kept = await tx
              .select({ messageId: boardCards.messageId })
              .from(boardCards)
              .where(eq(boardCards.columnId, dest.id))
              .orderBy(sql`${boardCards.rank} collate "C"`, asc(boardCards.messageId));
            const all = freshKeys(kept.length + rows.length);
            const ranks: BoardColumnRerankedEvent["ranks"] = [];
            for (const [i, r] of kept.entries()) {
              const rank = all[i] as string;
              await tx.update(boardCards).set({ rank }).where(eq(boardCards.messageId, r.messageId));
              ranks.push({ messageId: r.messageId, rank });
            }
            const ev: BoardColumnRerankedEvent = { conversationId: conv.id, columnId: dest.id, ranks };
            await deps.realtime.appendEvent(tx, convTopic(conv.id), EventTypes.boardColumnReranked, ev);
            keys = all.slice(kept.length);
          }
          for (const [i, r] of rows.entries()) {
            await tx
              .update(boardCards)
              .set({
                columnId: dest.id,
                rank: keys[i] as string,
                // Entering a column with a default waiting state applies it (P-09); null keeps the card's.
                ...(dest.defaultWaitingOn !== null ? { waitingOn: dest.defaultWaitingOn } : {}),
                version: sql`${boardCards.version} + 1`,
                updatedAt: sql`now()`,
                movedAt: sql`now()`,
              })
              .where(eq(boardCards.messageId, r.messageId));
          }
        }
        await tx.delete(boardColumns).where(eq(boardColumns.id, column.id));
        const ev = await announce(tx, deps, conv.id);
        await deps.audit.record(tx, {
          action: "board.column.deleted",
          resourceType: "conversation",
          resourceId: conv.id,
          sessionId: auth.sessionId,
          metadata: {
            conversationId: conv.id,
            columnId: column.id,
            category: column.category,
            movedCardsTo: moved > 0 ? (target?.id ?? null) : null,
            movedCards: moved,
            boardVersion: ev.board.version,
          },
        });
        return ev;
      }),
  );
}
