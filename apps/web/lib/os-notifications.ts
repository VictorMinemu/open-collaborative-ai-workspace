import { type MessageAuthor, type NotificationPrefs, UNREAD_CAP } from "@ocw/contracts";

/**
 * OS notifications while the web app or the desktop app runs (CHAT-10, D-02): the Web Notifications API, which the
 * Electron renderer supports too, so there is one code path. No service worker, no push subscription: a closed tab
 * gets nothing (closed-tab Web Push is deferred, P-12). Permission is asked only from a click handler, never on
 * load. Each pop-up's `tag` is the notification id, so the same browser replaces instead of stacking (Pitfall 12).
 */

export type OsPermission = "granted" | "denied" | "default" | "unsupported";

function api(): typeof Notification | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as { Notification?: typeof Notification }).Notification;
}

/** The browser's permission for this origin, or "unsupported" (no API, or during SSR). */
export function notificationPermission(): OsPermission {
  return api()?.permission ?? "unsupported";
}

/** Asks for permission. Call ONLY from a click handler (a user gesture). */
export async function requestNotificationPermission(): Promise<NotificationPermission> {
  const N = api();
  if (!N) return "denied";
  return N.requestPermission();
}

/**
 * Whether this tab shows a pop-up. The server decided `popup` (DND, mute, level); the client applies only its own
 * toggle (desktop inside the desktop app, web otherwise) and skips the conversation already in front of the member.
 */
export function shouldPopup(i: {
  popup: boolean;
  isDesktop: boolean;
  prefs: NotificationPrefs;
  focusedConversationId: string | null;
  conversationId: string;
  visible: boolean;
}): boolean {
  if (!i.popup) return false;
  if (!(i.isDesktop ? i.prefs.desktopEnabled : i.prefs.webEnabled)) return false;
  if (i.visible && i.focusedConversationId === i.conversationId) return false;
  return true;
}

/** Shows one pop-up (a no-op without permission or the API). Clicking it focuses the app and runs `onClick`. */
export function showOsNotification(i: { id: string; title: string; body: string; onClick(): void }): void {
  const N = api();
  if (N?.permission !== "granted") return;
  try {
    const n = new (N as typeof Notification)(i.title, { body: i.body, tag: i.id, silent: false });
    n.onclick = () => {
      window.focus();
      i.onClick();
      n.close?.();
    };
  } catch {
    // Some platforms (Android Chrome) only show notifications through a service worker, which D-02 rules out.
  }
}

const CHAT_ROUTE =
  /^\/chat\/(?:dm\/)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/i;

/** The conversation a chat route shows, or null. */
export function focusedConversationOf(pathname: string | null): string | null {
  return pathname?.match(CHAT_ROUTE)?.[1] ?? null;
}

const PREFIX = /^\(\d+\+?\)\s/;

/** `(N) title` (99+ at the cap); 0 removes the prefix. */
export function titleWithCount(title: string, n: number): string {
  const bare = title.replace(PREFIX, "");
  if (n <= 0) return bare;
  return `(${n >= UNREAD_CAP ? "99+" : n}) ${bare}`;
}

/** "Ada Lovelace in #design"; a DM is just the person (its label already names them). */
export function osNotificationTitle(
  actor: Pick<MessageAuthor, "displayName">,
  conversation: { kind: string; label: string },
): string {
  return conversation.kind === "dm" ? actor.displayName : `${actor.displayName} in ${conversation.label}`;
}

// ---------------------------------------------------------------- do not disturb (CHAT-10)

export type DndPreset = "30m" | "1h" | "2h" | "tomorrow";

export const DND_PRESETS: ReadonlyArray<{ id: DndPreset; label: string }> = [
  { id: "30m", label: "30 minutes" },
  { id: "1h", label: "1 hour" },
  { id: "2h", label: "2 hours" },
  { id: "tomorrow", label: "Until tomorrow, 09:00" },
];

/** When a preset ends, as an ISO instant ("tomorrow" is 09:00 tomorrow in the member's local time). */
export function dndPresetUntil(preset: DndPreset, now = new Date()): string {
  const minutes = { "30m": 30, "1h": 60, "2h": 120 } as const;
  if (preset !== "tomorrow") return new Date(now.getTime() + minutes[preset] * 60_000).toISOString();
  const t = new Date(now);
  t.setDate(t.getDate() + 1);
  t.setHours(9, 0, 0, 0);
  return t.toISOString();
}

const hhmm = (d: Date) =>
  `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** "16:05", "tomorrow 09:00" or "Mon 12 Oct, 09:00" (local time). */
export function formatDndUntil(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (sameDay(d, now)) return hhmm(d);
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  if (sameDay(d, tomorrow)) return `tomorrow ${hhmm(d)}`;
  const day = d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
  return `${day}, ${hhmm(d)}`;
}
