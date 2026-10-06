"use client";

import { useQueryClient } from "@tanstack/react-query";
import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { badgeRowOf, markConversationRead, setReadHold, useReadHold } from "@/lib/chat-queries";

/** How close to the end counts as "reached the bottom" (px). */
const BOTTOM_SLACK = 24;
/** A scroll this long after a wheel, touch or key press is the member's own (not the view's auto-scroll). */
const GESTURE_MS = 1_000;

const atEnd = (el: HTMLElement) => el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_SLACK;

/**
 * The read cursor of an open channel or DM (CHAT-09, D-07), shared by both views:
 * - while the tab is visible it marks read up to the newest message shown: the live tail, or in a detached
 *   permalink window only up to the window's newest message (reading old history never reads what is below it);
 * - a conversation the member marked unread is held: nothing is marked until the member scrolls to the bottom
 *   themselves, sends, or chooses "Mark as read" (the hold survives leaving and coming back in this tab);
 * - `dividerAfterSeq` places the "New messages" divider: where the member's cursor was when they opened the
 *   conversation, or where they marked it unread. It stays for the visit.
 */
export function useReadCursor(opts: {
  convId: string;
  /** Newest top-level seq of the live tail (0 while loading). */
  tailLastSeq: number;
  /** Newest seq of the detached permalink window, or null when the tail is shown. */
  windowLastSeq: number | null;
  scrollRef: RefObject<HTMLDivElement | null>;
}): { dividerAfterSeq: number | null; release: () => void } {
  const { convId, tailLastSeq, windowLastSeq, scrollRef } = opts;
  const qc = useQueryClient();
  const hold = useReadHold(convId);
  const target = windowLastSeq ?? tailLastSeq;

  // The divider of this visit: captured once, before this view moves the cursor.
  const [divider, setDivider] = useState<{ convId: string; after: number | null } | null>(null);
  useEffect(() => {
    if (!tailLastSeq || divider?.convId === convId) return;
    const row = badgeRowOf(qc, convId);
    const unread = (row?.unreadCount ?? 0) > 0 && (row?.lastReadSeq ?? tailLastSeq) < tailLastSeq;
    setDivider({ convId, after: hold ?? (unread && row ? row.lastReadSeq : null) });
  }, [qc, convId, tailLastSeq, hold, divider?.convId]);
  useEffect(() => {
    if (hold !== null) setDivider({ convId, after: hold });
  }, [convId, hold]);

  useEffect(() => {
    if (!target || hold !== null) return;
    const mark = () => document.visibilityState === "visible" && markConversationRead(qc, convId, target);
    mark();
    document.addEventListener("visibilitychange", mark);
    return () => document.removeEventListener("visibilitychange", mark);
  }, [qc, convId, target, hold]);

  // Reaching the bottom by the member's own gesture releases the hold (the effect above then marks read).
  const gestureAt = useRef(0);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || hold === null) return;
    const gesture = () => {
      gestureAt.current = Date.now();
    };
    const release = () => {
      if (Date.now() - gestureAt.current < GESTURE_MS && atEnd(el)) setReadHold(convId, null);
    };
    // A list too short to scroll never fires `scroll`: a downward wheel at the end counts by itself.
    const onWheel = (e: WheelEvent) => {
      gesture();
      if (e.deltaY > 0 && atEnd(el)) setReadHold(convId, null);
    };
    el.addEventListener("wheel", onWheel, { passive: true });
    el.addEventListener("touchmove", gesture, { passive: true });
    el.addEventListener("keydown", gesture);
    el.addEventListener("scroll", release, { passive: true });
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("touchmove", gesture);
      el.removeEventListener("keydown", gesture);
      el.removeEventListener("scroll", release);
    };
  }, [scrollRef, convId, hold]);

  const release = useCallback(() => setReadHold(convId, null), [convId]);
  return { dividerAfterSeq: divider?.convId === convId ? divider.after : null, release };
}
