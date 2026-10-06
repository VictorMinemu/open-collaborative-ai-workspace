import {
  type AiChatSnapshot,
  AiDeltaEvent,
  applyAiDelta,
  EphemeralTypes,
  EventTypes,
  type Message,
  MessageCreatedEvent,
  MessageUpdatedEvent,
  type SendAiMessageResponse,
  stitchAiSnapshot,
} from "@ocw/contracts";
import type { TopicFrame } from "@ocw/realtime-client";

/**
 * The live state of one AI chat (P-06), kept pure so it is unit-tested apart from React. Durable frames
 * (`message.created` / `message.updated`) are authoritative; ephemeral `ai.delta` frames are hints applied with
 * `applyAiDelta`. A delta that starts past the known text waits in `pending` (a gap) until a snapshot's
 * `running.partialText` is stitched under it, or the final `message.updated` replaces the text.
 */

export interface AiChatState {
  chatId: string;
  /** The latest snapshot (chat detail); null until the first one arrives. */
  snapshot: AiChatSnapshot | null;
  messages: Message[];
  /** Highest durable seq applied. */
  lastSeq: number;
  /** In-progress answer text by assistant message id. */
  streaming: ReadonlyMap<string, string>;
  /** Deltas that could not apply yet (they start past the known text). */
  pending: readonly AiDeltaEvent[];
  /** Recent durable frames, re-applied over a snapshot that is older than them. */
  recent: readonly DurableAiFrame[];
  /** A hole remains in a streaming answer: the hook refetches the snapshot. */
  gap: boolean;
}

export interface DurableAiFrame {
  seq: number;
  type: string;
  data: unknown;
}

export type AiChatAction =
  | { kind: "snapshot"; snapshot: AiChatSnapshot }
  | { kind: "frame"; frame: TopicFrame }
  | { kind: "sent"; response: SendAiMessageResponse };

const RECENT_MAX = 200;

export function initialAiChatState(chatId: string, primed?: SendAiMessageResponse): AiChatState {
  const base: AiChatState = {
    chatId,
    snapshot: null,
    messages: [],
    lastSeq: 0,
    streaming: new Map(),
    pending: [],
    recent: [],
    gap: false,
  };
  return primed ? reduceAiChat(base, { kind: "sent", response: primed }) : base;
}

const bySeq = (a: Message, b: Message) => a.seq - b.seq;

/** Insert or replace by id, keeping seq order. */
function upsert(list: Message[], m: Message): Message[] {
  const i = list.findIndex((x) => x.id === m.id);
  if (i < 0) return [...list, m].sort(bySeq);
  const next = list.slice();
  next[i] = m;
  return next;
}

/** Streaming text and pending deltas only exist for answers still streaming. */
function prune(state: AiChatState): AiChatState {
  const live = new Set(state.messages.filter((m) => m.status === "streaming").map((m) => m.id));
  const known = new Set(state.messages.map((m) => m.id));
  // An answer we have not seen created yet (its delta raced its `message.created`) keeps its text.
  const keep = (id: string) => live.has(id) || !known.has(id);
  const streaming = new Map([...state.streaming].filter(([id]) => keep(id)));
  const pending = state.pending.filter((d) => keep(d.messageId));
  return { ...state, streaming, pending, gap: pending.length > 0 };
}

/** Applies every pending delta of `messageId` that now fits, in offset order. */
function drain(state: AiChatState, messageId: string): AiChatState {
  let text = state.streaming.get(messageId) ?? "";
  const mine = state.pending.filter((d) => d.messageId === messageId).sort((a, b) => a.offset - b.offset);
  if (mine.length === 0) return state;
  const left: AiDeltaEvent[] = [];
  for (const d of mine) {
    const r = applyAiDelta({ messageId, text }, d);
    if (r.kind === "applied") text = r.text;
    else if (r.kind === "gap") left.push(d);
  }
  const streaming = new Map(state.streaming);
  streaming.set(messageId, text);
  const pending = [...state.pending.filter((d) => d.messageId !== messageId), ...left];
  return { ...state, streaming, pending, gap: pending.length > 0 };
}

function applyDelta(state: AiChatState, d: AiDeltaEvent): AiChatState {
  if (d.conversationId !== state.chatId) return state;
  const message = state.messages.find((m) => m.id === d.messageId);
  // The durable final text already replaced the stream: a late delta is noise.
  if (message && message.status !== "streaming") return state;
  const text = state.streaming.get(d.messageId) ?? "";
  const r = applyAiDelta({ messageId: d.messageId, text }, d);
  if (r.kind === "duplicate") return state;
  if (r.kind === "gap") return { ...state, pending: [...state.pending, d], gap: true };
  const streaming = new Map(state.streaming);
  streaming.set(d.messageId, r.text);
  return drain({ ...state, streaming }, d.messageId);
}

