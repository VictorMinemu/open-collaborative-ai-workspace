"use client";

import {
  AccountPoolPreview,
  AccountPoolView,
  type AddClaudeTokenRequest,
  DeviceSignIn,
  type DeviceSignInState,
  Ok,
  PoolAccount,
  PoolPolicy,
  type PoolProvider,
  type ProviderAuthState,
  ProviderAuthStatus,
  type UpdatePoolAccountRequest,
  type UpdatePoolPolicyRequest,
} from "@ocw/contracts";
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, isApiError } from "./api";
import { botKeys } from "./bots-queries";

/**
 * The subscription account pool (Phase 07.18). Members read only the preview: what a new Work Zone session on a device
 * would run on (the pool and its strategy, the device's own login, or nothing ready), with no label, id or token
 * (D-11, PD-19). Settings › Account pool (admins, `provider.manage`) reads the whole view and writes through the
 * admin routes; the API decides every write and never returns a token.
 */
export const poolKeys = {
  all: ["account-pool"] as const,
  view: ["account-pool", "view"] as const,
  previews: ["account-pool", "preview"] as const,
  preview: (deviceId: string) => ["account-pool", "preview", deviceId] as const,
  /** The ChatGPT sign-in for bots this admin started (the Models sign-in route with `poolAccount`). */
  botSignIn: ["account-pool", "sign-in", "bots"] as const,
  deviceSignIn: (deviceId: string) => ["account-pool", "sign-in", "device", deviceId] as const,
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

/** Replace one account in the cached view (both providers; ids are unique). */
function patchAccount(
  view: AccountPoolView | undefined,
  id: string,
  change: (a: PoolAccount) => PoolAccount,
): AccountPoolView | undefined {
  if (!view) return view;
  const map = (p: AccountPoolView["claude"]) => ({
    ...p,
    accounts: p.accounts.map((a) => (a.id === id ? change(a) : a)),
  });
  return { claude: map(view.claude), chatgpt: map(view.chatgpt) };
}

/**
 * `PATCH /account-pool/accounts/:id` (label, enabled, weight, a new token). Optimistic only for the on/off switch,
 * rolled back when the API refuses; the answer replaces the row (the API decides its status).
 */
export function updatePoolAccountMutation(qc: QueryClient) {
  return {
    mutationFn: ({ id, body }: { id: string; body: UpdatePoolAccountRequest }) =>
      api.patch(`/api/v1/account-pool/accounts/${id}`, { body, schema: PoolAccount }),
    onMutate: async ({ id, body }: { id: string; body: UpdatePoolAccountRequest }) => {
      if (body.enabled === undefined) return { previous: undefined };
      await qc.cancelQueries({ queryKey: poolKeys.view });
      const previous = qc.getQueryData<AccountPoolView>(poolKeys.view);
      const enabled = body.enabled;
      qc.setQueryData(
        poolKeys.view,
        patchAccount(previous, id, (a) => ({ ...a, enabled })),
      );
      return { previous };
    },
    onError: (
      _err: unknown,
      _vars: { id: string; body: UpdatePoolAccountRequest },
      ctx: { previous: AccountPoolView | undefined } | undefined,
    ) => {
      if (ctx?.previous) qc.setQueryData(poolKeys.view, ctx.previous);
    },
    onSuccess: (account: PoolAccount) => {
      qc.setQueryData(
        poolKeys.view,
        patchAccount(qc.getQueryData<AccountPoolView>(poolKeys.view), account.id, () => account),
      );
      void qc.invalidateQueries({ queryKey: poolKeys.previews });
    },
  };
}

export function useUpdatePoolAccount() {
  const qc = useQueryClient();
  return useMutation(updatePoolAccountMutation(qc));
}

/** `PUT /account-pool/:provider/order`: waits for the server, whose view replaces the cache. */
export function reorderPoolMutation(qc: QueryClient) {
  return {
    mutationFn: ({ provider, accountIds }: { provider: PoolProvider; accountIds: string[] }) =>
      api.put(`/api/v1/account-pool/${provider}/order`, { body: { accountIds }, schema: AccountPoolView }),
    onSuccess: (view: AccountPoolView) => qc.setQueryData(poolKeys.view, view),
  };
}

export function useReorderPool() {
  const qc = useQueryClient();
  return useMutation(reorderPoolMutation(qc));
}

/** `PUT /account-pool/:provider/policy` (strategy, scope, fallback to the device's login). */
export function updatePoolPolicyMutation(qc: QueryClient) {
  return {
    mutationFn: ({ provider, body }: { provider: PoolProvider; body: UpdatePoolPolicyRequest }) =>
      api.put(`/api/v1/account-pool/${provider}/policy`, { body, schema: PoolPolicy }),
    onSuccess: (policy: PoolPolicy) => {
      const view = qc.getQueryData<AccountPoolView>(poolKeys.view);
      if (view)
        qc.setQueryData(poolKeys.view, { ...view, [policy.provider]: { ...view[policy.provider], policy } });
      // The members' previews name the strategy.
      void qc.invalidateQueries({ queryKey: poolKeys.previews });
    },
  };
}

export function useUpdatePoolPolicy() {
  const qc = useQueryClient();
  return useMutation(updatePoolPolicyMutation(qc));
}

/** `DELETE /account-pool/accounts/:id`: sessions on it move to the next account at their next turn (PD-25). */
export function removePoolAccountMutation(qc: QueryClient) {
  return {
    mutationFn: (id: string) => api.del(`/api/v1/account-pool/accounts/${id}`, { schema: Ok }),
    onSuccess: () => refreshPool(qc),
  };
}

export function useRemovePoolAccount() {
  const qc = useQueryClient();
  return useMutation(removePoolAccountMutation(qc));
}

// ---- ChatGPT sign-ins: for bots (in the bots runtime) or on a server device (D-02, D-10) ----

/** Poll every 2 s while a sign-in is starting or waiting for its code to be used; stop otherwise. */
export function signInRefetchInterval(
  state: DeviceSignInState | ProviderAuthState | undefined,
): number | false {
  return state === "starting" || state === "pending" ? 2_000 : false;
}

/** `GET /model-providers/openai-codex/auth` while this dialog's bots sign-in runs. */
export function useBotPoolSignIn(enabled: boolean) {
  return useQuery({
    enabled,
    queryKey: poolKeys.botSignIn,
    queryFn: ({ signal }) =>
      api.get("/api/v1/model-providers/openai-codex/auth", { schema: ProviderAuthStatus, signal }),
    retry: noRetryOn4xx,
    refetchInterval: (q) => signInRefetchInterval(q.state.data?.state),
  });
}

/** Start a sign-in for bots that becomes a pool account once the bots runtime reports it connected (PD-12). */
export function startBotPoolSignInMutation(qc: QueryClient) {
  return {
    mutationFn: ({ label, restart }: { label: string; restart?: boolean }) =>
      api.post("/api/v1/model-providers/openai-codex/auth", {
        body: { poolAccount: { label }, ...(restart ? { restart: true } : {}) },
        schema: ProviderAuthStatus,
      }),
    onSuccess: (status: ProviderAuthStatus) => qc.setQueryData(poolKeys.botSignIn, status),
  };
}

export function useStartBotPoolSignIn() {
  const qc = useQueryClient();
  return useMutation(startBotPoolSignInMutation(qc));
}

export function cancelBotPoolSignInMutation(qc: QueryClient) {
  return {
    mutationFn: () => api.del("/api/v1/model-providers/openai-codex/auth", { schema: ProviderAuthStatus }),
    onSuccess: (status: ProviderAuthStatus) => qc.setQueryData(poolKeys.botSignIn, status),
  };
}

export function useCancelBotPoolSignIn() {
  const qc = useQueryClient();
  return useMutation(cancelBotPoolSignInMutation(qc));
}

const deviceSignInPath = (deviceId: string) =>
  `/api/v1/account-pool/chatgpt/device-sign-ins/current?deviceId=${encodeURIComponent(deviceId)}`;

/** `GET /account-pool/chatgpt/device-sign-ins/current?deviceId=` while a device sign-in runs. */
export function useDeviceSignIn(deviceId: string | null, enabled: boolean) {
  return useQuery({
    enabled: enabled && !!deviceId,
    queryKey: poolKeys.deviceSignIn(deviceId ?? ""),
    queryFn: ({ signal }) =>
      api.get(deviceSignInPath(deviceId ?? ""), { schema: DeviceSignIn.nullable(), signal }),
    retry: noRetryOn4xx,
    refetchInterval: (q) => signInRefetchInterval(q.state.data?.state),
  });
}

/** Sign a ChatGPT account in on a server device: Codex's device code runs there, in a new slot. */
export function startDeviceSignInMutation(qc: QueryClient) {
  return {
    mutationFn: (body: { deviceId: string; label: string }) =>
      api.post("/api/v1/account-pool/chatgpt/device-sign-ins", { body, schema: DeviceSignIn }),
    onSuccess: (signIn: DeviceSignIn) => qc.setQueryData(poolKeys.deviceSignIn(signIn.deviceId), signIn),
  };
}

export function useStartDeviceSignIn() {
  const qc = useQueryClient();
  return useMutation(startDeviceSignInMutation(qc));
}

export function cancelDeviceSignInMutation(qc: QueryClient) {
  return {
    mutationFn: (deviceId: string) =>
      api.del(deviceSignInPath(deviceId), { schema: DeviceSignIn.nullable() }),
    onSuccess: (signIn: DeviceSignIn | null, deviceId: string) =>
      qc.setQueryData(poolKeys.deviceSignIn(deviceId), signIn),
  };
}

export function useCancelDeviceSignIn() {
  const qc = useQueryClient();
  return useMutation(cancelDeviceSignInMutation(qc));
}

/** A sign-in connected: the new account is in the pool (and, for bots, the Models page's provider changed). */
export function onSignInConnected(qc: QueryClient) {
  void refreshPool(qc);
  void qc.invalidateQueries({ queryKey: botKeys.providers });
  void qc.invalidateQueries({ queryKey: botKeys.providerAuth("openai-codex") });
}

/** T-07.18-15-02: the one-time code and its link leave the page's cache when the dialog closes. */
export function forgetSignIn(qc: QueryClient, deviceId: string | null) {
  qc.removeQueries({ queryKey: poolKeys.botSignIn });
  if (deviceId) qc.removeQueries({ queryKey: poolKeys.deviceSignIn(deviceId) });
}
