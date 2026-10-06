"use client";

import type { ConversationRef, Message, ThreadSummary } from "@ocw/contracts";
import { ArrowUpRight, Hash, Lock, MessagesSquare, Users } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type MouseEvent, useEffect, useRef } from "react";
import { EmptyState } from "@/components/common/empty-state";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { shortAgo } from "@/components/work-zone/session-sidebar";
import { errorMessage } from "@/lib/api";
import { useThreadList } from "@/lib/chat-queries";
import { cn } from "@/lib/utils";
import { Markdown } from "../markdown";
import { BotBadge, PrincipalAvatar } from "../principal-avatar";
import { useMinuteClock } from "./all-view";

const threadHref = (t: ThreadSummary) => `/chat/${t.conversation.id}?thread=${t.root.id}`;

function ConversationLabel({ conversation }: { conversation: ConversationRef }) {
  const Icon =
    conversation.kind === "channel" ? (conversation.visibility === "private" ? Lock : Hash) : Users;
  return (
    <span
      className="flex min-w-0 items-center gap-1 font-medium text-foreground/80"
      data-testid="thread-conversation"
    >
      <Icon className="size-3.5 shrink-0" />
      <span className="truncate">{conversation.label.replace(/^#/, "")}</span>
    </span>
  );
}

function author(m: Message) {
  return m.author ?? { kind: m.authorKind, id: m.authorId, displayName: "Unknown", avatarUrl: null };
}

/** The root, in full (clipped), like a message in its channel. */
function RootMessage({ m, now }: { m: Message; now: number }) {
  const a = author(m);
  return (
    <div className="flex gap-2.5">
      <PrincipalAvatar
        kind={a.kind}
        name={a.displayName}
        avatarUrl={a.avatarUrl}
        seed={a.id}
        className="mt-0.5 size-8"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-1.5">
          <span className="truncate font-semibold text-sm">{a.displayName}</span>
          {a.kind === "agent" ? <BotBadge className="relative -top-px self-center" /> : null}
          <time dateTime={m.createdAt} className="shrink-0 text-muted-foreground text-xs tabular-nums">
            {shortAgo(m.createdAt, now)}
          </time>
        </div>
        {m.deletedAt ? (
          <p className="text-muted-foreground text-sm italic">This message was deleted.</p>
        ) : (
          <div className="max-h-32 overflow-hidden text-[14px]">
            <Markdown body={m.body} />
          </div>
        )}
      </div>
    </div>
  );
}

/** A reply under the root: compact, two lines at most. */
function ReplyLine({ m }: { m: Message }) {
  const a = author(m);
  return (
    <div className="flex gap-2" data-testid="thread-last-reply">
      <PrincipalAvatar
        kind={a.kind}
        name={a.displayName}
        avatarUrl={a.avatarUrl}
        seed={a.id}
        compact
        className="mt-0.5 size-5 text-[10px]"
      />
      <div className="min-w-0 flex-1 text-[13.5px]">
        <span className="mr-1.5 font-semibold">{a.displayName}</span>
        <div className="line-clamp-2 max-h-11 overflow-hidden text-foreground/85 [&_p]:inline">
          <Markdown body={m.body} />
        </div>
      </div>
    </div>
  );
}

function ThreadCard({ t, now }: { t: ThreadSummary; now: number }) {
  const router = useRouter();
  const href = threadHref(t);
  const unread = t.unreadReplies;
  // The whole card opens the thread, except its own links and buttons (mentions, URLs in the body).
  const open = (e: MouseEvent) => {
    if ((e.target as HTMLElement).closest("a,button")) return;
    router.push(href);
  };
  const hiddenReplies = Math.max(0, t.replyCount - (t.lastReplies?.length ?? 0));
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the "Open thread" link is the keyboard path; this is a larger target
    <article
      data-testid="thread-card"
      data-root-id={t.root.id}
      data-unread={unread > 0 || undefined}
      onClick={open}
      className={cn(
        "cursor-pointer rounded-xl border bg-card px-3.5 py-3 shadow-xs transition-colors hover:border-foreground/15",
        unread > 0 && "border-primary/30 ring-1 ring-primary/10",
      )}
    >
      <div className="mb-2 flex min-w-0 items-center gap-2 text-muted-foreground text-xs">
        <ConversationLabel conversation={t.conversation} />
        {unread > 0 ? (
          <span
            data-testid="thread-unread"
            className="ml-auto shrink-0 rounded-full bg-primary px-2 py-px font-semibold text-[11px] text-primary-foreground"
          >
            {unread >= 100 ? "99+" : unread} new {unread === 1 ? "reply" : "replies"}
          </span>
        ) : null}
      </div>
      <RootMessage m={t.root} now={now} />
      {t.lastReplies && t.lastReplies.length > 0 ? (
        <div className="mt-2.5 ml-[18px] grid gap-2 border-l-2 pl-[22px]">
          {hiddenReplies > 0 ? (
            <span className="text-muted-foreground text-xs">
              {hiddenReplies} earlier {hiddenReplies === 1 ? "reply" : "replies"}
            </span>
          ) : null}
          {t.lastReplies.map((r) => (
            <ReplyLine key={r.id} m={r} />
          ))}
        </div>
      ) : null}
      <div className="mt-3 flex items-center gap-2">
        <span className="flex -space-x-1.5" aria-hidden>
          {t.participants.slice(0, 4).map((p) => (
            <PrincipalAvatar
              key={`${p.kind}:${p.id}`}
              kind={p.kind}
              name={p.displayName}
              avatarUrl={p.avatarUrl}
              seed={p.id}
              compact
              className="size-5 text-[9px] ring-2 ring-card"
            />
          ))}
        </span>
        <span className="min-w-0 truncate text-muted-foreground text-xs">
          {t.replyCount} {t.replyCount === 1 ? "reply" : "replies"}
          {t.lastReplyAt ? ` · last ${shortAgo(t.lastReplyAt, now)}` : ""}
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto"
          data-testid="thread-open"
          render={<Link href={href} />}
        >
          Open thread <ArrowUpRight />
        </Button>
      </div>
    </article>
  );
}

/**
 * `/chat/threads` (CHAT-02): threads the member started, replied to or was mentioned in, newest reply first, with
 * unread replies. The API lists them only from conversations the member can read (P-03). No subscription of its
 * own (Pitfall 13): the sidebar's watchers refresh it on `thread.updated`, and it refetches on window focus.
 */
export function ThreadsView() {
  const threads = useThreadList();
  const now = useMinuteClock();
  const items = threads.data?.pages.flatMap((p) => p.threads) ?? [];
  const unread = items.filter((t) => t.unreadReplies > 0).length;
  const sentinel = useRef<HTMLDivElement>(null);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = threads;

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

  return (
    <div className="flex min-w-0 flex-1 flex-col" data-testid="threads-view">
      <PageHeader
        title="Threads"
        icon={<MessagesSquare />}
        description={
          unread > 0
            ? `${unread} thread${unread === 1 ? "" : "s"} with new replies`
            : "Threads you started, replied to or were mentioned in"
        }
      />
      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
        {threads.isPending ? (
          <div className="mx-auto grid w-full max-w-3xl gap-3 p-4 sm:p-6">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-36 rounded-xl" />
            ))}
          </div>
        ) : threads.isError ? (
          <EmptyState
            icon={MessagesSquare}
            title="Couldn't load your threads"
            description={errorMessage(threads.error)}
          >
            <Button variant="outline" onClick={() => void threads.refetch()}>
              Try again
            </Button>
          </EmptyState>
        ) : items.length === 0 ? (
          <EmptyState
            icon={MessagesSquare}
            title="No threads yet"
            description="Reply in a thread, start one, or get mentioned in one; it shows up here with its new replies."
            className="min-h-full"
          />
        ) : (
          <div
            className="mx-auto grid w-full max-w-3xl grid-cols-1 gap-3 p-3 sm:p-6"
            data-testid="threads-list"
          >
            {items.map((t) => (
              <ThreadCard key={t.root.id} t={t} now={now} />
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
  );
}
