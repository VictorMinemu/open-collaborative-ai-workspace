"use client";

import {
  DigestPreview,
  type DigestSettings,
  DigestTestResponse,
  DigestView,
  EventTypes,
  topic,
} from "@ocw/contracts";
import type { TopicFrame } from "@ocw/realtime-client";
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, isApiError } from "./api";
import { useMe } from "./queries";
import { useTopic } from "./realtime";

/**
 * Settings › Digest (07.6-16, AUTO-05; R6) over the digest API of 07.6-13: `GET|PUT /digest` (the person's one digest
 * and the bots they can DM), the preview (the unsaved form composed now: stores, sends and bills nothing) and the
 * test send (the saved digest sent now: one of its 5 runs a day, it moves "since the last digest"). The
 * view refetches on `automation.updated` / `automation_run.updated` of the person's own `user:` stream (ids only), so
 * the next and last send times follow a pause from the automations list or a run that just went out. Every response
 * is parsed with its contract schema.
 */

export const digestKeys = {
  all: ["digest"] as const,
  view: ["digest", "view"] as const,
};

const retryUnlessClientError = (count: number, err: unknown) =>
  !(isApiError(err) && err.status >= 400 && err.status < 500) && count < 2;

/** One frame of the viewer's `user:` stream: durable (`ev`) and ephemeral (`eph`) frames are both read (07.6-22). */
export function applyDigestFrame(qc: QueryClient, frame: TopicFrame): boolean {
  if (frame.op !== "ev" && frame.op !== "eph") return false;
  if (frame.type !== EventTypes.automationUpdated && frame.type !== EventTypes.automationRunUpdated)
    return false;
  void qc.invalidateQueries({ queryKey: digestKeys.view });
  return true;
}

export function useDigest() {
  const qc = useQueryClient();
  const me = useMe({ enabled: false });
  const userId = me.data?.user.id ?? null;
  useTopic(userId ? topic("user", userId) : null, (frame) => {
    applyDigestFrame(qc, frame);
  });
  return useQuery({
    queryKey: digestKeys.view,
    queryFn: ({ signal }) => api.get("/api/v1/digest", { schema: DigestView, signal }),
    retry: retryUnlessClientError,
    staleTime: 30_000,
  });
}

export function useSaveDigest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: DigestSettings) => api.put("/api/v1/digest", { body, schema: DigestView }),
    onSuccess: (view) => qc.setQueryData(digestKeys.view, view),
  });
}

/** The exact Markdown the bot would send now for the unsaved form. */
export function useDigestPreview() {
  return useMutation({
    mutationFn: (body: DigestSettings) => api.post("/api/v1/digest/preview", { body, schema: DigestPreview }),
  });
}

/** Sends the saved digest now to the person's DM with its bot; answers where it was posted. */
export function useSendDigestTest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post("/api/v1/digest/test", { body: {}, schema: DigestTestResponse }),
    onSettled: () => qc.invalidateQueries({ queryKey: digestKeys.view }),
  });
}
