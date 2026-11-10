import {
  EventTypes,
  MarkNotificationsReadRequest,
  type Notification,
  NotificationList,
  NotificationListQuery,
  type NotificationReadEvent,
  Ok,
} from "@ocw/contracts";
import { messages, notifications } from "@ocw/db";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { markDecided } from "../../authz";
import { type App, authOf, type Core, tenant } from "../../core";
import { badRequest } from "../../lib/errors";
import { authorOf, type ConversationAccess, conversationRefs, loadDirectory } from "../chat";
import { iso, NOTIFIABLE_KINDS, unreadCountFor, visible } from "./service";
import { snippetOf } from "./snippet";
import { teamMentionUnits } from "./team-mentions";

/**
 * The inbox (CHAT-08, Pitfall 9, P-03, P-05): a member's own notifications, only from conversations the resolver
 * lets them read NOW (`readableIds`), only for messages that still exist (tombstones drop out), with the snippet
 * computed from the current body. Mark-read touches the caller's rows only (T-04-09-05).
 */

/** Opaque keyset cursor over (created at with microseconds, id), newest first. */
const Cursor = z.object({
  t: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/),
  id: z.uuid(),
});
const encodeCursor = (c: z.infer<typeof Cursor>) => Buffer.from(JSON.stringify(c)).toString("base64url");
function decodeCursor(raw: string): z.infer<typeof Cursor> {
  try {
    return Cursor.parse(JSON.parse(Buffer.from(raw, "base64url").toString("utf8")));
  } catch {
    throw badRequest("Invalid cursor", "invalid_cursor");
  }
}

export function registerNotificationRoutes(app: App, ctx: { core: Core; access: ConversationAccess }): void {
  const { core, access } = ctx;
  const tags = ["notifications"];

  app.get(
    "/notifications",
    {
      config: { authz: "user" },
      preHandler: core.identity.requireUser,
      schema: { tags, querystring: NotificationListQuery, response: { 200: NotificationList } },
    },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        const me = authOf(req).userId;
        const { filter, limit } = req.query;
        const after = req.query.cursor ? decodeCursor(req.query.cursor) : null;
        // P-03: the resolver decides every readable conversation; the query only narrows to the caller's rows. AI chats
        // count (06-08): their notifications show only while the chat is readable now (a revoke drops them).
        const readableIds = await access.readableIds(tx, me, { kinds: NOTIFIABLE_KINDS });
        markDecided(req);
        if (readableIds.length === 0) return { items: [], nextCursor: null, unreadCount: 0 };
        const rows = await tx
          .select({
            n: notifications,
            body: messages.body,
            key: sql<string>`to_char(${notifications.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
          })
          .from(notifications)
          .innerJoin(messages, eq(messages.id, notifications.messageId))
          .where(
            and(
              visible(me, readableIds, filter),
              after
                ? sql`(${notifications.createdAt}, ${notifications.id}) < (${after.t}::timestamptz, ${after.id}::uuid)`
                : undefined,
            ),
          )
          .orderBy(desc(notifications.createdAt), desc(notifications.id))
          .limit(limit + 1);
        const page = rows.slice(0, limit);
        const last = page.at(-1);
        const dir = await loadDirectory(tx);
        const refs = await conversationRefs(tx, [...new Set(page.map((r) => r.n.conversationId))], me, dir);
        // 07.17 (PD-14): a team mention shows the unit that reached the reader, read now (null once it is gone).
        const units = await teamMentionUnits(
          tx,
          page.filter((r) => r.n.kind === "team_mention").map((r) => r.n.unitId),
        );
        const items: Notification[] = page.flatMap((r) => {
          const conversation = refs.get(r.n.conversationId);
          if (!conversation) return [];
          return [
            {
              id: r.n.id,
              kind: r.n.kind,
              conversation,
              messageId: r.n.messageId,
              threadRootId: r.n.threadRootId,
              actor: authorOf(dir, r.n.actorKind, r.n.actorId),
              // Computed now from the current body (Pitfall 9): an edited message shows its new text.
              snippet: snippetOf(r.body),
              createdAt: iso(r.n.createdAt),
              readAt: r.n.readAt ? iso(r.n.readAt) : null,
              ...(r.n.kind === "team_mention" ? { unit: (r.n.unitId && units.get(r.n.unitId)) || null } : {}),
            },
          ];
        });
        return {
          items,
          nextCursor: rows.length > limit && last ? encodeCursor({ t: last.key, id: last.n.id }) : null,
          unreadCount: await unreadCountFor(tx, me, readableIds, filter),
        };
      }),
  );

  app.post(
    "/notifications/read",
    {
      config: { authz: "user" },
      preHandler: core.identity.requireUser,
      schema: { tags, body: MarkNotificationsReadRequest, response: { 200: Ok } },
    },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        const me = authOf(req).userId;
        // Own rows only (and RLS): another member's id simply matches nothing.
        markDecided(req);
        const updated = await tx
          .update(notifications)
          .set({ readAt: sql`now()` })
          .where(
            and(
              eq(notifications.userId, me),
              isNull(notifications.readAt),
              req.body.ids ? inArray(notifications.id, req.body.ids) : undefined,
            ),
          )
          .returning({ id: notifications.id });
        if (updated.length > 0) {
          const unreadCount = await unreadCountFor(
            tx,
            me,
            await access.readableIds(tx, me, { kinds: NOTIFIABLE_KINDS }),
            "all",
          );
          const ev: NotificationReadEvent = req.body.all
            ? { all: true, unreadCount }
            : { ids: updated.map((u) => u.id), unreadCount };
          await core.realtime.appendEvent(tx, `user:${me}`, EventTypes.notificationRead, ev);
        }
        return { ok: true as const };
      }),
  );
}
