import {
  type CreateWatchedRecordRequest,
  EventTypes,
  type UpdateWatchedRecordRequest,
  type WatchedCheckInterval,
  type WatchedField,
  type WatchedRecord,
  type WatchedStatus,
} from "@ocw/contracts";
import {
  agents,
  boardCards,
  mcpServers,
  messages,
  orgMembers,
  type Tx,
  tenantOf,
  watchedRecords,
} from "@ocw/db";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { authOf, type Core } from "../../core";
import { badRequest, conflict, HttpError, notFound } from "../../lib/errors";
import { decideConversation } from "../automation";
import { type ConversationAccess, convTopic, readableBoard, writableBoard } from "../chat";
import { activeShare } from "../connectors";
import { channelResource, type PermissionService } from "../organization";
import { refuseTools, TOOL_REFUSAL_MESSAGES } from "./tools";

/**
 * Watched records, the link side (AUTO-04, D-04, D-07, Pitfall 8). Every decision is the resolver's, on the request:
 *
 * - Reading a watch = reading its board (hidden = missing = 404).
 * - Linking, editing and unlinking = posting on the board (`channel.post`, archived 410) + `record.watch` there; the card
 *   is a 07.1 board card; the reporting bot is a member of the board that may post there and read it for the linker
 *   (agent ∩ human); the connector exposes the named tools.
 * - Audience (07.4 D-03, Pitfall 8): a per-member connector reads with the linker's own account, so its values may reach
 *   the shared board only through an active `member_account_shares` row for (linker, board, connector), checked at
 *   link, at preview and again at every check (`check.ts`). Organization-secret connectors read with the workspace's
 *   access and need none.
 *
 * Audits carry ids and counts only, never a record value.
 */

export type WatchedRow = typeof watchedRecords.$inferSelect;
export type ServerRow = typeof mcpServers.$inferSelect;

export interface WatchedCtx {
  core: Core;
  perms: PermissionService;
  access: ConversationAccess;
}

const MESSAGES = {
  member_account: (connector: string, channel: string) =>
    `${connector} uses your own account, so everyone in #${channel} would see what it reads. Allow ${connector} in #${channel} first.`,
} as const;

export const minutes = (n: number) => n * 60_000;

/** The board of `conversationId` for the caller: read (404 hidden) or write (+ archived 410, `channel.post` 403). */
export async function boardFor(
  req: FastifyRequest,
  tx: Tx,
  ctx: WatchedCtx,
  conversationId: string,
  mode: "read" | "write",
) {
  try {
    return mode === "write"
      ? await writableBoard(req, tx, ctx, conversationId)
      : await readableBoard(req, tx, ctx, conversationId);
  } catch (err) {
    if (err instanceof HttpError && err.code === "not_a_board") {
      throw badRequest("Only a board card can watch a record", "not_a_board_card");
    }
    throw err;
  }
}

/** `record.watch` on the board (the resolver's unit rules can take it away there). */
async function assertWatch(
  req: FastifyRequest,
  tx: Tx,
  ctx: WatchedCtx,
  facts: Parameters<typeof channelResource>[0],
) {
  await ctx.perms.assertCan(req, tx, "record.watch", channelResource(facts));
}

/** The bot reports for the linker: a member of the board that may post there and read it for them. */
async function assertBot(
  tx: Tx,
  ctx: WatchedCtx,
  p: { agentId: string; userId: string; conv: Parameters<typeof decideConversation>[2]["conv"] },
) {
  const code = await decideConversation(tx, ctx.perms, p);
  if (code === "agent_not_member") {
    throw badRequest("The bot that reports changes must be a member of this board", "agent_not_member");
  }
  if (code) throw badRequest("That bot can't post on this board", "agent_cannot_post");
}

/**
 * The connector (RLS: this organization's) and the tools the watch names (`tools.ts`): each exists, passes the cell's
 * dangerous-name denylist and is granted to the bot (`agentId`; null = any live bot, for the preview); the read tool is
 * recorded read-only and not destructive. 400 with the refusal's code otherwise.
 */
