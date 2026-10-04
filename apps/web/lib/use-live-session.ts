"use client";

import {
  EventTypes,
  WorkApproval,
  WorkPrompt,
  WorkSession,
  WorkSessionChanges,
  type WorkSessionDetail,
  WorkSessionEventPayload,
  type WorkSessionEventRecord,
} from "@ocw/contracts";
import type { TopicFrame } from "@ocw/realtime-client";
import { useCallback, useEffect, useReducer } from "react";
import { useTopic } from "./realtime";
import { useWorkSession } from "./workzone-queries";

export interface LiveSession {
  session: WorkSession;
  prompts: WorkPrompt[];
  approvals: WorkApproval[];
  events: WorkSessionEventRecord[];
  /** In-progress assistant text by messageId (ephemeral deltas). */
  streaming: Record<string, string>;
  changes: WorkSessionChanges | null;
  lastSeq: number;
}

type Action = { kind: "reset"; detail: WorkSessionDetail } | { kind: "frame"; frame: TopicFrame };

function upsert<T extends { id: string }>(list: T[], item: T): T[] {
  const i = list.findIndex((x) => x.id === item.id);
  if (i < 0) return [...list, item];
  const next = list.slice();
  next[i] = item;
  return next;
}

function reduce(state: LiveSession | null, action: Action): LiveSession | null {
  if (action.kind === "reset") {
    const d = action.detail;
    return {
      session: d.session,
      prompts: d.prompts,
      approvals: d.approvals,
      events: d.events,
      streaming: {},
      changes: state?.session.id === d.session.id ? state.changes : null,
      lastSeq: d.lastSeq,
    };
  }
  if (!state) return state;
  const f = action.frame;
  if (f.op === "eph") {
    if (f.type !== "assistant.delta") return state;
    const d = f.data as { messageId?: string; text?: string };
    if (!d.messageId || typeof d.text !== "string") return state;
    // Ignore late deltas for messages that are already final.
    if (state.events.some((e) => e.event.type === "assistant.message" && e.event.messageId === d.messageId)) {
      return state;
    }
    return {
      ...state,
      streaming: { ...state.streaming, [d.messageId]: (state.streaming[d.messageId] ?? "") + d.text },
    };
  }
  if (f.seq <= state.lastSeq) return state;
  const next = { ...state, lastSeq: f.seq };
  switch (f.type) {
    case EventTypes.workSessionEvent: {
      const p = WorkSessionEventPayload.safeParse(f.data);
      if (!p.success) return next;
      next.events = [...state.events, { seq: f.seq, at: p.data.at, event: p.data.event }];
      if (
        p.data.event.type === "assistant.message" &&
        state.streaming[p.data.event.messageId] !== undefined
      ) {
        const { [p.data.event.messageId]: _done, ...rest } = state.streaming;
        next.streaming = rest;
      }
      return next;
    }
    case EventTypes.workSessionUpdated: {
      const p = WorkSession.safeParse(f.data);
      return p.success ? { ...next, session: p.data } : next;
    }
    case EventTypes.promptUpdated: {
      const p = WorkPrompt.safeParse(f.data);
      return p.success ? { ...next, prompts: upsert(state.prompts, p.data) } : next;
    }
    case EventTypes.approvalUpdated: {
      const p = WorkApproval.safeParse(f.data);
      return p.success ? { ...next, approvals: upsert(state.approvals, p.data) } : next;
    }
    case EventTypes.workSessionChanges: {
      const p = WorkSessionChanges.safeParse(f.data);
      return p.success ? { ...next, changes: p.data } : next;
    }
    default:
      return next;
  }
}

/**
 * REST snapshot + `ws:<id>` stream (durable events with seq replay, ephemeral deltas) → live session state. The
 * subscription opts into presence: whoever has the session open is shown as watching it.
 */
export function useLiveSession(id: string) {
  const query = useWorkSession(id);
  const [state, dispatch] = useReducer(reduce, null);

  useEffect(() => {
    if (query.data) dispatch({ kind: "reset", detail: query.data });
  }, [query.data]);

  const onFrame = useCallback((frame: TopicFrame) => dispatch({ kind: "frame", frame }), []);
  const ready = state !== null && state.session.id === id;
  // This is the view that shows the session, so the viewer counts as watching it (presence opt-in, RT-04).
  useTopic(ready ? `ws:${id}` : null, onFrame, query.data?.lastSeq, () => void query.refetch(), {
    presence: true,
  });

  return { state: ready ? state : null, query };
}
