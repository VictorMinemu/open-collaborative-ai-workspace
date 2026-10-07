"use client";

import { AtSign, Bookmark, Inbox, type LucideIcon, MessagesSquare, Sparkles } from "lucide-react";
import Link from "next/link";
import { sectionItemClass } from "@/components/shell/section-sidebar";
import { useIsDesktop } from "@/hooks/use-media-query";
import { cn } from "@/lib/utils";

/**
 * The chat sidebar's views (CHAT-02, D-08): All, Mentions (the inbox, CHAT-08), Threads, AI Chats and Saved.
 * Desktop: compact rows at the top of the sidebar. 390: a horizontally scrollable segmented row on the sidebar home.
 */

export type ChatViewId = "all" | "mentions" | "threads" | "ai" | "saved";

export const CHAT_VIEWS: ReadonlyArray<{ id: ChatViewId; label: string; href: string; icon: LucideIcon }> = [
  { id: "all", label: "All", href: "/chat/all", icon: Inbox },
  { id: "mentions", label: "Mentions", href: "/chat/mentions", icon: AtSign },
  { id: "threads", label: "Threads", href: "/chat/threads", icon: MessagesSquare },
  { id: "ai", label: "AI Chats", href: "/chat/ai", icon: Sparkles },
  { id: "saved", label: "Saved", href: "/chat/saved", icon: Bookmark },
];

/** AI Chats stays selected inside an AI chat (`/chat/ai/new`, `/chat/ai/<id>`, 05-03); the others match exactly. */
const isActive = (v: (typeof CHAT_VIEWS)[number], path: string) =>
  path === v.href || (v.id === "ai" && path.startsWith(`${v.href}/`));

/** `saved-link` is kept for the Saved entry (04-05 specs); the others are `view-<id>`. */
const testIdOf = (id: ChatViewId) => (id === "saved" ? "saved-link" : `view-${id}`);

function Count({ n, active }: { n: number; active: boolean }) {
  return (
    <span
      data-testid="view-count"
      className={cn(
        "ml-auto min-w-5 shrink-0 rounded-full px-1.5 text-center font-semibold text-[11px] tabular-nums leading-5",
        active ? "bg-primary text-primary-foreground" : "bg-primary/12 text-primary",
      )}
    >
      {n > 99 ? "99+" : n}
    </span>
  );
}

export function SidebarViews({
  activePath,
  counts = {},
}: {
  activePath: string;
  counts?: Partial<Record<string, number>>;
}) {
  const isDesktop = useIsDesktop();

  if (!isDesktop) {
    return (
      <nav
        aria-label="Views"
        data-testid="views-segmented"
        className="-mx-2 mb-3 flex gap-1.5 overflow-x-auto pr-8 pb-0.5 pl-2 [mask-image:linear-gradient(to_right,black_88%,transparent)] [scrollbar-width:none]"
      >
        {CHAT_VIEWS.map((v) => {
          const active = isActive(v, activePath);
          const n = counts[v.id] ?? 0;
          return (
            <Link
              key={v.id}
              href={v.href}
              data-testid={testIdOf(v.id)}
              aria-current={active ? "page" : undefined}
              className={cn(
                "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 font-medium text-[13px] outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/40",
                active
                  ? "border-transparent bg-foreground text-background"
                  : "bg-background text-foreground/80 hover:bg-sidebar-accent dark:bg-sidebar-accent/40",
              )}
            >
              <v.icon className="size-4" />
              {v.label}
              {n > 0 ? (
                <span
                  data-testid="view-count"
                  className={cn(
                    "rounded-full px-1.5 font-semibold text-[11px] tabular-nums leading-[18px]",
                    active ? "bg-background/20" : "bg-primary text-primary-foreground",
                  )}
                >
                  {n > 99 ? "99+" : n}
                </span>
              ) : null}
            </Link>
          );
        })}
      </nav>
    );
  }

  return (
    <nav aria-label="Views" data-testid="views-list" className="mb-3 grid grid-cols-1 gap-px">
      {CHAT_VIEWS.map((v) => {
        const active = isActive(v, activePath);
        const n = counts[v.id] ?? 0;
        return (
          <Link
            key={v.id}
            href={v.href}
            data-testid={testIdOf(v.id)}
            aria-current={active ? "page" : undefined}
            className={sectionItemClass(active)}
          >
            <v.icon className={cn("size-4 shrink-0", active ? "" : "text-muted-foreground")} />
            <span className={cn("truncate", n > 0 && !active && "font-semibold text-foreground")}>
              {v.label}
            </span>
            {n > 0 ? <Count n={n} active={active} /> : null}
          </Link>
        );
      })}
    </nav>
  );
}