export async function connectorWithTools(
  tx: Tx,
  p: {
    serverId: string;
    agentId: string | null;
    readTool: string;
    otherTools?: Array<string | null | undefined>;
  },
) {
  const [server] = await tx.select().from(mcpServers).where(eq(mcpServers.id, p.serverId)).limit(1);
  if (!server) throw notFound("Connector not found", "connector_not_found");
  if (server.transport === "sandboxed-stdio" || !server.url) {
    throw badRequest("Records can be watched only through a remote connector", "connector_unsupported");
  }
  if (server.authMode === "org_secret" && !server.orgEnabled) {
    throw conflict("This connector is turned off for the organization", "connector_disabled");
  }
  const refused = await refuseTools(tx, {
    serverId: server.id,
    agentId: p.agentId,
    readTool: p.readTool,
    otherTools: p.otherTools ?? [],
  });
  if (refused) {
    throw new HttpError(400, refused.code, TOOL_REFUSAL_MESSAGES[refused.code](refused.tool, server.name), {
      tool: refused.tool,
    });
  }
  return server;
}

/** Pitfall 8: a per-member connector's values reach a shared board only with the linker's active share there. */
export async function assertShared(
  tx: Tx,
  p: { userId: string; conversationId: string; channelName: string | null; server: ServerRow },
) {
  if (p.server.authMode === "org_secret") return;
  const shared = await activeShare(tx, {
    userId: p.userId,
    conversationId: p.conversationId,
    resourceKind: "connector",
    resourceId: p.server.id,
  });
  if (!shared) {
    throw new HttpError(
      409,
      "member_account",
      MESSAGES.member_account(p.server.name, p.channelName ?? "channel"),
      {
        conversationId: p.conversationId,
        connectorId: p.server.id,
      },
    );
  }
}

export async function rowById(tx: Tx, id: string): Promise<WatchedRow | null> {
  const [row] = await tx.select().from(watchedRecords).where(eq(watchedRecords.id, id)).limit(1);
  return row ?? null;
}

async function emitUpdated(
  core: Core,
  tx: Tx,
  row: Pick<WatchedRow, "id" | "cardMessageId" | "conversationId">,
) {
  await core.realtime.appendEvent(tx, convTopic(row.conversationId), EventTypes.watchedRecordUpdated, {
    watchedRecordId: row.id,
    cardMessageId: row.cardMessageId,
  });
}

export { emitUpdated };

// ---------------------------------------------------------------- DTO

interface Viewer {
  canPost: boolean;
  canWatch: boolean;
}

async function viewerOf(
  req: FastifyRequest,
  tx: Tx,
  ctx: WatchedCtx,
  board: Awaited<ReturnType<typeof boardFor>>,
) {
  const resource = channelResource(board.facts);
  const canPost = board.conv.archivedAt === null && (await ctx.perms.can(req, tx, "channel.post", resource));
  const canWatch = canPost && (await ctx.perms.can(req, tx, "record.watch", resource));
  return { canPost, canWatch };
}

