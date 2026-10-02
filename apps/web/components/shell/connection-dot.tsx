"use client";

import type { ConnectionStatus } from "@ocw/realtime-client";
import { useRealtimeStatus } from "@/lib/realtime";
import { cn } from "@/lib/utils";

const META: Record<ConnectionStatus, { label: string; className: string }> = {
  open: { label: "Live", className: "bg-success" },
  connecting: { label: "Connecting…", className: "bg-warning animate-pulse" },
  reconnecting: { label: "Reconnecting…", className: "bg-warning animate-pulse" },
  idle: { label: "Offline", className: "bg-muted-foreground/50" },
  closed: { label: "Offline", className: "bg-muted-foreground/50" },
};

export function useConnectionMeta() {
  const status = useRealtimeStatus();
  return { status, ...META[status] };
}

/** Small status dot; positioned by the caller (e.g. on the avatar corner). */
export function ConnectionDot({ className }: { className?: string }) {
  const { status, label, className: tone } = useConnectionMeta();
  return (
    <span
      role="status"
      aria-label={`Realtime: ${label}`}
      title={`Realtime: ${label}`}
      data-testid="connection-status"
      data-status={status}
      className={cn("block size-2.5 rounded-full ring-2 ring-sidebar", tone, className)}
    />
  );
}
