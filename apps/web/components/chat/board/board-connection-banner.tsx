"use client";

import type { ConnectionStatus } from "@ocw/realtime-client";
import { WifiOff } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { useConnectionMeta } from "@/components/shell/connection-dot";

/**
 * The board's live-connection banner (07.1-09, D-03, 07.1-UI-SPEC Offline and reconnecting): once the board has
 * loaded, a live connection that stays `reconnecting`, `closed` or `idle` for more than 3 s shows a 32 px status row
 * under the toolbar. It goes away when the connection is open again; the realtime client then replays the missed
 * frames from its cursor, so other people's changes appear without a reload.
 */

export const BOARD_BANNER_DELAY_MS = 3000;

export const BOARD_CONNECTION_COPY = {
  reconnecting: "Reconnecting… Changes from others will show up when you're back.",
  offline: "You're offline. Changes from others will show up when you reconnect.",
} as const;

export type ConnectionBannerKind = keyof typeof BOARD_CONNECTION_COPY;

/**
 * Which copy a connection status shows (null = no banner). A client that keeps retrying while the browser itself
 * reports no network is offline, not reconnecting.
 */
export function connectionBannerKind(
  status: ConnectionStatus,
  browserOnline: boolean,
): ConnectionBannerKind | null {
  switch (status) {
    case "open":
    case "connecting":
      return null;
    case "reconnecting":
      return browserOnline ? "reconnecting" : "offline";
    case "closed":
    case "idle":
      return "offline";
  }
}

function subscribeOnline(onChange: () => void): () => void {
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
  };
}

/** `navigator.onLine`, live (true on the server). */
function useBrowserOnline(): boolean {
  return useSyncExternalStore(
    subscribeOnline,
    () => navigator.onLine,
    () => true,
  );
}

/** The 32 px status row (it grows to two lines rather than cut the copy at 390). */
export function ConnectionBannerRow({ kind }: { kind: ConnectionBannerKind }) {
  return (
    <div
      role="status"
      data-testid="board-connection-banner"
      data-kind={kind}
      className="flex min-h-8 shrink-0 items-center gap-2 border-b bg-muted/60 px-4 py-1.5 text-muted-foreground text-xs leading-4 md:px-6"
    >
      <WifiOff className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="min-w-0">{BOARD_CONNECTION_COPY[kind]}</span>
    </div>
  );
}

/** Mounted under the board toolbar; `loaded` = the board snapshot is in (the 3 s count only starts then). */
export function BoardConnectionBanner({ loaded }: { loaded: boolean }) {
  const { status } = useConnectionMeta();
  const online = useBrowserOnline();
  const kind = connectionBannerKind(status, online);
  const down = loaded && kind !== null;
  const [shown, setShown] = useState(false);

  useEffect(() => {
    if (!down) {
      setShown(false);
      return;
    }
    const timer = window.setTimeout(() => setShown(true), BOARD_BANNER_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [down]);

  return shown && kind ? <ConnectionBannerRow kind={kind} /> : null;
}
