"use client";

import {
  AgentList,
  type ChannelList,
  ChannelList as ChannelListSchema,
  ChannelMemberList,
  ChannelSummary,
  type CreateChannelRequest,
  type CreateDmRequest,
  type DmAgentCounterpart,
  type DmGroupCounterpart,
  type DmList,
  DmList as DmListSchema,
  type DmParticipant,
  type DmSummary,
  DmSummary as DmSummarySchema,
  type DmUserCounterpart,
  IanaTimeZone,
  type Message,
  type MessageDeletedEvent,
  type MessagePage,
  MessagePage as MessagePageSchema,
  Message as MessageSchema,
  Ok,
  PinnedMessageList,
  type PinUpdatedEvent,
  type ReactionSummary,
  type ReactionUpdatedEvent,
  SavedList,
  type SaveUpdatedEvent,
  ThreadList,
  type ThreadReadEvent,
  type ThreadResponse,
  ThreadResponse as ThreadResponseSchema,
  type ThreadUpdatedEvent,
  type UpdateChannelRequest,
} from "@ocw/contracts";
import {
  type InfiniteData,
  type QueryClient,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { api, isApiError } from "./api";

export const chatKeys = {
  channels: ["chat", "channels"] as const,
  channel: (id: string) => ["chat", "channel", id] as const,
  members: (id: string) => ["chat", "members", id] as const,
  messages: (id: string) => ["chat", "messages", id] as const,
  /** A detached window around a permalink target; shares the `messages` prefix so updates reach both. */
  around: (id: string, anchorId: string) => ["chat", "messages", id, "around", anchorId] as const,
  thread: (rootId: string) => ["chat", "thread", rootId] as const,
  threads: ["chat", "thread"] as const,
  pins: (convId: string) => ["chat", "pins", convId] as const,
  allMessages: ["chat", "messages"] as const,
  saved: ["chat", "saved"] as const,
  /** The Threads view (CHAT-02); not under the `thread` prefix of single threads. */
  threadList: ["chat", "thread-list"] as const,
  agents: ["chat", "agents"] as const,
  dms: ["chat", "dms"] as const,
};

function retryUnlessClientError(failureCount: number, err: unknown): boolean {
  if (isApiError(err) && err.status >= 400 && err.status < 500) return false;
  return failureCount < 2;
}

// ---------------------------------------------------------------- channels

export function useChannels() {
  return useQuery({
    queryKey: chatKeys.channels,
    queryFn: ({ signal }) => api.get("/api/v1/channels", { schema: ChannelListSchema, signal }),
    retry: retryUnlessClientError,
    staleTime: 30_000,
  });
}

export function useCreateChannel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateChannelRequest) =>
      api.post("/api/v1/channels", { body, schema: ChannelSummary }),
    onSuccess: (channel) => {
      qc.setQueryData<ChannelList>(chatKeys.channels, (prev) =>
        prev
          ? {
              ...prev,
              channels: [...prev.channels.filter((c) => c.id !== channel.id), channel].sort((a, b) =>
                (a.name ?? "").localeCompare(b.name ?? ""),
              ),
            }
          : prev,
      );
      void qc.invalidateQueries({ queryKey: chatKeys.channels });
    },
  });
}

function patchChannel(qc: QueryClient, id: string, patch: Partial<ChannelSummary>) {
  qc.setQueryData<ChannelList>(chatKeys.channels, (prev) =>
    prev ? { ...prev, channels: prev.channels.map((c) => (c.id === id ? { ...c, ...patch } : c)) } : prev,
  );
}

/** CHAT-02: move a channel to another unit (or the organization) and/or change its topic (owner or admin). */
export function useUpdateChannel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdateChannelRequest }) =>
      api.patch(`/api/v1/channels/${id}`, { body, schema: ChannelSummary }),
    onSuccess: (channel) => {
      patchChannel(qc, channel.id, channel);
      qc.setQueryData(chatKeys.channel(channel.id), channel);
      void qc.invalidateQueries({ queryKey: chatKeys.channels });
    },
  });
}

