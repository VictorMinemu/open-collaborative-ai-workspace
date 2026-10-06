import type { ChannelSummary } from "@ocw/contracts";
import { Hash, Lock } from "lucide-react";
import { hasUnread } from "@/lib/chat-queries";
import { cn } from "@/lib/utils";

/** `#` for public channels, a lock for private ones. */
export function ChannelIcon({
  channel,
  className,
}: {
  channel: Pick<ChannelSummary, "visibility">;
  className?: string;
}) {
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
