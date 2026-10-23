"use client";

import {
  AudiencePeople,
  AudiencePreview,
  type SessionAudienceInput,
  UpdateWorkSessionVisibilityResult,
  WorkProjectDetail,
  WorkSessionVisibilityView,
} from "@ocw/contracts";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";
import { api } from "./api";

/**
 * Who can see a Work Zone session (Phase 07.9, UI-SPEC Surface 1): the panel's data and its one write. Everything
 * here is the API's answer; the browser never filters people, counts viewers or decides who may change it.
 */

export const visKeys = {
  view: (sessionId: string) => ["wz", "visibility", sessionId] as const,
  people: (sessionId: string, q: string) => ["wz", "visibility", sessionId, "people", q] as const,
  audiencePeople: (projectId: string, q: string) => ["wz", "audience", projectId, "people", q] as const,
  preview: (projectId: string, key: string) => ["wz", "audience", projectId, "preview", key] as const,
  projectTeams: (unitId: string) => ["wz", "audience", "teams", unitId] as const,
};

/**
 * `GET /work-sessions/:id/visibility`, loaded when the panel opens. The cached answer shows at once and is checked
 * again in the background (stale-while-revalidate); the chip never waits for it (its label comes from the session).
 */
export function useSessionVisibility(sessionId: string, opts: { enabled?: boolean } = {}) {
  return useQuery({
    enabled: opts.enabled ?? true,
    queryKey: visKeys.view(sessionId),
    queryFn: ({ signal }) =>
      api.get(`/api/v1/work-sessions/${sessionId}/visibility`, { schema: WorkSessionVisibilityView, signal }),
    staleTime: 0,
    retry: 1,
  });
}

/**
 * `PUT /work-sessions/:id/visibility`, serialized: one request at a time, and while one runs only the latest choice
 * waits (a choice made in between is dropped, so the last state wins). `update` resolves with the API's answer, or
 * null when a newer choice replaced it before it was sent; it rejects on a refusal. The view cache takes the answer.
 */
export function useUpdateSessionVisibility(sessionId: string) {
  const qc = useQueryClient();
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const latest = useRef(0);
  const [pending, setPending] = useState(0);

  const update = useCallback(
    (input: SessionAudienceInput): Promise<UpdateWorkSessionVisibilityResult | null> => {
      const ticket = ++latest.current;
      setPending((n) => n + 1);
      const run = chain.current
        .catch(() => undefined)
        .then(async () => {
          if (ticket !== latest.current) return null;
          const result = await api.put(`/api/v1/work-sessions/${sessionId}/visibility`, {
            body: input,
            schema: UpdateWorkSessionVisibilityResult,
          });
          qc.setQueryData(visKeys.view(sessionId), result.visibility);
          return result;
        })
        .finally(() => setPending((n) => n - 1));
      chain.current = run;
      return run;
    },
    [qc, sessionId],
  );

  return { update, pending: pending > 0 };
}

/** People an editor may add to an existing session (`GET /work-sessions/:id/visibility/people?q=`, project access). */
export function useVisibilityPeople(sessionId: string, q: string, enabled: boolean) {
  const needle = q.trim();
  return useQuery({
    enabled,
    queryKey: visKeys.people(sessionId, needle),
    queryFn: ({ signal }) =>
      api.get(
        `/api/v1/work-sessions/${sessionId}/visibility/people${needle ? `?q=${encodeURIComponent(needle)}` : ""}`,
        { schema: AudiencePeople, signal },
      ),
    placeholderData: keepPreviousData,
    staleTime: 15_000,
  });
}

/** People who may see a session not started yet on repository `projectId` (draft mode, the new-session dialog). */
export function useAudiencePeople(projectId: string, q: string, enabled: boolean) {
  const needle = q.trim();
  return useQuery({
    enabled,
    queryKey: visKeys.audiencePeople(projectId, needle),
    queryFn: ({ signal }) =>
      api.get(
        `/api/v1/projects/${projectId}/audience/people${needle ? `?q=${encodeURIComponent(needle)}` : ""}`,
        { schema: AudiencePeople, signal },
      ),
    placeholderData: keepPreviousData,
    staleTime: 15_000,
  });
}

/** The query string of a draft audience for the preview (`kind`, comma lists of ids). */
export function previewQuery(input: SessionAudienceInput): string {
  const p = new URLSearchParams({ kind: input.kind });
  if (input.kind === "teams") p.set("teamIds", input.teamIds.join(","));
  if (input.kind === "people") p.set("userIds", input.userIds.join(","));
  return p.toString();
}

/** Who a draft audience would show the new session to (`GET /projects/:projectId/audience/preview`). */
export function useAudiencePreview(projectId: string, input: SessionAudienceInput) {
  const qs = previewQuery(input);
  return useQuery({
    queryKey: visKeys.preview(projectId, qs),
    queryFn: ({ signal }) =>
      api.get(`/api/v1/projects/${projectId}/audience/preview?${qs}`, { schema: AudiencePreview, signal }),
    placeholderData: keepPreviousData,
    staleTime: 15_000,
    retry: false,
  });
}

/** A team project's assigned teams for the draft Team picker (`GET /work-projects/:unitId`, project access). */
export function useProjectTeams(unitId: string | null) {
  return useQuery({
    enabled: unitId !== null,
    queryKey: visKeys.projectTeams(unitId ?? ""),
    queryFn: ({ signal }) =>
      api.get(`/api/v1/work-projects/${unitId}`, { schema: WorkProjectDetail, signal }),
    select: (d) => d.teams,
    staleTime: 30_000,
  });
}