export function useChannelAction(action: "join" | "leave" | "archive") {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post(`/api/v1/channels/${id}/${action}`, { body: {} }),
    onSuccess: (_res, id) => {
      if (action === "join") patchChannel(qc, id, { isMember: true });
      void qc.invalidateQueries({ queryKey: chatKeys.channels });
      void qc.invalidateQueries({ queryKey: chatKeys.members(id) });
    },
  });
}

/** Moves the caller's read cursor forward (server keeps the max). */
export function markRead(qc: QueryClient, id: string, seq: number) {
  const list = qc.getQueryData<ChannelList>(chatKeys.channels);
  const ch = list?.channels.find((c) => c.id === id);
  if (!ch?.isMember || ch.lastReadSeq >= seq) return;
  patchChannel(qc, id, { lastReadSeq: seq });
  void api.post(`/api/v1/channels/${id}/read`, { body: { seq }, schema: Ok }).catch(() => {});
}

/** A new top-level message arrived on a channel the user is not looking at. */
/** The list preview of a message body, like the API's `lastMessagePreview` (one line, ≤ 140 chars). */
export function previewOf(body: string): string | null {
  return body.replace(/\s+/g, " ").trim().slice(0, 140) || null;
}

export function bumpLatest(qc: QueryClient, id: string, seq: number, createdAt: string, body?: string) {
  const list = qc.getQueryData<ChannelList>(chatKeys.channels);
  const ch = list?.channels.find((c) => c.id === id);
  if (!ch || ch.latestMessageSeq >= seq) return;
  patchChannel(qc, id, {
    latestMessageSeq: seq,
    lastMessageAt: createdAt,
    ...(body !== undefined ? { lastMessagePreview: previewOf(body) } : {}),
  });
}

// ---------------------------------------------------------------- direct conversations (D-03)

export type BotDm = DmSummary & { counterpart: DmAgentCounterpart };

/** A DM with a bot (Phase 3.1); human and group DMs carry another counterpart kind. */
export function isBotDm(d: DmSummary): d is BotDm {
  return d.counterpart.kind === "agent";
}

export type HumanDm = DmSummary & { counterpart: DmUserCounterpart };
export type GroupDm = DmSummary & { counterpart: DmGroupCounterpart };

export function isHumanDm(d: DmSummary): d is HumanDm {
  return d.counterpart.kind === "user";
}

export function isGroupDm(d: DmSummary): d is GroupDm {
  return d.counterpart.kind === "group";
}

/**
 * Opens (or finds) the direct conversation with `participants` (the caller is implied): one person or bot → a
 * DM, two or more → a group DM (CHAT-04). The result lands in the sidebar's list right away.
 */
export async function createDm(qc: QueryClient, participants: DmParticipant[]): Promise<DmSummary> {
  const body: CreateDmRequest = { participants };
  const dm = await api.post("/api/v1/dms", { body, schema: DmSummarySchema });
  qc.setQueryData<DmList>(chatKeys.dms, (prev) =>
    prev ? { ...prev, dms: [dm, ...prev.dms.filter((d) => d.id !== dm.id)] } : prev,
  );
  void qc.invalidateQueries({ queryKey: chatKeys.dms });
  return dm;
}

/** The caller's direct conversations: bots (personal and team), people and groups, for the sidebar. */
export function useDms() {
  return useQuery({
    queryKey: chatKeys.dms,
    queryFn: ({ signal }) => api.get("/api/v1/dms", { schema: DmListSchema, signal }),
    retry: retryUnlessClientError,
    staleTime: 30_000,
  });
}

function patchDm(qc: QueryClient, id: string, patch: Partial<DmList["dms"][number]>) {
  qc.setQueryData<DmList>(chatKeys.dms, (prev) =>
    prev ? { ...prev, dms: prev.dms.map((d) => (d.id === id ? { ...d, ...patch } : d)) } : prev,
  );
}

