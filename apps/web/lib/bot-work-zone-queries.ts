"use client";

import { type BotWorkZoneProfileInput, BotWorkZoneProfileView } from "@ocw/contracts";
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, isApiError } from "./api";

/**
 * A bot's Work Zone profile (07.16-12, D-01, PD-04, PD-20) on 07.16-07's routes. The API decides everything: who may
 * save, what the profile may hold (the saver's own live controls) and whether the bot may act now (`status`). The web
 * renders the view it answers and never computes what the bot may do.
 */
export const botWorkZoneKeys = {
  profile: (agentId: string) => ["bot-work-zone", agentId] as const,
};

const path = (agentId: string) => `/api/v1/agents/${agentId}/work-zone-profile`;

function noRetryOn4xx(failureCount: number, err: unknown): boolean {
  if (isApiError(err) && err.status >= 400 && err.status < 500) return false;
  return failureCount < 1;
}

/** `GET /agents/:id/work-zone-profile`: the profile (null when none), its live status and the viewer's rights. */
export function useBotWorkZoneProfile(agentId: string | null, enabled = true) {
  return useQuery({
    enabled: !!agentId && enabled,
    queryKey: botWorkZoneKeys.profile(agentId ?? ""),
    queryFn: ({ signal }) => api.get(path(agentId ?? ""), { schema: BotWorkZoneProfileView, signal }),
    retry: noRetryOn4xx,
  });
}

/** The save mutation's options (the hook's, and the tests'): one PUT with the full desired state; the answer is cached. */
export function saveProfileMutation(qc: QueryClient, agentId: string) {
  return {
    mutationFn: (body: BotWorkZoneProfileInput) =>
      api.put(path(agentId), { body, schema: BotWorkZoneProfileView }),
    onSuccess: (view: BotWorkZoneProfileView) => {
      qc.setQueryData(botWorkZoneKeys.profile(agentId), view);
    },
  };
}

/** The remove mutation's options: DELETE answers the empty view; it is cached, then refetched. */
export function removeProfileMutation(qc: QueryClient, agentId: string) {
  return {
    mutationFn: () => api.del(path(agentId), { schema: BotWorkZoneProfileView }),
    onSuccess: (view: BotWorkZoneProfileView) => {
      qc.setQueryData(botWorkZoneKeys.profile(agentId), view);
      void qc.invalidateQueries({ queryKey: botWorkZoneKeys.profile(agentId) });
    },
  };
}

/** `PUT /agents/:id/work-zone-profile`. A refusal leaves the cache alone: the form keeps what the person typed. */
export function useSaveBotWorkZoneProfile(agentId: string) {
  const qc = useQueryClient();
  return useMutation(saveProfileMutation(qc, agentId));
}

/** `DELETE /agents/:id/work-zone-profile`. */
export function useRemoveBotWorkZoneProfile(agentId: string) {
  const qc = useQueryClient();
  return useMutation(removeProfileMutation(qc, agentId));
}
