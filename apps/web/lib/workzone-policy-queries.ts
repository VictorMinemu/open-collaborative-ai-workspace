"use client";

import { type UpdateWorkZonePolicyRequest, WorkZonePolicyView } from "@ocw/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, isApiError } from "./api";

/**
 * The organization Work Zone policy (03.2-04 routes, `GET/PUT /api/v1/work-zone-policy`). The web only edits
 * what the API stores and enforces; every check (modes, models, effort, fast mode, Full access) is server-side.
 */
export const workZonePolicyKeys = { policy: ["wz", "policy"] as const };

function noRetryOn4xx(failureCount: number, err: unknown): boolean {
  if (isApiError(err) && err.status >= 400 && err.status < 500) return false;
  return failureCount < 1;
}

export function useWorkZonePolicy(enabled: boolean) {
  return useQuery({
    enabled,
    queryKey: workZonePolicyKeys.policy,
    queryFn: ({ signal }) => api.get("/api/v1/work-zone-policy", { schema: WorkZonePolicyView, signal }),
    retry: noRetryOn4xx,
  });
}

export function useUpdateWorkZonePolicy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateWorkZonePolicyRequest) =>
      api.put("/api/v1/work-zone-policy", { body, schema: WorkZonePolicyView }),
    onSuccess: (policy) => {
      qc.setQueryData(workZonePolicyKeys.policy, policy);
      // Every session's controls are re-decided by the API against the new policy.
      void qc.invalidateQueries({ queryKey: ["wz", "controls"] });
    },
  });
}
