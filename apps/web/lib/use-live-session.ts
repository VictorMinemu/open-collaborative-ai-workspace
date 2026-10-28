"use client";

import {
  EventTypes,
  type RevokeCause,
  type RevokedFrame,
  WorkApproval,
  WorkPrompt,
  WorkSession,
  WorkSessionChanges,
  type WorkSessionDetail,
  WorkSessionEventPayload,
  type WorkSessionEventRecord,
  type WorkSessionList,
} from "@ocw/contracts";
import type { TopicFrame } from "@ocw/realtime-client";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useReducer, useState } from "react";
import { markSeen } from "@/components/work-zone/sidebar/use-seen-sessions";
import { useTopic } from "./realtime";
import { mergeSessionSnapshot, useWorkSession, wzKeys } from "./workzone-queries";

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
      // The `ws:` snapshot is viewer-neutral: the per-viewer fields keep the REST snapshot's values (07.10, PD-03).
      const p = WorkSession.safeParse(f.data);
      return p.success ? { ...next, session: mergeSessionSnapshot(state.session, p.data) } : next;
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
 * When a stream frame ends a turn the open view just watched (07.10-04, R10): a prompt that completed or failed, or the
 * session turning idle. Returns the server's time of that end, so the seen map is never behind the API's
 * `lastTurnEndedAt` when the browser's clock is; null for any other frame.
 */
/** What a session frame must carry to end a turn (the rest of the snapshot is the reducer's business). */
const TurnState = WorkSession.pick({ status: true, updatedAt: true });

export function turnEndedAt(frame: TopicFrame): number | null {
  if (frame.op === "eph") return null;
  if (frame.type === EventTypes.promptUpdated) {
    const p = WorkPrompt.safeParse(frame.data);
    if (!p.success || (p.data.status !== "completed" && p.data.status !== "failed")) return null;
    return p.data.completedAt ? Date.parse(p.data.completedAt) : 0;
  }
  if (frame.type === EventTypes.workSessionUpdated) {
    const p = TurnState.safeParse(frame.data);
    return p.success && p.data.status === "idle" ? Date.parse(p.data.updatedAt) : null;
  }
  return null;
}

/** The latest turn end a freshly loaded view knows (the viewer's own last turn, every finished prompt); 0 if none. */
export function lastTurnEndOf(detail: { session: WorkSession; prompts: readonly WorkPrompt[] }): number {
  const times = [detail.session.attention?.lastTurnEndedAt, ...detail.prompts.map((p) => p.completedAt)]
    .filter((t): t is string => typeof t === "string")
    .map((t) => Date.parse(t))
    .filter(Number.isFinite);
  return Math.max(0, ...times);
}

/**
 * REST snapshot + `ws:<id>` stream (durable events with seq replay, ephemeral deltas) → live session state. The
 * subscription opts into presence: whoever has the session open is shown as watching it.
 *
 * RT-01: when the server drops the stream because the viewer lost access (role, rule or device change), `revoked`
 * turns true for this id: the cached detail is removed and not refetched, and the stream stays closed. It resets
 * when the id changes. `lostTitle` keeps the title the viewer was already looking at; `lostCause` is the frame's
 * reason code (07.9, D-13), null when the server gave none.
 */
export function useLiveSession(id: string) {
  const qc = useQueryClient();
  const [lost, setLost] = useState<{ id: string; title: string | null; cause: RevokeCause | null } | null>(
    null,
  );
  const revoked = lost?.id === id;
  const query = useWorkSession(id, { enabled: !revoked });
  const [state, dispatch] = useReducer(reduce, null);

  useEffect(() => {
    if (!query.data) return;
    dispatch({ kind: "reset", detail: query.data });
    // The viewer opened the session: its finished turns are seen in this browser ("Your turn" leaves, 07.10-04).
    markSeen(query.data.session.id, Math.max(Date.now(), lastTurnEndOf(query.data)));
  }, [query.data]);

  const onFrame = useCallback(
    (frame: TopicFrame) => {
      dispatch({ kind: "frame", frame });
      // A turn ended while the view is open: the viewer saw it (local only, never sent; 07.10-04, R10).
      const ended = turnEndedAt(frame);
      if (ended !== null) markSeen(id, Math.max(Date.now(), ended));
      // Settings and what the caller may pick follow the session (D-07): refresh the controls with it.
      if (frame.op !== "eph" && frame.type === EventTypes.workSessionUpdated) {
        void qc.invalidateQueries({ queryKey: wzKeys.controls(id) });
      }
    },
    [qc, id],
  );
  const ready = state !== null && state.session.id === id;
  const title = ready ? state.session.title : null;
  const onRevoked = useCallback(
    (frame: RevokedFrame) => {
      setLost({ id, title, cause: frame.cause ?? null });
      qc.removeQueries({ queryKey: wzKeys.session(id) });
      // Drop the row at once: a refetch may now be refused (403) and would otherwise keep the stale list.
      qc.setQueryData<WorkSessionList>(wzKeys.sessions, (old) =>
        old ? { ...old, sessions: old.sessions.filter((s) => s.id !== id) } : old,
      );
      void qc.invalidateQueries({ queryKey: wzKeys.sessions });
    },
    [qc, id, title],
  );
  // This is the view that shows the session, so the viewer counts as watching it (presence opt-in, RT-04).
  useTopic(ready && !revoked ? `ws:${id}` : null, onFrame, query.data?.lastSeq, () => void query.refetch(), {
    presence: true,
    onRevoked,
  });

  return {
    state: ready && !revoked ? state : null,
    query,
    revoked,
    lostTitle: revoked ? (lost?.title ?? null) : null,
    /** Why the live view was taken away (D-13: `visibility`, `role`, `device`, `module`); null when not said. */
    lostCause: revoked ? (lost?.cause ?? null) : null,
  };
}
