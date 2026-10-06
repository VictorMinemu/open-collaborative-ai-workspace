import {
  EventTypes,
  IdParams,
  MAX_PINS_PER_CONVERSATION,
  Ok,
  PinnedMessageList,
  PinParams,
  type PinUpdatedEvent,
} from "@ocw/contracts";
import { messagePins, messages, type Tx } from "@ocw/db";
import { and, count, desc, eq, inArray, isNull } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { type App, authOf, tenant } from "../../core";
import { conflict, gone, notFound } from "../../lib/errors";
import { channelResource } from "../organization";
import { authorOf, loadDirectory } from "./directory";
import type { ChatRouteCtx } from "./index";
import { convTopic, hydrateViewer, iso, type MessageRow, replyParticipantsFor, toMessage } from "./service";

/**
 * Pins per conversation (CHAT-13): shared by every reader, capped at `MAX_PINS_PER_CONVERSATION`, audited
 * (`message.pinned` / `message.unpinned`, ids only) and live through `pin.updated` on `conv:<id>`. Any member who
 * may post pins; the pinner always unpins; in channels a moderator (`channel.archive`: the owner relation or an
 * admin) unpins anyone's pin; in direct conversations any participant does (no moderation there, D-01).
 */

const CONV_NOT_FOUND = "Conversation not found";
const MSG_NOT_FOUND = "Message not found";

/** The ids among `messageIds` that are pinned in their conversation (page hydration). */
export async function pinnedFor(tx: Tx, messageIds: string[]): Promise<Set<string>> {
  if (messageIds.length === 0) return new Set();
  const rows = await tx
    .select({ id: messagePins.messageId })
    .from(messagePins)
    .where(inArray(messagePins.messageId, messageIds));
  return new Set(rows.map((r) => r.id));
}

export function registerPinRoutes(app: App, ctx: ChatRouteCtx): void {
  const { core, deps, access, perms } = ctx;
  const tags = ["chat"];

  /** A message of `conversationId`, locked; hidden, missing and foreign messages are the same 404. */
  async function messageIn(tx: Tx, conversationId: string, id: string): Promise<MessageRow> {
    const [row] = await tx.select().from(messages).where(eq(messages.id, id)).limit(1).for("update");
    if (!row || row.conversationId !== conversationId) throw notFound(MSG_NOT_FOUND);
    return row;
  }

  async function emit(tx: Tx, conversationId: string, messageId: string, pinned: boolean, by: string) {
    const ev: PinUpdatedEvent = { conversationId, messageId, pinned, by: { kind: "user", id: by } };
    await deps.realtime.appendEvent(tx, convTopic(conversationId), EventTypes.pinUpdated, ev);
    await deps.audit.record(tx, {
      action: pinned ? "message.pinned" : "message.unpinned",
      resourceType: "message",
      resourceId: messageId,
      metadata: { messageId, conversationId },
    });
  }

  /** The conversation the caller reads (hidden = missing = 404), refused when archived (410). */
  async function liveConversation(req: FastifyRequest, tx: Tx, id: string) {
    const r = await access.readable(req, tx, id, { notFoundMessage: CONV_NOT_FOUND });
    if (r.conv.archivedAt) throw gone("This conversation is archived", "channel_archived");
    return r;
  }

  app.get(
    "/conversations/:id/pins",
    {
      config: { authz: "user" },
      preHandler: core.identity.requireUser,
      schema: { tags, params: IdParams, response: { 200: PinnedMessageList } },
    },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        const { conv } = await access.readable(req, tx, req.params.id, { notFoundMessage: CONV_NOT_FOUND });
        const rows = await tx
          .select({ m: messages, pinnedBy: messagePins.pinnedBy, pinnedAt: messagePins.createdAt })
          .from(messagePins)
          .innerJoin(messages, eq(messages.id, messagePins.messageId))
          // Tombstones lose their pins on delete (P-05); the filter keeps any stray row out too.
          .where(and(eq(messagePins.conversationId, conv.id), isNull(messages.deletedAt)))
          .orderBy(desc(messagePins.createdAt), desc(messagePins.messageId));
        const dir = await loadDirectory(tx);
        const roots = rows.filter((r) => !r.m.threadId && r.m.replyCount > 0).map((r) => r.m.id);
        const participants = await replyParticipantsFor(tx, roots, dir);
        const list = await hydrateViewer(
          tx,
          rows.map((r) => toMessage(r.m, dir, r.m.threadId ? undefined : (participants.get(r.m.id) ?? []))),
          authOf(req).userId,
        );
        return {
          pins: rows.map((r, i) => ({
            message: list[i] ?? toMessage(r.m, dir),
            pinnedBy: authorOf(dir, "user", r.pinnedBy),
            pinnedAt: iso(r.pinnedAt),
          })),
        };
      }),
  );

  app.put(
    "/conversations/:id/pins/:messageId",
    {
      config: { authz: "user" },
      preHandler: core.identity.requireUser,
      schema: { tags, params: PinParams, response: { 200: Ok } },
    },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        const me = authOf(req).userId;
        const { conv, facts } = await liveConversation(req, tx, req.params.id);
        await perms.assertCan(req, tx, "channel.post", channelResource(facts));
        const message = await messageIn(tx, conv.id, req.params.messageId);
        if (message.deletedAt) throw conflict("This message was deleted", "message_deleted");
        const [existing] = await tx
          .select({ id: messagePins.messageId })
          .from(messagePins)
          .where(and(eq(messagePins.conversationId, conv.id), eq(messagePins.messageId, message.id)))
          .limit(1);
        if (existing) return { ok: true as const };
        const [n] = await tx
          .select({ n: count() })
          .from(messagePins)
          .where(eq(messagePins.conversationId, conv.id));
        if (Number(n?.n ?? 0) >= MAX_PINS_PER_CONVERSATION) {
          throw conflict(
            `A conversation can have at most ${MAX_PINS_PER_CONVERSATION} pinned messages`,
            "too_many_pins",
          );
        }
        const inserted = await tx
          .insert(messagePins)
          .values({
            organizationId: conv.organizationId,
            conversationId: conv.id,
            messageId: message.id,
            pinnedBy: me,
          })
          .onConflictDoNothing()
          .returning({ id: messagePins.messageId });
        if (inserted.length > 0) await emit(tx, conv.id, message.id, true, me);
        return { ok: true as const };
      }),
  );

  app.delete(
    "/conversations/:id/pins/:messageId",
    {
      config: { authz: "user" },
      preHandler: core.identity.requireUser,
      schema: { tags, params: PinParams, response: { 200: Ok } },
    },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        const me = authOf(req).userId;
        const { conv, facts } = await liveConversation(req, tx, req.params.id);
        const message = await messageIn(tx, conv.id, req.params.messageId);
        const [pinRow] = await tx
          .select({ pinnedBy: messagePins.pinnedBy })
          .from(messagePins)
          .where(and(eq(messagePins.conversationId, conv.id), eq(messagePins.messageId, message.id)))
          .limit(1)
          .for("update");
        if (!pinRow) return { ok: true as const };
        // Someone else's pin in a channel: the resolver decides moderation (owner relation or admin).
        if (pinRow.pinnedBy !== me && conv.kind === "channel") {
          await perms.assertCan(req, tx, "channel.archive", channelResource(facts));
        }
        await tx
          .delete(messagePins)
          .where(and(eq(messagePins.conversationId, conv.id), eq(messagePins.messageId, message.id)));
        await emit(tx, conv.id, message.id, false, me);
        return { ok: true as const };
      }),
  );
}
