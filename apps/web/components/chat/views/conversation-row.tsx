"use client";

import type { ChannelSummary, DmSummary } from "@ocw/contracts";
import Link from "next/link";
import type { ReactNode } from "react";
import { shortAgo } from "@/components/work-zone/session-sidebar";
import { cn } from "@/lib/utils";
import { ChannelIcon } from "../channel-icon";
import { GroupAvatars, PrincipalAvatar } from "../principal-avatar";

/** A conversation in a list view (All, AI Chats): avatar, name, one-line preview, time, unread dot. */
export function ConversationRow({
  href,
  avatar,
  title,
  meta,
  preview,
  at,
  unread,
  now,
  testId,
  conversationId,
}: {
  href: string;
  avatar: ReactNode;
  title: ReactNode;
  /** Small chip after the title ("Personal", "Product › Mobile"). */
  meta?: ReactNode;
  preview: string | null | undefined;
  at: string | null;
  unread: boolean;
  now: number;
  testId: string;
  conversationId: string;
}) {
  return (
    <Link
      href={href}
      data-testid={testId}
      data-conversation-id={conversationId}
      data-unread={unread || undefined}
      className="group/row flex items-center gap-3 rounded-lg px-3 py-2.5 outline-none transition-colors hover:bg-accent/60 focus-visible:ring-[3px] focus-visible:ring-ring/40"
    >
      <span className="flex size-9 shrink-0 items-center justify-center">{avatar}</span>
      <span className="grid min-w-0 flex-1 gap-0.5">
        <span className="flex min-w-0 items-center gap-1.5">
          <span
            className={cn(
              "min-w-0 truncate text-[14.5px]",
              unread ? "font-semibold text-foreground" : "font-medium text-foreground/90",
            )}
          >
            {title}
          </span>
          {meta}
          <span
            className={cn(
              "ml-auto shrink-0 pl-2 text-[12px] tabular-nums",
              unread ? "font-medium text-primary" : "text-muted-foreground",
            )}
          >
            {at ? shortAgo(at, now) : ""}
          </span>
        </span>
        <span className="flex min-w-0 items-center gap-2">
          <span
            data-testid="conversation-preview"
            className={cn(
              "min-w-0 flex-1 truncate text-[13px]",
              unread ? "text-foreground/80" : "text-muted-foreground",
            )}
          >
            {preview ?? <span className="italic">No messages yet</span>}
          </span>
          {unread ? (
            <>
              <span className="sr-only">(unread)</span>
              <span aria-hidden className="size-2 shrink-0 rounded-full bg-primary" />
            </>
          ) : null}
        </span>
      </span>
    </Link>
  );
}

/** The avatar of a channel or a direct conversation in list views. */
export function ConversationAvatar({ item }: { item: ChannelSummary | DmSummary }) {
  if ("counterpart" in item) {
    const c = item.counterpart;
    if (c.kind === "group") return <GroupAvatars members={c.members} large className="size-9" />;
    return (
      <PrincipalAvatar kind={c.kind} name={c.name} avatarUrl={c.avatarUrl} seed={c.id} className="size-9" />
    );
  }
  return (
    <span className="flex size-9 items-center justify-center rounded-[30%] bg-muted text-muted-foreground">
      <ChannelIcon channel={item} className="size-[18px]" />
    </span>
  );
}
