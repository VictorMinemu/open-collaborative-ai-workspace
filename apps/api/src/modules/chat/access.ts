import { conversationMembers, conversations, orgUnits, type Tx } from "@ocw/db";
import { and, eq, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import type { Core } from "../../core";
import { notFound } from "../../lib/errors";
import {
  AuthzDeniedError,
  type ChannelFacts,
  channelResource,
  createPermissionService,
  orgResource,
} from "../organization";
import { type AiAccess, aiAccessSql, type ConversationRow, channelFacts, getConversation } from "./service";

/**
 * The readable set (P-03): the ONLY place any module decides which conversations a user may read. The permission
 * resolver decides `channel.read` for every id (hidden = missing = 404); SQL may narrow the candidates (a DM is
 * only a candidate for its members) but never decides on its own. Lists (search, inbox, mentions, saves, pins,
 * threads, unread) pass `readableIds` to their queries; event-time decisions use `isReadable`.
 *
 * AI chats additionally need `ai_chat.read` at organization scope (ADR-0024): the AI chats module turned off by a
 * catalog deny rule hides every AI chat, owned or shared, on every path at once (routes, search, inbox,
 * notifications, the `conv:` topic). A plain `ai_chat.use` deny keeps reads (research Gap 1).
 */

/**
 * `ai_chat` (P-03) is readable only by callers that ask for it (the ai-chat module, the `conv:` topic, search and
 * attachments later): the default set stays channel/dm/group, so sidebars, unread, inbox, threads and saves never
 * see an AI chat.
 */
export type ReadableKind = "channel" | "dm" | "group" | "ai_chat";
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
   * The caller's own AI chat by the chat's own access alone (`channel.read` as its owner), WITHOUT the AI chats module
   * gate (`ai_chat.read`, ADR-0024). Withdrawal only (revoking her own share links), so a member can always stop
   * sharing; never use it to return chat content. 404 (hidden = missing) otherwise.
   */
  ownedAiChat(
    req: FastifyRequest,
    tx: Tx,
    conversationId: string,
    notFoundMessage?: string,
  ): Promise<{ conv: ConversationRow; facts: ChannelFacts }>;
  /**
   * Whether `userId` still holds the conversation's own access (`channel.read`: owner, grant or membership), without
   * module gates. Participation bookkeeping only (an AI chat's roster follows its grants, ADR-0024); never a read.
   */
  holdsOwnAccess(
    tx: Tx,
    userId: string,
    conversationId: string,
    opts?: { kinds?: readonly ReadableKind[] },
  ): Promise<boolean>;
  /**
   * Boolean form for event-time decisions (notifications, WS). The plan named it "can-read"; that identifier
   * belongs to a deleted pre-resolver helper and the static guard (guard.test.ts) refuses it.
   */
  isReadable(
    tx: Tx,
    userId: string,
    conversationId: string,
    opts?: { kinds?: readonly ReadableKind[] },
  ): Promise<boolean>;
}

/** Hidden must read exactly like missing (same status, code and message). */
function asMissing(err: unknown, notFoundMessage: string): unknown {
  return err instanceof AuthzDeniedError && err.hidden
    ? new AuthzDeniedError(err.denial, { hideAs404: true, message: notFoundMessage })
    : err;
}