function applyDurable(state: AiChatState, f: DurableAiFrame): AiChatState {
  if (f.seq <= state.lastSeq) return state;
  let messages = state.messages;
  if (f.type === EventTypes.messageCreated || f.type === EventTypes.messageUpdated) {
    const parsed = (
      f.type === EventTypes.messageCreated ? MessageCreatedEvent : MessageUpdatedEvent
    ).safeParse(f.data);
    if (
      parsed.success &&
      parsed.data.message.conversationId === state.chatId &&
      !parsed.data.message.threadId
    ) {
      messages = upsert(messages, parsed.data.message);
    }
  }
  return prune({ ...state, messages, lastSeq: f.seq });
}

/** One of two texts when it extends the other (the longer); otherwise the authoritative one. */
function longerConsistent(current: string, authoritative: string): string {
  if (current.length > authoritative.length && current.startsWith(authoritative)) return current;
  return authoritative;
}

function applySnapshot(state: AiChatState, snap: AiChatSnapshot): AiChatState {
  const fromSnapshot = new Set(snap.messages.map((m) => m.id));
  const maxSeq = snap.messages.reduce((n, m) => Math.max(n, m.seq), 0);
  // Messages we hold that are newer than the snapshot (e.g. a send whose events are still on the wire) stay.
  const newer = state.messages.filter((m) => !fromSnapshot.has(m.id) && m.seq > maxSeq);
  // The same generation never goes back from a final state to streaming: a snapshot read across its finalize
  // (row before, cursor after) must not undo the final `message.updated` we already applied.
  const held = new Map(state.messages.map((m) => [m.id, m]));
  const merged = snap.messages.map((m) => {
    const mine = held.get(m.id);
    const regress =
      mine !== undefined &&
      mine.status !== "streaming" &&
      m.status === "streaming" &&
      mine.generation?.id !== undefined &&
      mine.generation.id === m.generation?.id;
    return regress ? mine : m;
  });
  let next: AiChatState = {
    ...state,
    snapshot: snap,
    messages: [...merged, ...newer].sort(bySeq),
    lastSeq: snap.lastSeq,
  };
  // Durable frames newer than the snapshot win over it.
  for (const f of [...state.recent].sort((a, b) => a.seq - b.seq)) {
    if (f.seq > snap.lastSeq) next = applyDurable(next, f);
  }
  next = { ...next, lastSeq: Math.max(next.lastSeq, state.lastSeq) };

  const running = snap.running;
  const runningMessage = running ? next.messages.find((m) => m.id === running.messageId) : undefined;
  if (running && runningMessage?.status === "streaming") {
    const current = next.streaming.get(running.messageId) ?? "";
    const base = longerConsistent(current, running.partialText);
    const mine = next.pending.filter((d) => d.messageId === running.messageId);
    const stitched = stitchAiSnapshot(base, mine);
    const streaming = new Map(next.streaming);
    streaming.set(running.messageId, stitched.text);
    const left = mine.filter((d) => d.offset + d.text.length > stitched.text.length);
    const pending = [...next.pending.filter((d) => d.messageId !== running.messageId), ...left];
    next = { ...next, streaming, pending };
  }
  return prune(next);
}

export function reduceAiChat(state: AiChatState, action: AiChatAction): AiChatState {
  switch (action.kind) {
    case "snapshot":
      return action.snapshot.chat.id === state.chatId ? applySnapshot(state, action.snapshot) : state;
    case "sent": {
      const r = action.response;
      if (r.chat.id !== state.chatId) return state;
      // The POST answer may arrive after the WebSocket already delivered newer versions: never step back.
      const add = [r.userMessage, r.assistantMessage].filter(
        (m) => !state.messages.some((x) => x.id === m.id),
      );
      if (add.length === 0) return state;
      return prune({ ...state, messages: [...state.messages, ...add].sort(bySeq) });
    }
    case "frame": {
      const f = action.frame;
      if (f.op === "eph") {
        if (f.type !== EphemeralTypes.aiDelta) return state;
        const d = AiDeltaEvent.safeParse(f.data);
        return d.success ? applyDelta(state, d.data) : state;
      }
      const frame: DurableAiFrame = { seq: f.seq, type: f.type, data: f.data };
      const recent = [...state.recent, frame].slice(-RECENT_MAX);
      return applyDurable({ ...state, recent }, frame);
    }
  }
}

/** The text to show for a message: the live stream while it streams, the durable body otherwise. */
export function displayText(state: Pick<AiChatState, "streaming">, m: Message): string {
  if (m.status === "streaming") return state.streaming.get(m.id) ?? m.body;
  return m.body;
}
