"use client";

import {
  type AgentTypingEvent,
  EphemeralTypes,
  EventTypes,
  type Message,
  type MessageCreatedEvent,
  type MessageDeletedEvent,
  type MessageUpdatedEvent,
} from "@ocw/contracts";
import type { TopicFrame } from "@ocw/realtime-client";
import { useQueryClient } from "@tanstack/react-query";
import { Bot, Gauge, Lock, NotebookPen, Settings2, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { BotSettingsSheet } from "@/components/bots/bot-settings-sheet";
import { MemoryPanel } from "@/components/bots/memory-panel";
import { EmptyState } from "@/components/common/empty-state";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip } from "@/components/ui/tooltip";
import { errorMessage, isApiError } from "@/lib/api";
import { useAgents } from "@/lib/bots-queries";
import { capabilityKeys, useBotCapabilities, useBotMemories } from "@/lib/capability-queries";
import {
  applyMessage,
  applyMessageDeleted,
  applyMessageUpdate,
  bumpDmLatest,
  chatKeys,
  isBotDm,
  markDmRead,
  postMessage,
  useDms,
  useMessages,
} from "@/lib/chat-queries";
import { parsePermalink, permalinkPath } from "@/lib/permalink";
import { useMe } from "@/lib/queries";
import { useTopic } from "@/lib/realtime";
import { cn } from "@/lib/utils";
import { Composer } from "./composer";
import { JumpToLatest } from "./jump-to-latest";
import { MessageList, type PendingMessage } from "./message-list";
import { MessageUnavailable } from "./message-unavailable";
import { PrincipalAvatar } from "./principal-avatar";
import { TypingIndicator, useTypers } from "./typing";
import { useCentreOnce, usePermalinkWindow, useWindowPaging } from "./use-permalink-window";
import { useStickToBottom } from "./use-stick-to-bottom";