/** Moves the caller's DM read cursor forward (server keeps the max). */
export function markDmRead(qc: QueryClient, id: string, seq: number) {
  const dm = qc.getQueryData<DmList>(chatKeys.dms)?.dms.find((d) => d.id === id);
  if (dm && dm.lastReadSeq >= seq) return;
  patchDm(qc, id, { lastReadSeq: seq });
  void api.post(`/api/v1/conversations/${id}/read`, { body: { seq }, schema: Ok }).catch(() => {});
}

/** `markDmRead` as a hook, for components that only hold the conversation id. */
export function useMarkConversationRead() {
  const qc = useQueryClient();
  return (id: string, seq: number) => markDmRead(qc, id, seq);
}

/** A new top-level message arrived in a DM (sidebar unread dot). */
export function bumpDmLatest(qc: QueryClient, id: string, seq: number, createdAt: string, body?: string) {
  const dm = qc.getQueryData<DmList>(chatKeys.dms)?.dms.find((d) => d.id === id);
  if (!dm || dm.latestMessageSeq >= seq) return;
  patchDm(qc, id, {
    latestMessageSeq: seq,
    lastMessageAt: createdAt,
    ...(body !== undefined ? { lastMessagePreview: previewOf(body) } : {}),
  });
}

// ---------------------------------------------------------------- members & agents

export function useChannelMembers(id: string | null) {
  return useQuery({
    enabled: !!id,
    queryKey: chatKeys.members(id ?? ""),
    queryFn: ({ signal }) => api.get(`/api/v1/channels/${id}/members`, { schema: ChannelMemberList, signal }),
    retry: retryUnlessClientError,
  });
}

export function useAddChannelMember(channelId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { kind: "user" | "agent"; id: string }) =>
      api.post(`/api/v1/channels/${channelId}/members`, { body, schema: ChannelMemberList }),
    onSuccess: (members) => {
      qc.setQueryData(chatKeys.members(channelId), members);
      patchChannel(qc, channelId, { memberCount: members.members.length });
    },
  });
}

/** Bots of the org. Tolerates a missing agents API (404) so chat works before the bots module ships. */
export function useAgents() {
  return useQuery({
    queryKey: chatKeys.agents,
    queryFn: async ({ signal }) => {
      try {
        return await api.get("/api/v1/agents", { schema: AgentList, signal });
      } catch (err) {
        if (isApiError(err, 404)) return { agents: [] };
        throw err;
      }
    },
    retry: retryUnlessClientError,
    staleTime: 60_000,
  });
}

// ---------------------------------------------------------------- messages

export function useMessages(channelId: string, enabled: boolean) {
  return useQuery({
    enabled,
    queryKey: chatKeys.messages(channelId),
    queryFn: ({ signal }) =>
      api.get(`/api/v1/conversations/${channelId}/messages?limit=50`, { schema: MessagePageSchema, signal }),
    retry: retryUnlessClientError,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 5 * 60_000,
  });
}

/** The cache key of the window a view shows: the live tail, or the detached window around `anchorId`. */
const windowKey = (convId: string, anchorId?: string | null) =>
  anchorId ? chatKeys.around(convId, anchorId) : chatKeys.messages(convId);

/**
 * The page around a permalink target (CHAT-14): older and newer neighbours of the anchor (a thread reply
 * resolves to its root, `threadRootId`). Detached from the live tail: live messages never grow it at the bottom.
 */
export function useMessagesAround(convId: string, anchorId: string | null) {
  return useQuery({
    enabled: !!anchorId,
    queryKey: chatKeys.around(convId, anchorId ?? ""),
    queryFn: ({ signal }) =>
      api.get(
        `/api/v1/conversations/${convId}/messages?limit=50&around=${encodeURIComponent(anchorId ?? "")}`,
        { schema: MessagePageSchema, signal },
      ),
    retry: retryUnlessClientError,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 60_000,
  });
}

