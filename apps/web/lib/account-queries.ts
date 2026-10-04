"use client";

import {
  AuthCapabilities,
  type ChangePasswordRequest,
  Ok,
  Profile,
  type RequestPasswordResetRequest,
  type ResetPasswordRequest,
  SessionList,
  type UpdateProfileRequest,
} from "@ocw/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, isApiError } from "./api";
import { queryKeys } from "./queries";

/** The signed-in user's own account: profile, sessions, password (02-09 APIs). */
export const accountKeys = {
  profile: ["profile"] as const,
  sessions: ["sessions"] as const,
  capabilities: ["auth-capabilities"] as const,
};

function retryUnlessClientError(failureCount: number, err: unknown): boolean {
  if (isApiError(err) && err.status >= 400 && err.status < 500) return false;
  return failureCount < 1;
}

// ---- profile (ORG-06) ----

export function useProfile() {
  return useQuery({
    queryKey: accountKeys.profile,
    queryFn: ({ signal }) => api.get("/api/v1/me/profile", { schema: Profile, signal }),
    retry: retryUnlessClientError,
  });
}

export function useUpdateProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateProfileRequest) => api.patch("/api/v1/me/profile", { body, schema: Profile }),
    onSuccess: (profile) => {
      qc.setQueryData(accountKeys.profile, profile);
      // The shell (user menu), the member directory and chat avatars read these.
      void qc.invalidateQueries({ queryKey: queryKeys.me });
      void qc.invalidateQueries({ queryKey: queryKeys.members });
    },
  });
}

// ---- sessions (AUTH-05) ----

export function useSessions() {
  return useQuery({
    queryKey: accountKeys.sessions,
    queryFn: ({ signal }) => api.get("/api/v1/me/sessions", { schema: SessionList, signal }),
    retry: retryUnlessClientError,
    select: (d) => d.sessions,
  });
}

export function useRevokeSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del(`/api/v1/me/sessions/${encodeURIComponent(id)}`, { schema: Ok }),
    onSettled: () => qc.invalidateQueries({ queryKey: accountKeys.sessions }),
  });
}

export function useRevokeOtherSessions() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post("/api/v1/me/sessions/revoke-others", { body: {}, schema: Ok }),
    onSettled: () => qc.invalidateQueries({ queryKey: accountKeys.sessions }),
  });
}

// ---- passwords (AUTH-04) ----

export function useChangePassword() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ChangePasswordRequest) => api.post("/api/v1/me/password", { body, schema: Ok }),
    onSuccess: () => qc.invalidateQueries({ queryKey: accountKeys.sessions }),
  });
}

/** Public: whether the server can e-mail reset links (SMTP configured). */
export function useAuthCapabilities() {
  return useQuery({
    queryKey: accountKeys.capabilities,
    queryFn: ({ signal }) => api.get("/api/v1/auth/capabilities", { schema: AuthCapabilities, signal }),
    retry: retryUnlessClientError,
    staleTime: 5 * 60_000,
  });
}

/** Always resolves the same way for any address (the API answers { ok } to avoid account enumeration). */
export function useRequestPasswordReset() {
  return useMutation({
    mutationFn: (body: RequestPasswordResetRequest) =>
      api.post("/api/v1/password-reset/request", { body, schema: Ok }),
  });
}

export function useResetPassword() {
  return useMutation({
    mutationFn: (body: ResetPasswordRequest) => api.post("/api/v1/password-reset", { body, schema: Ok }),
  });
}
