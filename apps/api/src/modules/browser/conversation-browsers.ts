import { type ConversationBrowserItem, ConversationBrowserList, IdParams } from "@ocw/contracts";
import { browserContexts, conversations } from "@ocw/db";
import { and, desc, eq, inArray, isNull, or } from "drizzle-orm";
import { type App, authOf, type Core, tenant } from "../../core";
import { type ConversationAccess, loadDirectory } from "../chat";
import { browserContextResource, type PermissionService } from "../organization";

/**
 * `GET /api/v1/conversations/:id/browsers` (07.8-26; D-06, BRW-02, UI-SPEC Surface 1b): the bots' open pages in a
 * conversation and in its threads that the caller may watch, for the conversation header's live chip.
 *
 * - The conversation must be readable by the caller (`channel.read`, hidden = 404, the same as missing), so another
 *   organization's id or a conversation the caller does not read never answers, not even with an empty list.
 * - Each page is decided by the resolver's `browser.watch`, exactly as the live view decides it (the caller reads the
 *   conversation; owner and requester facts; a member's sealed session keeps the page theirs, D-12 U-2).
 * - The host and the bot only: never a path, an activity or who is in control (the live view tells a watcher that).
 */

const tags = ["browser"];
const MAX = 50;
const READABLE = ["channel", "dm", "group", "ai_chat"] as const;

export function registerConversationBrowsers(
  app: App,
  deps: { core: Core; perms: PermissionService; access: ConversationAccess },
): void {
  const { core, perms, access } = deps;
  const user = { config: { authz: "user" as const }, preHandler: [core.identity.requireUser] };

  app.get(
    "/conversations/:id/browsers",
    { ...user, schema: { tags, params: IdParams, response: { 200: ConversationBrowserList } } },
    async (req, reply) => {
      reply.header("cache-control", "no-store");
      const viewerId = authOf(req).userId;
      return core.db.withTenant(tenant(req), async (tx) => {
        const { conv } = await access.readable(req, tx, req.params.id, { kinds: READABLE });
        const threads = await tx
          .select({ id: conversations.id, rootMessageId: conversations.rootMessageId })
          .from(conversations)
          .where(and(eq(conversations.kind, "thread"), eq(conversations.parentConversationId, conv.id)));
        const rootOf = new Map(threads.map((t) => [t.id, t.rootMessageId]));
        const pages = await tx
          .select()
          .from(browserContexts)
          .where(
            and(
              isNull(browserContexts.closedAt),
              threads.length > 0
                ? or(
                    eq(browserContexts.conversationId, conv.id),
                    inArray(
                      browserContexts.conversationId,
                      threads.map((t) => t.id),
                    ),
                  )
                : eq(browserContexts.conversationId, conv.id),
            ),
          )
          .orderBy(desc(browserContexts.openedAt))
          .limit(MAX);
        if (pages.length === 0) return { items: [] };
        const dir = await loadDirectory(tx);
        const principal = { kind: "user" as const, userId: viewerId };
        const items: ConversationBrowserItem[] = [];
        for (const page of pages) {
          const bot = dir.agents.get(page.agentId);
          if (!bot || bot.deleted) continue;
          const resource = browserContextResource({
            // The caller reads the conversation (decided above); a thread is read through it.
            reader: true,
            botOwner: bot.ownerUserId === viewerId,
            requester: page.requestedForUserId === viewerId,
            memberSession: page.sessionId !== null,
          });
          const watch = await perms.decide(tx, principal, "browser.watch", resource);
          if (!watch.allowed) continue;
          items.push({
            contextId: page.id,
            host: page.host,
            secure: page.secure,
            bot: {
              id: bot.id,
              displayName: bot.displayName.slice(0, 200),
              avatarUrl: bot.avatarUrl ?? null,
            },
            // A page opened in a thread keeps the channel's id and its thread's root (and a thread conversation of the
            // channel, should a turn ever carry one, names its root).
            threadRootId:
              page.threadRootMessageId ??
              (page.conversationId === conv.id ? null : (rootOf.get(page.conversationId) ?? null)),
          });
        }
        return { items };
      });
    },
  );
}
