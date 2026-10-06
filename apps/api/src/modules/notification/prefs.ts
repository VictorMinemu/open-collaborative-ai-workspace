import {
  type ConversationNotificationSettings,
  ConversationNotificationSettings as ConversationNotificationSettingsSchema,
  DEFAULT_NOTIFICATION_PREFS,
  EventTypes,
  IdParams,
  type NotificationPrefs,
  NotificationPrefs as NotificationPrefsSchema,
  type NotificationPrefsUpdatedEvent,
  UpdateConversationNotificationSettingsRequest,
  UpdateNotificationPrefsRequest,
} from "@ocw/contracts";
import { conversationMembers, notificationPrefs, type Tx, tenantOf } from "@ocw/db";
import { and, eq, sql } from "drizzle-orm";
import { markDecided } from "../../authz";
import { type App, authOf, type Core, tenant } from "../../core";
import { conflict } from "../../lib/errors";
import type { ConversationAccess } from "../chat";

/**
 * Notification preferences (CHAT-10, D-02). Global prefs (do not disturb, default channel level, desktop and web
 * toggles) and one conversation's level and mute belong to the caller only (T-04-11-04): the global row is keyed to
 * the session user, and a conversation's settings live on the caller's own membership of a conversation the resolver
 * lets them read. Both writes tell the caller's other tabs and devices with `notification_prefs.updated` on
 * `user:<me>` (P-04). The notification service reads the same values to decide `popup`.
 */

const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);

/** The member's prefs, or the defaults while they never changed anything. */
export async function loadPrefs(tx: Tx, userId: string): Promise<NotificationPrefs> {
  const [row] = await tx
    .select()
    .from(notificationPrefs)
    .where(eq(notificationPrefs.userId, userId))
    .limit(1);
  if (!row) return { ...DEFAULT_NOTIFICATION_PREFS };
  return {
    dndUntil: iso(row.dndUntil),
    desktopEnabled: row.desktopEnabled,
    webEnabled: row.webEnabled,
    defaultLevel: row.defaultLevel,
  };
}

export function registerPrefsRoutes(app: App, ctx: { core: Core; access: ConversationAccess }): void {
  const { core, access } = ctx;
  const tags = ["notifications"];

  const announce = (tx: Tx, me: string, ev: NotificationPrefsUpdatedEvent) =>
    core.realtime.appendEvent(tx, `user:${me}`, EventTypes.notificationPrefsUpdated, ev);

  app.get(
    "/notification-prefs",
    {
      config: { authz: "user" },
      preHandler: core.identity.requireUser,
      schema: { tags, response: { 200: NotificationPrefsSchema } },
    },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        // The caller's own row only; nothing to decide beyond being signed in to the organization.
        markDecided(req);
        return loadPrefs(tx, authOf(req).userId);
      }),
  );

  app.put(
    "/notification-prefs",
    {
      config: { authz: "user" },
      preHandler: core.identity.requireUser,
      schema: { tags, body: UpdateNotificationPrefsRequest, response: { 200: NotificationPrefsSchema } },
    },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        const me = authOf(req).userId;
        markDecided(req);
        const next: NotificationPrefs = { ...(await loadPrefs(tx, me)) };
        const b = req.body;
        if (b.dndUntil !== undefined) next.dndUntil = b.dndUntil;
        if (b.desktopEnabled !== undefined) next.desktopEnabled = b.desktopEnabled;
        if (b.webEnabled !== undefined) next.webEnabled = b.webEnabled;
        if (b.defaultLevel !== undefined) next.defaultLevel = b.defaultLevel;
        const values = {
          dndUntil: next.dndUntil,
          desktopEnabled: next.desktopEnabled,
          webEnabled: next.webEnabled,
          defaultLevel: next.defaultLevel,
        };
        await tx
          .insert(notificationPrefs)
          .values({ organizationId: tenantOf(tx).organizationId, userId: me, ...values })
          .onConflictDoUpdate({
            target: [notificationPrefs.organizationId, notificationPrefs.userId],
            set: { ...values, updatedAt: sql`now()` },
          });
        await announce(tx, me, { prefs: next });
        return next;
      }),
  );

  app.put(
    "/conversations/:id/notification-settings",
    {
      config: { authz: "user" },
      preHandler: core.identity.requireUser,
      schema: {
        tags,
        params: IdParams,
        body: UpdateConversationNotificationSettingsRequest,
        response: { 200: ConversationNotificationSettingsSchema },
      },
    },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        const me = authOf(req).userId;
        // Hidden = missing = 404 (the resolver decides, P-03); then only the caller's own membership changes.
        const { conv } = await access.readable(req, tx, req.params.id);
        const patch: Partial<{ notifyLevel: ConversationNotificationSettings["level"]; muted: boolean }> = {};
        if (req.body.level !== undefined) patch.notifyLevel = req.body.level;
        if (req.body.muted !== undefined) patch.muted = req.body.muted;
        const [row] = await tx
          .update(conversationMembers)
          .set(patch)
          .where(
            and(
              eq(conversationMembers.conversationId, conv.id),
              eq(conversationMembers.memberKind, "user"),
              eq(conversationMembers.memberId, me),
            ),
          )
          .returning({ level: conversationMembers.notifyLevel, muted: conversationMembers.muted });
        if (!row) throw conflict("Join the conversation to change its notifications", "not_a_member");
        const settings: ConversationNotificationSettings = { level: row.level, muted: row.muted };
        await announce(tx, me, { conversationId: conv.id, settings });
        return settings;
      }),
  );
}
