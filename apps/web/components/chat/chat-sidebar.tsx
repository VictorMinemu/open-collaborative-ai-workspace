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
import { Bookmark, ChevronRight, Hash, Lock, Plus } from "lucide-react";
import Link from "next/link";
import { useParams, usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { PersonalBotButton } from "@/components/bots/personal-bot-button";
import { SectionSidebar, sectionItemClass } from "@/components/shell/section-sidebar";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip } from "@/components/ui/tooltip";
import {
  applySaveUpdate,
  bumpDmLatest,
  bumpLatest,
  chatKeys,
  isBotDm,
  useChannels,
  useDms,
} from "@/lib/chat-queries";
import { useMe } from "@/lib/queries";
import { useTopic } from "@/lib/realtime";
import { cn } from "@/lib/utils";
import { CreateChannelDialog } from "./create-channel-dialog";
import { PrincipalAvatar } from "./principal-avatar";

export function ChannelIcon({
  channel,
  className,
}: {
  channel: Pick<ChannelSummary, "visibility">;
  className?: string;
}) {
  const Icon = channel.visibility === "private" ? Lock : Hash;
  return (
    <Icon
      className={cn("size-4 shrink-0", className)}
      strokeWidth={channel.visibility === "private" ? 2 : 2.2}
    />
  );
}

export function isUnread(c: ChannelSummary): boolean {
  return c.isMember && c.latestMessageSeq > c.lastReadSeq;
}

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
    if (frame.type.startsWith("conversation.")) refetch();
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

/** "Bots" group under Channels: the caller's private chats with bots (personal first), one-click create. */
function BotsSection({ activeId }: { activeId: string | null }) {
  const dms = useDms();
  const list = (dms.data?.dms ?? []).filter(isBotDm);
  const hasPersonal = list.some((d) => d.counterpart.scope === "personal");
  return (
    <section aria-labelledby="bots-heading" className="mt-5" data-testid="bots-section">
      <div className="flex h-8 items-center justify-between gap-2 px-2">
        <h3
          id="bots-heading"
          className="truncate font-semibold text-[11.5px] text-muted-foreground uppercase tracking-wider"
        >
          Bots
        </h3>
        <PersonalBotButton variant="icon" />
      </div>
      {dms.isPending ? (
        <div className="grid gap-1.5 px-2.5 pt-1">
          <Skeleton className="h-5" style={{ width: "64%" }} />
        </div>
      ) : (
        <nav aria-label="Bots" className="grid gap-px" data-testid="dm-list">
          {list.map((d) => {
            const active = d.id === activeId;
            const unread = !active && d.latestMessageSeq > d.lastReadSeq;
            return (
              <Link
                key={d.id}
                href={`/chat/dm/${d.id}`}
                data-testid="dm-link"
                data-bot-name={d.counterpart.name}
                data-unread={unread || undefined}
                aria-current={active ? "page" : undefined}
                className={cn(sectionItemClass(active), unread && "font-semibold text-foreground")}
              >
                <PrincipalAvatar
                  kind="agent"
                  name={d.counterpart.name}
                  avatarUrl={d.counterpart.avatarUrl}
                  seed={d.counterpart.id}
                  compact
                  className="size-5 text-[11px]"
                />
                <span className="truncate">{d.counterpart.name}</span>
                {unread ? (
                  <>
                    <span className="sr-only">(unread)</span>
                    <span aria-hidden className="ml-auto size-2 shrink-0 rounded-full bg-primary" />
                  </>
                ) : null}
              </Link>
            );
          })}
          {!hasPersonal ? <PersonalBotButton variant="row" /> : null}
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
  const [creating, setCreating] = useState(false);
  const [browseOpen, setBrowseOpen] = useState(false);

  const list = channels.data?.channels ?? [];
  const joined = list.filter((c) => c.isMember);
  const others = list.filter((c) => !c.isMember);

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
              onClick={() => setCreating(true)}
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
          <nav aria-label="Channels" className="grid gap-px" data-testid="channel-list">
            {joined.map((c) => {
              const active = c.id === activeId;
              const unread = !active && isUnread(c);
              return (
                <Link
                  key={c.id}
                  href={`/chat/${c.id}`}
                  data-testid="channel-link"
                  data-channel-name={c.name}
                  data-unread={unread || undefined}
                  aria-current={active ? "page" : undefined}
                  className={cn(sectionItemClass(active), unread && "font-semibold text-foreground")}
                >
                  <ChannelIcon channel={c} className={active ? "" : "text-muted-foreground"} />
                  <span className="truncate">{c.name}</span>
                  {unread ? (
                    <>
                      <span className="sr-only">(unread)</span>
                      <span aria-hidden className="ml-auto size-2 shrink-0 rounded-full bg-primary" />
                    </>
                  ) : null}
                </Link>
              );
            })}
            {others.length > 0 ? (
              <>
                <button
                  type="button"
                  onClick={() => setBrowseOpen((o) => !o)}
                  aria-expanded={browseOpen}
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
                        aria-current={c.id === activeId ? "page" : undefined}
                        className={cn(sectionItemClass(c.id === activeId), "text-muted-foreground")}
                      >
                        <ChannelIcon channel={c} />
                        <span className="truncate">{c.name}</span>
                      </Link>
                    ))
                  : null}
              </>
            ) : null}
            <button
              type="button"
              onClick={() => setCreating(true)}
              className={cn(sectionItemClass(false), "mt-1 text-muted-foreground")}
            >
              <span className="flex size-4 items-center justify-center rounded-[4px] bg-muted">
                <Plus className="size-3" />
              </span>
              Add a channel
            </button>
          </nav>
        )}
        <BotsSection activeId={activeId} />
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

      <CreateChannelDialog open={creating} onOpenChange={setCreating} />
    </>
  );
}
