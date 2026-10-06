"use client";

import type { ChannelSummary, Message } from "@ocw/contracts";
import { MessagesSquare, X } from "lucide-react";
import { useCallback } from "react";
import { toast } from "sonner";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { useIsDesktop } from "@/hooks/use-media-query";
import { useThread } from "@/lib/chat-queries";
import { permalinkPath } from "@/lib/permalink";
import { Composer, type MentionCandidate } from "./composer";
import { MessageList, type PendingMessage } from "./message-list";
import { PrincipalAvatar } from "./principal-avatar";
import { type Typer, TypingIndicator } from "./typing";
import { useCentreOnce } from "./use-permalink-window";
import { useStickToBottom } from "./use-stick-to-bottom";

interface ThreadPanelProps {
  channel: ChannelSummary;
  rootId: string;
  me: { id: string; name: string };
  candidates: MentionCandidate[];
  typers: Typer[];
  pending: PendingMessage[];
  canPost: boolean;
  onClose: () => void;
  onSend: (body: string, threadRootId: string) => void;
  onRetry: (p: PendingMessage) => void;
  onTyping: (threadRootId: string) => void;
  /** A permalink to a reply of this thread (`m` with `thread`): scrolled to and highlighted (CHAT-14). */
  highlightId?: string | null;
}

function ThreadBody({
  channel,
  rootId,
  me,
  candidates,
  typers,
  pending,
  canPost,
  onClose,
  onSend,
  onRetry,
  onTyping,
  highlightId = null,
}: ThreadPanelProps) {
  const thread = useThread(rootId);
  const replies = thread.data?.replies ?? [];
  const myPending = pending.filter((p) => p.threadRootId === rootId);
  const threadTypers = typers.filter((t) => t.threadRootId === rootId);
  const scroll = useStickToBottom(`${replies.length}:${myPending.length}:${threadTypers.length}`, rootId);
  const participants = thread.data?.participants ?? [];
  // Centre the linked reply once it rendered; a deleted one is gone from the list (P-05), so say so instead.
  useCentreOnce(scroll, highlightId, highlightId);
  const onReplyHidden = useCallback(() => toast("This message was deleted"), []);
  // Replies link to the thread form (`?thread=<root>&m=<reply>`); the root links as a channel message.
  const linkFor = useCallback(
    (m: Message) => permalinkPath({ id: channel.id, kind: "channel" }, m.id, m.threadId),
    [channel.id],
  );

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="thread-panel">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b px-4">
        <MessagesSquare className="size-[18px] shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <h2 className="font-semibold text-[15px] leading-tight tracking-tight">Thread</h2>
          <p className="truncate text-muted-foreground text-xs">#{channel.name}</p>
        </div>
        {participants.length > 0 ? (
          <div className="flex -space-x-1.5" role="img" aria-label={`${participants.length} participants`}>
            {participants.slice(0, 4).map((p) => (
              <PrincipalAvatar
                key={`${p.kind}:${p.id}`}
                kind={p.kind}
                name={p.displayName}
                avatarUrl={p.avatarUrl}
                seed={p.id}
                compact
                className="size-6 text-[10px] ring-2 ring-background"
              />
            ))}
          </div>
        ) : null}
        <button
          type="button"
          aria-label="Close thread"
          data-testid="close-thread"
          onClick={onClose}
          className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40"
        >
          <X className="size-4" />
        </button>
      </header>

      <div
        ref={scroll.ref}
        onScroll={scroll.onScroll}
        className="scrollbar-thin min-h-0 flex-1 overflow-y-auto"
      >
        {thread.isPending ? (
          <div className="grid gap-3 p-5">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-4 w-4/5" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        ) : thread.isError ? (
          <p className="p-6 text-center text-muted-foreground text-sm">This thread is no longer available.</p>
        ) : thread.data ? (
          <>
            <MessageList
              messages={[thread.data.root]}
              pending={[]}
              me={me}
              typers={[]}
              onRetry={onRetry}
              showThreadSummary={false}
              readOnly={!!channel.archivedAt}
              canDeleteAny={channel.viewerCan?.includes("message.delete_any") ?? false}
              showTombstones
              anchorId={highlightId}
              linkFor={linkFor}
            />
            <div className="flex items-center gap-3 px-4 py-1.5 sm:px-5" data-testid="thread-reply-count">
              <span className="text-muted-foreground text-xs">
                {thread.data.root.replyCount === 0
                  ? "No replies yet"
                  : `${thread.data.root.replyCount} ${thread.data.root.replyCount === 1 ? "reply" : "replies"}`}
              </span>
              <div className="h-px flex-1 bg-border" />
            </div>
            <MessageList
              startDay={thread.data.root.createdAt}
              messages={replies}
              pending={myPending}
              me={me}
              typers={[]}
              onRetry={onRetry}
              showThreadSummary={false}
              readOnly={!!channel.archivedAt}
              canDeleteAny={channel.viewerCan?.includes("message.delete_any") ?? false}
              anchorId={highlightId}
              linkFor={linkFor}
              onAnchorHidden={onReplyHidden}
            />
          </>
        ) : null}
      </div>

      <TypingIndicator typers={threadTypers} />
      <div className="shrink-0 px-4 pb-[max(env(safe-area-inset-bottom),12px)] sm:px-5">
        <Composer
          testId="thread-composer"
          placeholder={canPost ? "Reply…" : "Join the channel to reply"}
          disabled={!canPost}
          candidates={candidates}
          autoFocus
          onTyping={() => onTyping(rootId)}
          onSend={(body) => {
            scroll.scrollToBottom();
            onSend(body, rootId);
          }}
        />
      </div>
    </div>
  );
}

/** Desktop: side panel next to the channel. Mobile: full-screen sheet. */
export function ThreadPanel(props: ThreadPanelProps) {
  const isDesktop = useIsDesktop();
  if (isDesktop) {
    return (
      <aside className="flex w-[min(420px,42vw)] shrink-0 flex-col border-l bg-background lg:w-[440px]">
        <ThreadBody {...props} />
      </aside>
    );
  }
  return (
    <Sheet open onOpenChange={(o) => !o && props.onClose()}>
      <SheetContent side="right" showClose={false} className="w-full max-w-none border-l-0 p-0">
        <SheetTitle className="sr-only">Thread</SheetTitle>
        <ThreadBody {...props} />
      </SheetContent>
    </Sheet>
  );
}