/** Prepends the previous page to the shown window (the tail, or the detached window when `anchorId` is set). */
export async function loadOlder(
  qc: QueryClient,
  channelId: string,
  anchorId?: string | null,
): Promise<boolean> {
  const key = windowKey(channelId, anchorId);
  const page = qc.getQueryData<MessagePage>(key);
  if (!page?.nextBefore) return false;
  const older = await api.get(
    `/api/v1/conversations/${channelId}/messages?limit=50&before=${page.nextBefore}`,
    { schema: MessagePageSchema },
  );
  qc.setQueryData<MessagePage>(key, (prev) => {
    if (!prev) return prev;
    const known = new Set(prev.messages.map((m) => m.id));
    return {
      ...prev,
      messages: [...older.messages.filter((m) => !known.has(m.id)), ...prev.messages],
      nextBefore: older.nextBefore,
    };
  });
  return older.nextBefore !== null;
}

/** Appends the next page (`after=<nextAfter>`) to a detached window; false once it reached the live end. */
export async function loadNewer(qc: QueryClient, convId: string, anchorId: string): Promise<boolean> {
  const key = chatKeys.around(convId, anchorId);
  const page = qc.getQueryData<MessagePage>(key);
  if (!page?.nextAfter) return false;
  const newer = await api.get(`/api/v1/conversations/${convId}/messages?limit=50&after=${page.nextAfter}`, {
    schema: MessagePageSchema,
  });
  qc.setQueryData<MessagePage>(key, (prev) => {
    if (!prev) return prev;
    const known = new Set(prev.messages.map((m) => m.id));
    return {
      ...prev,
      messages: [...prev.messages, ...newer.messages.filter((m) => !known.has(m.id))],
      nextAfter: newer.nextAfter ?? null,
    };
  });
  return (newer.nextAfter ?? null) !== null;
}

/**
 * A detached window that reached the live end folds into the tail page (same rows, so the scroll position holds)
 * and the view is live again. The tail keeps its live updates; the window adds the older history.
 */
export function rejoinTail(qc: QueryClient, convId: string, anchorId: string): boolean {
  const win = qc.getQueryData<MessagePage>(chatKeys.around(convId, anchorId));
  const tail = qc.getQueryData<MessagePage>(chatKeys.messages(convId));
  if (!win || win.nextAfter || !tail) return false;
  const byId = new Map<string, Message>();
  for (const m of win.messages) byId.set(m.id, m);
  for (const m of tail.messages) byId.set(m.id, m);
  const messages = [...byId.values()].sort((a, b) => a.seq - b.seq);
  const winFirst = win.messages[0]?.seq ?? Number.POSITIVE_INFINITY;
  const tailFirst = tail.messages[0]?.seq ?? Number.POSITIVE_INFINITY;
  qc.setQueryData<MessagePage>(chatKeys.messages(convId), {
    ...tail,
    messages,
    nextBefore: winFirst <= tailFirst ? win.nextBefore : tail.nextBefore,
  });
  return true;
}

export function useThread(rootId: string | null) {
  return useQuery({
    enabled: !!rootId,
    queryKey: chatKeys.thread(rootId ?? ""),
    queryFn: ({ signal }) =>
      api.get(`/api/v1/messages/${rootId}/thread`, { schema: ThreadResponseSchema, signal }),
    retry: retryUnlessClientError,
    staleTime: Number.POSITIVE_INFINITY,
  });
}

/**
 * The browser's IANA time zone, so a bot can answer with the poster's local date and time (D-12). Checked
 * against the same contract the API enforces (e.g. Chrome's `Etc/Unknown` is dropped), so a zone can never
 * make a post fail: without one the bot simply gets UTC.
 */
