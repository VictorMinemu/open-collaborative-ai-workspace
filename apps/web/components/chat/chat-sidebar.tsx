"use client";

import {
  type AiChatUpdatedEvent,
  type ChannelSummary,
  type ConversationReadEvent,
  type DmSummary,
  EventTypes,
  type MessageCreatedEvent,
  type MessageDeletedEvent,
  type NotificationCreatedEvent,
  type NotificationReadEvent,
  type SaveUpdatedEvent,
  type ThreadReadEvent,
  type ThreadUpdatedEvent,
} from "@ocw/contracts";
import type { TopicFrame } from "@ocw/realtime-client";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, MessageSquarePlus, Plus } from "lucide-react";
import Link from "next/link";
import { useParams, usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { PersonalBotButton } from "@/components/bots/personal-bot-button";
import { SectionSidebar, sectionItemClass } from "@/components/shell/section-sidebar";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip } from "@/components/ui/tooltip";
import { applyAiChatUpdated } from "@/lib/ai-chat-queries";
import {
  applyConversationRead,
  applySaveUpdate,
  applyThreadRead,
  badgeRowOf,
  bumpDmLatest,
  bumpLatest,
  bumpMention,
  bumpUnread,
  chatKeys,
  hasUnread,
  isListedThread,
  refreshCountsSoon,
  useChannels,
  useDms,
  useReadHold,
  useThreadList,
} from "@/lib/chat-queries";
import {
  applyNotificationCreated,
  applyNotificationRead,
  unreadOf,
  useNotifications,
} from "@/lib/notification-queries";
import { usePermissionCheck } from "@/lib/permissions";
import { useMe } from "@/lib/queries";
import { useTopic } from "@/lib/realtime";
import { cn } from "@/lib/utils";
import { AiChatsSection } from "./ai-chats-section";
import { ChannelIcon, isUnread } from "./channel-icon";
import { ConversationBadge } from "./conversation-badge";
import { CreateChannelDialog } from "./create-channel-dialog";
import { NewDmDialog } from "./new-dm-dialog";
import { GroupAvatars, PrincipalAvatar } from "./principal-avatar";
import { MutedIcon, rowBadge, SidebarSections } from "./sidebar-sections";
import { SidebarViews } from "./sidebar-views";

export { ChannelIcon, isUnread } from "./channel-icon";

/**
 * Badge deltas of one conversation from its `conv:` frames (CHAT-09, D-07): a new top-level message from someone
 * else counts once (seq-idempotent against the snapshot), the member's own (any device) moves the cursor, a deleted
 * top-level message re-reads the snapshot. Reactions, edits, thread replies and membership changes never count.
 */
function applyBadgeFrame(
  qc: QueryClient,
  id: string,
  frame: TopicFrame,
  meId: string,
  kind: "channel" | "dm",
) {
  if (frame.op !== "ev") return;
  if (frame.type === EventTypes.messageDeleted) {
    if (!(frame.data as MessageDeletedEvent).threadId) refreshCountsSoon(qc);
    return;
  }
  if (frame.type !== EventTypes.messageCreated) return;
  const { message } = frame.data as MessageCreatedEvent;
  if (message.threadId) return;
  const before = badgeRowOf(qc, id);
  const fresh = !!before && frame.seq > before.latestMessageSeq;
  if (kind === "dm") bumpDmLatest(qc, id, frame.seq, message.createdAt, message.body);
  else bumpLatest(qc, id, frame.seq, message.createdAt, message.body);
  if (message.authorKind === "user" && message.authorId === meId) {
    // Own messages (from any device) never make a conversation unread.
    if (kind === "dm") {
      qc.setQueryData(chatKeys.dms, (prev: { dms: DmSummary[] } | undefined) =>
        prev
          ? {
              ...prev,
              dms: prev.dms.map((d) =>
                d.id === id ? { ...d, lastReadSeq: Math.max(d.lastReadSeq, frame.seq) } : d,
              ),
            }
          : prev,
      );
    } else {
      qc.setQueryData(chatKeys.channels, (prev: { channels: ChannelSummary[] } | undefined) =>
        prev
          ? {
              ...prev,
              channels: prev.channels.map((c) =>
                c.id === id ? { ...c, lastReadSeq: Math.max(c.lastReadSeq, frame.seq) } : c,
              ),
            }
          : prev,
      );
    }
    return;
  }
  if (fresh && before && frame.seq > before.lastReadSeq) bumpUnread(qc, id);
}

