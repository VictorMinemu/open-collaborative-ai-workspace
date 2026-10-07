"use client";

import {
  type AiChatAccessChangedEvent,
  AiChatDetail,
  AiChatList,
  type AiChatListScope,
  type AiChatSnapshot,
  AiChatSnapshot as AiChatSnapshotSchema,
  type AiChatSummary,
  AiChatSummary as AiChatSummarySchema,
  AiModelList,
  AiUserPreferences,
  type ConversationReadEvent,
  type CreateAiChatRequest,
  EventTypes,
  type Message,
  type Notification,
  type RegenerateRequest,
  type SendAiMessageRequest,
  SendAiMessageResponse,
  StopAiGenerationResponse,
  topic,
  type UpdateAiChatRequest,
  type UpdateAiUserPreferencesRequest,
} from "@ocw/contracts";
import type { TopicFrame } from "@ocw/realtime-client";
import {
  type InfiniteData,
  type QueryClient,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useCallback, useEffect, useReducer, useRef } from "react";
import { type AiChatState, displayText, initialAiChatState, reduceAiChat } from "./ai-chat-stream";
import { api, isApiError } from "./api";
import { useMe } from "./queries";
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
  /** The member's chat list (05-10): the recent one (sidebar and /chat/ai) or the archived one. */
  list: (archived: boolean) => ["ai", "chats", archived ? "archived" : "recent"] as const,
  /** Chats other members shared with the viewer (06-03, `scope=shared`), not archived. */
  shared: ["ai", "chats", "shared"] as const,
  /** The latest summary of one chat seen live (`ai_chat.updated`, a rename): the header's title and archive state. */
  summary: (id: string) => ["ai", "summary", id] as const,
  /** Settings and tool states of one chat after a PATCH (05-11): newer than its snapshot. */
  settings: (id: string) => ["ai", "settings", id] as const,
  /** The member's own defaults (05-11). */
  preferences: ["ai", "preferences"] as const,
};

/** Rows per page of the chat list (the API's keyset cursor). */
const LIST_PAGE = 30;

/**
 * The member's AI chats (05-10, AICHAT-04): newest activity first, keyset-paged, the archived ones apart. Kept live
 * by `applyAiChatUpdated` (the sidebar's `user:` topic), so a new chat, a generated title, a rename or an archive
 * moves rows without a refetch.
 */
export function useAiChats(
  archived = false,
  opts: { enabled?: boolean; scope?: Exclude<AiChatListScope, "all"> } = {},
) {
  const scope = opts.scope ?? "mine";
  return useInfiniteQuery({
    queryKey: scope === "shared" ? aiKeys.shared : aiKeys.list(archived),
    queryFn: ({ pageParam, signal }) => {
      const p = new URLSearchParams({ limit: String(LIST_PAGE), archived: String(archived) });
      if (scope !== "mine") p.set("scope", scope);
      if (pageParam) p.set("cursor", pageParam);
      return api.get(`/api/v1/ai-chats?${p.toString()}`, { schema: AiChatList, signal });
    },
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    staleTime: 30_000,
    enabled: opts.enabled ?? true,
  });
}

/**
 * AI chats other members shared with the viewer (06-03, MULTI-01): newest activity first. A new grant arrives live as
 * `ai_chat.updated` with the viewer's access, which `applyAiChatUpdated` routes here, never to the viewer's own list.
 */
export function useSharedAiChats(opts: { enabled?: boolean } = {}) {
  return useAiChats(false, { ...opts, scope: "shared" });
}

type ListData = InfiniteData<AiChatList, string | null>;

const newestFirst = (a: AiChatSummary, b: AiChatSummary) =>
  b.lastActivityAt.localeCompare(a.lastActivityAt) || b.id.localeCompare(a.id);

/**
 * Applies a chat summary from `ai_chat.updated` (or a PATCH answer) to every cache that shows it: the chat's live
 * summary, and the lists (removed from the ones it no longer belongs to, inserted or moved in its own; loaded rows
 * are re-sorted onto the first page so the next page's cursor stays valid).
 */
export function applyAiChatUpdated(qc: QueryClient, chat: AiChatSummary): void {
  qc.setQueryData(aiKeys.summary(chat.id), chat);
  // Phase 6: a chat someone shared with the viewer belongs to "Shared with me" only (absent access = owner).
  const sharedWithMe = chat.access !== undefined && chat.access !== "owner";
  const lists: Array<{ key: readonly unknown[]; belongs: boolean }> = [
    { key: aiKeys.list(false), belongs: !sharedWithMe && !chat.archived },
    { key: aiKeys.list(true), belongs: !sharedWithMe && chat.archived },
    { key: aiKeys.shared, belongs: sharedWithMe && !chat.archived },
  ];
  for (const { key, belongs } of lists) {
    qc.setQueryData<ListData>(key, (prev) => {
      if (!prev) return prev;
      const rest = prev.pages.flatMap((p) => p.chats).filter((c) => c.id !== chat.id);
      const last = prev.pages.at(-1);
      const tail = rest.at(-1);
      // Older than everything loaded while more pages exist: it arrives with paging.
      const later = belongs && !!last?.nextCursor && !!tail && newestFirst(tail, chat) < 0;
      const rows = belongs && !later ? [...rest, chat].sort(newestFirst) : rest;
      return {
        ...prev,
        pages: prev.pages.map((p, i) => ({ ...p, chats: i === 0 ? rows : [] })),
      };
    });
  }
}

