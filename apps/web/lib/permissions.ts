"use client";

import { EventTypes, MyPermissions, type Permission, topic } from "@ocw/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { api, isApiError } from "./api";
import { useMe } from "./queries";
import { useTopic } from "./realtime";

/**
 * The caller's organization-scope permissions, decided by the API resolver (GET /api/v1/me/permissions).
 * UI gating is cosmetic: the API re-decides every action. The browser never re-implements policy.
 */
export const permissionKeys = { mine: ["permissions"] as const };

function noRetryOn4xx(failureCount: number, err: unknown): boolean {
  if (isApiError(err) && err.status >= 400 && err.status < 500) return false;
  return failureCount < 1;
}

export function usePermissions() {
  const qc = useQueryClient();
  const me = useMe({ enabled: false });
  const orgId = me.data?.organization.id ?? null;
  const userId = me.data?.user.id ?? null;

  // A role, unit or rule change re-decides what this user may do.
  useTopic(orgId ? topic("org", orgId) : null, (frame) => {
    if (frame.op !== "ev") return;
    const data = frame.data as { userId?: string } | null;
    if (
      (frame.type === EventTypes.memberUpdated && data?.userId === userId) ||
      frame.type === EventTypes.unitsUpdated ||
      frame.type === EventTypes.permissionRulesUpdated
    ) {
      void qc.invalidateQueries({ queryKey: permissionKeys.mine });
    }
  });

  return useQuery({
    enabled: me.data !== undefined,
    queryKey: permissionKeys.mine,
    queryFn: ({ signal }) => api.get("/api/v1/me/permissions", { schema: MyPermissions, signal }),
    retry: noRetryOn4xx,
    staleTime: 60_000,
  });
}

/** `(p) => boolean`; false while loading, so a forbidden entry never flashes. */
export function usePermissionCheck(): (permission: Permission) => boolean {
  const { data } = usePermissions();
  return useCallback((permission: Permission) => data?.permissions.includes(permission) ?? false, [data]);
}

export function useCan(permission: Permission): boolean {
  return usePermissionCheck()(permission);
}
