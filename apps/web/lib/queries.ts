"use client";

import {
  type AcceptInvitationRequest,
  type CreateInvitationRequest,
  Invitation,
  InvitationList,
  MemberList,
  MeResponse,
  Ok,
  PublicInvitation,
  type SetupRequest,
  SetupStatusResponse,
  type SignInRequest,
} from "@ocw/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiRequestError, api, isApiError } from "./api";

export const queryKeys = {
  me: ["me"] as const,
  setupStatus: ["setup-status"] as const,
  members: ["members"] as const,
  invitations: ["invitations"] as const,
  publicInvitation: (id: string) => ["public-invitation", id] as const,
};

/** Do not retry auth / validation failures; retry transient errors once, quickly, so "can't reach" shows fast. */
function retryUnlessClientError(failureCount: number, err: unknown): boolean {
  if (isApiError(err) && err.status >= 400 && err.status < 500) return false;
  return failureCount < 1;
}

// ---- identity ----

/**
 * The signed-in member, or null. A `/me` that answered 401 means the session ended (revoked, signed out elsewhere,
 * deactivated) even though the cache still holds the last `/me`: TanStack Query keeps data on error. Every auth
 * guard decides with this one rule, so the app never renders a dead session and the sign-in page never sends it
 * back to the app (that ping-pong mounted the whole shell and its queries every frame, 07.8-29).
 */
export function signedInMe(me: { data?: MeResponse; error: unknown }): MeResponse | null {
  return me.data && !isApiError(me.error, 401) ? me.data : null;
}

/** Pass `enabled: false` to only observe the cached value (never triggers a request). */
export function useMe({ enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({
    enabled,
    queryKey: queryKeys.me,
    queryFn: ({ signal }) => api.get("/api/v1/me", { schema: MeResponse, signal }),
    retry: retryUnlessClientError,
    staleTime: 60_000,
  });
}

export function useSetupStatus(enabled = true) {
  return useQuery({
    enabled,
    queryKey: queryKeys.setupStatus,
    queryFn: ({ signal }) => api.get("/api/v1/setup/status", { schema: SetupStatusResponse, signal }),
    retry: retryUnlessClientError,
    staleTime: 30_000,
  });
}

export function useSetup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: SetupRequest) => api.post("/api/v1/setup", { body, schema: MeResponse }),
    onSuccess: (me) => {
      qc.setQueryData(queryKeys.me, me);
      qc.setQueryData(queryKeys.setupStatus, { setupComplete: true });
    },
  });
}

export function useSignIn() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: SignInRequest) => {
      try {
        await api.post("/api/auth/sign-in/email", { body });
      } catch (err) {
        if (isApiError(err) && (err.status === 401 || err.status === 400)) {
          throw new ApiRequestError(err.status, err.code, "Incorrect email or password");
        }
        throw err;
      }
      return api.get("/api/v1/me", { schema: MeResponse });
    },
    onSuccess: (me) => qc.setQueryData(queryKeys.me, me),
  });
}

export function useSignOut() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post("/api/auth/sign-out", { body: {} }),
    onSettled: () => {
      qc.clear();
    },
  });
}

// ---- invitations ----

export function usePublicInvitation(id: string) {
  return useQuery({
    queryKey: queryKeys.publicInvitation(id),
    queryFn: ({ signal }) => api.get(`/api/v1/invitations/${id}`, { schema: PublicInvitation, signal }),
    retry: retryUnlessClientError,
  });
}

export function useAcceptInvitation(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: AcceptInvitationRequest) =>
      api.post(`/api/v1/invitations/${id}/accept`, { body, schema: MeResponse }),
    onSuccess: (me) => qc.setQueryData(queryKeys.me, me),
  });
}

export function useInvitations(enabled = true) {
  return useQuery({
    queryKey: queryKeys.invitations,
    queryFn: ({ signal }) => api.get("/api/v1/invitations", { schema: InvitationList, signal }),
    retry: retryUnlessClientError,
    enabled,
  });
}

export function useCreateInvitation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateInvitationRequest) =>
      api.post("/api/v1/invitations", { body, schema: Invitation }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.invitations }),
  });
}

export function useRevokeInvitation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del(`/api/v1/invitations/${id}`, { schema: Ok }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.invitations }),
  });
}

// ---- organization ----

export function useMembers() {
  return useQuery({
    queryKey: queryKeys.members,
    queryFn: ({ signal }) => api.get("/api/v1/members", { schema: MemberList, signal }),
    retry: retryUnlessClientError,
  });
}
