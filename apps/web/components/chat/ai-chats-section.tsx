"use client";

import type { AiChatSummary } from "@ocw/contracts";
import { ChevronRight, MessageCircle, MessagesSquare, SquarePen } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { sectionItemClass } from "@/components/shell/section-sidebar";
import { buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip } from "@/components/ui/tooltip";
import { useAiChats, useSharedAiChats } from "@/lib/ai-chat-queries";
import { cn } from "@/lib/utils";
import { ConversationBadge } from "./conversation-badge";

/** Rows the sidebar shows; the rest are one click away on /chat/ai. */
const SIDEBAR_CHATS = 5;

const ACTIVE_RE = /^\/chat\/ai\/([0-9a-f-]{36})(?:[/?#]|$)/u;

/**
 * "AI chats" in the chat sidebar (05-10, AICHAT-04), under the views: the member's five most recent chats (only they
 * ever see them), "New chat" and "See all". Live: a new chat, a generated title, a rename or an archive arrive as
 * `ai_chat.updated` on the member's `user:` topic (the sidebar's ListSync applies them to the same list cache).
 * Under them, "Shared with me" (06-03): up to five chats other members shared in place, each with its owner's name;
 * only when there is one. A new grant arrives live on the same topic. 06-08: shared chats the member takes part in
 * show their unread count (cleared when opened) and the "Answering" dot, from per-recipient `ai_chat.updated`.
 */
export function AiChatsSection() {
  const pathname = usePathname();
  const list = useAiChats(false);
  const all = (list.data?.pages ?? []).flatMap((p) => p.chats);
  const chats = all.slice(0, SIDEBAR_CHATS);
  const sharedList = useSharedAiChats();
  const shared = (sharedList.data?.pages ?? []).flatMap((p) => p.chats).slice(0, SIDEBAR_CHATS);
  const activeId = ACTIVE_RE.exec(pathname)?.[1] ?? null;

  return (
    <section aria-labelledby="ai-chats-heading" className="mb-4" data-testid="sidebar-ai-chats">
      <div className="flex h-8 items-center justify-between gap-2 px-2">
        <h3
          id="ai-chats-heading"
          className="truncate font-semibold text-[11.5px] text-muted-foreground uppercase tracking-wider"
        >
          AI chats
        </h3>
        <Tooltip content="New chat">
          <Link
            href="/chat/ai/new"
            aria-label="New chat"
            data-testid="sidebar-ai-new-chat"
            className={buttonVariants({ variant: "ghost", size: "icon-xs" })}
          >
            <SquarePen />
          </Link>
        </Tooltip>
      </div>
      {list.isPending ? (
        <div className="grid gap-1.5 px-2.5 pt-1">
          <Skeleton className="h-5" style={{ width: "70%" }} />
        </div>
      ) : (
        <nav aria-label="AI chats" className="grid grid-cols-1 gap-px">
          {chats.map((c) => {
            const active = c.id === activeId;
            const unread = unreadOf(c, active);
            return (
              <Link
                key={c.id}
                href={`/chat/ai/${c.id}`}
                data-testid="sidebar-ai-chat"
                data-chat-id={c.id}
                data-unread={unread > 0 || undefined}
                aria-current={active ? "page" : undefined}
                className={cn(sectionItemClass(active), unread > 0 && "font-semibold text-foreground")}
              >
                <MessageCircle
                  aria-hidden
                  className={cn("size-4 shrink-0", active ? "" : "text-muted-foreground")}
                />
                <span className="truncate">{c.title}</span>
                <RowStatus generating={c.generating} unread={unread} />
              </Link>
            );
          })}
          {chats.length === 0 ? (
            <Link
              href="/chat/ai/new"
              data-testid="sidebar-ai-new-chat-row"
              className={cn(sectionItemClass(false), "text-muted-foreground")}
            >
              <span className="flex size-4 items-center justify-center rounded-[4px] bg-muted">
                <SquarePen className="size-3" />
              </span>
              New chat
            </Link>
          ) : (
            <Link
              href="/chat/ai"
              data-testid="sidebar-ai-see-all"
              className={cn(sectionItemClass(false), "text-muted-foreground")}
            >
              <ChevronRight aria-hidden className="size-4 shrink-0" />
              See all
            </Link>
          )}
        </nav>
      )}
      {shared.length > 0 ? <SharedWithMe chats={shared} activeId={activeId} /> : null}
    </section>
  );
}

/** Chats shared with the member: the title, and whose chat it is on a second, quieter line. */
function SharedWithMe({ chats, activeId }: { chats: AiChatSummary[]; activeId: string | null }) {
  return (
    <div data-testid="sidebar-ai-shared" className="mt-2">
      <h4
        id="ai-shared-heading"
        className="flex h-7 items-center px-2.5 font-medium text-[12px] text-muted-foreground"
      >
        Shared with me
      </h4>
      <nav aria-labelledby="ai-shared-heading" className="grid grid-cols-1 gap-px">
        {chats.map((c) => {
          const active = c.id === activeId;
          const unread = unreadOf(c, active);
          return (
            <Link
              key={c.id}
              href={`/chat/ai/${c.id}`}
              data-testid="sidebar-ai-shared-chat"
              data-chat-id={c.id}
              data-unread={unread > 0 || undefined}
              aria-current={active ? "page" : undefined}
              className={cn(sectionItemClass(active), "h-auto min-h-8 items-start py-1.5")}
            >
              <MessagesSquare
                aria-hidden
                className={cn("mt-0.5 size-4 shrink-0", active ? "" : "text-muted-foreground")}
              />
              <span className="grid min-w-0 flex-1 leading-tight">
                <span className={cn("truncate", unread > 0 && "font-semibold text-foreground")}>
                  {c.title}
                </span>
                {c.owner ? (
                  <span className="truncate font-normal text-[12px] text-muted-foreground">
                    {c.owner.displayName}
                  </span>
                ) : null}
              </span>
              {/* 06-08: every participant hears when an answer starts and ends (per-recipient summaries). */}
              <RowStatus generating={c.generating} unread={unread} className="mt-px self-start" />
            </Link>
          );
        })}
      </nav>
    </div>
  );
}

/** Unread messages of a shared chat the member takes part in (06-08); never on the chat on screen, never on solo ones. */
function unreadOf(c: AiChatSummary, active: boolean): number {
  return active ? 0 : (c.unreadCount ?? 0);
}

/** The unread badge (shared chats), else the "Answering" dot while an answer runs. */
function RowStatus({
  generating,
  unread,
  className,
}: {
  generating: boolean;
  unread: number;
  className?: string;
}) {
  if (unread > 0) {
    return (
      <ConversationBadge
        level="default"
        muted={false}
        unreadCount={unread}
        mentionCount={0}
        className={className}
      />
    );
  }
  if (!generating) return null;
  return (
    <span
      className={cn(
        "ml-auto size-1.5 shrink-0 animate-pulse rounded-full bg-primary",
        className && "mt-1.5 self-start",
      )}
    >
      <span className="sr-only">Answering</span>
    </span>
  );
}