async function toDtos(tx: Tx, rows: WatchedRow[], viewer: Viewer): Promise<WatchedRecord[]> {
  if (rows.length === 0) return [];
  const agentIds = [...new Set(rows.map((r) => r.agentId))];
  const serverIds = [...new Set(rows.map((r) => r.mcpServerId))];
  const userIds = [...new Set(rows.map((r) => r.checkAsUserId))];
  // One connection per transaction: the reads run one after another.
  const bots = await tx
    .select({ id: agents.id, name: agents.name })
    .from(agents)
    .where(inArray(agents.id, agentIds));
  const servers = await tx
    .select({ id: mcpServers.id, name: mcpServers.name, authMode: mcpServers.authMode })
    .from(mcpServers)
    .where(inArray(mcpServers.id, serverIds));
  const people = await tx
    .select({ id: orgMembers.userId, name: orgMembers.displayName })
    .from(orgMembers)
    .where(inArray(orgMembers.userId, userIds));
  const bot = new Map(bots.map((b) => [b.id, b.name]));
  const server = new Map(servers.map((s) => [s.id, s]));
  const person = new Map(people.map((p) => [p.id, p.name]));
  const can: WatchedRecord["viewerCan"] = [];
  if (viewer.canWatch) can.push("edit");
  if (viewer.canPost) can.push("check");
  if (viewer.canWatch) can.push("unlink");
  return rows.map((r) => {
    const s = server.get(r.mcpServerId);
    return {
      id: r.id,
      cardMessageId: r.cardMessageId,
      conversationId: r.conversationId,
      agent: { id: r.agentId, displayName: bot.get(r.agentId) ?? "Bot" },
      connector: {
        id: r.mcpServerId,
        name: s?.name ?? "Connector",
        authMode: s?.authMode === "org_secret" ? "org_secret" : "per_member",
      },
      externalRef: r.externalRef,
      readTool: r.readTool,
      writeTool: r.writeTool,
      noteTool: r.noteTool,
      idArg: r.idArg,
      fields: r.fields as unknown as WatchedField[],
      checkIntervalMinutes: r.checkIntervalMinutes as WatchedCheckInterval,
      lastStatus: r.lastStatus as WatchedStatus,
      checkedAt: r.checkedAt ? new Date(r.checkedAt).toISOString() : null,
      lastChangedAt: r.lastChangedAt ? new Date(r.lastChangedAt).toISOString() : null,
      linkedBy: { id: r.checkAsUserId, displayName: person.get(r.checkAsUserId) ?? "Former member" },
      version: r.version,
      viewerCan: [...can],
    };
  });
}

// ---------------------------------------------------------------- operations

export async function listWatched(req: FastifyRequest, tx: Tx, ctx: WatchedCtx, conversationId: string) {
  const board = await boardFor(req, tx, ctx, conversationId, "read");
  const rows = await tx
    .select()
    .from(watchedRecords)
    .where(eq(watchedRecords.conversationId, board.conv.id))
    .orderBy(asc(watchedRecords.createdAt), asc(watchedRecords.id));
  return { records: await toDtos(tx, rows, await viewerOf(req, tx, ctx, board)) };
}

/** One watch the caller can read (its board), or 404. */
export async function getWatched(
  req: FastifyRequest,
  tx: Tx,
  ctx: WatchedCtx,
  id: string,
  mode: "read" | "write",
) {
  const row = await rowById(tx, id);
  if (!row) throw notFound("Watched record not found", "watched_record_not_found");
  const board = await boardFor(req, tx, ctx, row.conversationId, mode);
  return { row, board };
}

export async function dtoOf(
  req: FastifyRequest,
  tx: Tx,
  ctx: WatchedCtx,
  row: WatchedRow,
  board: Awaited<ReturnType<typeof boardFor>>,
) {
  const [dto] = await toDtos(tx, [row], await viewerOf(req, tx, ctx, board));
  return dto as WatchedRecord;
}