export function createConversationAccess(core: Core): ConversationAccess {
  const perms = createPermissionService(core);

  /** The conversation and `userId`'s decision on its own access (`channel.read`), module gates aside. */
  async function ownAccess(tx: Tx, userId: string, conversationId: string, kinds: readonly ReadableKind[]) {
    const conv = await getConversation(tx, conversationId, kinds);
    if (!conv) return null;
    const facts = await channelFacts(tx, conv, { kind: "user", id: userId });
    const d = await perms.decide(tx, { kind: "user", userId }, "channel.read", channelResource(facts));
    return { conv, allowed: d.allowed };
  }

  const access: ConversationAccess = {
    async readableRow(req, tx, conv, notFoundMessage = "Conversation not found") {
      if (!conv) throw notFound(notFoundMessage);
      const userId = req.auth?.userId;
      if (!userId) throw notFound(notFoundMessage);
      const facts = await channelFacts(tx, conv, { kind: "user", id: userId });
      try {
        await perms.assertCan(req, tx, "channel.read", channelResource(facts), { hideAs404: true });
        // ADR-0024: the AI chats module (`ai_chat.read`) decides on top of the chat's own access.
        if (conv.kind === "ai_chat") {
          await perms.assertCan(req, tx, "ai_chat.read", orgResource(), { hideAs404: true });
        }
      } catch (err) {
        // Hidden must read exactly like missing, or the message itself would tell a permalink holder that the
        // conversation exists.
        throw asMissing(err, notFoundMessage);
      }
      return { conv, facts };
    },

    async ownedAiChat(req, tx, conversationId, notFoundMessage = "Conversation not found") {
      const conv = await getConversation(tx, conversationId, ["ai_chat"]);
      const userId = req.auth?.userId;
      if (!conv || !userId) throw notFound(notFoundMessage);
      const facts = await channelFacts(tx, conv, { kind: "user", id: userId });
      try {
        await perms.assertCan(req, tx, "channel.read", channelResource(facts), { hideAs404: true });
      } catch (err) {
        throw asMissing(err, notFoundMessage);
      }
      // A grantee reads the chat too; only its owner withdraws what was shared from it.
      if (facts.aiAccess !== "owner") throw notFound(notFoundMessage);
      return { conv, facts };
    },

    async readable(req, tx, conversationId, opts = {}) {
      const conv = await getConversation(tx, conversationId, opts.kinds ?? ALL_KINDS);
      return access.readableRow(req, tx, conv, opts.notFoundMessage);
    },

    async readableIds(tx, userId, opts = {}) {
      let kinds = opts.kinds ?? ALL_KINDS;
      // ADR-0024: one organization-scope decision; without `ai_chat.read` no AI chat is a candidate at all.
      if (kinds.includes("ai_chat")) {
        const d = await perms.decide(tx, { kind: "user", userId }, "ai_chat.read", orgResource());
        if (!d.allowed) kinds = kinds.filter((k) => k !== "ai_chat");
      }
      if (kinds.length === 0) return [];
      const me = conversationMembers;
      // P-03: an AI chat's candidates come from its owner and active grants, never from membership rows.
      const aiAccess = sql<AiAccess>`case when ${conversations.kind} = 'ai_chat' then ${aiAccessSql(
        userId,
        conversations.id,
      )} end`;
      const rows = await tx
        .select({
          id: conversations.id,
          kind: conversations.kind,
          visibility: conversations.visibility,
          archivedAt: conversations.archivedAt,
          role: me.role,
          unitPath: orgUnits.path,
          aiAccess,
        })
        .from(conversations)
        .leftJoin(
          me,
          and(eq(me.conversationId, conversations.id), eq(me.memberKind, "user"), eq(me.memberId, userId)),
        )
        .leftJoin(orgUnits, eq(orgUnits.id, conversations.unitId))
        .where(
          and(
            inArray(conversations.kind, [...kinds]),
            opts.includeArchived ? undefined : isNull(conversations.archivedAt),
            // Narrowing only: a direct conversation is a candidate for its members alone; an AI chat for its owner
            // and grantees alone (P-03).
            or(
              eq(conversations.kind, "channel"),
              and(ne(conversations.kind, "ai_chat"), eq(me.memberId, userId)),
              and(eq(conversations.kind, "ai_chat"), isNotNull(aiAccess)),
            ),
          ),
        );
      const allowed = await perms.filterFor(tx, { kind: "user", userId }, rows, "channel.read", (r) =>
        channelResource({
          visibility: r.visibility,
          archived: r.archivedAt !== null,
          viewerRole: r.role ?? null,
          kind: r.kind === "group" || r.kind === "channel" || r.kind === "ai_chat" ? r.kind : "dm",
          ...(r.kind === "ai_chat" ? { aiAccess: r.aiAccess ?? null } : {}),
          // Unit-scoped rules apply to the unit's channels (CHAT-02, principle 6).
          unitPath: r.kind === "channel" ? (r.unitPath ?? []) : [],
        }),
      );
      return allowed.map((r) => r.id);
    },

    async holdsOwnAccess(tx, userId, conversationId, opts = {}) {
      return (await ownAccess(tx, userId, conversationId, opts.kinds ?? ALL_KINDS))?.allowed ?? false;
    },

    async isReadable(tx, userId, conversationId, opts = {}) {
      const own = await ownAccess(tx, userId, conversationId, opts.kinds ?? ALL_KINDS);
      if (!own?.allowed) return false;
      if (own.conv.kind !== "ai_chat") return true;
      return (await perms.decide(tx, { kind: "user", userId }, "ai_chat.read", orgResource())).allowed;
    },
  };
  return access;
}