function newId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function DmSkeleton() {
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b px-4 sm:px-6">
        <Skeleton className="size-8 rounded-[30%]" />
        <Skeleton className="h-4 w-40" />
      </header>
      <div className="flex flex-1 flex-col justify-end gap-5 px-5 pb-6">
        {[55, 80].map((w) => (
          <div key={w} className="flex gap-3">
            <Skeleton className="size-9 rounded-full" />
            <div className="grid flex-1 gap-2">
              <Skeleton className="h-3.5 w-28" />
              <Skeleton className="h-3.5" style={{ width: `${w}%` }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * A private direct conversation with a bot (D-03/D-04): flat (no threads), the bot answers every message
 * without an @mention, and only the caller can read it. Same optimistic send/retry as the channel view.
 */
export function DmView({ conversationId }: { conversationId: string }) {
  const qc = useQueryClient();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // A permalink (CHAT-14): DMs are flat, so `m` is always a top-level message.
  const { messageId: permalinkId } = parsePermalink(searchParams);
  const meQ = useMe({ enabled: false });
  const me = useMemo(
    () => ({ id: meQ.data?.user.id ?? "", name: meQ.data?.user.name ?? "You" }),
    [meQ.data?.user.id, meQ.data?.user.name],
  );

  const dms = useDms();
  const dm = dms.data?.dms.find((d) => d.id === conversationId);
  const bot = dm && isBotDm(dm) ? dm.counterpart : undefined;
  const [lost, setLost] = useState(false);
  const messages = useMessages(conversationId, !!dm && !lost);
  const { typers, touch, clear } = useTypers();
  const [pending, setPending] = useState<PendingMessage[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Bot settings for whoever may configure this bot (its owner; a team bot's managers), per the API.
  const agents = useAgents();
  const canConfigure = !!agents.data?.agents
    .find((a) => a.id === bot?.id)
    ?.viewerCan?.includes("bot.configure");
  const capabilities = useBotCapabilities(canConfigure && bot ? bot.id : null);
  // What the bot remembers about the caller (D-10): the caller's own notes, shown while memory is on or any
  // note exists (a bot whose memory was switched off still lets its human see and clear what it kept).
  const memories = useBotMemories(bot && !lost ? bot.id : null);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const memoryOn = capabilities.data ? capabilities.data.effective.memory.effective : undefined;
  const showMemory = memoryOn === true || (memories.data?.items.length ?? 0) > 0;

  // ---------------------------------------------------------------- permalink window (CHAT-14)
  const win = usePermalinkWindow({
    convId: conversationId,
    tail: messages.data,
    permalinkId,
    linkedTop: permalinkId,
  });
  const { detached, shown } = win;

  // ---------------------------------------------------------------- realtime
  const onFrame = (frame: TopicFrame) => {
    if (frame.op === "eph") {
      if (frame.type === EphemeralTypes.agentTyping) {
        const d = frame.data as AgentTypingEvent;
        touch({ kind: "agent", id: d.agentId, name: d.displayName, threadRootId: null });
      }
      return;
    }
    if (frame.type === EventTypes.messageUpdated) {
      applyMessageUpdate(qc, (frame.data as MessageUpdatedEvent).message);
      return;
    }
    if (frame.type === EventTypes.messageDeleted) {
      applyMessageDeleted(qc, frame.data as MessageDeletedEvent);
      return;
    }
    if (frame.type !== EventTypes.messageCreated) return;
    const { message } = frame.data as MessageCreatedEvent;
    applyMessage(qc, message);
    if (message.authorKind !== "system") clear(message.authorKind, message.authorId);
    // A bot reply is one more turn today: refresh the usage chip.
    if (message.authorKind === "agent" && canConfigure && bot) {
      void qc.invalidateQueries({ queryKey: capabilityKeys.bot(bot.id) });
    }
    // The reply may come after the bot saved a note: refresh what it remembers.
    if (message.authorKind === "agent" && bot) {
      void qc.invalidateQueries({ queryKey: capabilityKeys.memories(bot.id) });
    }
    if (!message.threadId) {
      bumpDmLatest(qc, conversationId, message.seq, message.createdAt);
      if (document.visibilityState === "visible") markDmRead(qc, conversationId, message.seq);
    }
  };
  useTopic(
    messages.data && !lost ? `conv:${conversationId}` : null,
    onFrame,
    messages.data?.lastSeq,
    () => void qc.invalidateQueries({ queryKey: chatKeys.messages(conversationId) }),
    {
      onRevoked: () => {
        setLost(true);
        void qc.invalidateQueries({ queryKey: chatKeys.dms });
        qc.removeQueries({ queryKey: chatKeys.messages(conversationId) });
      },
    },
  );

  // ---------------------------------------------------------------- read cursor
  const lastSeq = messages.data?.messages.at(-1)?.seq ?? 0;
  useEffect(() => {
    if (!lastSeq) return;
    const mark = () => document.visibilityState === "visible" && markDmRead(qc, conversationId, lastSeq);
    mark();
    document.addEventListener("visibilitychange", mark);
    return () => document.removeEventListener("visibilitychange", mark);
  }, [qc, conversationId, lastSeq]);

  // ---------------------------------------------------------------- sending
  const scroll = useStickToBottom(
    `${detached ? "window" : "tail"}:${shown?.messages.length ?? 0}:${pending.length}:${typers.length}`,
    conversationId,
    detached,
  );
  // A deleted target hidden by P-05 lands on its nearest visible neighbour, without a highlight.
  const [fallback, setFallback] = useState<{ link: string; target: string | null } | null>(null);
  const onAnchorHidden = useCallback(
    (neighbourId: string | null) => {
      if (!permalinkId) return;
      toast("This message was deleted");
      setFallback({ link: permalinkId, target: neighbourId });
    },
    [permalinkId],
  );
  const fallbackTarget = fallback && fallback.link === permalinkId ? fallback.target : null;
  useCentreOnce(scroll, permalinkId, fallbackTarget ?? win.centreTarget);

  const { release } = win;
  const jumpToLatest = useCallback(() => {
    release();
    scroll.scrollToBottom();
    router.replace(pathname, { scroll: false });
  }, [release, scroll, router, pathname]);

  const linkFor = useCallback(
    (m: Message) => permalinkPath({ id: conversationId, kind: "dm" }, m.id),
    [conversationId],
  );

  const deliver = useCallback(
    async (p: PendingMessage) => {
      try {
        const msg = await postMessage(conversationId, { body: p.body, clientMessageId: p.clientMessageId });
        applyMessage(qc, msg);
        setPending((prev) => prev.filter((x) => x.clientMessageId !== p.clientMessageId));
        markDmRead(qc, conversationId, msg.seq);
      } catch (err) {
        setPending((prev) =>
          prev.map((x) => (x.clientMessageId === p.clientMessageId ? { ...x, failed: true } : x)),
        );
        toast.error(errorMessage(err));
      }
    },
    [conversationId, qc],
  );

  const send = useCallback(
    (body: string) => {
      const p: PendingMessage = {
        clientMessageId: newId(),
        body,
        threadRootId: null,
        failed: false,
        createdAt: new Date().toISOString(),
      };
      // Posting from old history returns to the live tail, where the message appears.
      if (detached) jumpToLatest();
      scroll.scrollToBottom();
      setPending((prev) => [...prev, p]);
      void deliver(p);
    },
    [deliver, scroll, detached, jumpToLatest],
  );

  const retry = useCallback(
    (p: PendingMessage) => {
      setPending((prev) =>
        prev.map((x) => (x.clientMessageId === p.clientMessageId ? { ...x, failed: false } : x)),
      );
      void deliver({ ...p, failed: false });
    },
    [deliver],
  );

  // ---------------------------------------------------------------- older / newer pages
  const { onScroll, loadingOlder, loadingNewer } = useWindowPaging({
    convId: conversationId,
    scroll,
    shown,
    windowId: win.windowId,
    detached,
  });

  // ---------------------------------------------------------------- render
  if (lost || (dms.isSuccess && !dm) || win.unavailable) {
    // A permalink never says whether the conversation exists (T-04-03-01).
    if (permalinkId && !lost) return <MessageUnavailable />;
    return (
      <div className="flex min-w-0 flex-1 flex-col" data-testid="dm-missing">
        <PageHeader title="Private chat" icon={<Lock />} />
        <EmptyState
          icon={Lock}
          title="This chat isn't available"
          description="It may have been closed, or the link belongs to someone else's private chat."
        >
          <Button render={<Link href="/chat" />}>Back to chat</Button>
        </EmptyState>
      </div>
    );
  }
  if (dms.isError) {
    return (
      <div className="flex min-w-0 flex-1 flex-col">
        <PageHeader title="Private chat" icon={<Bot />} />
        <EmptyState icon={Bot} title="Couldn't load this chat" description={errorMessage(dms.error)}>
          <Button variant="outline" onClick={() => void dms.refetch()}>
            Try again
          </Button>
        </EmptyState>
      </div>
    );
  }
  if (!dm || !bot) return <DmSkeleton />;

  const personal = bot.scope === "personal";
  const privacyLine = personal
    ? "Personal bot · only you can see this chat"
    : "Private chat · only you can see it";
  const disabled = bot.status === "disabled";

  const intro =
    shown && shown.nextBefore === null ? (
      <div className="px-4 pt-10 pb-4 sm:px-5" data-testid="dm-intro">
        <PrincipalAvatar
          kind="agent"
          name={bot.name}
          avatarUrl={bot.avatarUrl}
          seed={bot.id}
          className="size-14 text-2xl"
        />
        <h2 className="mt-3 font-semibold text-xl tracking-tight">
          {personal ? `Your personal bot, ${bot.name}` : `Your private chat with ${bot.name}`}
        </h2>
        <p className="mt-1 max-w-xl text-muted-foreground text-sm">
          {bot.name} answers every message here, no @mention needed.
        </p>
        <p className="mt-3 inline-flex max-w-xl items-start gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-muted-foreground text-xs">
          <ShieldCheck className="mt-px size-3.5 shrink-0 text-primary" />
          <span>Nobody else can read this conversation — not other members, not admins.</span>
        </p>
      </div>
    ) : null;

  return (
    <div className="flex min-w-0 flex-1" data-testid="dm-view" data-conversation-id={dm.id}>
      <div className="flex min-w-0 flex-1 flex-col">
        <PageHeader
          icon={
            <PrincipalAvatar
              kind="agent"
              name={bot.name}
              avatarUrl={bot.avatarUrl}
              seed={bot.id}
              className="size-8 text-base"
            />
          }
          title={<span data-testid="dm-title">{bot.name}</span>}
          description={
            // Inline (not inline-flex) so a narrow header ellipsizes the line instead of clipping it.
            <span data-testid="dm-privacy">
              <Lock className="mr-1 inline-block size-3 align-[-1px]" aria-hidden />
              {privacyLine}
            </span>
          }
          actions={
            canConfigure || showMemory ? (
              <>
                {showMemory ? (
                  <Tooltip content={`What ${bot.name} remembers about you`}>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`What ${bot.name} remembers about you`}
                      data-testid="bot-memory"
                      onClick={() => setMemoryOpen(true)}
                      className="max-sm:w-8 max-sm:px-0!"
                    >
                      <NotebookPen />
                      <span className="max-sm:sr-only">Memory</span>
                    </Button>
                  </Tooltip>
                ) : null}
                {canConfigure && capabilities.data ? (
                  <button
                    type="button"
                    onClick={() => setSettingsOpen(true)}
                    data-testid="dm-usage"
                    aria-label={`${capabilities.data.usage.today} of ${capabilities.data.usage.limit} replies used today`}
                    className={cn(
                      "hidden h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs tabular-nums outline-none transition-colors hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/40 sm:inline-flex",
                      capabilities.data.usage.today >= capabilities.data.usage.limit
                        ? "border-destructive/30 text-destructive"
                        : "text-muted-foreground",
                    )}
                  >
                    <Gauge className="size-3.5" aria-hidden />
                    {capabilities.data.usage.today} / {capabilities.data.usage.limit} today
                  </button>
                ) : null}
                {canConfigure ? (
                  <Tooltip content="Bot settings">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Bot settings"
                      data-testid="bot-settings"
                      onClick={() => setSettingsOpen(true)}
                    >
                      <Settings2 />
                    </Button>
                  </Tooltip>
                ) : null}
              </>
            ) : null
          }
        />
        {canConfigure ? (
          <BotSettingsSheet agentId={bot.id} open={settingsOpen} onOpenChange={setSettingsOpen} />
        ) : null}
        {showMemory || memoryOpen ? (
          <MemoryPanel
            agentId={bot.id}
            botName={bot.name}
            open={memoryOpen}
            onOpenChange={setMemoryOpen}
            memoryOn={memoryOn ?? true}
          />
        ) : null}

        <div className="relative flex min-h-0 flex-1 flex-col">
          <div
            ref={scroll.ref}
            onScroll={onScroll}
            className="scrollbar-thin flex min-h-0 flex-1 flex-col overflow-y-auto"
            data-testid="dm-scroll"
            data-detached={detached ? "true" : undefined}
          >
            {messages.isPending || win.loading ? (
              <div className="flex flex-1 items-end justify-center pb-8 text-muted-foreground">
                <Spinner />
              </div>
            ) : messages.isError || win.error ? (
              <EmptyState
                icon={isApiError(messages.error, 404) ? Lock : Bot}
                title="Couldn't load messages"
                description={errorMessage(messages.error ?? win.error)}
              >
                <Button
                  variant="outline"
                  onClick={() => (messages.isError ? void messages.refetch() : win.retry())}
                >
                  Try again
                </Button>
              </EmptyState>
            ) : (
              <div className="mt-auto">
                {loadingOlder ? (
                  <div className="flex justify-center py-3 text-muted-foreground">
                    <Spinner />
                  </div>
                ) : null}
                <MessageList
                  messages={shown?.messages ?? []}
                  pending={detached ? [] : pending}
                  me={me}
                  typers={typers}
                  onRetry={retry}
                  showThreadSummary={false}
                  intro={intro}
                  readOnly={!!dm.archivedAt || disabled}
                  anchorId={permalinkId}
                  linkFor={linkFor}
                  onAnchorHidden={onAnchorHidden}
                />
                {loadingNewer ? (
                  <div className="flex justify-center py-3 text-muted-foreground">
                    <Spinner />
                  </div>
                ) : null}
              </div>
            )}
          </div>
          {detached ? <JumpToLatest newCount={win.newCount} onJump={jumpToLatest} /> : null}
        </div>

        <TypingIndicator typers={typers} />
        <div className="shrink-0 px-4 pb-[max(env(safe-area-inset-bottom),12px)] sm:px-5">
          {disabled ? (
            <div className="flex items-center gap-3 rounded-xl border bg-muted/40 px-4 py-3 text-muted-foreground text-sm">
              <Bot className="size-4 shrink-0" />
              <span>{bot.name} is turned off. Its history stays readable here.</span>
            </div>
          ) : (
            <Composer
              placeholder={`Message ${bot.name}`}
              candidates={[]}
              mentions={false}
              onSend={send}
              autoFocus
              footer={
                <p className="mt-1.5 hidden px-1 text-[11px] text-muted-foreground/80 md:block">
                  <kbd className="font-sans font-medium">Enter</kbd> to send ·{" "}
                  <kbd className="font-sans font-medium">Shift + Enter</kbd> for a new line
                </p>
              }
            />
          )}
        </div>
      </div>
    </div>
  );
}