/** `POST /watched-records`: link a board card to an external record; the first check (baseline) is enqueued. */
export async function linkWatched(
  req: FastifyRequest,
  tx: Tx,
  ctx: WatchedCtx,
  body: CreateWatchedRecordRequest,
): Promise<WatchedRecord> {
  const userId = authOf(req).userId;
  const [message] = await tx
    .select({ id: messages.id, conversationId: messages.conversationId, deletedAt: messages.deletedAt })
    .from(messages)
    .where(eq(messages.id, body.cardMessageId))
    .limit(1);
  if (!message || message.deletedAt) throw notFound("Card not found", "card_not_found");
  const board = await boardFor(req, tx, ctx, message.conversationId, "write");
  const [isCard] = await tx
    .select({ id: boardCards.messageId })
    .from(boardCards)
    .where(and(eq(boardCards.messageId, message.id), eq(boardCards.conversationId, board.conv.id)))
    .limit(1);
  if (!isCard) throw badRequest("Only a board card can watch a record", "not_a_board_card");
  await assertWatch(req, tx, ctx, board.facts);
  await assertBot(tx, ctx, { agentId: body.agentId, userId, conv: board.conv });
  const server = await connectorWithTools(tx, {
    serverId: body.mcpServerId,
    agentId: body.agentId,
    readTool: body.readTool,
    otherTools: [body.writeTool, body.noteTool],
  });
  await assertShared(tx, { userId, conversationId: board.conv.id, channelName: board.conv.name, server });
  if (await alreadyWatched(tx, message.id))
    throw conflict("This card already watches a record", "already_watched");

  const now = Date.now();
  let row: WatchedRow | undefined;
  try {
    [row] = await tx
      .insert(watchedRecords)
      .values({
        organizationId: tenantOf(tx).organizationId,
        cardMessageId: message.id,
        conversationId: board.conv.id,
        agentId: body.agentId,
        mcpServerId: server.id,
        externalRef: body.externalRef,
        readTool: body.readTool,
        writeTool: body.writeTool ?? null,
        noteTool: body.noteTool ?? null,
        idArg: body.idArg,
        fields: body.fields,
        checkAsUserId: userId,
        checkIntervalMinutes: body.checkIntervalMinutes,
        nextCheckAt: new Date(now + minutes(body.checkIntervalMinutes)).toISOString(),
        createdBy: userId,
      })
      .returning();
  } catch (err) {
    if (
      (err as { code?: string; cause?: { code?: string } })?.code === "23505" ||
      (err as { cause?: { code?: string } })?.cause?.code === "23505"
    ) {
      throw conflict("This card already watches a record", "already_watched");
    }
    throw err;
  }
  if (!row) throw new Error("watched record insert returned nothing");
  await ctx.core.audit.record(tx, {
    action: "watched_record.linked",
    resourceType: "watched_record",
    resourceId: row.id,
    metadata: {
      conversationId: row.conversationId,
      cardMessageId: row.cardMessageId,
      mcpServerId: row.mcpServerId,
      agentId: row.agentId,
      authMode: server.authMode,
      fieldCount: body.fields.length,
      checkIntervalMinutes: row.checkIntervalMinutes,
    },
  });
  // The first check sets the baseline silently (no change card for the first snapshot).
  await ctx.core.jobs.sendInTx(tx, "watched.check", {
    organizationId: row.organizationId,
    watchedRecordId: row.id,
    source: "schedule",
  });
  await emitUpdated(ctx.core, tx, row);
  return dtoOf(req, tx, ctx, row, board);
}

async function alreadyWatched(tx: Tx, cardMessageId: string): Promise<boolean> {
  const [hit] = await tx
    .select({ id: watchedRecords.id })
    .from(watchedRecords)
    .where(eq(watchedRecords.cardMessageId, cardMessageId))
    .limit(1);
  return hit !== undefined;
}

