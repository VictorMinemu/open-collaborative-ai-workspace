"use client";

import {
  decideNotify,
  EphemeralTypes,
  EventTypes,
  MessageNotifyEvent,
  type NotificationCreatedEvent,
  type NotificationPrefsUpdatedEvent,
  type NotificationReadEvent,
} from "@ocw/contracts";
import type { TopicFrame } from "@ocw/realtime-client";
import { useQueryClient } from "@tanstack/react-query";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { badgeRowOf, useChannels } from "@/lib/chat-queries";
import {
  applyNotificationCreated,
  applyNotificationPrefsUpdated,
  applyNotificationRead,
  dndActive,
  prefsOf,
  unreadOf,
  useNotificationPrefs,
  useNotifications,
} from "@/lib/notification-queries";
import {
  focusedConversationOf,
  osNotificationTitle,
  shouldPopup,
  showOsNotification,
  titleWithCount,
} from "@/lib/os-notifications";
import { permalinkPath } from "@/lib/permalink";
import { useMe } from "@/lib/queries";
import { useTopic } from "@/lib/realtime";

/** A frame replayed after a long disconnection is history, not news: no pop-up for anything older than this. */
const STALE_MS = 10 * 60_000;

const kindOf = (k: string): "channel" | "dm" | "group" =>
  k === "channel" ? "channel" : k === "group" ? "group" : "dm";

/**
 * The app-wide listener of OS notifications (CHAT-10, D-02), mounted once in the AppShell so it runs on every page
 * while the web app or the desktop app is open. It shares the tab's one `user:<me>` subscription with the chat
 * sidebar (same snapshot cursor, so neither skips the other's frames) and keeps the inbox cache live everywhere.
 * The server decided `popup` (DND, mute, level); here only the desktop/web toggle and "already in front" apply
 * (`shouldPopup`). Each pop-up is tagged with its notification id and shown once per tab (Pitfall 12). Level "all"
 * channels arrive as ephemeral `message.notify` (tag = message id). It also keeps the tab title count and the desktop
 * app's dock/taskbar badge.
 */
export function OsNotifier(): null {
  const qc = useQueryClient();
  const router = useRouter();
  const pathname = usePathname();
  const me = useMe({ enabled: false });
  const userId = me.data?.user.id ?? null;
  // The prefs are needed before the first pop-up; the channel snapshot gives the stream cursor the sidebar uses.
  useNotificationPrefs();
  const channels = useChannels();
  const [cursor, setCursor] = useState<number | null>(null);
  if (cursor === null && channels.data) setCursor(channels.data.userSeq ?? 0);
  const shown = useRef(new Set<string>());
  const pathRef = useRef(pathname);
  pathRef.current = pathname;

  const visibleNow = () => document.visibilityState === "visible";
  const isDesktop = () => !!window.ocwDesktop?.isDesktop;

  const onFrame = (frame: TopicFrame) => {
    if (frame.op === "eph" && frame.type === EphemeralTypes.messageNotify) {
      onMessageNotify(frame.data);
      return;
    }
    if (frame.op !== "ev") return;
    if (frame.type === EventTypes.notificationPrefsUpdated) {
      applyNotificationPrefsUpdated(qc, frame.data as NotificationPrefsUpdatedEvent);
      return;
    }
    if (frame.type === EventTypes.notificationRead) {
      applyNotificationRead(qc, frame.data as NotificationReadEvent);
      return;
    }
    if (frame.type !== EventTypes.notificationCreated) return;
    const ev = frame.data as NotificationCreatedEvent;
    const n = ev.notification;
    applyNotificationCreated(qc, ev);
    if (shown.current.has(n.id)) return;
    shown.current.add(n.id);
    if (Date.now() - Date.parse(n.createdAt) > STALE_MS) return;
    const pop = shouldPopup({
      popup: ev.popup,
      isDesktop: isDesktop(),
      prefs: prefsOf(qc),
      focusedConversationId: focusedConversationOf(pathRef.current),
      conversationId: n.conversation.id,
      visible: visibleNow(),
    });
    if (!pop) return;
    showOsNotification({
      id: n.id,
      title: osNotificationTitle(n.actor, n.conversation),
      body: n.snippet,
      onClick: () =>
        router.push(
          permalinkPath(
            { id: n.conversation.id, kind: kindOf(n.conversation.kind) },
            n.messageId,
            n.threadRootId,
          ),
        ),
    });
  };

  /**
   * `message.notify` (ephemeral, level "all"): the server already decided with the prefs it had; this tab decides
   * again with what it holds now (a DND or level change from another device may be newer), then applies its toggle.
   */
  const onMessageNotify = (data: unknown) => {
    const parsed = MessageNotifyEvent.safeParse(data);
    if (!parsed.success) return;
    const ev = parsed.data;
    if (shown.current.has(ev.messageId)) return;
    shown.current.add(ev.messageId);
    const prefs = prefsOf(qc);
    const row = badgeRowOf(qc, ev.conversation.id);
    const { popup } = decideNotify({
      event: "message",
      conversationKind: "channel",
      level: row?.notifyLevel ?? "default",
      defaultLevel: prefs.defaultLevel,
      muted: row?.muted ?? false,
      dndActive: dndActive(prefs),
      actorKind: ev.actor.kind,
    });
    const pop = shouldPopup({
      popup,
      isDesktop: isDesktop(),
      prefs,
      focusedConversationId: focusedConversationOf(pathRef.current),
      conversationId: ev.conversation.id,
      visible: visibleNow(),
    });
    if (!pop) return;
    showOsNotification({
      id: ev.messageId,
      title: osNotificationTitle(ev.actor, ev.conversation),
      body: ev.snippet,
      onClick: () => router.push(permalinkPath({ id: ev.conversation.id, kind: "channel" }, ev.messageId)),
    });
  };

  useTopic(userId && cursor !== null ? `user:${userId}` : null, onFrame, cursor ?? undefined);

  // The tab title shows the unread Mentions count, "(2) …" (Next sets titles on navigation: re-apply after it).
  const mentions = useNotifications("mentions");
  const count = unreadOf(mentions.data);
  useEffect(() => {
    const apply = () => {
      const next = titleWithCount(document.title, count);
      if (next !== document.title) document.title = next;
    };
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(document.head, { subtree: true, childList: true, characterData: true });
    // The desktop app mirrors it on the dock/taskbar badge (one validated IPC channel; older builds lack it).
    void window.ocwDesktop?.setBadgeCount?.(count).catch(() => {});
    return () => observer.disconnect();
  }, [count]);
  // Signing out unmounts the shell: leave a clean title and badge behind.
  useEffect(
    () => () => {
      document.title = titleWithCount(document.title, 0);
      void window.ocwDesktop?.setBadgeCount?.(0).catch(() => {});
    },
    [],
  );

  return null;
}
