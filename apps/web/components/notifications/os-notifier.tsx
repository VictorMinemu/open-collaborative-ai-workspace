"use client";

import {
  EventTypes,
  type NotificationCreatedEvent,
  type NotificationPrefsUpdatedEvent,
  type NotificationReadEvent,
} from "@ocw/contracts";
import type { TopicFrame } from "@ocw/realtime-client";
import { useQueryClient } from "@tanstack/react-query";
import { usePathname, useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { useChannels } from "@/lib/chat-queries";
import {
  applyNotificationCreated,
  applyNotificationPrefsUpdated,
  applyNotificationRead,
  prefsOf,
  useNotificationPrefs,
} from "@/lib/notification-queries";
import {
  focusedConversationOf,
  osNotificationTitle,
  shouldPopup,
  showOsNotification,
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
 * (`shouldPopup`). Each pop-up is tagged with its notification id and shown once per tab (Pitfall 12).
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

  const onFrame = (frame: TopicFrame) => {
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
      isDesktop: !!window.ocwDesktop?.isDesktop,
      prefs: prefsOf(qc),
      focusedConversationId: focusedConversationOf(pathRef.current),
      conversationId: n.conversation.id,
      visible: document.visibilityState === "visible",
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

  useTopic(userId && cursor !== null ? `user:${userId}` : null, onFrame, cursor ?? undefined);
  return null;
}
