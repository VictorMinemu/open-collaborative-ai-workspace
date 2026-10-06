import { conversationMembers, conversations, type Tx } from "@ocw/db";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import type { Core } from "../../core";
import { notFound } from "../../lib/errors";
import {
  AuthzDeniedError,
  type ChannelFacts,
  channelResource,
  createPermissionService,
} from "../organization";
import { type ConversationRow, channelFacts, getConversation } from "./service";

/**
 * The readable set (P-03): the ONLY place any module decides which conversations a user may read. The permission
 * resolver decides `channel.read` for every id (hidden = missing = 404); SQL may narrow the candidates (a DM is
 * only a candidate for its members) but never decides on its own. Lists (search, inbox, mentions, saves, pins,
 * threads, unread) pass `readableIds` to their queries; event-time decisions use `isReadable`.
 */

export type ReadableKind = "channel" | "dm" | "group";
const ALL_KINDS: readonly ReadableKind[] = ["channel", "dm", "group"];

export interface ConversationAccess {
  /** The conversation and the caller's facts when channel.read is allowed; 404 otherwise (hidden = missing). */
  readable(
    req: FastifyRequest,
    tx: Tx,
    conversationId: string,
    opts?: { kinds?: readonly ReadableKind[]; notFoundMessage?: string },
  ): Promise<{ conv: ConversationRow; facts: ChannelFacts }>;
  /** `readable` for a row the caller already loaded (null = missing). */
  readableRow(
    req: FastifyRequest,
    tx: Tx,
    conv: ConversationRow | null,
    notFoundMessage?: string,
  ): Promise<{ conv: ConversationRow; facts: ChannelFacts }>;
  /** Resolver-filtered ids of conversations `userId` can read: channels (public + member private), DMs and groups. */
  readableIds(
    tx: Tx,
    userId: string,
    opts?: { includeArchived?: boolean; kinds?: readonly ReadableKind[] },
  ): Promise<string[]>;
  /**
   * Boolean form for event-time decisions (notifications, WS). The plan named it "can-read"; that identifier
   * belongs to a deleted pre-resolver helper and the static guard (guard.test.ts) refuses it.
   */
  isReadable(tx: Tx, userId: string, conversationId: string): Promise<boolean>;
}

export function createConversationAccess(core: Core): ConversationAccess {
  const perms = createPermissionService(core);

  const access: ConversationAccess = {
    async readableRow(req, tx, conv, notFoundMessage = "Conversation not found") {
      if (!conv) throw notFound(notFoundMessage);
      const userId = req.auth?.userId;
      if (!userId) throw notFound(notFoundMessage);
      const facts = await channelFacts(tx, conv, { kind: "user", id: userId });
      try {
        await perms.assertCan(req, tx, "channel.read", channelResource(facts), { hideAs404: true });
      } catch (err) {
        // Hidden must read exactly like missing (same status, code and message), or the message itself would
        // tell a permalink holder that the conversation exists.
        if (err instanceof AuthzDeniedError && err.hidden) {
          throw new AuthzDeniedError(err.denial, { hideAs404: true, message: notFoundMessage });
        }
        throw err;
      }
      return { conv, facts };
    },

    async readable(req, tx, conversationId, opts = {}) {
      const conv = await getConversation(tx, conversationId, opts.kinds ?? ALL_KINDS);
      return access.readableRow(req, tx, conv, opts.notFoundMessage);
    },

    async readableIds(tx, userId, opts = {}) {
      const kinds = opts.kinds ?? ALL_KINDS;
      const me = conversationMembers;
      const rows = await tx
        .select({
          id: conversations.id,
          kind: conversations.kind,
          visibility: conversations.visibility,
          archivedAt: conversations.archivedAt,
          role: me.role,
        })
        .from(conversations)
        .leftJoin(
          me,
          and(eq(me.conversationId, conversations.id), eq(me.memberKind, "user"), eq(me.memberId, userId)),
        )
        .where(
          and(
            inArray(conversations.kind, [...kinds]),
            opts.includeArchived ? undefined : isNull(conversations.archivedAt),
            // Narrowing only: a direct conversation is a candidate for its members alone.
            or(eq(conversations.kind, "channel"), eq(me.memberId, userId)),
          ),
        );
      const allowed = await perms.filterFor(tx, { kind: "user", userId }, rows, "channel.read", (r) =>
        channelResource({
          visibility: r.visibility,
          archived: r.archivedAt !== null,
          viewerRole: r.role ?? null,
          kind: r.kind === "channel" ? "channel" : "dm",
        }),
      );
      return allowed.map((r) => r.id);
    },

    async isReadable(tx, userId, conversationId) {
      const conv = await getConversation(tx, conversationId, ALL_KINDS);
      if (!conv) return false;
      const facts = await channelFacts(tx, conv, { kind: "user", id: userId });
      const d = await perms.decide(tx, { kind: "user", userId }, "channel.read", channelResource(facts));
      return d.allowed;
    },
  };
  return access;
}
