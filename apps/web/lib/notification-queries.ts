"use client";

import {
  DEFAULT_NOTIFICATION_PREFS,
  type MarkNotificationsReadRequest,
  type Notification,
  type NotificationCreatedEvent,
  NotificationList,
  type NotificationPrefs,
  NotificationPrefs as NotificationPrefsSchema,
  type NotificationPrefsUpdatedEvent,
  type NotificationReadEvent,
  Ok,
  type UpdateNotificationPrefsRequest,
} from "@ocw/contracts";
import { type InfiniteData, type QueryClient, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { api, isApiError } from "./api";
import { applyConversationSettings } from "./chat-queries";

/**
 * The inbox (CHAT-08): the member's notifications, newest first, as the Mentions view (`mentions`: @mentions,
 * @channel, @here) or All activity (also DMs, group DMs and thread replies). The server re-checks access and
 * computes snippets on every read (Pitfall 9). Live updates arrive on the member's own `user:` stream: the chat sidebar
 * and the app-level OsNotifier share the one subscription of the tab (Pitfall 13); both apply frames idempotently.
 */

export type NotificationFilter = "all" | "mentions";

export const notifKeys = {
  all: ["notifications"] as const,
  list: (filter: NotificationFilter) => ["notifications", filter] as const,
  /** Not under the `notifications` prefix: invalidating the lists never refetches the prefs. */
  prefs: ["notification-prefs"] as const,
};

const MENTIONS_FILTER = new Set<Notification["kind"]>(["mention", "channel", "here"]);
const FILTERS: NotificationFilter[] = ["all", "mentions"];
const matches = (filter: NotificationFilter, n: Notification) =>
  filter === "all" || MENTIONS_FILTER.has(n.kind);

const retryUnlessClientError = (count: number, err: unknown) =>
  !(isApiError(err) && err.status >= 400 && err.status < 500) && count < 2;

export function useNotifications(filter: NotificationFilter, opts: { enabled?: boolean } = {}) {
  return useInfiniteQuery({
    queryKey: notifKeys.list(filter),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      api.get(
        `/api/v1/notifications?filter=${filter}&limit=30${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ""}`,
        { schema: NotificationList, signal },
      ),
    getNextPageParam: (last) => last.nextCursor,
    retry: retryUnlessClientError,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
    enabled: opts.enabled ?? true,
  });
}

type Cache = InfiniteData<NotificationList>;

function update(qc: QueryClient, filter: NotificationFilter, fn: (prev: Cache) => Cache) {
  qc.setQueryData<Cache>(notifKeys.list(filter), (prev) => (prev ? fn(prev) : prev));
}

let refreshTimer: ReturnType<typeof setTimeout> | null = null;
/** Exact counts come back from the server shortly after any local estimate (another tab may have read some). */
function refreshSoon(qc: QueryClient) {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    void qc.invalidateQueries({ queryKey: notifKeys.all });
  }, 1_500);
}

/** Marks items read in every cached list; `unreadCount` drops by the items that were unread there. */
function markReadLocally(qc: QueryClient, ids: Set<string> | "all", at: string) {
  for (const filter of FILTERS) {
    update(qc, filter, (prev) => {
      let dropped = 0;
      const pages = prev.pages.map((p) => ({
        ...p,
        items: p.items.map((n) => {
          if (n.readAt || (ids !== "all" && !ids.has(n.id))) return n;
          dropped++;
          return { ...n, readAt: at };
        }),
      }));
      return {
        ...prev,
        pages: pages.map((p, i) => ({
          ...p,
          unreadCount: ids === "all" ? 0 : i === 0 ? Math.max(0, p.unreadCount - dropped) : p.unreadCount,
        })),
      };
    });
  }
}

/** Marks some (or all) of the member's notifications read; the lists update at once. */
export async function markNotificationsRead(qc: QueryClient, body: MarkNotificationsReadRequest) {
  markReadLocally(qc, body.all ? "all" : new Set(body.ids ?? []), new Date().toISOString());
  try {
    await api.post("/api/v1/notifications/read", { body, schema: Ok });
  } finally {
    refreshSoon(qc);
  }
}

