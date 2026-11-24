"use client";

import { AccountPoolPreview, AccountPoolView, type AddClaudeTokenRequest, PoolAccount } from "@ocw/contracts";
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, isApiError } from "./api";

/**
 * The subscription account pool (Phase 07.18). Members read only the preview: what a new Work Zone session on a device
 * would run on (the pool and its strategy, the device's own login, or nothing ready), with no label, id or token
 * (D-11, PD-19). Settings › Account pool (admins, `provider.manage`) reads the whole view and writes through the
 * admin routes; the API decides every write and never returns a token.
 */
export const poolKeys = {
  all: ["account-pool"] as const,
  view: ["account-pool", "view"] as const,
  preview: (deviceId: string) => ["account-pool", "preview", deviceId] as const,
};

function noRetryOn4xx(failureCount: number, err: unknown): boolean {
  if (isApiError(err) && err.status >= 400 && err.status < 500) return false;
  return failureCount < 1;
}

/** `GET /account-pool/preview?deviceId=` for the chosen device; disabled without one. */
export function useAccountPoolPreview(deviceId: string | null) {
  return useQuery({
    enabled: !!deviceId,
    queryKey: poolKeys.preview(deviceId ?? ""),
    queryFn: ({ signal }) =>
      api.get(`/api/v1/account-pool/preview?deviceId=${encodeURIComponent(deviceId ?? "")}`, {
        schema: AccountPoolPreview,
        signal,
      }),
    staleTime: 15_000,
    // A 404 (a device the caller may no longer use) or an older API without the route: no line, the start decides.
    retry: false,
  });
}

// ---- admins: Settings › Account pool (D-10, PD-19) ----

/** `GET /account-pool`: both providers' policy and accounts. */
export function useAccountPool(enabled: boolean) {
  return useQuery({
    enabled,
    queryKey: poolKeys.view,
    queryFn: ({ signal }) => api.get("/api/v1/account-pool", { schema: AccountPoolView, signal }),
    retry: noRetryOn4xx,
  });
}

/** Every pool change re-reads the view and the members' previews (which account a new session would use). */
function refreshPool(qc: QueryClient) {
  return qc.invalidateQueries({ queryKey: poolKeys.all });
}

/** `POST /account-pool/claude/accounts`: the token goes once, in the body, and is never returned (PD-22). */
export function addClaudeAccountMutation(qc: QueryClient) {
  return {
    mutationFn: (body: AddClaudeTokenRequest) =>
      api.post("/api/v1/account-pool/claude/accounts", { body, schema: PoolAccount }),
    onSuccess: () => refreshPool(qc),
  };
}

export function useAddClaudeAccount() {
  const qc = useQueryClient();
  return useMutation(addClaudeAccountMutation(qc));
}
