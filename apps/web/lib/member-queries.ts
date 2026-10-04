"use client";

import {
  MemberDetail,
  MemberDetailList,
  type OrgRole,
  PasswordResetLink,
  type UpdateMemberRoleRequest,
} from "@ocw/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, isApiError } from "./api";
import { permissionKeys } from "./permissions";
import { queryKeys } from "./queries";

/**
 * Member directory (ORG-04, ORG-06) on the 02-07 / 02-09 APIs. Every key starts with ["members"], so one
 * `invalidateQueries({ queryKey: ["members"] })` refreshes the legacy `useMembers` list, the detail list and
 * every open profile. The API re-decides every mutation; the UI only hides what the resolver forbids.
 */
export const memberKeys = {
  all: queryKeys.members,
  details: ["members", "detail"] as const,
  profile: (userId: string) => ["members", "profile", userId] as const,
};

function noRetryOn4xx(failureCount: number, err: unknown): boolean {
  if (isApiError(err) && err.status >= 400 && err.status < 500) return false;
  return failureCount < 1;
}

export function useMemberDetails() {
  return useQuery({
    queryKey: memberKeys.details,
    queryFn: ({ signal }) => api.get("/api/v1/members", { schema: MemberDetailList, signal }),
    retry: noRetryOn4xx,
  });
}

export function useMemberProfile(userId: string | null) {
  return useQuery({
    enabled: userId !== null,
    queryKey: memberKeys.profile(userId ?? ""),
    queryFn: ({ signal }) => api.get(`/api/v1/members/${userId}`, { schema: MemberDetail, signal }),
    retry: noRetryOn4xx,
  });
}

function useInvalidateMembers() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: memberKeys.all });
}

interface RoleChange extends UpdateMemberRoleRequest {
  userId: string;
}

/** Optimistic: the row shows the new role at once and rolls back if the API refuses (e.g. 409 last_admin). */
export function useChangeRole() {
  const qc = useQueryClient();
  const invalidate = useInvalidateMembers();
  return useMutation({
    mutationFn: ({ userId, role }: RoleChange) =>
      api.patch(`/api/v1/members/${userId}/role`, { body: { role }, schema: MemberDetail }),
    onMutate: async ({ userId, role }) => {
      await qc.cancelQueries({ queryKey: memberKeys.details });
      const previous = qc.getQueryData<MemberDetailList>(memberKeys.details);
      if (previous) {
        qc.setQueryData<MemberDetailList>(memberKeys.details, {
          members: previous.members.map((m) => (m.userId === userId ? { ...m, role } : m)),
        });
      }
      return { previous };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) qc.setQueryData(memberKeys.details, context.previous);
    },
    onSettled: () => {
      void invalidate();
      // The caller's own role may have changed (or another admin's, which changes nothing for us: cheap).
      void qc.invalidateQueries({ queryKey: permissionKeys.mine });
      void qc.invalidateQueries({ queryKey: queryKeys.me });
    },
  });
}

export function useDeactivateMember() {
  const invalidate = useInvalidateMembers();
  return useMutation({
    mutationFn: (userId: string) =>
      api.post(`/api/v1/members/${userId}/deactivate`, { body: {}, schema: MemberDetail }),
    onSettled: () => invalidate(),
  });
}

export function useReactivateMember() {
  const invalidate = useInvalidateMembers();
  return useMutation({
    mutationFn: (userId: string) =>
      api.post(`/api/v1/members/${userId}/reactivate`, { body: {}, schema: MemberDetail }),
    onSettled: () => invalidate(),
  });
}

/**
 * One-time password reset link (02-09). The result is a credential: it is returned to the caller only and
 * never written to the query cache, the URL or any log (T-02-12-02).
 */
export function useCreateResetLink() {
  return useMutation({
    mutationFn: (userId: string) =>
      api.post(`/api/v1/members/${userId}/password-reset-link`, { body: {}, schema: PasswordResetLink }),
    gcTime: 0,
  });
}

export const ROLE_OPTIONS: readonly OrgRole[] = ["standard", "developer", "lead", "admin"];