/** Patches one chat's row in every list cache that holds it (no move, no insert). */
function patchListedChat(qc: QueryClient, chatId: string, patch: (c: AiChatSummary) => AiChatSummary): void {
  for (const key of [aiKeys.list(false), aiKeys.list(true), aiKeys.shared]) {
    qc.setQueryData<ListData>(key, (prev) =>
      prev?.pages.some((p) => p.chats.some((c) => c.id === chatId))
        ? {
            ...prev,
            pages: prev.pages.map((p) => ({
              ...p,
              chats: p.chats.map((c) => (c.id === chatId ? patch(c) : c)),
            })),
          }
        : prev,
    );
  }
}

/**
 * `conversation.read` of a shared AI chat from any of the member's tabs or devices (06-08): the unread count as the
 * server computed it. Rows without a count (solo chats, chats the member has not joined) keep none.
 */
export function applyAiChatRead(qc: QueryClient, ev: ConversationReadEvent): void {
  patchListedChat(qc, ev.conversationId, (c) =>
    c.unreadCount === undefined && !c.shared ? c : { ...c, unreadCount: ev.unreadCount },
  );
}

/**
 * `ai_chat.access_changed` on the member's `user:` topic (06-08, T-06-08-01): a chat the member lost leaves "Shared
 * with me" at once; a new or changed access arrives with its own `ai_chat.updated`.
 */
export function applyAiChatAccessChanged(qc: QueryClient, ev: AiChatAccessChangedEvent): void {
  if (ev.access !== null) return;
  qc.setQueryData<ListData>(aiKeys.shared, (prev) =>
    prev
      ? {
          ...prev,
          pages: prev.pages.map((p) => ({ ...p, chats: p.chats.filter((c) => c.id !== ev.conversationId) })),
        }
      : prev,
  );
}

/** A chat shared with the member by name (`ai_chat_shared`): "Shared with me" refetches its counts and order. */
export function applyAiChatNotification(qc: QueryClient, n: Notification): void {
  if (n.kind === "ai_chat_shared") void qc.invalidateQueries({ queryKey: aiKeys.shared });
}

/** The newest seq this tab asked the server to mark read, per chat (the server keeps the greatest anyway). */
const readSent = new Map<string, number>();

/**
 * Marks a shared AI chat read up to `seq` (06-08, like a channel): the badge clears at once and the server moves the
 * cursor forward only, clears the notifications it covers and tells the member's other tabs and devices.
 */
export function markAiChatRead(qc: QueryClient, chatId: string, seq: number): void {
  if ((readSent.get(chatId) ?? -1) >= seq) return;
  readSent.set(chatId, seq);
  patchListedChat(qc, chatId, (c) => (c.unreadCount ? { ...c, unreadCount: 0 } : c));
  void api.post(`/api/v1/ai-chats/${chatId}/read`, { body: { seq } }).catch(() => {
    readSent.delete(chatId);
  });
}

/** Debounce of the open chat's read marker: a burst of frames is one request. */
const READ_DEBOUNCE_MS = 400;

/**
 * The open shared chat is read while the tab is visible (06-08, P-09): debounced on its newest message seq. Solo
 * chats are never marked (they keep no badge, Phase 5 unchanged).
 */
function useAiChatReadMarker(chatId: string, shared: boolean, latestSeq: number): void {
  const qc = useQueryClient();
  useEffect(() => {
    if (!shared || latestSeq <= 0) return;
    const mark = () => {
      if (document.visibilityState === "visible") markAiChatRead(qc, chatId, latestSeq);
    };
    const t = setTimeout(mark, READ_DEBOUNCE_MS);
    document.addEventListener("visibilitychange", mark);
    return () => {
      clearTimeout(t);
      document.removeEventListener("visibilitychange", mark);
    };
  }, [qc, chatId, shared, latestSeq]);
}

/** The live summary of a chat when one arrived after its snapshot (title, archive), else undefined. */
export function useAiChatSummary(chatId: string): AiChatSummary | undefined {
  const q = useQuery<AiChatSummary | null>({
    queryKey: aiKeys.summary(chatId),
    queryFn: () => null,
    enabled: false,
    staleTime: Number.POSITIVE_INFINITY,
  });
  return q.data ?? undefined;
}

