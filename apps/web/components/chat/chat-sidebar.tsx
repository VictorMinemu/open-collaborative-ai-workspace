"use client";

import {
  type ChannelSummary,
  type DmSummary,
  EventTypes,
  type MessageCreatedEvent,
  type SaveUpdatedEvent,
} from "@ocw/contracts";
import type { TopicFrame } from "@ocw/realtime-client";
import { useQueryClient } from "@tanstack/react-query";
import { Bookmark, ChevronRight, MessageSquarePlus, Plus } from "lucide-react";
import Link from "next/link";
import { useParams, usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { PersonalBotButton } from "@/components/bots/personal-bot-button";
import { SectionSidebar, sectionItemClass } from "@/components/shell/section-sidebar";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip } from "@/components/ui/tooltip";
import { applySaveUpdate, bumpDmLatest, bumpLatest, chatKeys, useChannels, useDms } from "@/lib/chat-queries";
import { usePermissionCheck } from "@/lib/permissions";
import { useMe } from "@/lib/queries";
import { useTopic } from "@/lib/realtime";
import { cn } from "@/lib/utils";
import { ChannelIcon } from "./channel-icon";
import { CreateChannelDialog } from "./create-channel-dialog";
import { NewDmDialog } from "./new-dm-dialog";
import { GroupAvatars, PrincipalAvatar } from "./principal-avatar";
import { SidebarSections } from "./sidebar-sections";

export { ChannelIcon, isUnread } from "./channel-icon";

/** Watches one DM for new messages so its unread dot updates live (own messages never count). */
function DmWatcher({ dm, meId }: { dm: DmSummary; meId: string }) {
  const qc = useQueryClient();
  const [afterSeq] = useState(dm.lastSeq);
  useTopic(
    `conv:${dm.id}`,
    (frame) => {
      if (frame.op !== "ev" || frame.type !== EventTypes.messageCreated) return;
      const { message } = frame.data as MessageCreatedEvent;
      if (message.threadId) return;
      bumpDmLatest(qc, dm.id, frame.seq, message.createdAt);
      if (message.authorKind === "user" && message.authorId === meId) {
        qc.setQueryData(chatKeys.dms, (prev: { dms: DmSummary[] } | undefined) =>
          prev
            ? {
                ...prev,
                dms: prev.dms.map((d) =>
                  d.id === dm.id ? { ...d, lastReadSeq: Math.max(d.lastReadSeq, frame.seq) } : d,
                ),
              }
            : prev,
        );
      }
    },
    afterSeq,
  );
  return null;
}

/** Watches one joined channel for new top-level messages so its unread dot updates live. */
function ChannelWatcher({ channel, meId }: { channel: ChannelSummary; meId: string }) {
  const qc = useQueryClient();
  const [afterSeq] = useState(channel.lastSeq);
  useTopic(
    `conv:${channel.id}`,
    (frame) => {
      if (frame.op !== "ev" || frame.type !== EventTypes.messageCreated) return;
      const { message } = frame.data as MessageCreatedEvent;
      if (message.threadId) return;
      bumpLatest(qc, channel.id, frame.seq, message.createdAt);
      if (message.authorKind === "user" && message.authorId === meId) {
        // Own messages (from any device) never make a channel unread.
        qc.setQueryData(chatKeys.channels, (prev: { channels: ChannelSummary[] } | undefined) =>
          prev
            ? {
                ...prev,
                channels: prev.channels.map((c) =>
                  c.id === channel.id ? { ...c, lastReadSeq: Math.max(c.lastReadSeq, frame.seq) } : c,
                ),
              }
            : prev,
        );
      }
    },
    afterSeq,
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
  const unread = !active && d.latestMessageSeq > d.lastReadSeq;
  const c = d.counterpart;
  const label = c.name;
  return (
    <Link
      href={`/chat/dm/${d.id}`}
      data-testid="dm-link"
      data-dm-kind={c.kind}
      {...(c.kind === "agent" ? { "data-bot-name": c.name } : {})}
      data-unread={unread || undefined}
      aria-current={active ? "page" : undefined}
      className={cn(sectionItemClass(active), unread && "font-semibold text-foreground")}
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
      {unread ? (
        <>
          <span className="sr-only">(unread)</span>
          <span aria-hidden className="ml-auto size-2 shrink-0 rounded-full bg-primary" />
        </>
      ) : null}
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
  const onSaved = pathname === "/chat/saved";
  const activeId = params.channelId ?? params.conversationId ?? null;
  const me = useMe({ enabled: false });
  const channels = useChannels();
  const dms = useDms();
  const can = usePermissionCheck();
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
  // The API decides every placement; the "+" per section only mirrors it (admins: any unit).
  const canPlace = (unitId: string | null) =>
    unitId === null || can("unit.manage") || memberUnitIds.has(unitId);

  return (
    <>
      <SectionSidebar
        title="Channels"
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
        {/* Personal views. Plan 04-08 moves this into the views group. */}
        <nav aria-label="Your views" className="mb-3 grid gap-px">
          <Link
            href="/chat/saved"
            data-testid="saved-link"
            aria-current={onSaved ? "page" : undefined}
            className={sectionItemClass(onSaved)}
          >
            <Bookmark className={cn("size-4 shrink-0", onSaved ? "" : "text-muted-foreground")} />
            <span className="truncate">Saved</span>
          </Link>
        </nav>
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
