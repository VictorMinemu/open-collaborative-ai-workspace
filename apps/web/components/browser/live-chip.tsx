"use client";

import { type ConversationBrowserItem, ConversationBrowserList } from "@ocw/contracts";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { PrincipalAvatar } from "@/components/chat/principal-avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { api } from "@/lib/api";
import { chatKeys } from "@/lib/chat-queries";
import { cn } from "@/lib/utils";
import { useLiveStore } from "./live-store";
import { useOptionalLiveView } from "./live-view-provider";

/**
 * The conversation header's live chip (07.8-26; D-06, BRW-02, UI-SPEC Surface 1b): while a bot's browser is open in this
 * conversation (or one of its threads) and the viewer may watch it, "Live browser" with the bot's avatar ("Live" below
 * 768, named in full for screen readers) opens the live view; several open pages read "{n} live browsers" ("{n}" below
 * 768) and open a menu of "{bot} · {host}". Below 768 the avatar is left out, so a channel's title keeps its room. The
 * thread panel shows only the pages started in its thread.
 *
 * The list comes from `GET /conversations/:id/browsers` (the resolver decided each page). It is read again when a bot
 * turn of the conversation moves (`turn.activity`), when the live view shows an ended page, on focus, and every 20 s.
 */

const POLL_MS = 20_000;

export const conversationBrowsersKey = (conversationId: string) =>
  ["browser", "conversation", conversationId] as const;

function useConversationBrowsers(conversationId: string) {
  const q = useQuery({
    queryKey: conversationBrowsersKey(conversationId),
    queryFn: ({ signal }) =>
      api.get(`/api/v1/conversations/${conversationId}/browsers`, {
        schema: ConversationBrowserList,
        signal,
      }),
    staleTime: 5_000,
    refetchInterval: POLL_MS,
    refetchOnWindowFocus: true,
    retry: false,
  });
  const { refetch } = q;

  // A bot turn here moved (a page may have opened or closed): read again, once the burst settles.
  const turns = useQuery({
    queryKey: chatKeys.turnActivity(conversationId),
    queryFn: () => ({}),
    enabled: false,
    initialData: {},
    staleTime: Number.POSITIVE_INFINITY,
  }).data;
  const first = useRef(true);
  useEffect(() => {
    void turns;
    if (first.current) {
      first.current = false;
      return;
    }
    const t = window.setTimeout(() => void refetch(), 600);
    return () => window.clearTimeout(t);
  }, [turns, refetch]);

  // The live view saw one of these pages end: read again.
  const ended = useLiveStore((s) =>
    s.view && (s.view.server?.state === "ended" || s.view.server?.state === "no_permission")
      ? s.view.contextId
      : null,
  );
  const ids = q.data?.items.map((i) => i.contextId).join(",") ?? "";
  useEffect(() => {
    if (ended && ids.split(",").includes(ended)) void refetch();
  }, [ended, ids, refetch]);

  return q.data?.items ?? [];
}

export function LiveChip({
  conversationId,
  threadRootId,
  compact = false,
  className,
}: {
  conversationId: string;
  /** The thread panel's root: only the pages started in that thread. Absent: every page of the conversation. */
  threadRootId?: string;
  /** The phone's short label at every width (a narrow column, e.g. beside an open thread). */
  compact?: boolean;
  className?: string;
}) {
  const live = useOptionalLiveView();
  const all = useConversationBrowsers(conversationId);
  const items = threadRootId === undefined ? all : all.filter((i) => i.threadRootId === threadRootId);
  if (items.length === 0 || !live) return null;

  const openItem = (item: ConversationBrowserItem, trigger: HTMLElement | null) =>
    live.open({
      contextId: item.contextId,
      bot: { id: item.bot.id, name: item.bot.displayName, avatarUrl: item.bot.avatarUrl },
      trigger,
    });

  if (items.length === 1) {
    const item = items[0] as ConversationBrowserItem;
    return (
      <Button
        variant="outline"
        size="sm"
        data-testid="live-chip"
        data-count={1}
        aria-label={`Live browser, ${item.bot.displayName}`}
        onClick={(e) => openItem(item, e.currentTarget)}
        className={cn("gap-1.5 max-md:h-11 max-md:min-w-11 max-md:px-2.5", className)}
      >
        <Dot />
        <span className={compact ? "hidden" : "max-md:hidden"}>Live browser</span>
        <span className={compact ? undefined : "md:hidden"}>Live</span>
        <PrincipalAvatar
          kind="agent"
          name={item.bot.displayName}
          avatarUrl={item.bot.avatarUrl}
          seed={item.bot.id}
          // A phone header is tight (a channel's title must keep its room): the avatar is left out there.
          className={cn("size-4 rounded-[4px] text-[8px] max-md:hidden", compact && "hidden")}
        />
      </Button>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        data-testid="live-chip"
        data-count={items.length}
        aria-label={`${items.length} live browsers`}
        render={
          <Button variant="outline" size="sm" className={cn("gap-1.5 max-md:h-11 max-md:px-3", className)} />
        }
      >
        <Dot />
        <span className={compact ? "hidden" : "max-md:hidden"}>{items.length} live browsers</span>
        <span className={compact ? undefined : "md:hidden"}>{items.length}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" data-testid="live-chip-menu" className="min-w-56">
        {items.map((item) => (
          <DropdownMenuItem
            key={item.contextId}
            data-testid="live-chip-item"
            data-context={item.contextId}
            className="max-md:min-h-11"
            onClick={(e) => openItem(item, e.currentTarget as HTMLElement)}
          >
            <PrincipalAvatar
              kind="agent"
              name={item.bot.displayName}
              avatarUrl={item.bot.avatarUrl}
              seed={item.bot.id}
              className="size-5 rounded-md text-[10px]"
            />
            <span className="min-w-0 truncate">
              {item.bot.displayName} · <span className="font-mono text-xs">{item.host}</span>
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The emerald live dot (6 px; no pulse, UI-SPEC Reduced motion). */
function Dot() {
  return <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-emerald-500 dark:bg-emerald-400" />;
}
