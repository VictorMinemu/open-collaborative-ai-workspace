"use client";

import type { MessagePage } from "@ocw/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { isApiError } from "@/lib/api";
import { chatKeys, loadNewer, loadOlder, rejoinTail, useMessagesAround } from "@/lib/chat-queries";
import type { useStickToBottom } from "./use-stick-to-bottom";

type Scroll = ReturnType<typeof useStickToBottom>;

/**
 * Detached history for permalinks (CHAT-14), shared by the channel and DM views. A linked message outside the
 * live tail opens a window around it (`?around=`). The window outlives `m` in the URL (opening or closing a thread
 * drops it) until `release()` ("Jump to latest") or until paging reaches the live end, where it folds into the
 * tail and the view is live again.
 */
export function usePermalinkWindow({
  convId,
  tail,
  permalinkId,
  linkedTop,
}: {
  convId: string;
  /** The live tail page (`useMessages`). */
  tail: MessagePage | undefined;
  /** `m` from the URL. */
  permalinkId: string | null;
  /** The top-level message the URL names: the thread root for a reply link, else `m`. */
  linkedTop: string | null;
}) {
  const qc = useQueryClient();
  const [windowAnchor, setWindowAnchor] = useState<string | null>(null);
  // The link the reader jumped away from: while its `m` is still in the URL it must not reopen the window.
  const [dismissed, setDismissed] = useState<string | null>(null);
  useEffect(() => {
    if (!permalinkId) setDismissed(null);
  }, [permalinkId]);

  // Once the window resolved a reply to its root, the root is what the tail must hold (after a rejoin, it does).
  const resolvedTop = permalinkId
    ? (qc.getQueryData<MessagePage>(chatKeys.around(convId, permalinkId))?.anchorId ?? null)
    : null;
  const needsWindow =
    !!permalinkId &&
    permalinkId !== dismissed &&
    !!tail &&
    !tail.messages.some((m) => m.id === linkedTop || m.id === resolvedTop);
  const windowId = needsWindow ? permalinkId : windowAnchor;
  const around = useMessagesAround(convId, windowId);
  const detached = !!windowId && around.isSuccess;
  const shown = detached ? around.data : tail;

  useEffect(() => {
    if (needsWindow && permalinkId) setWindowAnchor(permalinkId);
  }, [needsWindow, permalinkId]);

  const windowAtEnd = detached && around.data?.nextAfter === null;
  useEffect(() => {
    if (!windowAtEnd || !windowId) return;
    if (rejoinTail(qc, convId, windowId)) setWindowAnchor(null);
  }, [windowAtEnd, windowId, qc, convId]);

  // "N new": top-level messages that reached the tail after the window was loaded.
  const windowSeq = detached ? (around.data?.lastSeq ?? null) : null;
  const newCount =
    windowSeq !== null && tail ? tail.messages.filter((m) => m.seq > windowSeq && !m.deletedAt).length : 0;

  const release = useCallback(() => {
    setWindowAnchor(null);
    setDismissed(permalinkId);
  }, [permalinkId]);

  // The row to centre for this link: the window's anchor, or the URL's target when it already is in the tail.
  const centreTarget = !permalinkId
    ? null
    : detached
      ? (around.data?.anchorId ?? null)
      : needsWindow
        ? null
        : linkedTop;

  return {
    windowId,
    detached,
    shown,
    newCount,
    centreTarget,
    /** The linked message is a reply: its root (from the server), so the view can open the thread. */
    threadRootId: around.data?.threadRootId ?? null,
    loading: !!windowId && around.isPending,
    /** Missing, hidden, deleted-and-gone or malformed: one answer (T-04-03-01). */
    unavailable:
      !!windowId && around.isError && (isApiError(around.error, 404) || isApiError(around.error, 400)),
    error: windowId && around.isError ? around.error : null,
    retry: () => void around.refetch(),
    release,
  };
}

/** Scrolls the row with `target` to the centre of the list once per `key` (the link), after it rendered. */
export function useCentreOnce(scroll: Scroll, key: string | null, target: string | null) {
  const done = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (!key || !target || done.current === key) return;
    const row = scroll.ref.current?.querySelector<HTMLElement>(
      `[data-testid="message"][data-message-id="${CSS.escape(target)}"]`,
    );
    if (!row) return;
    done.current = key;
    row.scrollIntoView({ block: "center" });
    scroll.onScroll();
  });
}

/**
 * Infinite scroll for the shown window: older pages at the top (position preserved), and in detached mode newer
 * pages at the bottom until the window reaches the live end.
 */
export function useWindowPaging({
  convId,
  scroll,
  shown,
  windowId,
  detached,
}: {
  convId: string;
  scroll: Scroll;
  shown: MessagePage | undefined;
  windowId: string | null;
  detached: boolean;
}) {
  const qc = useQueryClient();
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [loadingNewer, setLoadingNewer] = useState(false);
  const olderBusy = useRef(false);
  const newerBusy = useRef(false);
  const onScroll = () => {
    scroll.onScroll();
    const el = scroll.ref.current;
    if (!el) return;
    if (el.scrollTop <= 240 && !olderBusy.current && shown?.nextBefore) {
      olderBusy.current = true;
      setLoadingOlder(true);
      scroll.preserve();
      loadOlder(qc, convId, detached ? windowId : null)
        .catch(() => toast.error("Couldn't load older messages"))
        .finally(() => {
          olderBusy.current = false;
          setLoadingOlder(false);
        });
    }
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 240;
    if (detached && windowId && nearBottom && !newerBusy.current && shown?.nextAfter) {
      newerBusy.current = true;
      setLoadingNewer(true);
      loadNewer(qc, convId, windowId)
        .catch(() => toast.error("Couldn't load newer messages"))
        .finally(() => {
          newerBusy.current = false;
          setLoadingNewer(false);
        });
    }
  };
  return { onScroll, loadingOlder, loadingNewer };
}
