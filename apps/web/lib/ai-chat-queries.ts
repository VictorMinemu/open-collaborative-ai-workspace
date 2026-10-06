"use client";

import {
  type AiChatSnapshot,
  AiChatSnapshot as AiChatSnapshotSchema,
  AiModelList,
  type CreateAiChatRequest,
  type Message,
  type SendAiMessageRequest,
  SendAiMessageResponse,
} from "@ocw/contracts";
import type { TopicFrame } from "@ocw/realtime-client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useReducer, useRef } from "react";
import { type AiChatState, displayText, initialAiChatState, reduceAiChat } from "./ai-chat-stream";
import { api, isApiError } from "./api";
import { useRealtimeStatus, useTopic } from "./realtime";

/**
 * AI chat data (P-06). The page subscribes to `conv:<id>` FIRST and only then loads the snapshot; `onFrame` feeds
 * the pure reducer of `ai-chat-stream.ts`: `message.created` appends, `ai.delta` goes through `applyAiDelta` onto
 * the streaming answer, `message.updated` replaces it. Deltas that arrive before the snapshot (or past a hole) are
 * buffered and stitched onto its `running.partialText` with `stitchAiSnapshot`. While a hole remains the snapshot
 * is refetched (at most 3 times, 1.2 s apart); the final durable `message.updated` always replaces the text. A
 * reconnect of the socket runs the same refetch.
 */

export const aiKeys = {
  models: ["ai", "models"] as const,
  chat: (id: string) => ["ai", "chat", id] as const,
};

const GAP_REFETCH_MS = 1_200;
const GAP_REFETCH_TRIES = 3;

export function useAiModels() {
  return useQuery({
    queryKey: aiKeys.models,
    queryFn: () => api.get("/api/v1/ai-chat/models", { schema: AiModelList }),
    staleTime: 60_000,
  });
}

export function createAiChat(body: CreateAiChatRequest): Promise<SendAiMessageResponse> {
  return api.post("/api/v1/ai-chats", { body, schema: SendAiMessageResponse });
}

export function sendAiMessage(chatId: string, body: SendAiMessageRequest): Promise<SendAiMessageResponse> {
  return api.post(`/api/v1/ai-chats/${chatId}/messages`, { body, schema: SendAiMessageResponse });
}

/**
 * A send answered before the page of the new chat mounted (`/chat/ai/new` → `/chat/ai/<id>`): the new page shows
 * both turns at once instead of an empty screen while its snapshot loads.
 */
const handoff = new Map<string, SendAiMessageResponse>();

export function primeAiChat(response: SendAiMessageResponse): void {
  handoff.set(response.chat.id, response);
}

export interface AiChatView {
  snapshot: AiChatSnapshot | undefined;
  messages: Message[];
  /** In-progress answer text by assistant message id. */
  streamingText: ReadonlyMap<string, string>;
  /** The text to render for a message (live while it streams). */
  textOf: (m: Message) => string;
  /** Applies a send answered by the API (both turns show before their events arrive). */
  applySent: (r: SendAiMessageResponse) => void;
  isPending: boolean;
  error: unknown;
  notFound: boolean;
  refetch: () => void;
}

export function useAiChat(chatId: string): AiChatView {
  const qc = useQueryClient();
  const [state, dispatch] = useReducer(reduceAiChat, chatId, (id): AiChatState => {
    const primed = handoff.get(id);
    handoff.delete(id);
    return initialAiChatState(id, primed);
  });

  // 1. Subscribe first (declared before the query, so its effect runs first). A snapshot already in the cache
  //    gives the replay cursor; otherwise the server replays the chat's events, which the reducer dedupes by seq.
  const cursor = useRef(qc.getQueryData<AiChatSnapshot>(aiKeys.chat(chatId))?.lastSeq);
  const onFrame = useCallback((frame: TopicFrame) => dispatch({ kind: "frame", frame }), []);
  const query = useQuery({
    queryKey: aiKeys.chat(chatId),
    queryFn: () => api.get(`/api/v1/ai-chats/${chatId}`, { schema: AiChatSnapshotSchema }),
    retry: (n, err) => !(isApiError(err) && err.status >= 400 && err.status < 500) && n < 2,
    refetchOnWindowFocus: false,
  });
  const refetch = query.refetch;
  useTopic(`conv:${chatId}`, onFrame, cursor.current, () => void refetch());

  // 2. Every snapshot (first load, gap refetch, reconnect) is stitched with what streamed meanwhile.
  useEffect(() => {
    if (query.data) dispatch({ kind: "snapshot", snapshot: query.data });
  }, [query.data]);

  // 3. A hole in a streaming answer: refetch while it remains (≤ 3 tries, 1.2 s apart).
  const gapNow = useRef(state.gap);
  gapNow.current = state.gap;
  useEffect(() => {
    if (!state.gap) return;
    let cancelled = false;
    void (async () => {
      for (let i = 0; i < GAP_REFETCH_TRIES; i++) {
        await new Promise((r) => setTimeout(r, GAP_REFETCH_MS));
        if (cancelled || !gapNow.current) return;
        await refetch();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [state.gap, refetch]);

  // 4. Back online after a drop: the socket resumes durable events by seq; the snapshot brings the partial text.
  const status = useRealtimeStatus();
  const wasDown = useRef(false);
  useEffect(() => {
    if (status === "reconnecting") wasDown.current = true;
    if (status === "open" && wasDown.current) {
      wasDown.current = false;
      void refetch();
    }
  }, [status, refetch]);

  const textOf = useCallback((m: Message) => displayText(state, m), [state]);
  const applySent = useCallback((r: SendAiMessageResponse) => dispatch({ kind: "sent", response: r }), []);

  return {
    snapshot: state.snapshot ?? query.data,
    messages: state.messages,
    streamingText: state.streaming,
    textOf,
    applySent,
    isPending: query.isPending && state.messages.length === 0,
    error: query.error,
    notFound: isApiError(query.error, 404),
    refetch: () => void refetch(),
  };
}

/** A fresh idempotency key for a send (the API dedupes retries on it, P-07). */
export function newClientMessageId(): string {
  return crypto.randomUUID();
}
