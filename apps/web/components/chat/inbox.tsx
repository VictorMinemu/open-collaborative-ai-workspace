"use client";

import { type ConversationRef, MENTION_TOKEN_RE, type Notification } from "@ocw/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { AtSign, CheckCheck, Hash, Lock, MessageCircle, Users } from "lucide-react";
import Link from "next/link";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/common/empty-state";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { shortAgo } from "@/components/work-zone/session-sidebar";
import { errorMessage } from "@/lib/api";
import {
  markNotificationsRead,
  type NotificationFilter,
  unreadOf,
  useNotifications,
} from "@/lib/notification-queries";
import { permalinkPath } from "@/lib/permalink";
import { useMe } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { MentionChip, MentionContext, type MentionContextValue } from "./markdown";
import { BotBadge, PrincipalAvatar } from "./principal-avatar";
import { useOrgDirectory } from "./use-chat-directory";
import { useMinuteClock } from "./views/all-view";

/** What happened, after the actor's name. */
const KIND_LABEL: Record<Notification["kind"], string> = {
  mention: "mentioned you",
  channel: "notified @channel",
  here: "notified @here",
  dm: "sent you a message",
  group_dm: "wrote in a group",
  thread_reply: "replied in a thread",
};

const FILTERS: Array<{ id: NotificationFilter; label: string }> = [
  { id: "mentions", label: "Mentions" },
  { id: "all", label: "All activity" },
];

