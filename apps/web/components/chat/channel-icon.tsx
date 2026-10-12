import type { ChannelSummary } from "@ocw/contracts";
import { Hash, Lock, SquareKanban } from "lucide-react";
import { hasUnread } from "@/lib/chat-queries";
import { cn } from "@/lib/utils";

/**
 * `#` for public channels, a lock for private ones. Board channels (Phase 07.1, D-01) show the board glyph, with a
 * small lock badge when private.
 */
export function ChannelIcon({
  channel,
  className,
}: {
  channel: Pick<ChannelSummary, "visibility"> & Partial<Pick<ChannelSummary, "layout">>;
  className?: string;
}) {
  if (channel.layout === "board") {
    return (
      <span
        data-slot="channel-icon"
        data-layout="board"
        className={cn("relative inline-flex size-4 shrink-0", className)}
      >
        <SquareKanban className="size-full" strokeWidth={2} aria-hidden />
        {channel.visibility === "private" ? (
          <Lock
            aria-hidden
            strokeWidth={3}
            className="absolute -right-1 -bottom-1 size-2.5! rounded-[3px] bg-background p-px"
          />
        ) : null}
      </span>
    );
  }
  const Icon = channel.visibility === "private" ? Lock : Hash;
  return (
    <Icon
      className={cn("size-4 shrink-0", className)}
      strokeWidth={channel.visibility === "private" ? 2 : 2.2}
    />
  );
}

/** A joined channel with unread messages or mentions (CHAT-09: counted messages, P-07). */
export function isUnread(c: ChannelSummary): boolean {
  return c.isMember && hasUnread(c);
}
