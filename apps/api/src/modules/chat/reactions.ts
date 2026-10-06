import {
  EventTypes,
  MAX_REACTIONS_PER_MESSAGE,
  Ok,
  ReactionParams,
  type ReactionSummary,
  type ReactionUpdatedEvent,
} from "@ocw/contracts";
import { messageReactions, messages, type Tx } from "@ocw/db";
import { and, asc, countDistinct, eq, inArray } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { type App, authOf, tenant } from "../../core";
import { conflict, gone, notFound } from "../../lib/errors";
import { channelResource } from "../organization";
import type { ChatRouteCtx } from "./index";
import { convTopic, type MessageRow } from "./service";

/**
 * Emoji reactions (CHAT-07). One row per (message, emoji, member); toggled with PUT/DELETE on the emoji path
 * segment (Fastify decodes the percent-encoding, the `Emoji` contract refuses anything that is not one emoji).
 * Every real change appends `reaction.updated` with the absolute count on `conv:<id>` (P-04: no viewer field);
 * pages hydrate `reactions` with `mine` per viewer through `reactionsFor`.
 */

const NOT_FOUND = "Message not found";
/** First reactors carried by a summary or an event (names resolve from the directory on the client). */
const MEMBERS_SHOWN = 20;

type MemberRef = ReactionSummary["members"][number];

/**
 * Reactions of `messageIds` as `viewerId` sees them: per message, emoji ordered by their first reaction, each with
 * its count, `mine`, and the first 20 reactors.
 */
export async function reactionsFor(
  tx: Tx,
  messageIds: string[],
  viewerId: string,
): Promise<Map<string, ReactionSummary[]>> {
  const out = new Map<string, ReactionSummary[]>();
  if (messageIds.length === 0) return out;
  const rows = await tx
    .select({
      messageId: messageReactions.messageId,
      emoji: messageReactions.emoji,
      memberKind: messageReactions.memberKind,
      memberId: messageReactions.memberId,
    })
    .from(messageReactions)
    .where(inArray(messageReactions.messageId, messageIds))
    .orderBy(asc(messageReactions.createdAt), asc(messageReactions.memberId));
  const byMessage = new Map<string, Map<string, ReactionSummary>>();
  for (const r of rows) {
    let emojis = byMessage.get(r.messageId);
    if (!emojis) {
      emojis = new Map();
      byMessage.set(r.messageId, emojis);
    }
    let s = emojis.get(r.emoji);
    if (!s) {
      s = { emoji: r.emoji, count: 0, mine: false, members: [] };
      emojis.set(r.emoji, s);
    }
    s.count += 1;
    if (r.memberKind === "user" && r.memberId === viewerId) s.mine = true;
    if (s.members.length < MEMBERS_SHOWN) s.members.push({ kind: r.memberKind, id: r.memberId });
  }
  for (const [id, emojis] of byMessage) out.set(id, [...emojis.values()]);
  return out;
}

/** Count and first reactors of one emoji on one message (the event's absolute state). */
async function emojiState(tx: Tx, messageId: string, emoji: string) {
  const rows = await tx
    .select({ kind: messageReactions.memberKind, id: messageReactions.memberId })
    .from(messageReactions)
    .where(and(eq(messageReactions.messageId, messageId), eq(messageReactions.emoji, emoji)))
    .orderBy(asc(messageReactions.createdAt), asc(messageReactions.memberId));
  const members: MemberRef[] = rows.slice(0, MEMBERS_SHOWN).map((r) => ({ kind: r.kind, id: r.id }));
  return { count: rows.length, members };
}

export function registerReactionRoutes(app: App, ctx: ChatRouteCtx): void {
  const { core, deps, access, perms } = ctx;
  const tags = ["chat"];

  /**
   * The message, locked for the rest of the transaction, once the caller may react to it: readable (hidden =
   * missing = 404), not archived (410), `channel.post` decided by the resolver (member, not archived), not a
   * tombstone (409).
   */
  async function reactable(req: FastifyRequest, tx: Tx, id: string): Promise<MessageRow> {
    const [message] = await tx.select().from(messages).where(eq(messages.id, id)).limit(1).for("update");
    if (!message) throw notFound(NOT_FOUND);
    const { conv, facts } = await access.readable(req, tx, message.conversationId, {
      notFoundMessage: NOT_FOUND,
    });
    if (conv.archivedAt) throw gone("This conversation is archived", "channel_archived");
    await perms.assertCan(req, tx, "channel.post", channelResource(facts));
    if (message.deletedAt) throw conflict("This message was deleted", "message_deleted");
    return message;
  }

  async function emit(tx: Tx, message: MessageRow, emoji: string, actorId: string, added: boolean) {
    const ev: ReactionUpdatedEvent = {
      messageId: message.id,
      conversationId: message.conversationId,
      threadId: message.threadId,
      emoji,
      ...(await emojiState(tx, message.id, emoji)),
      actor: { kind: "user", id: actorId },
      added,
    };
    await deps.realtime.appendEvent(tx, convTopic(message.conversationId), EventTypes.reactionUpdated, ev);
  }

  app.put(
    "/messages/:id/reactions/:emoji",
    {
      config: { authz: "user" },
      preHandler: core.identity.requireUser,
      schema: { tags, params: ReactionParams, response: { 200: Ok } },
    },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        const me = authOf(req).userId;
        const { emoji } = req.params;
        const message = await reactable(req, tx, req.params.id);
        const [existing] = await tx
          .select({ emoji: messageReactions.emoji })
          .from(messageReactions)
          .where(and(eq(messageReactions.messageId, message.id), eq(messageReactions.emoji, emoji)))
          .limit(1);
        if (!existing) {
          // A new distinct emoji on this message: the cap applies (the row lock above serialises writers).
          const [d] = await tx
            .select({ n: countDistinct(messageReactions.emoji) })
            .from(messageReactions)
            .where(eq(messageReactions.messageId, message.id));
          if (Number(d?.n ?? 0) >= MAX_REACTIONS_PER_MESSAGE) {
            throw conflict(
              `A message can have at most ${MAX_REACTIONS_PER_MESSAGE} different reactions`,
              "too_many_reactions",
            );
          }
        }
        const inserted = await tx
          .insert(messageReactions)
          .values({
            organizationId: message.organizationId,
            messageId: message.id,
            conversationId: message.conversationId,
            emoji,
            memberKind: "user",
            memberId: me,
          })
          .onConflictDoNothing()
          .returning({ emoji: messageReactions.emoji });
        if (inserted.length > 0) await emit(tx, message, emoji, me, true);
        return { ok: true as const };
      }),
  );

  app.delete(
    "/messages/:id/reactions/:emoji",
    {
      config: { authz: "user" },
      preHandler: core.identity.requireUser,
      schema: { tags, params: ReactionParams, response: { 200: Ok } },
    },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        const me = authOf(req).userId;
        const { emoji } = req.params;
        const message = await reactable(req, tx, req.params.id);
        const removed = await tx
          .delete(messageReactions)
          .where(
            and(
              eq(messageReactions.messageId, message.id),
              eq(messageReactions.emoji, emoji),
              eq(messageReactions.memberKind, "user"),
              eq(messageReactions.memberId, me),
            ),
          )
          .returning({ emoji: messageReactions.emoji });
        if (removed.length > 0) await emit(tx, message, emoji, me, false);
        return { ok: true as const };
      }),
  );
}
