import type { ChannelSummary } from "@ocw/contracts";
import { Hash, Lock } from "lucide-react";
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

/** A joined channel with a top-level message newer than the member's read cursor. */
export function isUnread(c: ChannelSummary): boolean {
  return c.isMember && c.latestMessageSeq > c.lastReadSeq;
}
