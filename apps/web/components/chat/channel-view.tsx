"use client";

import {
  type AgentTypingEvent,
  ChannelSummary,
  EphemeralTypes,
  EventTypes,
  type MessageCreatedEvent,
  type MessageDeletedEvent,
  type MessageUpdatedEvent,
  type ThreadUpdatedEvent,
  type UserTypingEvent,
} from "@ocw/contracts";
import type { TopicFrame } from "@ocw/realtime-client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, AtSign, Hash, Lock, LogOut, MoreHorizontal, UserPlus, Users } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
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
import { api, errorMessage, isApiError } from "@/lib/api";
import {
  applyMessage,
  applyMessageDeleted,
  applyMessageUpdate,
  applyThreadUpdate,
  bumpLatest,
  chatKeys,
  loadOlder,
  markRead,
  postMessage,
  useChannelAction,
  useChannelMembers,
  useChannels,
  useMessages,
} from "@/lib/chat-queries";
import { useMe } from "@/lib/queries";
import { useRealtime, useTopic } from "@/lib/realtime";
import { formatDate } from "@/lib/utils";
import { ChannelIcon } from "./chat-sidebar";
import { Composer, type ComposerApi, ComposerHint, type MentionCandidate } from "./composer";
import { MentionContext } from "./markdown";
import { MembersDialog } from "./members-dialog";
import { MessageList, type PendingMessage } from "./message-list";
import { PrincipalAvatar } from "./principal-avatar";
import { ThreadPanel } from "./thread-panel";
import { TypingIndicator, useTypers } from "./typing";
import { dirKey, useOrgDirectory } from "./use-chat-directory";
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

