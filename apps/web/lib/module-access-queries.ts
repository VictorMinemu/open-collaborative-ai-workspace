"use client";

import { EventTypes, ModuleAccessView, type SetModuleAccessRequest, topic } from "@ocw/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, isApiError } from "./api";
import { useMe } from "./queries";
import { useTopic } from "./realtime";

/**
 * Module access (07.3-04, ADR-0024, ACCESS-02): the Modules panel's view of one scope (`null` = the organization) and
 * its toggles. The API decides everything (who may change what, inherited states, `canEdit`); the PUT answers with the
 * fresh view of the same scope. Live: a rule, unit or member change anywhere in the organization refetches every scope.
 */
export const moduleAccessKeys = {
  all: ["module-access"] as const,
  scope: (unitId: string | null) => ["module-access", unitId ?? "org"] as const,
};

function noRetryOn4xx(failureCount: number, err: unknown): boolean {
  if (isApiError(err) && err.status >= 400 && err.status < 500) return false;
  return failureCount < 1;
}

function useModuleAccessLive(): void {
  const qc = useQueryClient();
  const me = useMe({ enabled: false });
  const orgId = me.data?.organization.id ?? null;
  useTopic(orgId ? topic("org", orgId) : null, (frame) => {
    if (frame.op !== "ev") return;
    if (
      frame.type === EventTypes.permissionRulesUpdated ||
      frame.type === EventTypes.unitsUpdated ||
      frame.type === EventTypes.memberUpdated
    ) {
      void qc.invalidateQueries({ queryKey: moduleAccessKeys.all });
    }
  });
}

export function useModuleAccess(scopeUnitId: string | null) {
  useModuleAccessLive();
  return useQuery({
    queryKey: moduleAccessKeys.scope(scopeUnitId),
    queryFn: ({ signal }) =>
      api.get(`/api/v1/module-access${scopeUnitId ? `?unitId=${encodeURIComponent(scopeUnitId)}` : ""}`, {
        schema: ModuleAccessView,
        signal,
      }),
    retry: noRetryOn4xx,
  });
}

export function useSetModuleAccess(scopeUnitId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Omit<SetModuleAccessRequest, "scopeUnitId">) =>
      api.put("/api/v1/module-access", { body: { ...body, scopeUnitId }, schema: ModuleAccessView }),
    onSuccess: (view) => {
      qc.setQueryData(moduleAccessKeys.scope(scopeUnitId), view);
      // Other scopes (ancestors' overrides, descendants' inherited states) follow; the live event does it too.
      void qc.invalidateQueries({
        queryKey: moduleAccessKeys.all,
        predicate: (q) => q.queryKey[1] !== (scopeUnitId ?? "org"),
      });
    },
  });
}