/** Rename, archive/unarchive and settings (owner only); the answer updates every cache at once. */
export async function updateAiChat(
  qc: QueryClient,
  chatId: string,
  body: UpdateAiChatRequest,
): Promise<AiChatDetail> {
  const detail = await api.patch(`/api/v1/ai-chats/${chatId}`, { body, schema: AiChatDetail });
  const { settings, tools, viewerCan: _v, ...summary } = detail;
  applyAiChatUpdated(qc, summary);
  qc.setQueryData(aiKeys.settings(chatId), { settings, tools });
  return detail;
}

/** The chat's settings and tool states saved after its snapshot (chat settings sheet), else undefined. */
export function useAiChatSettingsLive(chatId: string): Pick<AiChatDetail, "settings" | "tools"> | undefined {
  const q = useQuery<Pick<AiChatDetail, "settings" | "tools"> | null>({
    queryKey: aiKeys.settings(chatId),
    queryFn: () => null,
    enabled: false,
    staleTime: Number.POSITIVE_INFINITY,
  });
  return q.data ?? undefined;
}

/** The member's own AI chat defaults: personal instructions, default model, Web on new chats (05-11). */
export function useAiPreferences() {
  return useQuery({
    queryKey: aiKeys.preferences,
    queryFn: () => api.get("/api/v1/me/ai-preferences", { schema: AiUserPreferences }),
    staleTime: 60_000,
  });
}

/** Saves the member's defaults; the model list's default follows the new default model. */
export async function saveAiPreferences(
  qc: QueryClient,
  body: UpdateAiUserPreferencesRequest,
): Promise<AiUserPreferences> {
  const saved = await api.put("/api/v1/me/ai-preferences", { body, schema: AiUserPreferences });
  qc.setQueryData(aiKeys.preferences, saved);
  void qc.invalidateQueries({ queryKey: aiKeys.models });
  return saved;
}

const GAP_REFETCH_MS = 1_200;
const GAP_REFETCH_TRIES = 3;
/** A streaming answer with no frame for this long re-reads the snapshot (the server heartbeats every 10 s). */
const STALL_REFETCH_MS = 10_000;

/**
 * The models the member may pick (`GET /ai-chat/models`). An admin's change in Settings › Models (a provider key, the
 * allowed list) arrives as `model_providers.updated` on `org:<id>` and refetches the list live, so an open picker
 * stops offering a model the admin just removed.
 */
export function useAiModels() {
  const qc = useQueryClient();
  const me = useMe({ enabled: false });
  const orgId = me.data?.organization.id ?? null;
  useTopic(orgId ? topic("org", orgId) : null, (frame) => {
    if (frame.op === "ev" && frame.type === EventTypes.modelProvidersUpdated) {
      void qc.invalidateQueries({ queryKey: aiKeys.models });
    }
  });
  return useQuery({
    queryKey: aiKeys.models,
    queryFn: () => api.get("/api/v1/ai-chat/models", { schema: AiModelList }),
    staleTime: 60_000,
  });
}

export function createAiChat(body: CreateAiChatRequest): Promise<SendAiMessageResponse> {
  return api.post("/api/v1/ai-chats", { body, schema: SendAiMessageResponse });
}

/**
 * An empty AI chat to upload files into before the first message (05-12): New chat creates one when the member
 * attaches the first file; it stays out of every list until its first message.
 */
export function createAiDraft(): Promise<AiChatSummary> {
  return api.post("/api/v1/ai-chats/drafts", { body: {}, schema: AiChatSummarySchema });
}

export function sendAiMessage(chatId: string, body: SendAiMessageRequest): Promise<SendAiMessageResponse> {
  return api.post(`/api/v1/ai-chats/${chatId}/messages`, { body, schema: SendAiMessageResponse });
}

/**
 * Stops a running answer (05-06). The request may land on any API instance; the text written so far stays and the
 * final `message.updated` (Stopped) arrives over the socket. Idempotent: a finished answer answers its status.
 */
export function stopGeneration(chatId: string, generationId: string): Promise<StopAiGenerationResponse> {
  return api.post(`/api/v1/ai-chats/${chatId}/generations/${generationId}/stop`, {
    body: {},
    schema: StopAiGenerationResponse,
  });
}

/**
 * Regenerates the chat's last answer (05-06), on its previous model or `model`. `messageId` is the answer on
 * screen: the API refuses (409 `not_last_answer`) when another tab already moved the chat on. The answer resets and
 * streams again on the same message; the replaced text is kept server-side (message_versions).
 */