export function ChannelView({ channelId }: { channelId: string }) {
  const qc = useQueryClient();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const threadId = searchParams.get("thread");
  const meQ = useMe({ enabled: false });
  const me = useMemo(
    () => ({ id: meQ.data?.user.id ?? "", name: meQ.data?.user.name ?? "You" }),
    [meQ.data?.user.id, meQ.data?.user.name],
  );
  const realtime = useRealtime();

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
  const members = useChannelMembers(channel ? channelId : null);
  const directory = useOrgDirectory();
  const { typers, touch, clear } = useTypers();
  const [pending, setPending] = useState<PendingMessage[]>([]);
  const [membersOpen, setMembersOpen] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const composerApi = useRef<ComposerApi | null>(null);
  const join = useChannelAction("join");
  const leave = useChannelAction("leave");
  const archive = useChannelAction("archive");

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset per channel
  useEffect(() => setPending([]), [channelId]);

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
      if (!handles.has(m.handle)) handles.set(m.handle, { kind: m.kind, displayName: m.displayName });
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
    if (frame.op === "eph") {
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
          bumpLatest(qc, channelId, message.seq, message.createdAt);
          if (document.visibilityState === "visible") markRead(qc, channelId, message.seq);
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
  useTopic(
    messages.data && !revoked ? topic : null,
    onFrame,
    messages.data?.lastSeq,
    () => {
      void qc.invalidateQueries({ queryKey: chatKeys.messages(channelId) });
    },
    { presence: true, onRevoked },
  );

  const sendTyping = useCallback(
    (threadRootId: string | null) =>
      realtime?.sendEphemeral(topic, EphemeralTypes.userTyping, { threadRootId }),
    [realtime, topic],
  );

  // ---------------------------------------------------------------- read cursor
  const lastSeq = messages.data?.messages.at(-1)?.seq ?? 0;
  useEffect(() => {
    if (!lastSeq) return;
    const mark = () => document.visibilityState === "visible" && markRead(qc, channelId, lastSeq);
    mark();
    document.addEventListener("visibilitychange", mark);
    return () => document.removeEventListener("visibilitychange", mark);
  }, [qc, channelId, lastSeq]);

  // ---------------------------------------------------------------- sending
  const channelPending = pending.filter((p) => !p.threadRootId);
  const scroll = useStickToBottom(
    `${messages.data?.messages.length ?? 0}:${channelPending.length}:${messages.data?.messages.at(-1)?.replyCount ?? 0}`,
    channelId,
  );

  const deliver = useCallback(
    async (p: PendingMessage) => {
      try {
        const msg = await postMessage(channelId, {
          body: p.body,
          clientMessageId: p.clientMessageId,
          ...(p.threadRootId ? { threadRootId: p.threadRootId } : {}),
        });
        applyMessage(qc, msg);
        setPending((prev) => prev.filter((x) => x.clientMessageId !== p.clientMessageId));
        if (!msg.threadId) markRead(qc, channelId, msg.seq);
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
    (body: string, threadRootId: string | null = null) => {
      const p: PendingMessage = {
        clientMessageId: newId(),
        body,
        threadRootId,
        failed: false,
        createdAt: new Date().toISOString(),
      };
      if (!threadRootId) scroll.scrollToBottom();
      setPending((prev) => [...prev, p]);
      void deliver(p);
    },
    [deliver, scroll],
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
  const openThread = useCallback(
    (id: string) => router.replace(`${pathname}?thread=${id}`, { scroll: false }),
    [router, pathname],
  );
  const closeThread = useCallback(() => router.replace(pathname, { scroll: false }), [router, pathname]);

  // ---------------------------------------------------------------- older pages
  const olderBusy = useRef(false);
  const onScroll = () => {
    scroll.onScroll();
    const el = scroll.ref.current;
    if (!el || el.scrollTop > 240 || olderBusy.current || !messages.data?.nextBefore) return;
    olderBusy.current = true;
    setLoadingOlder(true);
    scroll.preserve();
    loadOlder(qc, channelId)
      .catch(() => toast.error("Couldn't load older messages"))
      .finally(() => {
        olderBusy.current = false;
        setLoadingOlder(false);
      });
  };

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

  const memberList = members.data?.members ?? [];
  const bots = memberList.filter((m) => m.kind === "agent");
  const canPost = channel.isMember && !channel.archivedAt;
  // The server decides per channel (admin, or the channel owner): the menu only mirrors viewerCan.
  const canArchive = channel.viewerCan?.includes("channel.archive") ?? false;
  // Admins moderate channels they can read (D-01); the server re-decides every delete.
  const canModerate = channel.viewerCan?.includes("message.delete_any") ?? false;
  const channelTypers = typers;

  const intro =
    messages.data && messages.data.nextBefore === null ? (
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
                <PresenceStack people={present} />
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

          <div
            ref={scroll.ref}
            onScroll={onScroll}
            className="scrollbar-thin flex min-h-0 flex-1 flex-col overflow-y-auto"
            data-testid="channel-scroll"
          >
            {messages.isPending ? (
              <MessagesSkeleton />
            ) : messages.isError ? (
              <EmptyState
                icon={Hash}
                title="Couldn't load messages"
                description={errorMessage(messages.error)}
              >
                <Button variant="outline" onClick={() => void messages.refetch()}>
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
                  messages={messages.data?.messages ?? []}
                  pending={channelPending}
                  me={me}
                  typers={channelTypers}
                  onOpenThread={openThread}
                  onRetry={retry}
                  highlightId={threadId}
                  intro={intro}
                  readOnly={!!channel.archivedAt}
                  canDeleteAny={canModerate}
                />
              </div>
            )}
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
                  onClick={() => join.mutate(channel.id, { onError: (e) => toast.error(errorMessage(e)) })}
                >
                  {join.isPending ? <Spinner /> : null}
                  Join channel
                </Button>
              </div>
            ) : (
              <Composer
                placeholder={`Message #${channel.name}`}
                candidates={candidates}
                onSend={(body) => send(body)}
                onTyping={() => sendTyping(null)}
                apiRef={composerApi}
                autoFocus
                footer={<ComposerHint />}
              />
            )}
          </div>
        </div>

        {threadId ? (
          <ThreadPanel
            key={threadId}
            channel={channel}
            rootId={threadId}
            me={me}
            candidates={candidates}
            typers={typers}
            pending={pending}
            canPost={canPost}
            onClose={closeThread}
            onSend={(body, rootId) => send(body, rootId)}
            onRetry={retry}
            onTyping={(rootId) => sendTyping(rootId)}
          />
        ) : null}

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
