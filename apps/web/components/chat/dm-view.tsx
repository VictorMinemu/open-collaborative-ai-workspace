"use client";

import {
  type AgentTypingEvent,
  type Attachment,
  type DmGroupMember,
  EphemeralTypes,
  EventTypes,
  type Message,
  type MessageCreatedEvent,
  type MessageDeletedEvent,
  type MessageUpdatedEvent,
  type PinUpdatedEvent,
  type ReactionUpdatedEvent,
} from "@ocw/contracts";
import type { TopicFrame } from "@ocw/realtime-client";
import { useQueryClient } from "@tanstack/react-query";
import { Bot, Gauge, Lock, NotebookPen, Settings2, ShieldCheck, UserX } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { BotSettingsSheet } from "@/components/bots/bot-settings-sheet";
import { MemoryPanel } from "@/components/bots/memory-panel";
import { EmptyState } from "@/components/common/empty-state";
import { ModuleOff, useModule } from "@/components/shell/module-gate";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip } from "@/components/ui/tooltip";
import { errorMessage, isApiError } from "@/lib/api";
import { useAttachmentsConfig } from "@/lib/attachment-queries";
import { useAgents } from "@/lib/bots-queries";
import { capabilityKeys, useBotCapabilities, useBotMemories } from "@/lib/capability-queries";
import {
  applyMessage,
  applyMessageDeleted,
  applyMessageUpdate,
  applyPinUpdate,
  applyReactionUpdate,
  bumpDmLatest,
  chatKeys,
  isBotDm,
  isGroupDm,
  isHumanDm,
  markConversationUnread,
  markDmRead,
  postMessage,
  setReadHold,
  useDms,
  useMessages,
  usePins,
} from "@/lib/chat-queries";
import { parsePermalink, permalinkPath } from "@/lib/permalink";
import { useMe } from "@/lib/queries";
import { useTopic } from "@/lib/realtime";
import { cn } from "@/lib/utils";
import { DropZone } from "./attachments/drop-zone";
import { attachmentLimitsHint, Composer, type ComposerApi, type MentionCandidate } from "./composer";
import { ConversationNotifyMenu } from "./conversation-notify-menu";
import { JumpToLatest } from "./jump-to-latest";
import { MentionContext } from "./markdown";
import { MessageList, type PendingMessage } from "./message-list";
import { MessageUnavailable } from "./message-unavailable";
import { PinnedButton, PinnedSheet } from "./pinned-sheet";
import { BotBadge, GroupAvatars, PrincipalAvatar } from "./principal-avatar";
import { TypingIndicator, useTypers } from "./typing";
import { dirKey, useOrgDirectory } from "./use-chat-directory";
import { useCentreOnce, usePermalinkWindow, useWindowPaging } from "./use-permalink-window";
import { useReadCursor } from "./use-read-cursor";
import { useStickToBottom } from "./use-stick-to-bottom";