function browserTimeZone(): string | undefined {
  try {
    const parsed = IanaTimeZone.safeParse(Intl.DateTimeFormat().resolvedOptions().timeZone);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export function postMessage(
  channelId: string,
  body: { body: string; threadRootId?: string; clientMessageId: string },
): Promise<Message> {
  const clientTimeZone = browserTimeZone();
  return api.post(`/api/v1/conversations/${channelId}/messages`, {
    body: clientTimeZone ? { ...body, clientTimeZone } : body,
    schema: MessageSchema,
  });
}

/**
 * Applies a message (from the POST response or a `message.created` event) to the caches, idempotently. A
 * top-level message joins the live tail only: a detached permalink window never grows at the bottom by itself.
 */
export function applyMessage(qc: QueryClient, message: Message) {
  if (message.threadId) {
    qc.setQueryData<ThreadResponse>(chatKeys.thread(message.threadId), (prev) => {
      if (!prev || prev.replies.some((r) => r.id === message.id)) return prev;
      const replies = [...prev.replies, message].sort((a, b) => a.seq - b.seq);
      const participants = prev.participants.some(
        (p) => p.kind === message.author?.kind && p.id === message.author?.id,
      )
        ? prev.participants
        : message.author
          ? [...prev.participants, message.author]
          : prev.participants;
      return { ...prev, replies, participants };
    });
    return;
  }
  qc.setQueryData<MessagePage>(chatKeys.messages(message.conversationId), (prev) => {
    if (!prev || prev.messages.some((m) => m.id === message.id)) return prev;
    return { ...prev, messages: [...prev.messages, message].sort((a, b) => a.seq - b.seq) };
  });
}

/**
 * Patches every message window of a conversation: the live tail and any detached permalink window (they share
 * the `chatKeys.messages` prefix). Only creation is tail-only (`applyMessage`).
 */
function patchWindows(qc: QueryClient, convId: string, patch: (m: Message) => Message) {
  qc.setQueriesData<MessagePage>({ queryKey: chatKeys.messages(convId) }, (prev) =>
    prev ? { ...prev, messages: prev.messages.map(patch) } : prev,
  );
}

export function applyThreadUpdate(qc: QueryClient, channelId: string, ev: ThreadUpdatedEvent) {
  const patch = (m: Message): Message =>
    m.id === ev.rootId
      ? {
          ...m,
          replyCount: ev.replyCount,
          lastReplyAt: ev.lastReplyAt,
          replyParticipants: ev.replyParticipants,
        }
      : m;
  patchWindows(qc, channelId, patch);
  qc.setQueryData<ThreadResponse>(chatKeys.thread(ev.rootId), (prev) =>
    prev ? { ...prev, root: patch(prev.root) } : prev,
  );
}

// ---------------------------------------------------------------- edit (CHAT-06)

export function editMessage(id: string, body: string): Promise<Message> {
  return api.patch(`/api/v1/messages/${id}`, { body: { body }, schema: MessageSchema });
}

/**
 * Merges a changed message into a cached one. Realtime payloads omit viewer-specific fields (P-04), so the
 * cached `reactions`, `pinned`, `saved`, `attachments` and the root's `replyParticipants` survive the update.
 */
function mergeMessage(prev: Message, next: Message): Message {
  return {
    ...prev,
    ...next,
    reactions: next.reactions ?? prev.reactions,
    pinned: next.pinned ?? prev.pinned,
    saved: next.saved ?? prev.saved,
    attachments: next.attachments ?? prev.attachments,
    replyParticipants: next.replyParticipants ?? prev.replyParticipants,
  };
}

/** Applies an edited message (PATCH response or `message.updated`) to the page and thread caches. */
export function applyMessageUpdate(qc: QueryClient, message: Message) {
  const patch = (m: Message) => (m.id === message.id ? mergeMessage(m, message) : m);
  if (message.threadId) {
    qc.setQueryData<ThreadResponse>(chatKeys.thread(message.threadId), (prev) =>
      prev ? { ...prev, replies: prev.replies.map(patch) } : prev,
    );
    return;
  }
  patchWindows(qc, message.conversationId, patch);
  qc.setQueryData<ThreadResponse>(chatKeys.thread(message.id), (prev) =>
    prev ? { ...prev, root: patch(prev.root) } : prev,
  );
}

// ---------------------------------------------------------------- delete (CHAT-06, P-05)

export function deleteMessage(id: string): Promise<{ ok: true }> {
  return api.del(`/api/v1/messages/${id}`, { schema: Ok });
}

/**
 * Applies a delete (DELETE response or `message.deleted`) to the page and thread caches: the message becomes a
 * tombstone (empty body, no reactions or attachments). The list hides it unless it still has replies.
 */
export function applyMessageDeleted(qc: QueryClient, ev: MessageDeletedEvent) {
  const tomb = (m: Message): Message =>
    m.id === ev.messageId
      ? {
          ...m,
          body: "",
          mentions: [],
          deletedAt: ev.deletedAt,
          replyCount: ev.replyCount,
          reactions: [],
          attachments: [],
          pinned: false,
        }
      : m;
  if (ev.threadId) {
    qc.setQueryData<ThreadResponse>(chatKeys.thread(ev.threadId), (prev) =>
      prev ? { ...prev, replies: prev.replies.map(tomb) } : prev,
    );
    return;
  }
  patchWindows(qc, ev.conversationId, tomb);
  qc.setQueryData<ThreadResponse>(chatKeys.thread(ev.messageId), (prev) =>
    prev ? { ...prev, root: tomb(prev.root) } : prev,
  );
}

// ---------------------------------------------------------------- reactions (CHAT-07)

/**
 * Applies `patch` to one message wherever it is cached: a reply in its thread, a top-level message in every window
 * of its conversation and as the root of its thread.
 */
function patchMessage(
  qc: QueryClient,
  at: { messageId: string; conversationId: string; threadId: string | null },
  patch: (m: Message) => Message,
) {
  const one = (m: Message) => (m.id === at.messageId ? patch(m) : m);
  if (at.threadId) {
    qc.setQueryData<ThreadResponse>(chatKeys.thread(at.threadId), (prev) =>
      prev ? { ...prev, replies: prev.replies.map(one) } : prev,
    );
    return;
  }
  patchWindows(qc, at.conversationId, one);
  qc.setQueryData<ThreadResponse>(chatKeys.thread(at.messageId), (prev) =>
    prev ? { ...prev, root: one(prev.root) } : prev,
  );
}

/** One emoji's chip set to `next` (removed when null or at count 0); a new emoji goes last (first-reaction order). */
function withReaction(m: Message, emoji: string, next: ReactionSummary | null): Message {
  const list = m.reactions ?? [];
  const i = list.findIndex((r) => r.emoji === emoji);
  if (!next || next.count <= 0) return i < 0 ? m : { ...m, reactions: list.filter((r) => r.emoji !== emoji) };
  if (i < 0) return { ...m, reactions: [...list, next] };
  return { ...m, reactions: list.map((r, j) => (j === i ? next : r)) };
}

/**
 * Applies `reaction.updated` (P-04: absolute count, first reactors, actor). `mine` only changes when the actor is
 * the viewer; any other actor keeps the viewer's own state.
 */
export function applyReactionUpdate(qc: QueryClient, ev: ReactionUpdatedEvent, meId: string) {
  const isMe = ev.actor.kind === "user" && ev.actor.id === meId;
  patchMessage(qc, ev, (m) => {
    const prev = m.reactions?.find((r) => r.emoji === ev.emoji);
    const mine = isMe ? ev.added : (prev?.mine ?? false);
    return withReaction(m, ev.emoji, { emoji: ev.emoji, count: ev.count, mine, members: ev.members });
  });
}

/**
 * Toggles the viewer's `emoji` on `message`: optimistic in every cache, then PUT/DELETE; on failure the previous
 * chip comes back and the error is thrown for the caller's toast. The `reaction.updated` echo sets the absolute
 * count afterwards (idempotent).
 */
export async function toggleReaction(qc: QueryClient, message: Message, emoji: string, meId: string) {
  const before = message.reactions?.find((r) => r.emoji === emoji) ?? null;
  const adding = !before?.mine;
  const me = { kind: "user" as const, id: meId };
  const others = (before?.members ?? []).filter((x) => !(x.kind === "user" && x.id === meId));
  const optimistic: ReactionSummary = {
    emoji,
    count: (before?.count ?? 0) + (adding ? 1 : -1),
    mine: adding,
    members: adding ? [...others, me].slice(0, 20) : others,
  };
  const at = { messageId: message.id, conversationId: message.conversationId, threadId: message.threadId };
  patchMessage(qc, at, (m) => withReaction(m, emoji, optimistic));
  const path = `/api/v1/messages/${message.id}/reactions/${encodeURIComponent(emoji)}`;
  try {
    if (adding) await api.put(path, { body: {}, schema: Ok });
    else await api.del(path, { schema: Ok });
  } catch (err) {
    patchMessage(qc, at, (m) => withReaction(m, emoji, before));
    throw err;
  }
}

// ---------------------------------------------------------------- pins (CHAT-13)

/** The pinned messages of a conversation, newest pin first. */
export function usePins(convId: string, enabled = true) {
  return useQuery({
    enabled: enabled && !!convId,
    queryKey: chatKeys.pins(convId),
    queryFn: ({ signal }) =>
      api.get(`/api/v1/conversations/${convId}/pins`, { schema: PinnedMessageList, signal }),
    retry: retryUnlessClientError,
    staleTime: 60_000,
  });
}

export function pinMessage(convId: string, messageId: string): Promise<{ ok: true }> {
  return api.put(`/api/v1/conversations/${convId}/pins/${messageId}`, { body: {}, schema: Ok });
}

export function unpinMessage(convId: string, messageId: string): Promise<{ ok: true }> {
  return api.del(`/api/v1/conversations/${convId}/pins/${messageId}`, { schema: Ok });
}

/** Patches one message by id in every window of `convId` and in every cached thread (as root or reply). */
function patchById(qc: QueryClient, convId: string, messageId: string, patch: (m: Message) => Message) {
  const one = (m: Message) => (m.id === messageId ? patch(m) : m);
  patchWindows(qc, convId, one);
  qc.setQueriesData<ThreadResponse>({ queryKey: chatKeys.threads }, (prev) =>
    prev && (prev.root.id === messageId || prev.replies.some((r) => r.id === messageId))
      ? { ...prev, root: one(prev.root), replies: prev.replies.map(one) }
      : prev,
  );
}

/** Applies `pin.updated` (or a local pin/unpin): the message's `pinned` flag everywhere, then the pins list. */
export function applyPinUpdate(
  qc: QueryClient,
  ev: Pick<PinUpdatedEvent, "conversationId" | "messageId" | "pinned">,
) {
  patchById(qc, ev.conversationId, ev.messageId, (m) => ({ ...m, pinned: ev.pinned }));
  if (!ev.pinned) {
    qc.setQueryData<PinnedMessageList>(chatKeys.pins(ev.conversationId), (prev) =>
      prev ? { pins: prev.pins.filter((p) => p.message.id !== ev.messageId) } : prev,
    );
  }
  void qc.invalidateQueries({ queryKey: chatKeys.pins(ev.conversationId) });
}

// ---------------------------------------------------------------- personal saves (CHAT-13)

/** The member's Saved list, newest first, paged on `nextCursor`. */
export function useSaved() {
  return useInfiniteQuery({
    queryKey: chatKeys.saved,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      api.get(`/api/v1/saved?limit=30${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ""}`, {
        schema: SavedList,
        signal,
      }),
    getNextPageParam: (last) => last.nextCursor,
    retry: retryUnlessClientError,
    staleTime: 30_000,
  });
}

export function saveMessage(messageId: string): Promise<{ ok: true }> {
  return api.put(`/api/v1/messages/${messageId}/save`, { body: {}, schema: Ok });
}

export function unsaveMessage(messageId: string): Promise<{ ok: true }> {
  return api.del(`/api/v1/messages/${messageId}/save`, { schema: Ok });
}

/**
 * Applies `save.updated` (the member's own `user:` stream, any device) or a local save/unsave: the message's
 * `saved` flag in every cached window, thread and pins list, then the Saved list (removed at once, refetched).
 */
export function applySaveUpdate(qc: QueryClient, ev: SaveUpdatedEvent) {
  const one = (m: Message) => (m.id === ev.messageId ? { ...m, saved: ev.saved } : m);
  qc.setQueriesData<MessagePage>({ queryKey: chatKeys.allMessages }, (prev) =>
    prev?.messages.some((m) => m.id === ev.messageId) ? { ...prev, messages: prev.messages.map(one) } : prev,
  );
  qc.setQueriesData<ThreadResponse>({ queryKey: chatKeys.threads }, (prev) =>
    prev && (prev.root.id === ev.messageId || prev.replies.some((r) => r.id === ev.messageId))
      ? { ...prev, root: one(prev.root), replies: prev.replies.map(one) }
      : prev,
  );
  qc.setQueriesData<PinnedMessageList>({ queryKey: ["chat", "pins"] }, (prev) =>
    prev ? { pins: prev.pins.map((p) => ({ ...p, message: one(p.message) })) } : prev,
  );
  if (!ev.saved) {
    qc.setQueryData<InfiniteData<SavedList>>(chatKeys.saved, (prev) =>
      prev
        ? {
            ...prev,
            pages: prev.pages.map((pg) => ({
              ...pg,
              items: pg.items.filter((i) => i.message.id !== ev.messageId),
            })),
          }
        : prev,
    );
  }
  void qc.invalidateQueries({ queryKey: chatKeys.saved });
}

// ---------------------------------------------------------------- the Threads view (CHAT-02)

/** Threads the member started, replied to or was mentioned in, newest reply first, paged on `nextCursor`. */
export function useThreadList() {
  return useInfiniteQuery({
    queryKey: chatKeys.threadList,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      api.get(`/api/v1/threads?limit=30${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ""}`, {
        schema: ThreadList,
        signal,
      }),
    getNextPageParam: (last) => last.nextCursor,
    retry: retryUnlessClientError,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
}

/** True when `rootId` is in the cached Threads list (the sidebar refreshes it only for those, Pitfall 13). */
export function isListedThread(qc: QueryClient, rootId: string): boolean {
  const data = qc.getQueryData<InfiniteData<ThreadList>>(chatKeys.threadList);
  return data?.pages.some((p) => p.threads.some((t) => t.root.id === rootId)) ?? false;
}

function zeroUnread(qc: QueryClient, rootId: string) {
  qc.setQueryData<InfiniteData<ThreadList>>(chatKeys.threadList, (prev) =>
    prev
      ? {
          ...prev,
          pages: prev.pages.map((p) => ({
            ...p,
            threads: p.threads.map((t) => (t.root.id === rootId ? { ...t, unreadReplies: 0 } : t)),
          })),
        }
      : prev,
  );
}

/** The highest seq this tab already sent per thread, so re-renders never repeat the POST. */
const markedThreads = new Map<string, number>();

/** Marks a thread read up to `seq` (the server keeps the greatest); the Threads list updates at once. */
export function markThreadRead(qc: QueryClient, rootId: string, seq: number) {
  if ((markedThreads.get(rootId) ?? -1) >= seq) return;
  markedThreads.set(rootId, seq);
  zeroUnread(qc, rootId);
  void api.post(`/api/v1/threads/${rootId}/read`, { body: { seq }, schema: Ok }).catch(() => {
    markedThreads.delete(rootId);
  });
}

/** `thread.read` from the member's own `user:` stream (another tab or device read it). */
export function applyThreadRead(qc: QueryClient, ev: ThreadReadEvent) {
  zeroUnread(qc, ev.rootId);
  void qc.invalidateQueries({ queryKey: chatKeys.threadList });
}
