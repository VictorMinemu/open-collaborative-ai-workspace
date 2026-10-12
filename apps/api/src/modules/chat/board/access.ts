import { mentionAllOf } from "@ocw/contracts";
import { boardColumns, boards, type Tx } from "@ocw/db";
import { and, eq } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { authOf } from "../../../core";
import { badRequest, gone } from "../../../lib/errors";
import { type ChannelFacts, channelResource } from "../../organization";
import type { ChatRouteCtx } from "../index";
import { claimMentionAll, isOwnRetry } from "../mention-all";
import { type ConversationRow, getConversation } from "../service";

/**
 * The board route guards (BOARD-04, T-07.1-03-01/04): every `/boards/*` route resolves its board here, so the access
 * matrix lives in one file (07.1-05 proves and hardens it). Reads go through chat's one readable-set decision
 * (`access.readableRow`: hidden = missing = 404); writes add exactly what the message route decides: archived 410,
 * `channel.post`, and `channel.mention_all` plus the per-minute gate when the card's body broadcasts.
 */

export type BoardRow = typeof boards.$inferSelect;

export type BoardGuardCtx = Pick<ChatRouteCtx, "core" | "access" | "perms">;

export interface ResolvedBoard {
  conv: ConversationRow;
  facts: ChannelFacts;
  board: BoardRow;
}

const BOARD_NOT_FOUND = "Board not found";

/** The board channel when the caller may read it: 404 when missing or hidden, 400 `not_a_board` for a text channel. */
export async function readableBoard(
  req: FastifyRequest,
  tx: Tx,
  ctx: BoardGuardCtx,
  conversationId: string,
): Promise<ResolvedBoard> {
  const { conv, facts } = await ctx.access.readableRow(
    req,
    tx,
    await getConversation(tx, conversationId, ["channel"]),
    BOARD_NOT_FOUND,
  );
  if (conv.layout !== "board") throw badRequest("This channel is not a board", "not_a_board");
  const [board] = await tx.select().from(boards).where(eq(boards.conversationId, conv.id)).limit(1);
  if (!board) throw badRequest("This channel is not a board", "not_a_board");
  return { conv, facts, board };
}

/**
 * `readableBoard` plus the write decisions of the message route: 410 `channel_archived`, `channel.post`, and for a body
 * that uses `@channel` / `@here`, `channel.mention_all` and the shared one-per-minute gate (a retry of the caller's own
 * `clientMessageId` is not counted again).
 */
export async function writableBoard(
  req: FastifyRequest,
  tx: Tx,
  ctx: BoardGuardCtx,
  conversationId: string,
  opts: { body?: string; clientMessageId?: string; columnId?: string | undefined } = {},
): Promise<ResolvedBoard> {
  const resolved = await readableBoard(req, tx, ctx, conversationId);
  if (resolved.conv.archivedAt) throw gone("This channel is archived", "channel_archived");
  const resource = channelResource(resolved.facts);
  await ctx.perms.assertCan(req, tx, "channel.post", resource);
  if (opts.body !== undefined && mentionAllOf(opts.body)) {
    await ctx.perms.assertCan(req, tx, "channel.mention_all", resource);
    const retry =
      opts.clientMessageId !== undefined && (await isOwnRetry(tx, authOf(req).userId, opts.clientMessageId));
    if (!retry) {
      // Validate before claiming, as the message route does: a refused card never spends the minute (07.1-14).
      if (opts.columnId !== undefined) await assertColumnOnBoard(tx, resolved.conv.id, opts.columnId);
      await claimMentionAll(ctx.core, resolved.conv.id);
    }
  }
  return resolved;
}

/** 400 `invalid_column` unless the column belongs to this board (the card service re-checks under the lock). */
async function assertColumnOnBoard(tx: Tx, conversationId: string, columnId: string): Promise<void> {
  const [column] = await tx
    .select({ id: boardColumns.id })
    .from(boardColumns)
    .where(and(eq(boardColumns.id, columnId), eq(boardColumns.conversationId, conversationId)))
    .limit(1);
  if (!column) throw badRequest("That column is not on this board", "invalid_column");
}