export function regenerate(chatId: string, body: RegenerateRequest): Promise<SendAiMessageResponse> {
  return api.post(`/api/v1/ai-chats/${chatId}/regenerate`, { body, schema: SendAiMessageResponse });
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
  /** Answers rendered streaming now are live on this page (not a replay ahead of the first snapshot). */
  live: boolean;
  /** This page sent or regenerated in the chat (New chat's first send lands here with it set). */
  sentHere: boolean;
  error: unknown;
  notFound: boolean;
  refetch: () => void;
}

export function useAiChat(chatId: string): AiChatView {
  const qc = useQueryClient();
  // This page sent (or regenerated) in the chat: what streams next is live, even before the first snapshot.
  const sentHere = useRef(false);
  const [state, dispatch] = useReducer(reduceAiChat, chatId, (id): AiChatState => {
    const primed = handoff.get(id);
    handoff.delete(id);
    if (primed) sentHere.current = true;
    return initialAiChatState(id, primed);
  });

  // 1. Subscribe first (declared before the query, so its effect runs first). A snapshot already in the cache
  //    gives the replay cursor; otherwise the server replays the chat's events, which the reducer dedupes by seq.
  const cursor = useRef(qc.getQueryData<AiChatSnapshot>(aiKeys.chat(chatId))?.lastSeq);
  const lastFrameAt = useRef(Date.now());
  const onFrame = useCallback((frame: TopicFrame) => {
    lastFrameAt.current = Date.now();
    dispatch({ kind: "frame", frame });
  }, []);
  // A `resync` (too many events to replay) re-reads the snapshot; the query is declared below.
  const resync = useRef<() => void>(() => {});
  useTopic(`conv:${chatId}`, onFrame, cursor.current, () => resync.current());

  // 2. Then the snapshot. Every snapshot (first load, gap refetch, reconnect) is stitched with what streamed.
  const query = useQuery({
    queryKey: aiKeys.chat(chatId),
    queryFn: () => api.get(`/api/v1/ai-chats/${chatId}`, { schema: AiChatSnapshotSchema }),
    retry: (n, err) => !(isApiError(err) && err.status >= 400 && err.status < 500) && n < 2,
    refetchOnWindowFocus: false,
  });
  const refetch = query.refetch;
  resync.current = () => void refetch();

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

  // 4. Safety net: an answer still streaming with nothing heard for a while re-reads the snapshot (the final
  //    `message.updated` may have raced a snapshot taken just before it).
  const streamingNow = state.messages.some((m) => m.status === "streaming");
  useEffect(() => {
    if (!streamingNow) return;
    lastFrameAt.current = Date.now();
    const t = setInterval(() => {
      if (Date.now() - lastFrameAt.current < STALL_REFETCH_MS) return;
      lastFrameAt.current = Date.now();
      void refetch();
    }, 2_000);
    return () => clearInterval(t);
  }, [streamingNow, refetch]);

  // 5. Back online after a drop: the socket resumes durable events by seq; the snapshot brings the partial text.
  const status = useRealtimeStatus();
  const wasDown = useRef(false);
  useEffect(() => {
    if (status === "reconnecting") wasDown.current = true;
    if (status === "open" && wasDown.current) {
      wasDown.current = false;
      void refetch();
    }
  }, [status, refetch]);

  // 6. A shared chat on screen is read (06-08): its badge clears here and on the member's other devices.
  const live = useAiChatSummary(chatId);
  const shared = (live?.shared ?? state.snapshot?.chat.shared ?? query.data?.chat.shared) === true;
  const latestSeq = state.messages.reduce((max, m) => (m.threadId === null && m.seq > max ? m.seq : max), 0);
  useAiChatReadMarker(chatId, shared, latestSeq);

  const textOf = useCallback((m: Message) => displayText(state, m), [state]);
  const applySent = useCallback((r: SendAiMessageResponse) => {
    sentHere.current = true;
    dispatch({ kind: "sent", response: r });
  }, []);

  return {
    snapshot: state.snapshot ?? query.data,
    messages: state.messages,
    streamingText: state.streaming,
    textOf,
    applySent,
    isPending: query.isPending && state.messages.length === 0,
    // A fresh page replays the chat's durable events before its snapshot lands: an answer that ended before the
    // page opened then shows `streaming` for a moment. Until a snapshot (or a send from this page) anchors the
    // state, nothing rendered counts as having streamed here (05-14: no usage-limit dialog again after a reload).
    // Only the snapshot the reducer applied counts: `query.data` is set one render before the effect applies it,
    // and that render still showed the replayed `streaming` placeholder as live (05-15, the dialog reopened).
    live: sentHere.current || state.snapshot !== null,
    sentHere: sentHere.current,
    error: query.error,
    notFound: isApiError(query.error, 404),
    refetch: () => void refetch(),
  };
}

/** A fresh idempotency key for a send (the API dedupes retries on it, P-07). */
export function newClientMessageId(): string {
  return crypto.randomUUID();
}
