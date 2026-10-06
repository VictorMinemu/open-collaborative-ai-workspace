import {
  EditMessageRequest,
  EventTypes,
  IdParams,
  type Mention,
  Message,
  type MessageDeletedEvent,
  Ok,
  type PinUpdatedEvent,
  type ThreadUpdatedEvent,
} from "@ocw/contracts";
import { attachments, messagePins, messageReactions, messages, messageVersions, type Tx } from "@ocw/db";
import { and, count, eq, ne, sql } from "drizzle-orm";
import { type App, authOf, type Core, tenant } from "../../core";
import { conflict, forbidden, gone, notFound } from "../../lib/errors";
import { channelResource, type PermissionService } from "../organization";
import type { ConversationAccess } from "./access";
import { type Directory, loadDirectory } from "./directory";
import { resolveMentions } from "./mentions";
import { type ChatDeps, convTopic, iso, type MessageRow, replyParticipantsFor, toMessage } from "./service";

/**
 * Message actions (CHAT-06, D-01): edit and soft delete with an append-only version history. Every change locks
 * the message row, stores the prior body in `app.message_versions` (UPDATE/DELETE revoked from the app role),
 * appends the realtime event and audits ids plus the version, never a body (T-04-01-03), all in the request
 * transaction. Access is decided by `createConversationAccess` (P-03): hidden and missing are the same 404.
 */

export interface MessageActionsContext {
  core: Core;
  deps: ChatDeps;
  access: ConversationAccess;
  perms: PermissionService;
}

const NOT_FOUND = "Message not found";

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

/**
 * Tombstones a locked message (P-05): version N+1 keeps the old body and mentions, the row keeps its place with
 * an empty body, its reactions and pins go (a removed pin emits `pin.updated`), its attachments are marked
 * deleted, a reply leaves its thread's count, and `message.deleted` plus the `message.deleted` audit (with
 * `moderated`) are written.
 */
export async function deleteMessage(
  tx: Tx,
  deps: ChatDeps,
  input: { message: MessageRow; by: { kind: "user"; id: string }; moderated: boolean },
): Promise<{ version: number }> {
  const { message, by } = input;
  const topic = convTopic(message.conversationId);
  const version = await nextVersion(tx, message.id);
  await tx.insert(messageVersions).values({
    organizationId: message.organizationId,
    messageId: message.id,
    version,
    kind: "delete",
    body: message.body,
    mentions: message.mentions,
    editedByKind: by.kind,
    editedBy: by.id,
  });
  const [row] = await tx
    .update(messages)
    .set({ body: "", mentions: [], deletedAt: sql`now()`, deletedBy: by.id })
    .where(eq(messages.id, message.id))
    .returning();
  if (!row?.deletedAt) throw new Error("message delete returned no row");

  await tx.delete(messageReactions).where(eq(messageReactions.messageId, message.id));
  const unpinned = await tx
    .delete(messagePins)
    .where(eq(messagePins.messageId, message.id))
    .returning({ conversationId: messagePins.conversationId });
  for (const pin of unpinned) {
    const ev: PinUpdatedEvent = {
      conversationId: pin.conversationId,
      messageId: message.id,
      pinned: false,
      by: { kind: by.kind, id: by.id },
    };
    await deps.realtime.appendEvent(tx, topic, EventTypes.pinUpdated, ev);
  }
  await tx
    .update(attachments)
    .set({ status: "deleted", deletedAt: sql`now()` })
    .where(and(eq(attachments.messageId, message.id), ne(attachments.status, "deleted")));

  const deleted: MessageDeletedEvent = {
    messageId: row.id,
    conversationId: row.conversationId,
    threadId: row.threadId,
    deletedAt: iso(row.deletedAt),
    replyCount: row.replyCount,
  };
  await deps.realtime.appendEvent(tx, topic, EventTypes.messageDeleted, deleted);

  // A deleted reply no longer counts in its thread (the root shows what is left to read).
  if (row.threadId) {
    const [root] = await tx
      .update(messages)
      .set({ replyCount: sql`greatest(${messages.replyCount} - 1, 0)` })
      .where(eq(messages.id, row.threadId))
      .returning();
    if (root) {
      const dir = await loadDirectory(tx);
      const ev: ThreadUpdatedEvent = {
        rootId: root.id,
        replyCount: root.replyCount,
        lastReplyAt: root.lastReplyAt === null ? null : iso(root.lastReplyAt),
        replyParticipants: (await replyParticipantsFor(tx, [root.id], dir)).get(root.id) ?? [],
      };
      await deps.realtime.appendEvent(tx, topic, EventTypes.threadUpdated, ev);
    }
  }

  await deps.audit.record(tx, {
    action: "message.deleted",
    resourceType: "message",
    resourceId: row.id,
    metadata: { messageId: row.id, conversationId: row.conversationId, version, moderated: input.moderated },
  });
  return { version };
}

export function registerMessageActionRoutes(app: App, ctx: MessageActionsContext): void {
  const { core, deps, access, perms } = ctx;
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
        const { conv } = await access.readable(req, tx, message.conversationId, {
          notFoundMessage: NOT_FOUND,
        });
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

  app.delete(
    "/messages/:id",
    {
      config: { authz: "user" },
      preHandler: core.identity.requireUser,
      schema: { tags, params: IdParams, response: { 200: Ok } },
    },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        const auth = authOf(req);
        const message = await lockMessage(tx, req.params.id);
        // Readable first: an admin never learns about (or moderates) a conversation hidden from them (D-01).
        const { conv, facts } = await access.readable(req, tx, message.conversationId, {
          notFoundMessage: NOT_FOUND,
        });
        if (conv.archivedAt) throw gone("This conversation is archived", "channel_archived");
        if (message.deletedAt) throw conflict("This message was already deleted", "message_deleted");
        const own = message.authorKind === "user" && message.authorId === auth.userId;
        // Someone else's message: the resolver decides moderation (admins; never in a DM, policy precondition).
        if (!own) await perms.assertCan(req, tx, "message.delete_any", channelResource(facts));
        await deleteMessage(tx, deps, { message, by: { kind: "user", id: auth.userId }, moderated: !own });
        return { ok: true as const };
      }),
  );
}
