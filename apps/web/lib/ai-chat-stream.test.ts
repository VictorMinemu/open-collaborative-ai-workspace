import type { AiChatSnapshot, AiDeltaEvent, Message, SendAiMessageResponse } from "@ocw/contracts";
import type { TopicFrame } from "@ocw/realtime-client";
import { describe, expect, it } from "vitest";
import { type AiChatState, displayText, initialAiChatState, reduceAiChat } from "./ai-chat-stream";

const CHAT = "6f1c1a52-2b8e-4a36-9a43-0d2d4f1b7e01";
const ORG = "0b7f2f5e-8f3e-4f0a-b0a5-5b8d1d0c9a11";
const USER_MSG = "1a2b3c4d-0000-4000-8000-000000000001";
const ANSWER = "1a2b3c4d-0000-4000-8000-000000000002";
const GEN = "1a2b3c4d-0000-4000-8000-000000000003";
const AT = "2026-10-06T10:00:00.000Z";

function message(over: Partial<Message> & Pick<Message, "id" | "seq">): Message {
  return {
    organizationId: ORG,
    conversationId: CHAT,
    authorKind: "user",
    authorId: null,
    body: "",
    mentions: [],
    status: "sent",
    threadId: null,
    replyCount: 0,
    lastReplyAt: null,
    clientKind: null,
    createdAt: AT,
    editedAt: null,
    ...over,
  };
}

const userMsg = message({ id: USER_MSG, seq: 1, body: "hi" });
const streamingAnswer = message({ id: ANSWER, seq: 2, authorKind: "agent", status: "streaming" });
const finalAnswer = (body: string) => ({ ...streamingAnswer, body, status: "completed" as const });

function snapshot(messages: Message[], lastSeq: number, partialText: string | null): AiChatSnapshot {
  return {
    chat: {
      id: CHAT,
      title: "New chat",
      titleSource: "auto",
      lastModel: null,
      lastModelLabel: null,
      archived: false,
      generating: partialText !== null,
      createdAt: AT,
      lastActivityAt: AT,
      settings: { instructions: "", usePersonalInstructions: true, tools: { web: false } },
      tools: [],
      viewerCan: [],
    },
    messages,
    hasMore: false,
    running: partialText === null ? null : { generationId: GEN, messageId: ANSWER, partialText },
    lastSeq,
  } as AiChatSnapshot;
}

const delta = (offset: number, text: string): TopicFrame => ({
  op: "eph",
  topic: `conv:${CHAT}`,
  type: "ai.delta",
  data: { conversationId: CHAT, messageId: ANSWER, generationId: GEN, offset, text } satisfies AiDeltaEvent,
});

const durable = (seq: number, type: string, m: Message): TopicFrame => ({
  op: "ev",
  topic: `conv:${CHAT}`,
  seq,
  type,
  data: { message: m },
});

function run(state: AiChatState, ...frames: TopicFrame[]): AiChatState {
  return frames.reduce((s, frame) => reduceAiChat(s, { kind: "frame", frame }), state);
}

const textOf = (s: AiChatState) => displayText(s, s.messages.find((m) => m.id === ANSWER) as Message);

