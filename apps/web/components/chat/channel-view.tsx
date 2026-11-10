"use client";

import {
  type AgentTypingEvent,
  type Attachment,
  ChannelSummary,
  EphemeralTypes,
  EventTypes,
  type Message,
  type MessageCreatedEvent,
  type MessageDeletedEvent,
  type MessageUpdatedEvent,
  type PinUpdatedEvent,
  type ReactionUpdatedEvent,
  type ThreadUpdatedEvent,
  type TurnActivityEvent,
  type UserTypingEvent,
} from "@ocw/contracts";
import type { TopicFrame } from "@ocw/realtime-client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  AtSign,
  FolderInput,
  Hash,
  Lock,
  LogOut,
  MoreHorizontal,
  Plus,
  UserPlus,
  Users,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useLiveActivity } from "@/components/browser/bot-activity";
import { LiveChip } from "@/components/browser/live-chip";
import { EmptyState } from "@/components/common/empty-state";
import { PresenceStack, usePresentPeople } from "@/components/presence/presence-stack";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useIsDesktop } from "@/hooks/use-media-query";
import { api, errorMessage, isApiError } from "@/lib/api";
import { useAttachmentsConfig } from "@/lib/attachment-queries";
import { useCardRootEditor } from "@/lib/board-manage-queries";
import { applyBoardFrame, boardAfterSeq, findCard, resyncBoard, useBoard } from "@/lib/board-queries";
import {
  applyMessage,
  applyMessageDeleted,
  applyMessageUpdate,
  applyPinUpdate,
  applyReactionUpdate,
  applyThreadUpdate,
  applyTurnActivity,
  bumpLatest,
  chatKeys,
  markConversationUnread,
  markRead,
  postMessage,
  setReadHold,
  useChannelAction,
  useChannelMembers,
  useChannels,
  useMessages,
  usePins,
} from "@/lib/chat-queries";
import { parsePermalink, permalinkPath } from "@/lib/permalink";
import { useMe } from "@/lib/queries";
import { useRealtime, useTopic } from "@/lib/realtime";
import { formatDate } from "@/lib/utils";
import { DropZone } from "./attachments/drop-zone";
import { BoardConnectionBanner } from "./board/board-connection-banner";
import { BoardView } from "./board/board-view";
import { CardEditDialog } from "./board/card-edit-dialog";
import type { CardAuthor } from "./board/card-tile";
import { NewCardDialog } from "./board/new-card-dialog";
import { ChannelIcon } from "./chat-sidebar";
import {
  attachmentLimitsHint,
  Composer,
  type ComposerApi,
  ComposerHint,
  type MentionCandidate,
  type SpecialMention,
} from "./composer";
import { ConversationNotifyMenu } from "./conversation-notify-menu";
import { JumpToLatest } from "./jump-to-latest";
import { MentionContext } from "./markdown";
import { MembersDialog } from "./members-dialog";
import { MessageList, type PendingMessage } from "./message-list";
import { MessageUnavailable } from "./message-unavailable";
import { MoveChannelDialog } from "./move-channel-dialog";
import { PinnedButton, PinnedSheet } from "./pinned-sheet";
import { PrincipalAvatar } from "./principal-avatar";
import { ThreadPanel } from "./thread-panel";
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

