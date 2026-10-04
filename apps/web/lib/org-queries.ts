"use client";

import {
  type AddUnitMemberRequest,
  type CreateUnitRequest,
  EventTypes,
  Ok,
  OrgUnit,
  OrgUnitList,
  PermissionRuleList,
  topic,
  UnitMember,
  UnitMemberList,
  type UnitRole,
} from "@ocw/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, isApiError } from "./api";
import { useMe } from "./queries";
import { useTopic } from "./realtime";

/**
 * Departments, teams and projects (hierarchy units, not Work Zone repositories) and their memberships.
 * Every control the UI shows comes from `OrgUnit.viewerCan` / `useCan`; the API decides every change.
 */
export const orgKeys = {
  /** Prefix of every unit query: invalidating it refreshes the tree and every member list. */
  units: ["units"] as const,
  unitMembers: (id: string) => ["units", id, "members"] as const,
  rules: ["permission-rules"] as const,
};

function noRetryOn4xx(failureCount: number, err: unknown): boolean {
  if (isApiError(err) && err.status >= 400 && err.status < 500) return false;
  return failureCount < 1;
}

export function useUnits() {
  return useQuery({
    queryKey: orgKeys.units,
    queryFn: ({ signal }) => api.get("/api/v1/units", { schema: OrgUnitList, signal }),
    retry: noRetryOn4xx,
  });
}

export function useUnitMembers(id: string | null) {
  return useQuery({
    enabled: id !== null,
    queryKey: orgKeys.unitMembers(id ?? "none"),
    queryFn: ({ signal }) => api.get(`/api/v1/units/${id}/members`, { schema: UnitMemberList, signal }),
    retry: noRetryOn4xx,
  });
}

/** Explicit allow/deny rules (rule.read: admins). Read-only in this release (D-02). */
export function usePermissionRules(enabled: boolean) {
  return useQuery({
    enabled,
    queryKey: orgKeys.rules,
    queryFn: ({ signal }) => api.get("/api/v1/permission-rules", { schema: PermissionRuleList, signal }),
    retry: noRetryOn4xx,
  });
}

function useInvalidateUnits() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: orgKeys.units });
}

export function useCreateUnit() {
  const invalidate = useInvalidateUnits();
  return useMutation({
    mutationFn: (body: CreateUnitRequest) => api.post("/api/v1/units", { body, schema: OrgUnit }),
    onSuccess: invalidate,
  });
}

export function useRenameUnit() {
  const invalidate = useInvalidateUnits();
  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      api.patch(`/api/v1/units/${id}`, { body: { name }, schema: OrgUnit }),
    onSuccess: invalidate,
  });
}

export function useMoveUnit() {
  const invalidate = useInvalidateUnits();
  return useMutation({
    mutationFn: ({ id, parentId }: { id: string; parentId: string | null }) =>
      api.post(`/api/v1/units/${id}/move`, { body: { parentId }, schema: OrgUnit }),
    onSuccess: invalidate,
  });
}

export function useDeleteUnit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del(`/api/v1/units/${id}`, { schema: Ok }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: orgKeys.units });
      // Rules scoped to the unit cascade with it.
      void qc.invalidateQueries({ queryKey: orgKeys.rules });
    },
  });
}

export function useAddUnitMember(unitId: string) {
  const invalidate = useInvalidateUnits();
  return useMutation({
    mutationFn: (body: AddUnitMemberRequest) =>
      api.post(`/api/v1/units/${unitId}/members`, { body, schema: UnitMember }),
    onSuccess: invalidate,
  });
}

export function useUpdateUnitMember(unitId: string) {
  const invalidate = useInvalidateUnits();
  return useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: UnitRole }) =>
      api.patch(`/api/v1/units/${unitId}/members/${userId}`, { body: { role }, schema: UnitMember }),
    onSuccess: invalidate,
  });
}

export function useRemoveUnitMember(unitId: string) {
  const invalidate = useInvalidateUnits();
  return useMutation({
    mutationFn: (userId: string) => api.del(`/api/v1/units/${unitId}/members/${userId}`, { schema: Ok }),
    onSuccess: invalidate,
  });
}

/**
 * Keeps the tree, member lists and rules live: `units.updated` and `permission_rules.updated` on `org:<id>`.
 * `/me/permissions` already refetches on both events (lib/permissions.ts), so it is not repeated here.
 */
export function useUnitsLive(): void {
  const qc = useQueryClient();
  const me = useMe({ enabled: false });
  const orgId = me.data?.organization.id ?? null;
  useTopic(orgId ? topic("org", orgId) : null, (frame) => {
    if (frame.op !== "ev") return;
    if (frame.type === EventTypes.unitsUpdated || frame.type === EventTypes.memberUpdated) {
      void qc.invalidateQueries({ queryKey: orgKeys.units });
    }
    if (frame.type === EventTypes.permissionRulesUpdated) {
      void qc.invalidateQueries({ queryKey: orgKeys.rules });
    }
  });
}