function ConversationLabel({ conversation }: { conversation: ConversationRef }) {
  const Icon =
    conversation.kind === "channel"
      ? conversation.visibility === "private"
        ? Lock
        : Hash
      : conversation.kind === "group"
        ? Users
        : MessageCircle;
  return (
    <span data-testid="inbox-conversation" className="flex min-w-0 items-center gap-0.5 text-foreground/75">
      <Icon className="size-3 shrink-0" />
      <span className="truncate">{conversation.label.replace(/^#/, "")}</span>
    </span>
  );
}

/** One line of plain text with @mention chips; nothing else is interpreted (the snippet is not Markdown). */
function SnippetText({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(new RegExp(MENTION_TOKEN_RE.source, "g"))) {
    const handle = (m[2] ?? "").replace(/[._-]+$/, "");
    if (!handle) continue;
    const start = (m.index ?? 0) + (m[1]?.length ?? 0);
    if (start > last) parts.push(text.slice(last, start));
    parts.push(
      <MentionChip key={start} handle={handle.toLowerCase()}>
        @{handle}
      </MentionChip>,
    );
    last = start + 1 + handle.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}

function InboxItem({ n, now, onOpen }: { n: Notification; now: number; onOpen: (n: Notification) => void }) {
  const unread = n.readAt === null;
  return (
    <Link
      href={permalinkPath(
        {
          id: n.conversation.id,
          kind:
            n.conversation.kind === "channel" ? "channel" : n.conversation.kind === "group" ? "group" : "dm",
        },
        n.messageId,
        n.threadRootId,
      )}
      onClick={() => onOpen(n)}
      data-testid="inbox-item"
      data-notification-id={n.id}
      data-message-id={n.messageId}
      data-kind={n.kind}
      data-unread={unread || undefined}
      className={cn(
        "group/item relative flex gap-3 rounded-lg px-3 py-2.5 outline-none transition-colors hover:bg-accent/60 focus-visible:ring-[3px] focus-visible:ring-ring/40",
        unread && "bg-primary/[0.045] dark:bg-primary/[0.08]",
      )}
    >
      <PrincipalAvatar
        kind={n.actor.kind}
        name={n.actor.displayName}
        avatarUrl={n.actor.avatarUrl}
        seed={n.actor.id ?? n.actor.displayName}
        className="mt-0.5 size-9"
      />
      <span className="grid min-w-0 flex-1 gap-0.5">
        <span className="flex min-w-0 items-baseline gap-1.5 text-[13px]">
          <span className="min-w-0 truncate">
            <span
              data-testid="inbox-actor"
              className={cn("font-semibold", unread ? "text-foreground" : "text-foreground/90")}
            >
              {n.actor.displayName}
            </span>
            {n.actor.kind === "agent" ? <BotBadge className="relative -top-px ml-1" /> : null}
            <span className="text-muted-foreground"> {KIND_LABEL[n.kind]}</span>
          </span>
          <time
            dateTime={n.createdAt}
            className={cn(
              "ml-auto shrink-0 pl-2 text-[12px] tabular-nums",
              unread ? "font-medium text-primary" : "text-muted-foreground",
            )}
          >
            {shortAgo(n.createdAt, now)}
          </time>
        </span>
        <span className="flex min-w-0 items-center gap-1 text-[12px] text-muted-foreground">
          <ConversationLabel conversation={n.conversation} />
          {n.threadRootId ? <span className="shrink-0">· thread</span> : null}
        </span>
        <span className="flex min-w-0 items-start gap-2">
          <span
            data-testid="inbox-snippet"
            className={cn(
              "line-clamp-2 min-w-0 flex-1 break-words text-[13.5px] leading-snug",
              unread ? "text-foreground/90" : "text-muted-foreground",
            )}
          >
            <SnippetText text={n.snippet} />
          </span>
          {unread ? (
            <>
              <span className="sr-only">(unread)</span>
              <span
                aria-hidden
                data-testid="inbox-unread-dot"
                className="mt-1.5 size-2 shrink-0 rounded-full bg-primary"
              />
            </>
          ) : null}
        </span>
      </span>
    </Link>
  );
}

/**
 * `/chat/mentions` (CHAT-08): the member's inbox. "Mentions" lists @mentions, @channel and @here; "All activity" adds
 * DMs, group DMs and thread replies. Opening an item marks it read and jumps to the message (permalink). The server
 * only returns what the member can read now, with snippets computed at read time (Pitfall 9); live updates come
 * from the sidebar's `user:` subscription (no subscription of its own, Pitfall 13).
 */
export function Inbox() {
  const qc = useQueryClient();
  const [filter, setFilter] = useState<NotificationFilter>("mentions");
  const list = useNotifications(filter);
  const now = useMinuteClock();
  const me = useMe({ enabled: false });
  const directory = useOrgDirectory();
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  const unread = unreadOf(list.data);
  const sentinel = useRef<HTMLDivElement>(null);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = list;

  const mentionCtx = useMemo<MentionContextValue>(() => {
    const myHandle = me.data ? (directory.byKey.get(`user:${me.data.user.id}`)?.handle ?? null) : null;
    return { handles: directory.handles, myHandle };
  }, [directory, me.data]);

  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasNextPage) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting) && !isFetchingNextPage) void fetchNextPage();
      },
      { rootMargin: "400px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const open = (n: Notification) => {
    if (n.readAt) return;
    markNotificationsRead(qc, { ids: [n.id] }).catch((e: unknown) => toast.error(errorMessage(e)));
  };
  const markAll = () => {
    markNotificationsRead(qc, { all: true }).catch((e: unknown) => toast.error(errorMessage(e)));
  };

  const emptyTitle = filter === "mentions" ? "No mentions yet" : "No activity yet";
  const emptyText =
    filter === "mentions"
      ? "When someone @mentions you, or uses @channel or @here where you are, it shows up here."
      : "Mentions, direct messages and replies in your threads show up here.";

  return (
    <MentionContext.Provider value={mentionCtx}>
      <div className="flex min-w-0 flex-1 flex-col" data-testid="inbox">
        <PageHeader
          title="Mentions"
          icon={<AtSign />}
          description={unread > 0 ? `${unread > 99 ? "99+" : unread} unread` : "You're all caught up"}
          actions={
            unread > 0 ? (
              <Button variant="ghost" size="sm" onClick={markAll} data-testid="inbox-mark-all">
                <CheckCheck />
                <span className="hidden sm:inline">Mark all read</span>
              </Button>
            ) : null
          }
        />
        <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-3xl px-2 pt-3 sm:px-4 sm:pt-4">
            <div
              role="tablist"
              aria-label="Show"
              data-testid="inbox-filter"
              className="inline-flex rounded-lg bg-muted p-0.5 text-[13px]"
            >
              {FILTERS.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  role="tab"
                  aria-selected={filter === f.id}
                  data-testid={`inbox-filter-${f.id}`}
                  onClick={() => setFilter(f.id)}
                  className={cn(
                    "h-7 rounded-md px-3 font-medium outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/40",
                    filter === f.id
                      ? "bg-background text-foreground shadow-xs dark:bg-input/40"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>
          {list.isPending ? (
            <div className="mx-auto grid w-full max-w-3xl gap-2 p-2 sm:p-4">
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-16 rounded-lg" />
              ))}
            </div>
          ) : list.isError ? (
            <EmptyState
              icon={AtSign}
              title="Couldn't load your mentions"
              description={errorMessage(list.error)}
            >
              <Button variant="outline" onClick={() => void list.refetch()}>
                Try again
              </Button>
            </EmptyState>
          ) : items.length === 0 ? (
            <div data-testid="inbox-empty">
              <EmptyState icon={AtSign} title={emptyTitle} description={emptyText} />
            </div>
          ) : (
            <div
              className="mx-auto grid w-full max-w-3xl grid-cols-1 gap-px p-2 sm:p-4"
              data-testid="inbox-list"
            >
              {items.map((n) => (
                <InboxItem key={n.id} n={n} now={now} onOpen={open} />
              ))}
              <div ref={sentinel} aria-hidden className="h-px" />
              {isFetchingNextPage ? (
                <div className="flex justify-center py-3 text-muted-foreground">
                  <Spinner />
                </div>
              ) : null}
            </div>
          )}
        </div>
      </div>
    </MentionContext.Provider>
  );
}
