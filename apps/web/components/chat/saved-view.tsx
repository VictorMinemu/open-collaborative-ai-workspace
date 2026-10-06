"use client";

import type { ConversationRef, SavedItem } from "@ocw/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { Archive, ArrowUpRight, Bookmark, BookmarkX, Bot, Hash, Lock, Users } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/common/empty-state";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { errorMessage } from "@/lib/api";
import { applySaveUpdate, unsaveMessage, useSaved } from "@/lib/chat-queries";
import { permalinkPath } from "@/lib/permalink";
import { relativeTime } from "@/lib/utils";
import { MessageCard } from "./message-card";

function ConversationIcon({ conversation }: { conversation: ConversationRef }) {
  const Icon =
    conversation.kind === "channel"
      ? conversation.visibility === "private"
        ? Lock
        : Hash
      : conversation.kind === "group"
        ? Users
        : Bot;
  return <Icon className="size-3.5 shrink-0" />;
}

const linkKind = (kind: ConversationRef["kind"]): "channel" | "dm" | "group" =>
  kind === "channel" ? "channel" : kind === "group" ? "group" : "dm";

function SavedRow({ item }: { item: SavedItem }) {
  const qc = useQueryClient();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const { message, conversation } = item;
  const remove = async () => {
    setBusy(true);
    try {
      await unsaveMessage(message.id);
      applySaveUpdate(qc, { messageId: message.id, saved: false });
    } catch (err) {
      toast.error(errorMessage(err));
      setBusy(false);
    }
  };
  return (
    <MessageCard
      testId="saved-item"
      message={message}
      context={
        <span className="flex min-w-0 items-center gap-1.5">
          <ConversationIcon conversation={conversation} />
          <span className="truncate font-medium text-foreground/80" data-testid="saved-conversation">
            {conversation.label}
          </span>
          {conversation.archived ? (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-muted px-1.5 py-px text-[10.5px]">
              <Archive className="size-3" /> Archived
            </span>
          ) : null}
          <span className="shrink-0">· saved {relativeTime(item.savedAt)}</span>
        </span>
      }
      actions={
        <>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => void remove()}
            data-testid="saved-remove"
          >
            <BookmarkX /> Remove
          </Button>
          <Button
            variant="outline"
            size="sm"
            data-testid="saved-jump"
            onClick={() =>
              router.push(
                permalinkPath(
                  { id: conversation.id, kind: linkKind(conversation.kind) },
                  message.id,
                  message.threadId,
                ),
              )
            }
          >
            Jump <ArrowUpRight />
          </Button>
        </>
      }
    />
  );
}

/**
 * `/chat/saved` (CHAT-13): the member's private bookmarks, newest first, only from conversations they can still
 * read (the API decides). Infinite scroll on `nextCursor`; live through the sidebar's `user:` subscription.
 */
export function SavedView() {
  const saved = useSaved();
  const items = saved.data?.pages.flatMap((p) => p.items) ?? [];
  const sentinel = useRef<HTMLDivElement>(null);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = saved;

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
    <div className="flex min-w-0 flex-1 flex-col" data-testid="saved-view">
      <PageHeader
        title="Saved"
        icon={<Bookmark />}
        description="Messages you saved for later. Only you can see this list."
      />
      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
        {saved.isPending ? (
          <div className="mx-auto grid w-full max-w-3xl gap-3 p-4 sm:p-6">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-28 rounded-xl" />
            ))}
          </div>
        ) : saved.isError ? (
          <EmptyState
            icon={Bookmark}
            title="Couldn't load your saved messages"
            description={errorMessage(saved.error)}
          >
            <Button variant="outline" onClick={() => void saved.refetch()}>
              Try again
            </Button>
          </EmptyState>
        ) : items.length === 0 ? (
          <EmptyState
            icon={Bookmark}
            title="Nothing saved yet"
            description="Save a message from its actions to find it here later. Only you can see what you save."
            className="min-h-full"
          />
        ) : (
          <div className="mx-auto grid w-full max-w-3xl gap-3 p-4 sm:p-6" data-testid="saved-list">
            {items.map((item) => (
              <SavedRow key={item.message.id} item={item} />
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
