"use client";

import type { ChannelSummary, DmSummary } from "@ocw/contracts";
import { Inbox } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { EmptyState } from "@/components/common/empty-state";
import { useModule } from "@/components/shell/module-gate";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { errorMessage } from "@/lib/api";
import { useChannels, useDms } from "@/lib/chat-queries";
import { withoutBotDms } from "@/lib/modules";
import { isUnread } from "../channel-icon";
import { ConversationAvatar, ConversationRow } from "./conversation-row";

type Item =
  | { kind: "channel"; c: ChannelSummary; unread: boolean; at: string }
  | { kind: "dm"; d: DmSummary; unread: boolean; at: string };

/** Re-renders every 30 s so the relative times stay right. */
export function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

/**
 * `/chat/all` (CHAT-02): every conversation the member is in (joined channels, DMs and groups), unread first, then
 * by latest activity, each with a one-line preview. Built from the sidebar's own lists: no extra request, no new
 * subscription (the sidebar watchers keep them live). Bot DMs leave the list once Bots is turned off (07.3).
 */
export function AllView() {
  const channels = useChannels();
  const dms = useDms();
  const now = useMinuteClock();
  const showBots = useModule("bots") !== "off";

  const items = useMemo<Item[]>(() => {
    const out: Item[] = [
      ...(channels.data?.channels ?? [])
        .filter((c) => c.isMember && !c.archivedAt)
        .map((c) => ({
          kind: "channel" as const,
          c,
          unread: isUnread(c),
          at: c.lastMessageAt ?? c.createdAt,
        })),
      ...withoutBotDms(dms.data?.dms ?? [], showBots).map((d) => ({
        kind: "dm" as const,
        d,
        unread: d.latestMessageSeq > d.lastReadSeq,
        at: d.lastMessageAt ?? d.createdAt,
      })),
    ];
    return out.sort((a, b) => Number(b.unread) - Number(a.unread) || Date.parse(b.at) - Date.parse(a.at));
  }, [channels.data, dms.data, showBots]);

  const unread = items.filter((i) => i.unread).length;
  const pending = channels.isPending || dms.isPending;
  const error = channels.error ?? dms.error;

  return (
    <div className="flex min-w-0 flex-1 flex-col" data-testid="all-view">
      <PageHeader
        title="All"
        icon={<Inbox />}
        description={
          unread > 0
            ? `${unread} conversation${unread === 1 ? "" : "s"} with unread messages`
            : "Every conversation you are in, newest first"
        }
      />
      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
        {pending ? (
          <div className="mx-auto grid w-full max-w-3xl gap-2 p-4 sm:p-6">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-14 rounded-lg" />
            ))}
          </div>
        ) : error ? (
          <EmptyState icon={Inbox} title="Couldn't load your conversations" description={errorMessage(error)}>
            <Button
              variant="outline"
              onClick={() => {
                void channels.refetch();
                void dms.refetch();
              }}
            >
              Try again
            </Button>
          </EmptyState>
        ) : items.length === 0 ? (
          <EmptyState
            icon={Inbox}
            title="No conversations yet"
            description="Join a channel or start a direct message; they all show up here."
            className="min-h-full"
          />
        ) : (
          <div className="mx-auto grid w-full max-w-3xl grid-cols-1 gap-px p-2 sm:p-4" data-testid="all-list">
            {items.map((i) =>
              i.kind === "channel" ? (
                <ConversationRow
                  key={i.c.id}
                  testId="all-item"
                  conversationId={i.c.id}
                  href={`/chat/${i.c.id}`}
                  avatar={<ConversationAvatar item={i.c} />}
                  title={i.c.name}
                  meta={
                    i.c.unit ? (
                      <span className="hidden shrink-0 truncate rounded-[4px] bg-muted px-1.5 py-px text-[11px] text-muted-foreground sm:inline">
                        {i.c.unit.name}
                      </span>
                    ) : null
                  }
                  preview={i.c.lastMessagePreview}
                  at={i.c.lastMessageAt}
                  unread={i.unread}
                  now={now}
                />
              ) : (
                <ConversationRow
                  key={i.d.id}
                  testId="all-item"
                  conversationId={i.d.id}
                  href={`/chat/dm/${i.d.id}`}
                  avatar={<ConversationAvatar item={i.d} />}
                  title={i.d.counterpart.name}
                  preview={i.d.lastMessagePreview}
                  at={i.d.lastMessageAt}
                  unread={i.unread}
                  now={now}
                />
              ),
            )}
          </div>
        )}
      </div>
    </div>
  );
}