/** `notification.created` on the member's `user:` stream: idempotent by id (replays and other tabs). */
export function applyNotificationCreated(qc: QueryClient, ev: NotificationCreatedEvent) {
  const n = ev.notification;
  for (const filter of FILTERS) {
    if (!matches(filter, n)) continue;
    update(qc, filter, (prev) => {
      const existing = prev.pages.flatMap((p) => p.items).find((x) => x.id === n.id);
      // A replay of what the list already has (its read state may be newer): nothing to do.
      if (existing?.kind === n.kind) return prev;
      if (existing) {
        // An upgraded row (a stronger reason): replace it in place; it is unread again.
        return {
          ...prev,
          pages: prev.pages.map((p) => ({ ...p, items: p.items.map((x) => (x.id === n.id ? n : x)) })),
        };
      }
      const [first, ...rest] = prev.pages;
      if (!first) return prev;
      return {
        ...prev,
        pages: [
          { ...first, items: [n, ...first.items], unreadCount: first.unreadCount + (n.readAt ? 0 : 1) },
          ...rest,
        ],
      };
    });
  }
}

/** `notification.read` from any of the member's tabs or devices. */
export function applyNotificationRead(qc: QueryClient, ev: NotificationReadEvent) {
  markReadLocally(qc, ev.all ? "all" : new Set(ev.ids ?? []), new Date().toISOString());
  update(qc, "all", (prev) => ({
    ...prev,
    pages: prev.pages.map((p, i) => (i === 0 ? { ...p, unreadCount: ev.unreadCount } : p)),
  }));
  refreshSoon(qc);
}

/** The unread count of a cached list (its first page carries it). */
export function unreadOf(data: Cache | undefined): number {
  return data?.pages[0]?.unreadCount ?? 0;
}

// ---------------------------------------------------------------- preferences (CHAT-10)

/** The member's notification preferences (DND, default level, desktop and web toggles). */
export function useNotificationPrefs(opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: notifKeys.prefs,
    queryFn: ({ signal }) =>
      api.get("/api/v1/notification-prefs", { schema: NotificationPrefsSchema, signal }),
    retry: retryUnlessClientError,
    staleTime: 5 * 60_000,
    enabled: opts.enabled ?? true,
  });
}

/** The cached prefs, or the defaults until they load. */
export function prefsOf(qc: QueryClient): NotificationPrefs {
  return qc.getQueryData<NotificationPrefs>(notifKeys.prefs) ?? DEFAULT_NOTIFICATION_PREFS;
}

/** Changes some prefs: applied at once, the server's answer wins, rolled back if it refuses. */
export async function updateNotificationPrefs(
  qc: QueryClient,
  patch: UpdateNotificationPrefsRequest,
): Promise<NotificationPrefs> {
  const before = prefsOf(qc);
  qc.setQueryData<NotificationPrefs>(notifKeys.prefs, { ...before, ...patch });
  try {
    const saved = await api.put("/api/v1/notification-prefs", {
      body: patch,
      schema: NotificationPrefsSchema,
    });
    qc.setQueryData<NotificationPrefs>(notifKeys.prefs, saved);
    return saved;
  } catch (err) {
    qc.setQueryData<NotificationPrefs>(notifKeys.prefs, before);
    throw err;
  }
}

/** `notification_prefs.updated` from any of the member's tabs or devices: global prefs or one conversation's. */
export function applyNotificationPrefsUpdated(qc: QueryClient, ev: NotificationPrefsUpdatedEvent) {
  if (ev.prefs) qc.setQueryData<NotificationPrefs>(notifKeys.prefs, ev.prefs);
  if (ev.conversationId && ev.settings) applyConversationSettings(qc, ev.conversationId, ev.settings);
}

/** True while do-not-disturb is on. */
export function dndActive(prefs: Pick<NotificationPrefs, "dndUntil">, now = Date.now()): boolean {
  return prefs.dndUntil !== null && Date.parse(prefs.dndUntil) > now;
}