/** `PATCH /watched-records/:id`: fields, interval, bot or tools, at the version the editor saw. */
export async function updateWatched(
  req: FastifyRequest,
  tx: Tx,
  ctx: WatchedCtx,
  id: string,
  body: UpdateWatchedRecordRequest,
): Promise<WatchedRecord> {
  const { row, board } = await getWatched(req, tx, ctx, id, "write");
  await assertWatch(req, tx, ctx, board.facts);
  if (row.version !== body.expectedVersion) {
    throw new HttpError(
      409,
      "version_conflict",
      "This watch changed since you opened it. Reload and try again.",
      {
        version: row.version,
      },
    );
  }
  if (body.agentId !== undefined && body.agentId !== row.agentId) {
    await assertBot(tx, ctx, { agentId: body.agentId, userId: authOf(req).userId, conv: board.conv });
    await assertBot(tx, ctx, { agentId: body.agentId, userId: row.checkAsUserId, conv: board.conv });
  }
  // The watch's tools as they will be after the edit, for the bot it will have.
  await connectorWithTools(tx, {
    serverId: row.mcpServerId,
    agentId: body.agentId ?? row.agentId,
    readTool: row.readTool,
    otherTools: [
      body.writeTool === undefined ? row.writeTool : body.writeTool,
      body.noteTool === undefined ? row.noteTool : body.noteTool,
    ],
  });

  const changed: string[] = [];
  const set: Partial<typeof watchedRecords.$inferInsert> = {};
  if (body.fields !== undefined) {
    changed.push("fields");
    set.fields = body.fields;
    // New fields are a new baseline, not a change: the next check snapshots them silently.
    set.snapshot = null;
    set.snapshotHash = null;
    set.lastWrittenHash = null;
  }
  if (body.checkIntervalMinutes !== undefined && body.checkIntervalMinutes !== row.checkIntervalMinutes) {
    changed.push("checkIntervalMinutes");
    set.checkIntervalMinutes = body.checkIntervalMinutes;
    set.nextCheckAt = new Date(Date.now() + minutes(body.checkIntervalMinutes)).toISOString();
  }
  if (body.agentId !== undefined && body.agentId !== row.agentId) {
    changed.push("agentId");
    set.agentId = body.agentId;
  }
  if (body.writeTool !== undefined && body.writeTool !== row.writeTool) {
    changed.push("writeTool");
    set.writeTool = body.writeTool;
  }
  if (body.noteTool !== undefined && body.noteTool !== row.noteTool) {
    changed.push("noteTool");
    set.noteTool = body.noteTool;
  }
  const [updated] = await tx
    .update(watchedRecords)
    .set({ ...set, version: row.version + 1, updatedAt: new Date().toISOString() })
    .where(and(eq(watchedRecords.id, row.id), eq(watchedRecords.version, row.version)))
    .returning();
  if (!updated) throw new HttpError(409, "version_conflict", "This watch changed since you opened it.");
  await ctx.core.audit.record(tx, {
    action: "watched_record.updated",
    resourceType: "watched_record",
    resourceId: row.id,
    metadata: {
      conversationId: row.conversationId,
      cardMessageId: row.cardMessageId,
      changed,
      ...(body.fields ? { fieldCount: body.fields.length } : {}),
    },
  });
  if (body.fields !== undefined) {
    await ctx.core.jobs.sendInTx(tx, "watched.check", {
      organizationId: updated.organizationId,
      watchedRecordId: updated.id,
      source: "schedule",
    });
  }
  await emitUpdated(ctx.core, tx, updated);
  return dtoOf(req, tx, ctx, updated, board);
}

/** `DELETE /watched-records/:id`: checks stop; past change cards stay in the thread. */
export async function unlinkWatched(req: FastifyRequest, tx: Tx, ctx: WatchedCtx, id: string): Promise<void> {
  const { row, board } = await getWatched(req, tx, ctx, id, "write");
  await assertWatch(req, tx, ctx, board.facts);
  await tx.delete(watchedRecords).where(eq(watchedRecords.id, row.id));
  await ctx.core.audit.record(tx, {
    action: "watched_record.unlinked",
    resourceType: "watched_record",
    resourceId: row.id,
    metadata: {
      conversationId: row.conversationId,
      cardMessageId: row.cardMessageId,
      mcpServerId: row.mcpServerId,
    },
  });
  await emitUpdated(ctx.core, tx, row);
}

/** The preview's checks (R9): the same rights and audience rule as a link, before the one read. */
export async function previewGuard(
  req: FastifyRequest,
  tx: Tx,
  ctx: WatchedCtx,
  body: { conversationId: string; mcpServerId: string; readTool: string },
): Promise<{ server: ServerRow; conversationId: string }> {
  const board = await boardFor(req, tx, ctx, body.conversationId, "write");
  await assertWatch(req, tx, ctx, board.facts);
  // No bot is chosen yet: the read tool must be granted to some live bot (the cell's `toolFilter.include`).
  const server = await connectorWithTools(tx, {
    serverId: body.mcpServerId,
    agentId: null,
    readTool: body.readTool,
  });
  await assertShared(tx, {
    userId: authOf(req).userId,
    conversationId: board.conv.id,
    channelName: board.conv.name,
    server,
  });
  return { server, conversationId: board.conv.id };
}