function newId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** "N members" in a group's header: opens the fixed member list (bots badged). */
function GroupMembersPopover({
  members,
  me,
  count,
}: {
  members: DmGroupMember[];
  me: { id: string; name: string };
  count: number;
}) {
  return (
    <Popover>
      <PopoverTrigger
        data-testid="group-members"
        className="rounded-sm font-medium text-foreground/80 underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/40"
      >
        {count} members
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-2" data-testid="group-members-list">
        <p className="px-2 pt-1 pb-2 text-muted-foreground text-xs">
          Members are fixed. A different set of people starts a new group.
        </p>
        <ul className="grid gap-0.5">
          <li className="flex items-center gap-2.5 rounded-md px-2 py-1.5">
            <PrincipalAvatar kind="user" name={me.name} seed={me.id} className="size-6 text-[10px]" />
            <span className="truncate text-sm">{me.name}</span>
            <span className="text-muted-foreground text-xs">(you)</span>
          </li>
          {members.map((m) => (
            <li key={`${m.kind}:${m.id}`} className="flex items-center gap-2.5 rounded-md px-2 py-1.5">
              <PrincipalAvatar
                kind={m.kind}
                name={m.name}
                avatarUrl={m.avatarUrl}
                seed={m.id}
                className="size-6 text-[10px]"
              />
              <span className="truncate text-sm">{m.name}</span>
              {m.kind === "agent" ? <BotBadge /> : null}
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
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
 * `/chat/dm/<id>`. A bot DM of a member whose Bots module is turned off (07.3, D-05 (3)) shows the in-place off
 * state instead of the conversation, and a skeleton while that is being decided (never a flash of the chat); people
 * and groups render as before. A failed permissions fetch counts as on (P-08): the API stays the authority.
 */
export function DmView({ conversationId }: { conversationId: string }) {
  const dms = useDms();
  const bots = useModule("bots");
  const dm = dms.data?.dms.find((d) => d.id === conversationId);
  if (dm && isBotDm(dm) && bots !== "on") {
    return bots === "off" ? <ModuleOff module="bots" /> : <DmSkeleton />;
  }
  return <DmConversation conversationId={conversationId} />;
}

/**
 * A private direct conversation with a bot (D-03/D-04): flat (no threads), the bot answers every message
 * without an @mention, and only the caller can read it. Same optimistic send/retry as the channel view.
 */
function DmConversation({ conversationId }: { conversationId: string }) {
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
  const composerApi = useRef<ComposerApi | null>(null);
  const filesConfig = useAttachmentsConfig();
  // The other party: a bot (3.1 DMs), a person (CHAT-04) or the other members of a group (D-06).
  const bot = dm && isBotDm(dm) ? dm.counterpart : undefined;
  const person = dm && isHumanDm(dm) ? dm.counterpart : undefined;
  const group = dm && isGroupDm(dm) ? dm.counterpart : undefined;
  const directory = useOrgDirectory();
  // @handles render as chips here too (04-02 open item), from the same org directory as channels.
  const mentionCtx = useMemo(
    () => ({
      handles: directory.handles,
      myHandle: directory.entries.find((e) => e.kind === "user" && e.id === me.id)?.handle ?? null,
    }),
    [directory, me.id],
  );
  // In a group, @mentions offer its members only: a team bot there answers only when mentioned (D-06).
  const groupCandidates = useMemo<MentionCandidate[]>(
    () =>
      (group?.members ?? []).map((m) => {
        const e = directory.byKey.get(dirKey(m.kind, m.id));
        return {
          kind: m.kind,
          id: m.id,
          displayName: m.name,
          handle: e?.handle ?? m.name.toLowerCase().replace(/[^a-z0-9._-]/g, ""),
          avatarUrl: m.avatarUrl,
          subtitle: e?.subtitle ?? null,
          inChannel: true,
        };
      }),
    [group, directory.byKey],
  );
  const [lost, setLost] = useState(false);
  const messages = useMessages(conversationId, !!dm && !lost);
  const pins = usePins(conversationId, !!dm && !lost);
  const [pinsOpen, setPinsOpen] = useState(false);
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
    if (frame.type === EventTypes.pinUpdated) {
      applyPinUpdate(qc, frame.data as PinUpdatedEvent);
      return;
    }
    if (frame.type === EventTypes.reactionUpdated) {
      applyReactionUpdate(qc, frame.data as ReactionUpdatedEvent, me.id);
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
      bumpDmLatest(qc, conversationId, message.seq, message.createdAt, message.body);
      // Reading old history (a detached window) never reads the live end (CHAT-09).
      if (!detached && document.visibilityState === "visible") markDmRead(qc, conversationId, message.seq);
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

  // ---------------------------------------------------------------- sending
  const scroll = useStickToBottom(
    `${detached ? "window" : "tail"}:${shown?.messages.length ?? 0}:${pending.length}:${typers.length}`,
    conversationId,
    detached,
  );

  // ---------------------------------------------------------------- read cursor (CHAT-09)
  const lastSeq = messages.data?.messages.at(-1)?.seq ?? 0;
  const reading = useReadCursor({
    convId: conversationId,
    tailLastSeq: lastSeq,
    windowLastSeq: detached ? (shown?.messages.at(-1)?.seq ?? null) : null,
    scrollRef: scroll.ref,
  });
  const markUnreadFrom = useCallback(
    (m: Message) =>
      void markConversationUnread(qc, conversationId, m.id).catch((err) => toast.error(errorMessage(err))),
    [qc, conversationId],
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
        const msg = await postMessage(conversationId, {
          body: p.body,
          clientMessageId: p.clientMessageId,
          ...(p.attachments?.length ? { attachmentIds: p.attachments.map((a) => a.id) } : {}),
        });
        applyMessage(qc, msg);
        setPending((prev) => prev.filter((x) => x.clientMessageId !== p.clientMessageId));
        // Sending ends a "marked unread" hold: the member is reading here (CHAT-09).
        setReadHold(conversationId, null);
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
    (body: string, attachments: Attachment[] = []) => {
      const p: PendingMessage = {
        clientMessageId: newId(),
        body,
        threadRootId: null,
        failed: false,
        createdAt: new Date().toISOString(),
        ...(attachments.length ? { attachments } : {}),
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
  if (!dm || (!bot && !person && !group)) return <DmSkeleton />;

  const personal = bot?.scope === "personal";
  const title = bot?.name ?? person?.name ?? group?.name ?? "Direct message";
  const memberCount = (group?.members.length ?? 0) + 1;
  const privacyLine = bot
    ? personal
      ? "Personal bot · only you can see this chat"
      : "Private chat · only you can see it"
    : group
      ? "only members can see this"
      : `@${person?.handle} · only the two of you can see this`;
  const disabled = bot?.status === "disabled";
  const deactivated = person?.deactivated === true;
  // Bots read text only for now, so a DM with a bot offers no files; people and groups do (CHAT-12, P-10).
  const canAttach = !bot && !disabled && !deactivated && !dm.archivedAt;
  const canDrop = canAttach && filesConfig.data?.enabled === true;
  const headerAvatar = bot ? (
    <PrincipalAvatar
      kind="agent"
      name={bot.name}
      avatarUrl={bot.avatarUrl}
      seed={bot.id}
      className="size-8 text-base"
    />
  ) : person ? (
    <PrincipalAvatar
      kind="user"
      name={person.name}
      avatarUrl={person.avatarUrl}
      seed={person.id}
      className="size-8 text-sm"
    />
  ) : group ? (
    <GroupAvatars members={group.members} className="size-8" large />
  ) : null;

  const groupIntro =
    group && shown && shown.nextBefore === null ? (
      <div className="px-4 pt-10 pb-4 sm:px-5" data-testid="dm-intro">
        <GroupAvatars members={group.members} className="size-14" large />
        <h2 className="mt-3 font-semibold text-xl tracking-tight">{group.name}</h2>
        <p className="mt-1 max-w-xl text-muted-foreground text-sm">
          This is the start of your group conversation with {memberCount - 1} others.
          {group.members.some((m) => m.kind === "agent")
            ? " Bots here answer only when you @mention them."
            : ""}
        </p>
        <p className="mt-3 inline-flex max-w-xl items-start gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-muted-foreground text-xs">
          <ShieldCheck className="mt-px size-3.5 shrink-0 text-primary" />
          <span>
            Only these {memberCount} members can read it — not other members, not admins. Nobody can be added
            later: a different set of people starts a new group.
          </span>
        </p>
      </div>
    ) : null;

  const personIntro =
    person && shown && shown.nextBefore === null ? (
      <div className="px-4 pt-10 pb-4 sm:px-5" data-testid="dm-intro">
        <PrincipalAvatar
          kind="user"
          name={person.name}
          avatarUrl={person.avatarUrl}
          seed={person.id}
          className="size-14 text-xl"
        />
        <h2 className="mt-3 font-semibold text-xl tracking-tight">{person.name}</h2>
        <p className="mt-1 max-w-xl text-muted-foreground text-sm">
          This is the start of your direct messages with {person.name}.
        </p>
        <p className="mt-3 inline-flex max-w-xl items-start gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-muted-foreground text-xs">
          <ShieldCheck className="mt-px size-3.5 shrink-0 text-primary" />
          <span>Only the two of you can read this conversation — not other members, not admins.</span>
        </p>
      </div>
    ) : null;

  const intro =
    bot && shown && shown.nextBefore === null ? (
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
    ) : (
      (personIntro ?? groupIntro)
    );

  return (
    <MentionContext.Provider value={mentionCtx}>
      <div
        className="flex min-w-0 flex-1"
        data-testid="dm-view"
        data-conversation-id={dm.id}
        data-dm-kind={dm.counterpart.kind}
      >
        <div className="flex min-w-0 flex-1 flex-col">
          <PageHeader
            icon={headerAvatar}
            title={<span data-testid="dm-title">{title}</span>}
            description={
              // Inline (not inline-flex) so a narrow header ellipsizes the line instead of clipping it.
              <span data-testid="dm-privacy">
                <Lock className="mr-1 inline-block size-3 align-[-1px]" aria-hidden />
                {group ? (
                  <>
                    <GroupMembersPopover members={group.members} me={me} count={memberCount} />
                    {" · "}
                  </>
                ) : null}
                {privacyLine}
              </span>
            }
            actions={
              <>
                <PinnedButton count={pins.data?.pins.length ?? 0} onClick={() => setPinsOpen(true)} />
                <ConversationNotifyMenu
                  conversation={{ id: dm.id, kind: dm.kind === "group" ? "group" : "dm" }}
                  lastSeq={lastSeq}
                  latestMessageId={messages.data?.messages.at(-1)?.id ?? null}
                />
                {bot && (canConfigure || showMemory) ? (
                  <>
                    {bot && showMemory ? (
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
                    {bot && canConfigure && capabilities.data ? (
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
                    {bot && canConfigure ? (
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
                ) : null}
              </>
            }
          />
          <PinnedSheet
            conversation={{ id: dm.id, kind: "dm", name: title }}
            open={pinsOpen}
            onOpenChange={setPinsOpen}
          />
          {bot && canConfigure ? (
            <BotSettingsSheet agentId={bot.id} open={settingsOpen} onOpenChange={setSettingsOpen} />
          ) : null}
          {bot && (showMemory || memoryOpen) ? (
            <MemoryPanel
              agentId={bot.id}
              botName={bot.name}
              open={memoryOpen}
              onOpenChange={setMemoryOpen}
              memoryOn={memoryOn ?? true}
            />
          ) : null}

          <DropZone
            conversationLabel={group ? title : `your conversation with ${title}`}
            enabled={canDrop}
            hint={attachmentLimitsHint(filesConfig.data)}
            onFiles={(files) => composerApi.current?.addFiles(files)}
          >
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
                      readOnly={!!dm.archivedAt || disabled || deactivated}
                      anchorId={permalinkId}
                      linkFor={linkFor}
                      onAnchorHidden={onAnchorHidden}
                      canUnpinAny
                      dividerAfterSeq={reading.dividerAfterSeq}
                      onMarkUnread={markUnreadFrom}
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
              {disabled || deactivated ? (
                <div
                  className="flex items-center gap-3 rounded-xl border bg-muted/40 px-4 py-3 text-muted-foreground text-sm"
                  data-testid="dm-readonly"
                >
                  {bot ? <Bot className="size-4 shrink-0" /> : <UserX className="size-4 shrink-0" />}
                  <span>
                    {bot
                      ? `${bot.name} is turned off. Its history stays readable here.`
                      : `${title} is no longer active in this workspace. The history stays readable here.`}
                  </span>
                </div>
              ) : (
                <Composer
                  placeholder={`Message ${title}`}
                  candidates={groupCandidates}
                  mentions={!!group}
                  conversationId={conversationId}
                  attachments={canAttach}
                  apiRef={composerApi}
                  onSend={(body, _ids, files) => send(body, files)}
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
          </DropZone>
        </div>
      </div>
    </MentionContext.Provider>
  );
}