/** Watches one DM for new messages so its badge updates live (own messages never count). */
function DmWatcher({ dm, meId }: { dm: DmSummary; meId: string }) {
  const qc = useQueryClient();
  const [afterSeq] = useState(dm.lastSeq);
  useTopic(
    `conv:${dm.id}`,
    (frame) => applyBadgeFrame(qc, dm.id, frame, meId, "dm"),
    afterSeq,
    // A gap beyond the replay window: the snapshot is the authority again (03.2-11 keeps the cursor right).
    () => refreshCountsSoon(qc),
  );
  return null;
}

let threadsTimer: ReturnType<typeof setTimeout> | null = null;
/**
 * The Threads view refreshes from the frames the channel watchers already receive (Pitfall 13: no per-thread
 * subscription): a `thread.updated` for a listed thread, or for a thread the member just took part in.
 */
function refreshThreadsSoon(qc: QueryClient) {
  if (threadsTimer) clearTimeout(threadsTimer);
  threadsTimer = setTimeout(() => {
    threadsTimer = null;
    void qc.invalidateQueries({ queryKey: chatKeys.threadList });
  }, 400);
}

/** Watches one joined channel so its badge and the Threads view update live (no other subscription). */
function ChannelWatcher({ channel, meId }: { channel: ChannelSummary; meId: string }) {
  const qc = useQueryClient();
  const [afterSeq] = useState(channel.lastSeq);
  useTopic(
    `conv:${channel.id}`,
    (frame) => {
      if (frame.op === "ev" && frame.type === EventTypes.threadUpdated) {
        const ev = frame.data as ThreadUpdatedEvent;
        const mine = ev.replyParticipants?.some((p) => p.kind === "user" && p.id === meId);
        if (mine || isListedThread(qc, ev.rootId)) refreshThreadsSoon(qc);
        return;
      }
      applyBadgeFrame(qc, channel.id, frame, meId, "channel");
    },
    afterSeq,
    // A gap beyond the replay window: the snapshot is the authority again (03.2-11 keeps the cursor right).
    () => refreshCountsSoon(qc),
  );
  return null;
}