describe("reduceAiChat", () => {
  it("streams deltas in order onto the answer and lets the final message replace them", () => {
    let s = reduceAiChat(initialAiChatState(CHAT), {
      kind: "snapshot",
      snapshot: snapshot([userMsg, streamingAnswer], 2, ""),
    });
    s = run(s, delta(0, "Hel"), delta(3, "lo"));
    expect(textOf(s)).toBe("Hello");
    s = run(s, durable(3, "message.updated", finalAnswer("Hello!")));
    expect(textOf(s)).toBe("Hello!");
    expect(s.streaming.size).toBe(0);
    // A late delta after the final text is ignored.
    s = run(s, delta(5, " world"));
    expect(textOf(s)).toBe("Hello!");
  });

  it("ignores duplicated deltas and keeps only the unseen suffix of an overlap", () => {
    let s = reduceAiChat(initialAiChatState(CHAT), {
      kind: "snapshot",
      snapshot: snapshot([userMsg, streamingAnswer], 2, ""),
    });
    s = run(s, delta(0, "abc"), delta(0, "abc"), delta(1, "bcde"), delta(2, "c"));
    expect(textOf(s)).toBe("abcde");
    expect(s.gap).toBe(false);
  });

  it("stitches deltas buffered before the snapshot onto its partial text (reload mid-answer)", () => {
    // Subscribed first: these arrive while the snapshot is loading; the snapshot holds the text before them.
    let s = run(initialAiChatState(CHAT), delta(5, "56789"), delta(10, "AB"));
    expect(s.gap).toBe(true);
    s = reduceAiChat(s, { kind: "snapshot", snapshot: snapshot([userMsg, streamingAnswer], 2, "01234") });
    expect(textOf(s)).toBe("0123456789AB");
    expect(s.gap).toBe(false);
  });

  it("keeps only the unseen part of buffered deltas when the snapshot is already ahead of them", () => {
    let s = run(initialAiChatState(CHAT), delta(5, "56789"));
    s = reduceAiChat(s, { kind: "snapshot", snapshot: snapshot([userMsg, streamingAnswer], 2, "0123456") });
    expect(textOf(s)).toBe("0123456789");
    s = run(s, delta(10, "A"));
    expect(textOf(s)).toBe("0123456789A");
  });

  it("reports a gap when a hole remains and repairs it with the next snapshot", () => {
    let s = reduceAiChat(initialAiChatState(CHAT), {
      kind: "snapshot",
      snapshot: snapshot([userMsg, streamingAnswer], 2, "abc"),
    });
    s = run(s, delta(6, "ghi"));
    expect(s.gap).toBe(true);
    expect(textOf(s)).toBe("abc");
    s = reduceAiChat(s, { kind: "snapshot", snapshot: snapshot([userMsg, streamingAnswer], 2, "abcdef") });
    expect(textOf(s)).toBe("abcdefghi");
    expect(s.gap).toBe(false);
  });

  it("never steps back to a shorter snapshot text it already extends", () => {
    let s = reduceAiChat(initialAiChatState(CHAT), {
      kind: "snapshot",
      snapshot: snapshot([userMsg, streamingAnswer], 2, ""),
    });
    s = run(s, delta(0, "abcdef"));
    s = reduceAiChat(s, { kind: "snapshot", snapshot: snapshot([userMsg, streamingAnswer], 2, "abc") });
    expect(textOf(s)).toBe("abcdef");
  });

  it("applies durable frames newer than a refetched snapshot over it", () => {
    let s = reduceAiChat(initialAiChatState(CHAT), {
      kind: "snapshot",
      snapshot: snapshot([userMsg, streamingAnswer], 2, ""),
    });
    s = run(s, durable(3, "message.updated", finalAnswer("done")));
    // A refetch answered from before seq 3 must not resurrect the streaming placeholder.
    s = reduceAiChat(s, { kind: "snapshot", snapshot: snapshot([userMsg, streamingAnswer], 2, "do") });
    expect(textOf(s)).toBe("done");
    expect(s.messages.find((m) => m.id === ANSWER)?.status).toBe("completed");
    expect(s.lastSeq).toBe(3);
  });

  it("drops replayed durable frames the snapshot already holds", () => {
    let s = reduceAiChat(initialAiChatState(CHAT), {
      kind: "snapshot",
      snapshot: snapshot([userMsg, finalAnswer("final")], 3, null),
    });
    s = run(s, durable(2, "message.created", streamingAnswer));
    expect(textOf(s)).toBe("final");
  });

  it("shows a sent turn at once and keeps it when an older snapshot lands", () => {
    const response = {
      chat: snapshot([], 0, null).chat,
      userMessage: userMsg,
      assistantMessage: streamingAnswer,
      generation: {},
    } as unknown as SendAiMessageResponse;
    let s = initialAiChatState(CHAT, response);
    expect(s.messages.map((m) => m.id)).toEqual([USER_MSG, ANSWER]);
    s = run(s, delta(0, "Hi"));
    expect(textOf(s)).toBe("Hi");
    s = reduceAiChat(s, { kind: "snapshot", snapshot: snapshot([], 0, null) });
    expect(s.messages.map((m) => m.id)).toEqual([USER_MSG, ANSWER]);
    expect(textOf(s)).toBe("Hi");
  });

  it("ignores frames of another conversation", () => {
    const s = reduceAiChat(initialAiChatState(CHAT), {
      kind: "snapshot",
      snapshot: snapshot([userMsg, streamingAnswer], 2, ""),
    });
    const other = { ...streamingAnswer, conversationId: ORG, id: GEN };
    const next = run(s, durable(3, "message.created", other), {
      op: "eph",
      topic: `conv:${ORG}`,
      type: "ai.delta",
      data: { conversationId: ORG, messageId: ANSWER, generationId: GEN, offset: 0, text: "x" },
    });
    expect(next.messages).toHaveLength(2);
    expect(textOf(next)).toBe("");
  });
});
