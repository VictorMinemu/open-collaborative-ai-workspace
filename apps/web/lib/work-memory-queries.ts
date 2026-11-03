"use client";

import {
  ApprovalRequestUpdatedEvent,
  EventTypes,
  MemoryPreferences,
  SessionMemorySummary,
  topic,
  WorkSessionMemoryUpdatedEvent,
} from "@ocw/contracts";
import type { TopicFrame } from "@ocw/realtime-client";
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, isApiError } from "./api";
import { useMe } from "./queries";
import { useTopic } from "./realtime";

/**
 * Work Zone → project memory in the web (Phase 07.6-22, AUTO-06; D-06 as amended by D-10, D-07, D-11; UI-SPEC
 * Surface 9, R7). The strip's state comes only from the per-viewer `GET /work-sessions/:id/memory` (`canPropose`,
 * `canMap` and the model are this viewer's), and it is refreshed only by frames on the viewer's own `user:` stream:
 * `work_session_memory.updated {workSessionId}` and `approval_request.updated {id}`. Never from the shared `ws:` stream
 * nor the `WorkSession` DTO (D-11). Every response is parsed with its contract schema.
 */

export const workMemoryKeys = {
  all: ["work-memory"] as const,
  sessions: ["work-memory", "session"] as const,
  session: (id: string) => ["work-memory", "session", id] as const,
  preferences: ["work-memory", "preferences"] as const,
};

/** 4xx answers are decisions (404 = not in the session's audience), never retried. */
function noRetryOn4xx(failureCount: number, err: unknown): boolean {
  if (isApiError(err) && err.status >= 400 && err.status < 500) return false;
  return failureCount < 2;
}

/** The session's memory state for this viewer; `enabled` only for a finished session (Ended or Archived). */
export function useSessionMemory(sessionId: string, enabled = true) {
  return useQuery({
    queryKey: workMemoryKeys.session(sessionId),
    queryFn: ({ signal }) =>
      api.get(`/api/v1/work-sessions/${encodeURIComponent(sessionId)}/memory`, {
        schema: SessionMemorySummary,
        signal,
      }),
    enabled,
    retry: noRetryOn4xx,
  });
}

/**
 * The owner asks for a summary (`POST …/memory/propose`, 202): the job writes it, and its own "writing" state arrives
 * by frame once it claims the session. The strip shows Writing from the 202 on, so a second click never sends a second
 * request; the frames (or a reload) bring the server's state.
 */
export function useProposeSessionMemory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (sessionId: string) =>
      api.post(`/api/v1/work-sessions/${encodeURIComponent(sessionId)}/memory/propose`, { body: {} }),
    onSuccess: (_data, sessionId) => {
      qc.setQueryData<SessionMemorySummary>(workMemoryKeys.session(sessionId), (prev) =>
        prev ? { ...prev, status: "writing" } : prev,
      );
    },
    onError: (_err, sessionId) => {
      // `nothing_new` / `session_unmapped` / `session_not_finished`: the server's state changed under the strip.
      void qc.invalidateQueries({ queryKey: workMemoryKeys.session(sessionId) });
    },
  });
}

/** The caller's automatic-proposals preference (off until they turn it on, D-07). */
export function useMemoryPreferences(enabled = true) {
  return useQuery({
    queryKey: workMemoryKeys.preferences,
    queryFn: ({ signal }) => api.get("/api/v1/me/preferences", { schema: MemoryPreferences, signal }),
    enabled,
    retry: noRetryOn4xx,
  });
}

export function useSetMemoryPreferences() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (autoProposeSessionSummaries: boolean) =>
      api.put("/api/v1/me/preferences", {
        body: { autoProposeSessionSummaries },
        schema: MemoryPreferences,
      }),
    onSuccess: (prefs) => qc.setQueryData(workMemoryKeys.preferences, prefs),
  });
}

/** `work_session_memory.updated {workSessionId}` (the viewer's own `user:` stream): refetch that session's state. */
export function applyWorkSessionMemoryUpdated(qc: QueryClient, data: unknown): boolean {
  const parsed = WorkSessionMemoryUpdatedEvent.safeParse(data);
  if (!parsed.success) return false;
  void qc.invalidateQueries({ queryKey: workMemoryKeys.session(parsed.data.workSessionId), exact: true });
  return true;
}

/**
 * `approval_request.updated {id}` (same stream): a decision on the proposal a strip shows (Pending → Applied or
 * Denied). Only the strips whose `proposalId` is that request refetch.
 */
export function applyApprovalUpdatedToMemory(qc: QueryClient, data: unknown): boolean {
  const parsed = ApprovalRequestUpdatedEvent.safeParse(data);
  if (!parsed.success) return false;
  let hit = false;
  for (const [key, value] of qc.getQueriesData<SessionMemorySummary>({ queryKey: workMemoryKeys.sessions })) {
    if (!value || value.proposalId !== parsed.data.id) continue;
    hit = true;
    void qc.invalidateQueries({ queryKey: key, exact: true });
  }
  return hit;
}

/**
 * One frame of the viewer's own `user:` stream. The memory frame is ephemeral (`eph`, published after commit, ids
 * only); approval updates are durable (`ev`). Both kinds are read; anything else is ignored.
 */
export function applyWorkMemoryFrame(qc: QueryClient, frame: TopicFrame): boolean {
  if (frame.op !== "ev" && frame.op !== "eph") return false;
  if (frame.type === EventTypes.workSessionMemoryUpdated)
    return applyWorkSessionMemoryUpdated(qc, frame.data);
  if (frame.type === EventTypes.approvalRequestUpdated) return applyApprovalUpdatedToMemory(qc, frame.data);
  return false;
}

/** Follows the viewer's own `user:` stream while a strip is shown (D-11); never `ws:` or `org:`. */
export function useWorkMemoryLiveUpdates(enabled: boolean) {
  const qc = useQueryClient();
  const me = useMe({ enabled: false });
  const userId = me.data?.user.id ?? null;
  useTopic(enabled && userId ? topic("user", userId) : null, (frame) => {
    applyWorkMemoryFrame(qc, frame);
  });
}
