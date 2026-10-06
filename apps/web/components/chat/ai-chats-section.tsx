"use client";

import { ChevronRight, MessageCircle, SquarePen } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { sectionItemClass } from "@/components/shell/section-sidebar";
import { buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip } from "@/components/ui/tooltip";
import { useAiChats } from "@/lib/ai-chat-queries";
import { cn } from "@/lib/utils";

/** Rows the sidebar shows; the rest are one click away on /chat/ai. */
const SIDEBAR_CHATS = 5;

const ACTIVE_RE = /^\/chat\/ai\/([0-9a-f-]{36})(?:[/?#]|$)/u;

/**
 * "AI chats" in the chat sidebar (05-10, AICHAT-04), under the views: the member's five most recent chats (only they
 * ever see them), "New chat" and "See all". Live: a new chat, a generated title, a rename or an archive arrive as
 * `ai_chat.updated` on the member's `user:` topic (the sidebar's ListSync applies them to the same list cache).
 */
export function AiChatsSection() {
  const pathname = usePathname();
  const list = useAiChats(false);
  const all = (list.data?.pages ?? []).flatMap((p) => p.chats);
  const chats = all.slice(0, SIDEBAR_CHATS);
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
            return (
              <Link
                key={c.id}
                href={`/chat/ai/${c.id}`}
                data-testid="sidebar-ai-chat"
                data-chat-id={c.id}
                aria-current={active ? "page" : undefined}
                className={sectionItemClass(active)}
              >
                <MessageCircle
                  aria-hidden
                  className={cn("size-4 shrink-0", active ? "" : "text-muted-foreground")}
                />
                <span className="truncate">{c.title}</span>
                {c.generating ? (
                  <span className="ml-auto size-1.5 shrink-0 animate-pulse rounded-full bg-primary">
                    <span className="sr-only">Answering</span>
                  </span>
                ) : null}
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
    </section>
  );
}
