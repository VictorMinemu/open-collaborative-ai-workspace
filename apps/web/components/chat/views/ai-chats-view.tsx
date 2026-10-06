"use client";

import type { AiChatSummary } from "@ocw/contracts";
import { Archive, Ellipsis, Sparkles, SquarePen } from "lucide-react";
import Link from "next/link";
import { useMemo, useRef, useState } from "react";
import { AiChatMenu, AiChatStandardItems, AiChatTitleInput } from "@/components/ai-chat/ai-chat-header";
import { PersonalBotButton } from "@/components/bots/personal-bot-button";
import { EmptyState } from "@/components/common/empty-state";
import { PageHeader } from "@/components/shell/page-header";
import { Button, buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { useSheetSurface } from "@/components/work-zone/control-surface";
import { shortAgo } from "@/components/work-zone/session-sidebar";
import { groupAiChats } from "@/lib/ai-chat-groups";
import { useAiChats } from "@/lib/ai-chat-queries";
import { errorMessage } from "@/lib/api";
import { type BotDm, isBotDm, useDms } from "@/lib/chat-queries";
import { cn, formatDate } from "@/lib/utils";
import { useMinuteClock } from "./all-view";
import { ConversationAvatar, ConversationRow } from "./conversation-row";

/**
 * `/chat/ai` (CHAT-02, AICHAT-04): the member's AI chats home. "New chat", the member's private AI chats grouped
 * Today / Previous 7 days / Older (local time) with Rename and Archive per row (a menu on a desktop, a sheet — also
 * on long-press — at 390), the archived ones apart, and below them the bot DMs under "Bots" exactly as before.
 */
export function AiChatsView() {
  const [archived, setArchived] = useState(false);
  const dms = useDms();
  const chats = useAiChats(archived);
  const now = useMinuteClock();
  const bots = (dms.data?.dms ?? []).filter(isBotDm);
  const list = useMemo(() => (chats.data?.pages ?? []).flatMap((p) => p.chats), [chats.data]);
  const groups = useMemo(() => groupAiChats(list, now), [list, now]);
  const nothingAtAll =
    !archived && !chats.isPending && list.length === 0 && !dms.isPending && bots.length === 0;

  return (
    <div className="flex min-w-0 flex-1 flex-col" data-testid="ai-chats-view">
      <PageHeader
        title="AI Chats"
        icon={<Sparkles />}
        description="Your private conversations with AI models and bots"
        actions={
          <>
            {bots.length > 0 ? (
              <Button variant="outline" size="sm" render={<Link href="/bots" />} className="max-sm:hidden">
                Browse bots
              </Button>
            ) : null}
            <Link href="/chat/ai/new" data-testid="ai-new-chat" className={buttonVariants({ size: "sm" })}>
              <SquarePen />
              New chat
            </Link>
          </>
        }
      />
      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
        {nothingAtAll ? (
          <EmptyState
            icon={Sparkles}
            title="No AI chats yet"
            description="Start a private chat with an AI model, message a bot from the Bots page, or create your own personal bot."
            className="min-h-full"
          >
            <Link href="/chat/ai/new" className={buttonVariants()}>
              <SquarePen />
              New chat
            </Link>
            <PersonalBotButton variant="row" className="w-auto" />
            <Button variant="outline" render={<Link href="/bots" />}>
              Browse bots
            </Button>
          </EmptyState>
        ) : (
          <div className="mx-auto grid w-full max-w-3xl grid-cols-1 gap-1 p-2 pb-8 sm:p-4 sm:pb-10">
            <div className="flex items-center justify-between gap-2 px-1 pt-1 pb-1 sm:px-2">
              <h2 className="font-semibold text-[13px] text-muted-foreground">
                {archived ? "Archived chats" : "Your chats"}
              </h2>
              <ListToggle archived={archived} onChange={setArchived} />
            </div>
            <ChatList archived={archived} query={chats} groups={groups} now={now} empty={list.length === 0} />
            {!archived ? <BotsList dms={dms} bots={bots} now={now} /> : null}
          </div>
        )}
      </div>
    </div>
  );
}

function ListToggle({ archived, onChange }: { archived: boolean; onChange: (archived: boolean) => void }) {
  const item = (on: boolean, value: boolean, label: string, testId: string) => (
    <button
      type="button"
      data-testid={testId}
      aria-pressed={on}
      onClick={() => onChange(value)}
      className={cn(
        "inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 font-medium text-[12.5px] outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/30",
        on
          ? "bg-background text-foreground shadow-xs dark:bg-accent"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {value ? <Archive aria-hidden className="size-3.5" /> : null}
      {label}
    </button>
  );
  return (
    <div
      role="group"
      aria-label="Show"
      className="inline-flex items-center gap-0.5 rounded-lg bg-muted p-0.5"
    >
      {item(!archived, false, "Recent", "ai-chats-recent")}
      {item(archived, true, "Archived", "ai-chats-archived")}
    </div>
  );
}

function ChatList({
  archived,
  query,
  groups,
  now,
  empty,
}: {
  archived: boolean;
  query: ReturnType<typeof useAiChats>;
  groups: ReturnType<typeof groupAiChats>;
  now: number;
  empty: boolean;
}) {
  if (query.isPending) {
    return (
      <div className="grid gap-2 px-1 sm:px-0">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-14 rounded-lg" />
        ))}
      </div>
    );
  }
  if (query.isError) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-lg border border-dashed px-4 py-3 text-sm">
        <span className="text-muted-foreground">Couldn't load your chats: {errorMessage(query.error)}</span>
        <Button size="sm" variant="outline" onClick={() => void query.refetch()}>
          Try again
        </Button>
      </div>
    );
  }
  if (empty) {
    return (
      <p
        data-testid={archived ? "ai-chats-archived-empty" : "ai-chats-empty"}
        className="rounded-lg border border-dashed px-4 py-6 text-center text-muted-foreground text-sm"
      >
        {archived
          ? "No archived chats. Archive a chat from its menu to keep this list short."
          : "No AI chats yet. Start one with New chat — only you can see it."}
      </p>
    );
  }
  return (
    <div data-testid="ai-chat-groups" className="grid gap-3">
      {groups.map((g) => (
        <section key={g.key} data-testid="ai-chat-group" data-group={g.key} aria-label={g.label}>
          <h3 className="px-3 pt-1 pb-1 font-medium text-[11.5px] text-muted-foreground uppercase tracking-wider">
            {g.label}
          </h3>
          <div className="grid grid-cols-1 gap-px">
            {g.chats.map((c) => (
              <AiChatRow key={c.id} chat={c} now={now} />
            ))}
          </div>
        </section>
      ))}
      {query.hasNextPage ? (
        <div className="flex justify-center pt-1">
          <Button
            variant="outline"
            size="sm"
            data-testid="ai-chats-more"
            disabled={query.isFetchingNextPage}
            onClick={() => void query.fetchNextPage()}
          >
            {query.isFetchingNextPage ? <Spinner /> : null}
            Load more
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** Press-and-hold on a phone opens the row's sheet (the click that follows is swallowed). */
function useLongPress(enabled: boolean, onLongPress: () => void) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fired = useRef(false);
  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  if (!enabled) return {};
  return {
    onPointerDown: (e: React.PointerEvent) => {
      if (e.pointerType === "mouse") return;
      fired.current = false;
      clear();
      timer.current = setTimeout(() => {
        fired.current = true;
        onLongPress();
      }, 500);
    },
    onPointerUp: clear,
    onPointerMove: clear,
    onPointerCancel: clear,
    onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
    onClickCapture: (e: React.MouseEvent) => {
      if (fired.current) {
        e.preventDefault();
        e.stopPropagation();
        fired.current = false;
      }
    },
  };
}

function AiChatRow({ chat, now }: { chat: AiChatSummary; now: number }) {
  const [editing, setEditing] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const sheet = useSheetSurface();
  const press = useLongPress(sheet, () => setMenuOpen(true));

  const icon = (
    <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-brand-soft text-brand-soft-foreground">
      <Sparkles aria-hidden className="size-4" />
    </span>
  );

  return (
    <div
      data-testid="ai-chat-row"
      data-chat-id={chat.id}
      className={cn(
        "group/row flex min-w-0 items-center gap-1 rounded-lg transition-colors hover:bg-accent/60",
        (menuOpen || editing) && "bg-accent/60",
      )}
    >
      {editing ? (
        <div className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2.5">
          {icon}
          <AiChatTitleInput chat={chat} onDone={() => setEditing(false)} testId="ai-chat-row-title-input" />
        </div>
      ) : (
        <Link
          href={`/chat/ai/${chat.id}`}
          className="flex min-w-0 flex-1 select-none items-center gap-3 rounded-lg px-3 py-2.5 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40 [-webkit-touch-callout:none]"
          {...press}
        >
          {icon}
          <span className="grid min-w-0 flex-1 gap-0.5">
            <span className="flex min-w-0 items-center gap-2">
              <span
                data-testid="ai-chat-row-title"
                className="min-w-0 truncate font-medium text-[14.5px] text-foreground/90"
              >
                {chat.title}
              </span>
              <time
                dateTime={chat.lastActivityAt}
                title={formatDate(chat.lastActivityAt)}
                className="ml-auto shrink-0 pl-2 text-[12px] text-muted-foreground tabular-nums"
              >
                {shortAgo(chat.lastActivityAt, now)}
              </time>
            </span>
            <span className="flex min-w-0 items-center gap-1.5 text-[12.5px] text-muted-foreground">
              {chat.lastModelLabel ? (
                <span
                  data-testid="ai-chat-row-model"
                  className="min-w-0 truncate rounded-[4px] bg-muted px-1.5 py-px font-medium text-[11px]"
                >
                  {chat.lastModelLabel}
                </span>
              ) : null}
              {chat.generating ? <span className="shrink-0">Answering…</span> : null}
            </span>
          </span>
        </Link>
      )}
      <AiChatMenu
        open={menuOpen}
        onOpenChange={setMenuOpen}
        title={chat.title}
        testId="ai-chat-row-menu"
        trigger={
          <button
            type="button"
            aria-label={`Options for ${chat.title}`}
            data-testid="ai-chat-row-menu-button"
            className={cn(
              buttonVariants({ variant: "ghost", size: "icon-sm" }),
              "mr-1.5 shrink-0 text-muted-foreground sm:opacity-0 sm:focus-visible:opacity-100 sm:group-hover/row:opacity-100 data-popup-open:opacity-100",
              editing && "hidden",
            )}
          >
            <Ellipsis />
          </button>
        }
      >
        <AiChatStandardItems chat={chat} onRename={() => setEditing(true)} />
      </AiChatMenu>
    </div>
  );
}

/** The bot DMs (Phase 4), unchanged: personal bot first, then by latest activity, as the sidebar orders them. */
function BotsList({ dms, bots, now }: { dms: ReturnType<typeof useDms>; bots: BotDm[]; now: number }) {
  if (dms.isPending) {
    return (
      <div className="mt-4 grid gap-2">
        <Skeleton className="h-14 rounded-lg" />
      </div>
    );
  }
  if (dms.isError) {
    return (
      <div className="mt-4 flex items-center justify-between gap-3 rounded-lg border border-dashed px-4 py-3 text-sm">
        <span className="text-muted-foreground">Couldn't load your bots: {errorMessage(dms.error)}</span>
        <Button size="sm" variant="outline" onClick={() => void dms.refetch()}>
          Try again
        </Button>
      </div>
    );
  }
  if (bots.length === 0) return null;
  return (
    <section aria-labelledby="ai-bots-heading" className="mt-5">
      <div className="flex items-center justify-between gap-2 px-1 pb-1 sm:px-2">
        <h2 id="ai-bots-heading" className="font-semibold text-[13px] text-muted-foreground">
          Bots
        </h2>
        <Link href="/bots" className="font-medium text-[12.5px] text-primary hover:underline">
          Browse bots
        </Link>
      </div>
      <div className="grid grid-cols-1 gap-px" data-testid="ai-chats-list">
        {bots.map((d) => (
          <ConversationRow
            key={d.id}
            testId="ai-chat-item"
            conversationId={d.id}
            href={`/chat/dm/${d.id}`}
            avatar={<ConversationAvatar item={d} />}
            title={d.counterpart.name}
            meta={
              <span
                className={cn(
                  "shrink-0 rounded-[4px] px-1.5 py-px font-medium text-[11px]",
                  d.counterpart.scope === "personal"
                    ? "bg-brand-soft text-brand-soft-foreground"
                    : "bg-muted text-muted-foreground",
                )}
              >
                {d.counterpart.scope === "personal" ? "Personal" : "Team"}
              </span>
            }
            preview={d.lastMessagePreview}
            at={d.lastMessageAt}
            unread={d.latestMessageSeq > d.lastReadSeq}
            now={now}
          />
        ))}
      </div>
    </section>
  );
}