/** Org/user list-change topics → refetch the channel list (debounced). */
function useChannelListSync(
  orgId: string | undefined,
  userId: string | undefined,
  seqs: { org?: number; user?: number },
) {
  const qc = useQueryClient();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Freeze the first snapshot's cursors so refetches do not resubscribe.
  const [cursors] = useState(seqs);
  const refetch = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      void qc.invalidateQueries({ queryKey: chatKeys.channels });
      void qc.invalidateQueries({ queryKey: chatKeys.dms });
    }, 150);
  };
  const onFrame = (frame: TopicFrame) => {
    // A renamed, moved or deleted unit changes section titles and channel placement (CHAT-02).
    if (frame.type.startsWith("conversation.") || frame.type === EventTypes.unitsUpdated) refetch();
  };
  // The member's own stream also carries their private saves (P-04), from any of their devices.
  const onUserFrame = (frame: TopicFrame) => {
    if (frame.op === "ev" && frame.type === EventTypes.saveUpdated) {
      applySaveUpdate(qc, frame.data as SaveUpdatedEvent);
      return;
    }
    // Read marks of threads (any of the member's tabs and devices) update the Threads view (P-04).
    if (frame.op === "ev" && frame.type === EventTypes.threadRead) {
      applyThreadRead(qc, frame.data as ThreadReadEvent);
      return;
    }
    // The inbox (CHAT-08): new notifications and read marks from any tab or device. A mention or reply in a
    // thread the Threads view does not list yet refreshes it too (no per-thread subscription, Pitfall 13).
    if (frame.op === "ev" && frame.type === EventTypes.notificationCreated) {
      const ev = frame.data as NotificationCreatedEvent;
      applyNotificationCreated(qc, ev);
      // CHAT-09: a mention-like notification of a top-level message is a mention badge on its conversation.
      bumpMention(qc, ev.notification);
      if (ev.notification.threadRootId) refreshThreadsSoon(qc);
      return;
    }
    if (frame.op === "ev" && frame.type === EventTypes.notificationRead) {
      applyNotificationRead(qc, frame.data as NotificationReadEvent);
      return;
    }
    // The member's own AI chats (05-10): created, titled, renamed, archived, answering — from any tab or device.
    if (frame.op === "ev" && frame.type === EventTypes.aiChatUpdated) {
      applyAiChatUpdated(qc, (frame.data as AiChatUpdatedEvent).chat);
      return;
    }
    // Read and mark-unread from any of the member's tabs and devices (CHAT-09, Pitfall 2).
    if (frame.op === "ev" && frame.type === EventTypes.conversationRead) {
      applyConversationRead(qc, frame.data as ConversationReadEvent);
      return;
    }
    onFrame(frame);
  };
  useTopic(orgId ? `org:${orgId}` : null, onFrame, cursors.org);
  useTopic(userId ? `user:${userId}` : null, onUserFrame, cursors.user);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
}

function ListSync({
  orgId,
  userId,
  orgSeq,
  userSeq,
}: {
  orgId: string;
  userId: string;
  orgSeq?: number;
  userSeq?: number;
}) {
  useChannelListSync(orgId, userId, {
    ...(orgSeq !== undefined ? { org: orgSeq } : {}),
    ...(userSeq !== undefined ? { user: userSeq } : {}),
  });
  return null;
}

/** One row of Direct messages: a bot (as in 3.1), a person or a group. */
function DmRow({ d, active }: { d: DmSummary; active: boolean }) {
  const held = useReadHold(d.id) !== null;
  const { input, style } = rowBadge(d, (!active || held) && hasUnread(d));
  const unread = style !== "none";
  const c = d.counterpart;
  const label = c.name;
  return (
    <Link
      href={`/chat/dm/${d.id}`}
      data-testid="dm-link"
      data-dm-kind={c.kind}
      {...(c.kind === "agent" ? { "data-bot-name": c.name } : {})}
      data-unread={unread || undefined}
      data-muted={d.muted || undefined}
      aria-current={active ? "page" : undefined}
      className={cn(
        sectionItemClass(active),
        unread && "font-semibold text-foreground",
        d.muted && !active && style !== "mention" && "opacity-60",
      )}
    >
      {c.kind === "group" ? (
        <GroupAvatars members={c.members} />
      ) : (
        <PrincipalAvatar
          kind={c.kind}
          name={c.name}
          avatarUrl={c.avatarUrl}
          seed={c.id}
          compact
          className="size-5 text-[11px]"
        />
      )}
      <span className={cn("truncate", c.kind === "user" && c.deactivated && "text-muted-foreground")}>
        {label}
      </span>
      {c.kind === "group" ? (
        <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
          {c.members.length + 1}
        </span>
      ) : null}
      {d.muted ? <MutedIcon /> : null}
      <ConversationBadge {...input} className={d.muted ? "ml-1" : undefined} />
    </Link>
  );
}

/**
 * "Direct messages" under Channels (CHAT-04): the caller's private chats with bots (personal first), people
 * and groups; "+" opens the New message picker; one-click personal bot creation while the caller has none.
 */
