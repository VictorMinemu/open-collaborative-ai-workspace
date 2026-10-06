import { EditMessageRequest, EventTypes, IdParams, type Mention, Message } from "@ocw/contracts";
import { messages, messageVersions, type Tx } from "@ocw/db";
import { count, eq, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { type App, authOf, type Core, tenant } from "../../core";
import { conflict, forbidden, gone, notFound } from "../../lib/errors";
import type { ChannelFacts, PermissionService } from "../organization";
import { type Directory, loadDirectory } from "./directory";
import { resolveMentions } from "./mentions";
import {
  type ChatDeps,
  type ConversationRow,
  convTopic,
  type MessageRow,
  replyParticipantsFor,
  toMessage,
} from "./service";

/**
 * Message actions (CHAT-06, D-01): edit with an append-only version history. Every change locks the message row,
 * stores the prior body in `app.message_versions` (UPDATE/DELETE revoked from the app role), appends the
 * realtime event and audits ids plus the version, never a body (T-04-01-03), all in the request transaction.
 */

/** Resolves the conversation of a message for the caller: hidden and missing are the same 404 (P-03). */
export type ReadableConversation = (
  req: FastifyRequest,
  tx: Tx,
  conversationId: string,
) => Promise<{ conv: ConversationRow; facts: ChannelFacts }>;

export interface MessageActionsContext {
  core: Core;
  deps: ChatDeps;
  perms: PermissionService;
  readable: ReadableConversation;
}

/** The message row, locked for the rest of the transaction; 404 when it does not exist in the tenant. */
async function lockMessage(tx: Tx, id: string): Promise<MessageRow> {
  const [row] = await tx.select().from(messages).where(eq(messages.id, id)).limit(1).for("update");
  if (!row) throw notFound("Message not found");
  return row;
}

async function nextVersion(tx: Tx, messageId: string): Promise<number> {
  const [row] = await tx
    .select({ n: count() })
    .from(messageVersions)
    .where(eq(messageVersions.messageId, messageId));
  return Number(row?.n ?? 0) + 1;
}

/** The DTO of a message as the API returns it (thread roots carry their reply participants). */
async function dtoOf(tx: Tx, row: MessageRow, dir: Directory): Promise<Message> {
  if (row.threadId || row.replyCount === 0) return toMessage(row, dir, row.threadId ? undefined : []);
  const participants = (await replyParticipantsFor(tx, [row.id], dir)).get(row.id) ?? [];
  return toMessage(row, dir, participants);
}

/**
 * Replaces the body of a locked message: version N+1 keeps the old body and mentions, mentions are re-resolved
 * from the new body, `message.updated` goes to `conv:<id>` without viewer fields (P-04) and `message.edited` is
 * audited. Never notifies a bot (Pitfall 8). `previousMentions` lets notifications target only new mentions.
 */
export async function editMessage(
  tx: Tx,
  deps: ChatDeps,
  dir: Directory,
  input: { message: MessageRow; body: string; editor: { kind: "user"; id: string } },
): Promise<{ row: MessageRow; version: number; previousMentions: Mention[] }> {
  const { message } = input;
  const version = await nextVersion(tx, message.id);
  await tx.insert(messageVersions).values({
    organizationId: message.organizationId,
    messageId: message.id,
    version,
    kind: "edit",
    body: message.body,
    mentions: message.mentions,
    editedByKind: input.editor.kind,
    editedBy: input.editor.id,
  });
  const [row] = await tx
    .update(messages)
    .set({ body: input.body, mentions: resolveMentions(input.body, dir), editedAt: sql`now()` })
    .where(eq(messages.id, message.id))
    .returning();
  if (!row) throw new Error("message update returned no row");
  await deps.realtime.appendEvent(tx, convTopic(row.conversationId), EventTypes.messageUpdated, {
    message: await dtoOf(tx, row, dir),
  });
  await deps.audit.record(tx, {
    action: "message.edited",
    resourceType: "message",
    resourceId: row.id,
    metadata: { messageId: row.id, conversationId: row.conversationId, version },
  });
  return { row, version, previousMentions: message.mentions };
}

export function registerMessageActionRoutes(app: App, ctx: MessageActionsContext): void {
  const { core, deps } = ctx;
  const tags = ["chat"];

  app.patch(
    "/messages/:id",
    {
      config: { authz: "user" },
      preHandler: core.identity.requireUser,
      schema: { tags, params: IdParams, body: EditMessageRequest, response: { 200: Message } },
    },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        const auth = authOf(req);
        const message = await lockMessage(tx, req.params.id);
        const { conv } = await ctx.readable(req, tx, message.conversationId);
        if (conv.archivedAt) throw gone("This conversation is archived", "channel_archived");
        // Only the author edits, in every conversation kind; an admin never edits someone else's words (D-01).
        if (message.authorKind !== "user" || message.authorId !== auth.userId) {
          throw forbidden("Only the author can edit this message", "not_author");
        }
        if (message.deletedAt) throw conflict("This message was deleted", "message_deleted");
        const dir = await loadDirectory(tx);
        if (req.body.body === message.body) return dtoOf(tx, message, dir);
        const { row } = await editMessage(tx, deps, dir, {
          message,
          body: req.body.body,
          editor: { kind: "user", id: auth.userId },
        });
        return dtoOf(tx, row, dir);
      }),
  );
}
