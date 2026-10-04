"use client";

import {
  AgentList,
  type ChannelList,
  ChannelList as ChannelListSchema,
  ChannelMemberList,
  ChannelSummary,
  type CreateChannelRequest,
  type Message,
  type MessagePage,
  MessagePage as MessagePageSchema,
  Message as MessageSchema,
  Ok,
  type ThreadResponse,
  ThreadResponse as ThreadResponseSchema,
  type ThreadUpdatedEvent,
} from "@ocw/contracts";
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, isApiError } from "./api";

export const chatKeys = {
  channels: ["chat", "channels"] as const,
  channel: (id: string) => ["chat", "channel", id] as const,
  members: (id: string) => ["chat", "members", id] as const,
  messages: (id: string) => ["chat", "messages", id] as const,
  thread: (rootId: string) => ["chat", "thread", rootId] as const,
  agents: ["chat", "agents"] as const,
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
    prev ? { channels: prev.channels.map((c) => (c.id === id ? { ...c, ...patch } : c)) } : prev,
  );
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
export function bumpLatest(qc: QueryClient, id: string, seq: number, createdAt: string) {
  const list = qc.getQueryData<ChannelList>(chatKeys.channels);
  const ch = list?.channels.find((c) => c.id === id);
  if (!ch || ch.latestMessageSeq >= seq) return;
  patchChannel(qc, id, { latestMessageSeq: seq, lastMessageAt: createdAt });
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

export async function loadOlder(qc: QueryClient, channelId: string): Promise<boolean> {
  const page = qc.getQueryData<MessagePage>(chatKeys.messages(channelId));
  if (!page?.nextBefore) return false;
  const older = await api.get(
    `/api/v1/conversations/${channelId}/messages?limit=50&before=${page.nextBefore}`,
    { schema: MessagePageSchema },
  );
  qc.setQueryData<MessagePage>(chatKeys.messages(channelId), (prev) => {
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

export function postMessage(
  channelId: string,
  body: { body: string; threadRootId?: string; clientMessageId: string },
): Promise<Message> {
  return api.post(`/api/v1/conversations/${channelId}/messages`, { body, schema: MessageSchema });
}

/** Applies a message (from the POST response or a `message.created` event) to the caches, idempotently. */
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
  qc.setQueryData<MessagePage>(chatKeys.messages(channelId), (prev) =>
    prev ? { ...prev, messages: prev.messages.map(patch) } : prev,
  );
  qc.setQueryData<ThreadResponse>(chatKeys.thread(ev.rootId), (prev) =>
    prev ? { ...prev, root: patch(prev.root) } : prev,
  );
}