function DirectMessagesSection({ activeId, onNew }: { activeId: string | null; onNew: () => void }) {
  const dms = useDms();
  const list = dms.data?.dms ?? [];
  const hasPersonal = list.some((d) => d.counterpart.kind === "agent" && d.counterpart.scope === "personal");
  return (
    <section aria-labelledby="dm-heading" className="mt-5" data-testid="dm-section">
      <div className="flex h-8 items-center justify-between gap-2 px-2">
        <h3
          id="dm-heading"
          className="truncate font-semibold text-[11.5px] text-muted-foreground uppercase tracking-wider"
        >
          Direct messages
        </h3>
        <Tooltip content="New message">
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="New message"
            data-testid="new-dm"
            onClick={onNew}
          >
            <Plus />
          </Button>
        </Tooltip>
      </div>
      {dms.isPending ? (
        <div className="grid gap-1.5 px-2.5 pt-1">
          <Skeleton className="h-5" style={{ width: "64%" }} />
        </div>
      ) : (
        <nav aria-label="Direct messages" className="grid gap-px" data-testid="dm-list">
          {list.map((d) => (
            <DmRow key={d.id} d={d} active={d.id === activeId} />
          ))}
          {!hasPersonal ? <PersonalBotButton variant="row" /> : null}
          <button
            type="button"
            onClick={onNew}
            data-testid="new-dm-row"
            className={cn(sectionItemClass(false), "text-muted-foreground")}
          >
            <span className="flex size-5 items-center justify-center rounded-[30%] bg-muted">
              <MessageSquarePlus className="size-3" />
            </span>
            New message
          </button>
        </nav>
      )}
    </section>
  );
}