function MessagesSkeleton() {
  return (
    <div className="flex flex-1 flex-col justify-end gap-5 px-5 pb-6">
      {[60, 85, 40].map((w) => (
        <div key={w} className="flex gap-3">
          <Skeleton className="size-9 rounded-full" />
          <div className="grid flex-1 gap-2">
            <Skeleton className="h-3.5 w-28" />
            <Skeleton className="h-3.5" style={{ width: `${w}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

/** The broadcasts the channel composer offers (CHAT-08). */
const SPECIAL_MENTIONS: SpecialMention[] = [
  { handle: "channel", label: "@channel", description: "Notify everyone in this channel" },
  { handle: "here", label: "@here", description: "Notify everyone online now" },
];

export function ChannelView({ channelId }: { channelId: string }) {
  const qc = useQueryClient();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const threadId = searchParams.get("thread");
  // A permalink (CHAT-14): `m` is the linked message, `thread` its root when it is a reply.
  const { messageId: permalinkId } = parsePermalink(searchParams);
  const meQ = useMe({ enabled: false });
  const me = useMemo(
    () => ({ id: meQ.data?.user.id ?? "", name: meQ.data?.user.name ?? "You" }),
    [meQ.data?.user.id, meQ.data?.user.name],
  );
  const realtime = useRealtime();
  const isDesktop = useIsDesktop();

  // ---------------------------------------------------------------- data
  const channels = useChannels();
  const fromList = channels.data?.channels.find((c) => c.id === channelId);
  // RT-01: the server dropped this channel's live stream because access was lost (kept per channel id, so it
  // resets on navigation). `leavingRef` marks our own leave, which must never read as "no access".
  const [lost, setLost] = useState<{ id: string; name: string } | null>(null);
  const revoked = lost?.id === channelId ? lost : null;
  const leavingRef = useRef<string | null>(null);
  const single = useQuery({
    enabled: channels.isSuccess && !fromList && !revoked,
    queryKey: chatKeys.channel(channelId),
    queryFn: ({ signal }) => api.get(`/api/v1/channels/${channelId}`, { schema: ChannelSummary, signal }),
    retry: false,
  });
  const channel = fromList ?? single.data;
  const messages = useMessages(channelId, !!channel);
  // Board channels (Phase 07.1, P-12): the board snapshot loads next to the messages; Board is the default view.
  const isBoard = channel?.layout === "board";
  const board = useBoard(channelId, { enabled: isBoard && !revoked });
  const view: "board" | "messages" =
    isBoard && searchParams.get("view") !== "messages" ? "board" : "messages";
  const activeColumnId = searchParams.get("col");
  const [newCard, setNewCard] = useState<{ columnId: string | null } | null>(null);
  // The card editor opened from the Messages view (07.1-14): a card root's own "Edit message" edits the card, since
  // the generic edit refuses card roots (400 `board_card_use_board`); a card past its column's loaded page is looked
  // up by its message id first (07.1 fix).
  const cardRoots = useCardRootEditor(
    channelId,
    isBoard ? board.data : undefined,
    !!channel?.isMember && !channel.archivedAt,
  );
  const members = useChannelMembers(channel ? channelId : null);
  const pins = usePins(channelId, !!channel && !revoked);
  const [pinsOpen, setPinsOpen] = useState(false);
  const pinnedBy = useMemo(
    () => new Map((pins.data?.pins ?? []).map((p) => [p.message.id, p.pinnedBy.id ?? ""])),
    [pins.data],
  );
  const directory = useOrgDirectory();
  const { typers, touch, clear } = useTypers();
  const [pending, setPending] = useState<PendingMessage[]>([]);
  const [membersOpen, setMembersOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const composerApi = useRef<ComposerApi | null>(null);
  const filesConfig = useAttachmentsConfig();
  const join = useChannelAction("join");
  const leave = useChannelAction("leave");
  const archive = useChannelAction("archive");

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset per channel
  useEffect(() => setPending([]), [channelId]);

  // ---------------------------------------------------------------- permalink window (CHAT-14)
  const win = usePermalinkWindow({
    convId: channelId,
    tail: messages.data,
    permalinkId,
    linkedTop: threadId ?? permalinkId,
  });
  const { detached, shown } = win;
  // 07.8-20: what a bot is doing in its sandbox or browser right now (the live label under the last message).
  const live = useLiveActivity(channelId, null, messages.data?.messages ?? []);

  // Mentionable: channel members (incl. bots even before the bots API exists) ∪ org directory.
  const candidates = useMemo<MentionCandidate[]>(() => {
    const out = new Map<string, MentionCandidate>();
    for (const m of members.data?.members ?? []) {
      out.set(dirKey(m.kind, m.id), {
        kind: m.kind,
        id: m.id,
        displayName: m.displayName,
        handle: m.handle,
        avatarUrl: m.avatarUrl,
        subtitle: null,
        inChannel: true,
      });
    }
    for (const e of directory.entries) {
      const k = dirKey(e.kind, e.id);
      if (!out.has(k)) out.set(k, { ...e, inChannel: false });
    }
    return [...out.values()].filter((c) => !(c.kind === "user" && c.id === me.id));
  }, [members.data, directory.entries, me.id]);

  const mentionCtx = useMemo(() => {
    const handles = new Map(directory.handles);
    for (const m of members.data?.members ?? []) {
      // A channel member always wins over a team under the same handle (the API's precedence, 07.17 PD-13).
      if (!handles.has(m.handle) || handles.get(m.handle)?.kind === "unit") {
        handles.set(m.handle, { kind: m.kind, displayName: m.displayName });
      }
    }
    const myHandle =
      members.data?.members.find((m) => m.kind === "user" && m.id === me.id)?.handle ??
      directory.entries.find((e) => e.kind === "user" && e.id === me.id)?.handle ??
      null;
    return { handles, myHandle };
  }, [directory, members.data, me.id]);

  const nameOf = useCallback(
    (kind: "user" | "agent", id: string) =>
      members.data?.members.find((m) => m.kind === kind && m.id === id)?.displayName ??
      directory.byKey.get(dirKey(kind, id))?.displayName ??
      "Someone",
    [members.data, directory.byKey],
  );

  // ---------------------------------------------------------------- realtime
  const topic = `conv:${channelId}`;
  // Same sources as nameOf: channel members first, then the org directory.
  const resolvePerson = useCallback(
    (userId: string) => {
      const m = members.data?.members.find((x) => x.kind === "user" && x.id === userId);
      if (m) return { name: m.displayName, avatarUrl: m.avatarUrl };
      const d = directory.byKey.get(dirKey("user", userId));
      return d ? { name: d.displayName, avatarUrl: d.avatarUrl } : undefined;
    },
    [members.data, directory.byKey],
  );
  const present = usePresentPeople(topic, { excludeUserId: me.id, resolve: resolvePerson });
  const onFrame = (frame: TopicFrame) => {
    // Board frames patch the board cache; card-root deletes and reply counts also go on to the message handlers.
    if (isBoard && applyBoardFrame(qc, channelId, frame)) return;
    if (frame.op === "eph") {
      // 07.8-20 (R2): a bot turn's sandbox and browser activity while it runs (readers of this conversation only).
      if (frame.type === EphemeralTypes.turnActivity) {
        applyTurnActivity(qc, frame.data as TurnActivityEvent);
        return;
      }
      if (frame.type === EphemeralTypes.agentTyping) {
        const d = frame.data as AgentTypingEvent;
        touch({ kind: "agent", id: d.agentId, name: d.displayName, threadRootId: d.threadRootId });
      } else if (frame.type === EphemeralTypes.userTyping) {
        const d = frame.data as UserTypingEvent;
        if (d.userId && d.userId !== me.id) {
          touch({
            kind: "user",
            id: d.userId,
            name: nameOf("user", d.userId),
            threadRootId: d.threadRootId ?? null,
          });
        }
      }
      return;
    }
    switch (frame.type) {
      case EventTypes.messageCreated: {
        const { message } = frame.data as MessageCreatedEvent;
        applyMessage(qc, message);
        if (message.authorKind !== "system") clear(message.authorKind, message.authorId);
        if (!message.threadId) {
          bumpLatest(qc, channelId, message.seq, message.createdAt, message.body);
          // Reading old history (a detached window) never reads the live end (CHAT-09).
          if (!detached && document.visibilityState === "visible") markRead(qc, channelId, message.seq);
        }
        return;
      }
      case EventTypes.threadUpdated:
        applyThreadUpdate(qc, channelId, frame.data as ThreadUpdatedEvent);
        return;
      case EventTypes.messageUpdated:
        // An edit never moves the read cursor nor makes the channel unread.
        applyMessageUpdate(qc, (frame.data as MessageUpdatedEvent).message);
        return;
      case EventTypes.messageDeleted:
        applyMessageDeleted(qc, frame.data as MessageDeletedEvent);
        return;
      case EventTypes.pinUpdated:
        applyPinUpdate(qc, frame.data as PinUpdatedEvent);
        return;
      case EventTypes.reactionUpdated:
        // Channel messages, thread replies and roots alike (the thread panel reads the same caches).
        applyReactionUpdate(qc, frame.data as ReactionUpdatedEvent, me.id);
        return;
      case EventTypes.conversationMemberAdded:
      case EventTypes.conversationMemberRemoved:
        void qc.invalidateQueries({ queryKey: chatKeys.members(channelId) });
        void qc.invalidateQueries({ queryKey: chatKeys.channels });
        return;
      case EventTypes.conversationUpdated:
        void qc.invalidateQueries({ queryKey: chatKeys.channels });
        void qc.invalidateQueries({ queryKey: chatKeys.channel(channelId) });
        return;
    }
  };
  const onRevoked = () => {
    if (leavingRef.current === channelId) return;
    setLost({ id: channelId, name: channel?.name ?? "this channel" });
    void qc.invalidateQueries({ queryKey: chatKeys.channels });
    void qc.invalidateQueries({ queryKey: chatKeys.channel(channelId) });
    void qc.invalidateQueries({ queryKey: chatKeys.members(channelId) });
    qc.removeQueries({ queryKey: chatKeys.messages(channelId) });
  };
  // One subscription per channel (Pitfall 3): a board channel waits for both cursors and starts from the lower one.
  const boardReady = !isBoard || board.data !== undefined || board.isError;
  useTopic(
    messages.data && boardReady && !revoked ? topic : null,
    onFrame,
    isBoard && board.data
      ? boardAfterSeq(messages.data?.lastSeq, board.data.lastSeq)
      : messages.data?.lastSeq,
    () => {
      void qc.invalidateQueries({ queryKey: chatKeys.messages(channelId) });
      if (isBoard) resyncBoard(qc, channelId);
    },
    { presence: true, onRevoked },
  );

  const sendTyping = useCallback(
    (threadRootId: string | null) =>
      realtime?.sendEphemeral(topic, EphemeralTypes.userTyping, { threadRootId }),
    [realtime, topic],
  );

  // ---------------------------------------------------------------- sending
  const channelPending = pending.filter((p) => !p.threadRootId);
  const scroll = useStickToBottom(
    `${detached ? "window" : "tail"}:${shown?.messages.length ?? 0}:${channelPending.length}:${shown?.messages.at(-1)?.replyCount ?? 0}`,
    channelId,
    detached,
  );

  // ---------------------------------------------------------------- read cursor (CHAT-09)
  const lastSeq = messages.data?.messages.at(-1)?.seq ?? 0;
  const reading = useReadCursor({
    convId: channelId,
    tailLastSeq: fromList?.isMember ? lastSeq : 0,
    windowLastSeq: detached ? (shown?.messages.at(-1)?.seq ?? null) : null,
    scrollRef: scroll.ref,
  });
  const markUnreadFrom = useCallback(
    (m: Message) =>
      void markConversationUnread(qc, channelId, m.id).catch((err) => toast.error(errorMessage(err))),
    [qc, channelId],
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

  // A reply linked without its root (`?m=<reply>`): open its thread like a full thread link would.
  const linkRoot = win.threadRootId;
  useEffect(() => {
    if (permalinkId && linkRoot && !threadId) {
      router.replace(`${pathname}?thread=${linkRoot}&m=${permalinkId}`, { scroll: false });
    }
  }, [permalinkId, linkRoot, threadId, router, pathname]);

  const { release } = win;
  const jumpToLatest = useCallback(() => {
    release();
    scroll.scrollToBottom();
    const params = new URLSearchParams(searchParams.toString());
    params.delete("m");
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }, [release, scroll, searchParams, router, pathname]);

  const linkFor = useCallback(
    (m: Message) => permalinkPath({ id: channelId, kind: "channel" }, m.id, m.threadId),
    [channelId],
  );

  const deliver = useCallback(
    async (p: PendingMessage) => {
      try {
        const msg = await postMessage(channelId, {
          body: p.body,
          clientMessageId: p.clientMessageId,
          ...(p.threadRootId ? { threadRootId: p.threadRootId } : {}),
          ...(p.attachments?.length ? { attachmentIds: p.attachments.map((a) => a.id) } : {}),
        });
        applyMessage(qc, msg);
        setPending((prev) => prev.filter((x) => x.clientMessageId !== p.clientMessageId));
        if (!msg.threadId) {
          // Sending ends a "marked unread" hold: the member is reading here (CHAT-09).
          setReadHold(channelId, null);
          markRead(qc, channelId, msg.seq);
        }
      } catch (err) {
        setPending((prev) =>
          prev.map((x) => (x.clientMessageId === p.clientMessageId ? { ...x, failed: true } : x)),
        );
        toast.error(errorMessage(err));
      }
    },
    [channelId, qc],
  );

  const send = useCallback(
    (body: string, threadRootId: string | null = null, attachments: Attachment[] = []) => {
      const p: PendingMessage = {
        clientMessageId: newId(),
        body,
        threadRootId,
        failed: false,
        createdAt: new Date().toISOString(),
        ...(attachments.length ? { attachments } : {}),
      };
      if (!threadRootId) {
        // Posting from old history returns to the live tail, where the message appears.
        if (detached) jumpToLatest();
        scroll.scrollToBottom();
      }
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

  // ---------------------------------------------------------------- threads (URL state)
  // A board channel keeps its view and column tab (`view`, `col`) across the thread round trip.
  const boardParams = useCallback(() => {
    const p = new URLSearchParams();
    if (!isBoard) return p;
    for (const k of ["view", "col"]) {
      const v = searchParams.get(k);
      if (v) p.set(k, v);
    }
    return p;
  }, [isBoard, searchParams]);
  const openThread = useCallback(
    (id: string) => {
      const p = boardParams();
      p.set("thread", id);
      router.replace(`${pathname}?${p.toString()}`, { scroll: false });
    },
    [router, pathname, boardParams],
  );
  const closeThread = useCallback(() => {
    const q = boardParams().toString();
    router.replace(q ? `${pathname}?${q}` : pathname, { scroll: false });
  }, [router, pathname, boardParams]);
  const setParam = useCallback(
    (key: string, value: string | null) => {
      const p = new URLSearchParams(searchParams.toString());
      if (value === null) p.delete(key);
      else p.set(key, value);
      const q = p.toString();
      router.replace(q ? `${pathname}?${q}` : pathname, { scroll: false });
    },
    [searchParams, router, pathname],
  );
  // Board layout (BOARD-05, UI-SPEC Opening a card): a link to a card root opens its thread over the board (at 390 on
  // the card's column tab); a link to any other top-level message opens the Messages view, where the permalink window
  // shows and highlights it like in a text channel. A reply link keeps the thread + highlight path above (`linkRoot`).
  const boardSnap = board.data;
  const linkLoading = win.loading;
  useEffect(() => {
    if (!isBoard || !permalinkId || threadId || view !== "board" || !boardSnap) return;
    const hit = findCard(boardSnap, permalinkId);
    if (hit) {
      const p = boardParams();
      p.set("thread", permalinkId);
      if (!isDesktop) p.set("col", hit.card.columnId);
      router.replace(`${pathname}?${p.toString()}`, { scroll: false });
      return;
    }
    if (linkLoading || linkRoot) return;
    const p = new URLSearchParams(searchParams.toString());
    p.set("view", "messages");
    router.replace(`${pathname}?${p.toString()}`, { scroll: false });
  }, [
    isBoard,
    permalinkId,
    threadId,
    view,
    boardSnap,
    boardParams,
    isDesktop,
    linkLoading,
    linkRoot,
    searchParams,
    router,
    pathname,
  ]);

  const authorOf = useCallback(
    (kind: "user" | "agent", id: string): CardAuthor => {
      const m = members.data?.members.find((x) => x.kind === kind && x.id === id);
      if (m) return { name: m.displayName, avatarUrl: m.avatarUrl };
      const d = directory.byKey.get(dirKey(kind, id));
      return d ? { name: d.displayName, avatarUrl: d.avatarUrl } : null;
    },
    [members.data, directory.byKey],
  );

  // ---------------------------------------------------------------- older / newer pages
  const { onScroll, loadingOlder, loadingNewer } = useWindowPaging({
    convId: channelId,
    scroll,
    shown,
    windowId: win.windowId,
    detached,
  });

  // ---------------------------------------------------------------- render
  if (revoked) {
    return (
      <div className="flex min-w-0 flex-1 flex-col" data-testid="channel-access-lost">
        <PageHeader title={<span className="text-muted-foreground">{revoked.name}</span>} icon={<Lock />} />
        <EmptyState
          icon={Lock}
          title={`You no longer have access to #${revoked.name}`}
          description="You were removed from this private channel or your permissions changed. Ask a channel member or an admin to add you back."
        >
          <Button render={<Link href="/chat" />}>Back to channels</Button>
        </EmptyState>
      </div>
    );
  }

  if (channels.isPending || (!fromList && single.isPending && channels.isSuccess)) {
    return (
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b px-4 sm:px-6">
          <Skeleton className="h-4 w-36" />
        </header>
        <MessagesSkeleton />
      </div>
    );
  }

  if (!channel) {
    // A permalink never says whether the conversation exists (T-04-03-01).
    if (permalinkId && (isApiError(single.error, 404) || single.isSuccess || channels.isSuccess)) {
      return <MessageUnavailable />;
    }
    const missing = isApiError(single.error, 404) || single.isSuccess || channels.isSuccess;
    return (
      <div className="flex min-w-0 flex-1 flex-col">
        <PageHeader title="Channel" icon={<Hash />} />
        <EmptyState
          icon={Hash}
          title={missing ? "This channel doesn't exist" : "Couldn't load this channel"}
          description={
            missing
              ? "It may be private, archived or the link may be wrong."
              : errorMessage(channels.error ?? single.error)
          }
        >
          <Button render={<Link href="/chat" />}>Back to channels</Button>
        </EmptyState>
      </div>
    );
  }

  if (win.unavailable) return <MessageUnavailable />;

  const memberList = members.data?.members ?? [];
  const bots = memberList.filter((m) => m.kind === "agent");
  const canPost = channel.isMember && !channel.archivedAt;
  // Messages view of a board: a card root opens the card editor (null when the viewer cannot post), also past the
  // first 100 of its column (looked up by id); every other message keeps the inline editor.
  const cardBoard = isBoard ? board.data : undefined;
  const editorFor = isBoard ? cardRoots.editorFor : undefined;
  const editingCard = cardRoots.editingCard;
  // Files go to the composer, so the pane takes drops only where it shows (P-10: none without storage).
  const canDrop = canPost && filesConfig.data?.enabled === true;
  // The server decides per channel (admin, or the channel owner): the menu only mirrors viewerCan.
  const canArchive = channel.viewerCan?.includes("channel.archive") ?? false;
  // CHAT-02: the owner or an admin regroups the channel under another unit (#general stays organization-wide).
  const canMove =
    (channel.viewerCan?.includes("channel.update") ?? false) && !channel.isDefault && !channel.archivedAt;
  // Admins moderate channels they can read (D-01); the server re-decides every delete.
  const canModerate = channel.viewerCan?.includes("message.delete_any") ?? false;
  // @channel / @here only where the server allows them (`channel.mention_all`, deny-able by rules).
  const specialMentions = channel.viewerCan?.includes("channel.mention_all") ? SPECIAL_MENTIONS : undefined;
  // 07.17 (D-07, PD-19): teams and departments are offered in channels and their threads (board cards included),
  // never in DMs, group DMs or AI chats; those whose handle a channel member holds are left out.
  const memberHandles = new Set(memberList.map((m) => m.handle));
  const unitMentions = directory.units.filter((u) => !memberHandles.has(u.handle));
  const channelTypers = typers;

  const intro =
    shown && shown.nextBefore === null ? (
      <div className="px-4 pt-10 pb-4 sm:px-5" data-testid="channel-intro">
        <div className="flex size-12 items-center justify-center rounded-xl bg-brand-soft text-brand-soft-foreground">
          <ChannelIcon channel={channel} className="size-6" />
        </div>
        <h2 className="mt-3 font-semibold text-xl tracking-tight">Welcome to #{channel.name}</h2>
        <p className="mt-1 max-w-xl text-muted-foreground text-sm">
          {channel.isDefault
            ? "This is the one channel that has everyone in it. Share announcements, say hi, and @mention a bot to bring it into the conversation."
            : `This is the very beginning of #${channel.name}.`}{" "}
          {channel.topic && !channel.isDefault ? channel.topic : null}
        </p>
        {canPost ? (
          <div className="mt-4 flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => setMembersOpen(true)}>
              <UserPlus /> Add people or bots
            </Button>
            <Button variant="outline" size="sm" onClick={() => composerApi.current?.insertMention()}>
              <AtSign /> Mention a bot
            </Button>
          </div>
        ) : null}
      </div>
    ) : null;

  return (
    <MentionContext.Provider value={mentionCtx}>
      <div className="flex min-w-0 flex-1" data-testid="channel-view" data-channel-id={channel.id}>
        <div className="flex min-w-0 flex-1 flex-col">
          <PageHeader
            icon={<ChannelIcon channel={channel} />}
            title={<span data-testid="channel-title">{channel.name}</span>}
            description={channel.topic ?? undefined}
            actions={
              <>
                {/* 07.8-26 (UI-SPEC Surface 1b): a bot's open browser here or in a thread, first in the cluster;
                    "Live" only while a thread panel narrows the column, so the channel's name keeps its room. */}
                <LiveChip conversationId={channel.id} compact={!!threadId} />
                <PresenceStack people={present} />
                <PinnedButton count={pins.data?.pins.length ?? 0} onClick={() => setPinsOpen(true)} />
                {channel.isMember ? (
                  <ConversationNotifyMenu
                    conversation={{ id: channel.id, kind: "channel" }}
                    lastSeq={lastSeq}
                    latestMessageId={messages.data?.messages.at(-1)?.id ?? null}
                  />
                ) : null}
                <button
                  type="button"
                  onClick={() => setMembersOpen(true)}
                  data-testid="channel-members-button"
                  aria-label={`${channel.memberCount} members`}
                  className="flex h-8 items-center gap-2 rounded-lg border px-1.5 pr-2.5 text-muted-foreground text-sm outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40"
                >
                  <span className="flex -space-x-1.5">
                    {memberList.length === 0 ? <Users className="mx-0.5 size-4" /> : null}
                    {[...memberList.filter((m) => m.kind === "user").slice(0, 3), ...bots.slice(0, 1)].map(
                      (m) => (
                        <PrincipalAvatar
                          key={`${m.kind}:${m.id}`}
                          kind={m.kind}
                          name={m.displayName}
                          avatarUrl={m.avatarUrl}
                          seed={m.id}
                          compact
                          className="size-6 text-[10px] ring-2 ring-background"
                        />
                      ),
                    )}
                  </span>
                  <span className="font-medium tabular-nums">{memberList.length || channel.memberCount}</span>
                </button>
                <DropdownMenu>
                  <DropdownMenuTrigger
                    aria-label="Channel options"
                    data-testid="channel-menu"
                    className="inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40"
                  >
                    <MoreHorizontal className="size-4" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => setMembersOpen(true)}>
                      <Users /> Members and bots
                    </DropdownMenuItem>
                    {canMove ? (
                      <DropdownMenuItem data-testid="move-channel" onClick={() => setMoveOpen(true)}>
                        <FolderInput /> Move to…
                      </DropdownMenuItem>
                    ) : null}
                    {channel.isMember && !channel.isDefault ? (
                      <DropdownMenuItem
                        onClick={() => {
                          // Our own leave revokes the stream too: that is not "lost access".
                          leavingRef.current = channel.id;
                          leave.mutate(channel.id, {
                            onSuccess: () => {
                              toast.success(`You left #${channel.name}`);
                              router.push("/chat");
                            },
                            onError: (e) => {
                              leavingRef.current = null;
                              toast.error(errorMessage(e));
                            },
                          });
                        }}
                      >
                        <LogOut /> Leave channel
                      </DropdownMenuItem>
                    ) : null}
                    {!channel.isDefault && !channel.archivedAt && canArchive ? (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          variant="destructive"
                          onClick={() =>
                            archive.mutate(channel.id, {
                              onSuccess: () => {
                                toast.success(`#${channel.name} archived`);
                                router.push("/chat");
                              },
                              onError: (e) => toast.error(errorMessage(e)),
                            })
                          }
                        >
                          <Archive /> Archive channel
                        </DropdownMenuItem>
                      </>
                    ) : null}
                  </DropdownMenuContent>
                </DropdownMenu>
              </>
            }
          />

          {isBoard ? (
            <div
              data-testid="board-toolbar"
              className="flex h-14 shrink-0 items-center justify-between gap-3 border-b px-4 md:h-12 md:px-6"
            >
              <Tabs
                value={view}
                onValueChange={(v) => setParam("view", v === "messages" ? "messages" : null)}
              >
                <TabsList aria-label="Channel view">
                  <TabsTrigger value="board" data-testid="view-board">
                    Board
                  </TabsTrigger>
                  <TabsTrigger value="messages" data-testid="view-messages">
                    Messages
                  </TabsTrigger>
                </TabsList>
              </Tabs>
              {view === "board" && canPost && board.data ? (
                <Button
                  size="sm"
                  className="max-md:h-11 max-md:px-4"
                  data-testid="new-card-button"
                  onClick={() => setNewCard({ columnId: null })}
                >
                  <Plus /> New card
                </Button>
              ) : null}
            </div>
          ) : null}
          {isBoard ? <BoardConnectionBanner loaded={board.data !== undefined} /> : null}

          {isBoard ? (
            // The board stays mounted under Messages (hidden), so switching back keeps its scroll and tab (P-12).
            <div className={view === "board" ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
              <BoardView
                channel={{ id: channel.id, name: channel.name ?? "" }}
                snapshot={board.data}
                loading={board.isPending && !board.isError}
                error={board.error}
                onRetry={() => void board.refetch()}
                canPost={canPost}
                canManage={channel.viewerCan?.includes("channel.update") ?? false}
                authorOf={authorOf}
                onOpenCard={openThread}
                selectedCardId={threadId}
                onAddCard={(columnId) => setNewCard({ columnId })}
                activeColumnId={activeColumnId}
                onActiveColumnChange={(id) => setParam("col", id)}
              />
              {channel.archivedAt ? (
                <div className="shrink-0 px-4 pb-[max(env(safe-area-inset-bottom),12px)] sm:px-6">
                  <div
                    className="flex items-center gap-3 rounded-xl border bg-muted/40 px-4 py-3 text-muted-foreground text-sm"
                    data-testid="archived-banner"
                  >
                    <Archive className="size-4 shrink-0" />
                    <span>
                      #{channel.name} was archived on {formatDate(channel.archivedAt)}. Its cards stay
                      readable.
                    </span>
                  </div>
                </div>
              ) : !channel.isMember ? (
                <div className="shrink-0 px-4 pb-[max(env(safe-area-inset-bottom),12px)] sm:px-6">
                  <div
                    className="flex flex-col items-center gap-3 rounded-xl border bg-muted/40 px-4 py-4 text-center sm:flex-row sm:text-left"
                    data-testid="join-banner"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="font-medium text-sm">You're previewing #{channel.name}</p>
                      <p className="text-muted-foreground text-xs">
                        Join to add cards, move them and reply in their threads.
                      </p>
                    </div>
                    <Button
                      data-testid="join-channel"
                      className="max-md:h-11"
                      disabled={join.isPending}
                      onClick={() =>
                        join.mutate(channel.id, { onError: (e) => toast.error(errorMessage(e)) })
                      }
                    >
                      {join.isPending ? <Spinner /> : null}
                      Join channel
                    </Button>
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
          {isBoard && view === "board" ? null : (
            <DropZone
              conversationLabel={`#${channel.name}`}
              enabled={canDrop}
              hint={attachmentLimitsHint(filesConfig.data)}
              onFiles={(files) => composerApi.current?.addFiles(files)}
            >
              <div className="relative flex min-h-0 flex-1 flex-col">
                <div
                  ref={scroll.ref}
                  onScroll={onScroll}
                  className="scrollbar-thin flex min-h-0 flex-1 flex-col overflow-y-auto"
                  data-testid="channel-scroll"
                  data-detached={detached ? "true" : undefined}
                >
                  {messages.isPending || win.loading ? (
                    <MessagesSkeleton />
                  ) : messages.isError || win.error ? (
                    <EmptyState
                      icon={Hash}
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
                        pending={detached ? [] : channelPending}
                        me={me}
                        typers={channelTypers}
                        onOpenThread={openThread}
                        onRetry={retry}
                        highlightId={threadId}
                        anchorId={threadId ? null : permalinkId}
                        linkFor={linkFor}
                        onAnchorHidden={onAnchorHidden}
                        intro={intro}
                        readOnly={!!channel.archivedAt}
                        canDeleteAny={canModerate}
                        canReact={canPost}
                        canUnpinAny={canArchive}
                        pinnedBy={pinnedBy}
                        dividerAfterSeq={reading.dividerAfterSeq}
                        onMarkUnread={channel.isMember ? markUnreadFrom : undefined}
                        {...(editorFor ? { editorFor } : {})}
                        live={detached ? [] : live}
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

              <TypingIndicator typers={channelTypers} inThreadHint />
              <div className="shrink-0 px-4 pb-[max(env(safe-area-inset-bottom),12px)] sm:px-5">
                {channel.archivedAt ? (
                  <div className="flex items-center gap-3 rounded-xl border bg-muted/40 px-4 py-3 text-muted-foreground text-sm">
                    <Archive className="size-4 shrink-0" />
                    <span>
                      #{channel.name} was archived on {formatDate(channel.archivedAt)}. Its history stays
                      readable.
                    </span>
                  </div>
                ) : !channel.isMember ? (
                  <div
                    className="flex flex-col items-center gap-3 rounded-xl border bg-muted/40 px-4 py-4 text-center sm:flex-row sm:text-left"
                    data-testid="join-banner"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="font-medium text-sm">You're previewing #{channel.name}</p>
                      <p className="text-muted-foreground text-xs">
                        Join to post, reply in threads and get unread updates.
                      </p>
                    </div>
                    <Button
                      data-testid="join-channel"
                      disabled={join.isPending}
                      onClick={() =>
                        join.mutate(channel.id, { onError: (e) => toast.error(errorMessage(e)) })
                      }
                    >
                      {join.isPending ? <Spinner /> : null}
                      Join channel
                    </Button>
                  </div>
                ) : (
                  <Composer
                    placeholder={`Message #${channel.name}`}
                    candidates={candidates}
                    conversationId={channel.id}
                    onSend={(body, _ids, files) => send(body, null, files)}
                    onTyping={() => sendTyping(null)}
                    apiRef={composerApi}
                    autoFocus
                    footer={<ComposerHint />}
                    specialMentions={specialMentions}
                    memberCount={memberList.length || channel.memberCount}
                    unitMentions={unitMentions}
                  />
                )}
              </div>
            </DropZone>
          )}
        </div>

        {threadId ? (
          <ThreadPanel
            key={threadId}
            channel={channel}
            rootId={threadId}
            me={me}
            candidates={candidates}
            unitMentions={unitMentions}
            typers={typers}
            pending={pending}
            canPost={canPost}
            onClose={closeThread}
            onSend={(body, rootId, files) => send(body, rootId, files)}
            onRetry={retry}
            onTyping={(rootId) => sendTyping(rootId)}
            highlightId={permalinkId}
            canUnpinAny={canArchive}
            pinnedBy={pinnedBy}
          />
        ) : null}

        <PinnedSheet
          conversation={{ id: channel.id, kind: "channel", name: channel.name }}
          open={pinsOpen}
          onOpenChange={setPinsOpen}
          canModerate={canArchive}
        />

        {isBoard && board.data && canPost ? (
          <NewCardDialog
            channel={{ id: channel.id, name: channel.name ?? "" }}
            snapshot={board.data}
            open={newCard !== null}
            onOpenChange={(o) => {
              if (!o) setNewCard(null);
            }}
            defaultColumnId={newCard?.columnId ?? null}
            // At 390 the new card's column becomes the visible tab, so the card is in view.
            onCreated={(card) => {
              if (!isDesktop) setParam("col", card.columnId);
            }}
          />
        ) : null}

        {cardBoard && editingCard && canPost ? (
          <CardEditDialog
            convId={channel.id}
            card={editingCard}
            board={cardBoard.board}
            open
            onOpenChange={(o) => {
              if (!o) cardRoots.close();
            }}
          />
        ) : null}

        {canMove ? <MoveChannelDialog channel={channel} open={moveOpen} onOpenChange={setMoveOpen} /> : null}

        <MembersDialog
          channel={channel}
          members={memberList}
          directory={directory.entries}
          open={membersOpen}
          onOpenChange={setMembersOpen}
          meId={me.id}
        />
      </div>
    </MentionContext.Provider>
  );
}