export function ChatSidebar() {
  const params = useParams<{ channelId?: string; conversationId?: string }>();
  const pathname = usePathname();
  const activeId = params.channelId ?? params.conversationId ?? null;
  const me = useMe({ enabled: false });
  const channels = useChannels();
  const dms = useDms();
  const can = usePermissionCheck();
  const threads = useThreadList();
  const mentions = useNotifications("mentions");
  const [creating, setCreating] = useState<{ unitId: string | null } | null>(null);
  const [browseOpen, setBrowseOpen] = useState(false);
  const [newDmOpen, setNewDmOpen] = useState(false);

  const list = channels.data?.channels ?? [];
  const memberUnitIds = new Set(channels.data?.memberUnitIds ?? []);
  const joined = list.filter((c) => c.isMember);
  // CHAT-02: the public channels of the member's own departments and teams show in their section (muted until
  // joined), so a new department channel reaches everyone in it live; everything else stays under More channels.
  const suggested = list.filter(
    (c) => !c.isMember && !c.archivedAt && c.unit != null && memberUnitIds.has(c.unit.id),
  );
  const suggestedIds = new Set(suggested.map((c) => c.id));
  const others = list.filter((c) => !c.isMember && !suggestedIds.has(c.id));
  // View badges: conversations with unread messages (All) and threads with unread replies (Threads).
  // A muted conversation counts only while something addresses the member (CHAT-10: same rule as its badge).
  const unreadAll =
    joined.filter((c) => c.id !== activeId && rowBadge(c, isUnread(c)).style !== "none").length +
    (dms.data?.dms ?? []).filter((d) => d.id !== activeId && rowBadge(d, hasUnread(d)).style !== "none")
      .length;
  // Every thread with unread replies (the API counts all pages on the first one, CHAT-09); the loaded pages otherwise.
  const unreadThreads =
    threads.data?.pages[0]?.unreadThreads ??
    (threads.data?.pages ?? []).flatMap((p) => p.threads).filter((t) => t.unreadReplies > 0).length;
  // The API decides every placement; the "+" per section only mirrors it (admins: any unit).
  const canPlace = (unitId: string | null) =>
    unitId === null || can("unit.manage") || memberUnitIds.has(unitId);

  return (
    <>
      <SectionSidebar
        title="Chat"
        actions={
          <Tooltip content="Create channel">
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Create channel"
              data-testid="create-channel"
              onClick={() => setCreating({ unitId: null })}
            >
              <Plus />
            </Button>
          </Tooltip>
        }
      >
        <SidebarViews
          activePath={pathname}
          counts={{ all: unreadAll, mentions: unreadOf(mentions.data), threads: unreadThreads }}
        />
        <AiChatsSection />
        {channels.isPending ? (
          <div className="grid gap-1.5 px-2.5 pt-1">
            {[72, 56, 64].map((w) => (
              <Skeleton key={w} className="h-5" style={{ width: `${w}%` }} />
            ))}
          </div>
        ) : (
          <nav aria-label="Channels" className="grid grid-cols-1 gap-px" data-testid="channel-list">
            <SidebarSections
              channels={[...joined, ...suggested]}
              activeId={activeId}
              memberUnitIds={memberUnitIds}
              onCreate={(unitId) => setCreating({ unitId })}
              canPlace={canPlace}
            />
            {others.length > 0 ? (
              <>
                <button
                  type="button"
                  onClick={() => setBrowseOpen((o) => !o)}
                  aria-expanded={browseOpen}
                  data-testid="more-channels"
                  className="mt-3 mb-0.5 flex h-7 items-center gap-1 px-2.5 text-left font-medium text-muted-foreground text-xs outline-none hover:text-foreground"
                >
                  <ChevronRight className={cn("size-3.5 transition-transform", browseOpen && "rotate-90")} />
                  More channels
                  <span className="ml-1 rounded-full bg-muted px-1.5 text-[10.5px] tabular-nums">
                    {others.length}
                  </span>
                </button>
                {browseOpen
                  ? others.map((c) => (
                      <Link
                        key={c.id}
                        href={`/chat/${c.id}`}
                        data-testid="channel-link"
                        data-channel-name={c.name}
                        data-joined="false"
                        aria-current={c.id === activeId ? "page" : undefined}
                        className={cn(sectionItemClass(c.id === activeId), "text-muted-foreground")}
                      >
                        <ChannelIcon channel={c} />
                        <span className="truncate">{c.name}</span>
                        {c.unit ? (
                          <span className="ml-auto max-w-[45%] shrink-0 truncate text-[11px] text-muted-foreground/80">
                            {c.unit.name}
                          </span>
                        ) : null}
                      </Link>
                    ))
                  : null}
              </>
            ) : null}
            <button
              type="button"
              onClick={() => setCreating({ unitId: null })}
              className={cn(sectionItemClass(false), "mt-1 text-muted-foreground")}
            >
              <span className="flex size-4 items-center justify-center rounded-[4px] bg-muted">
                <Plus className="size-3" />
              </span>
              Add a channel
            </button>
          </nav>
        )}
        <DirectMessagesSection activeId={activeId} onNew={() => setNewDmOpen(true)} />
      </SectionSidebar>

      {me.data && channels.data ? (
        <>
          <ListSync
            orgId={me.data.organization.id}
            userId={me.data.user.id}
            {...(channels.data.orgSeq !== undefined ? { orgSeq: channels.data.orgSeq } : {})}
            {...(channels.data.userSeq !== undefined ? { userSeq: channels.data.userSeq } : {})}
          />
          {joined.map((c) => (
            <ChannelWatcher key={c.id} channel={c} meId={me.data.user.id} />
          ))}
          {(dms.data?.dms ?? []).map((d) => (
            <DmWatcher key={d.id} dm={d} meId={me.data.user.id} />
          ))}
        </>
      ) : null}

      <CreateChannelDialog
        open={creating !== null}
        onOpenChange={(o) => !o && setCreating(null)}
        defaultUnitId={creating?.unitId ?? null}
      />
      <NewDmDialog open={newDmOpen} onOpenChange={setNewDmOpen} />
    </>
  );
}
