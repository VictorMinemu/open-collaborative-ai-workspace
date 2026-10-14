"use client";

import {
  type CreateVaultItemRequest,
  Ok,
  PrivateHostsSettings,
  type UpdateVaultItemRequest,
  VaultItem,
  VaultItemList,
} from "@ocw/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, isApiError } from "./api";

/**
 * Settings › Keychain (07.4-13; D-04, CONN-05; UI-SPEC § 3) and the organization's private network hosts (R5). A key's
 * value is WRITE-ONLY: create and update requests carry it, every response says only `hasValue` and `valueUpdatedAt`.
 */
export const keychainKeys = {
  list: ["keychain"] as const,
  item: (id: string) => ["keychain", "item", id] as const,
  privateHosts: ["keychain", "private-hosts"] as const,
};

function noRetryOn4xx(failureCount: number, err: unknown): boolean {
  if (isApiError(err) && err.status >= 400 && err.status < 500) return false;
  return failureCount < 1;
}

export function useKeychain(enabled = true) {
  return useQuery({
    enabled,
    queryKey: keychainKeys.list,
    queryFn: ({ signal }) => api.get("/api/v1/keychain", { schema: VaultItemList, signal }),
    retry: noRetryOn4xx,
  });
}

/** One of the caller's keys (404 for anyone else's): the `?share=…&key=<id>` link names it. */
export function useVaultItem(id: string | null) {
  return useQuery({
    enabled: id !== null,
    queryKey: keychainKeys.item(id ?? ""),
    queryFn: ({ signal }) => api.get(`/api/v1/keychain/${id}`, { schema: VaultItem, signal }),
    retry: false,
  });
}

function usePatchList() {
  const qc = useQueryClient();
  return (item: VaultItem) =>
    qc.setQueryData<VaultItemList>(keychainKeys.list, (prev) => {
      if (!prev) return prev;
      const bucket = item.scope === "personal" ? "personal" : "unit";
      const list = prev[bucket];
      const next = list.some((x) => x.id === item.id)
        ? list.map((x) => (x.id === item.id ? item : x))
        : [...list, item];
      return { ...prev, [bucket]: next };
    });
}

function useInvalidate() {
  const qc = useQueryClient();
  return () => void qc.invalidateQueries({ queryKey: ["keychain"] });
}

export function useCreateVaultItem() {
  const patch = usePatchList();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (body: CreateVaultItemRequest) => api.post("/api/v1/keychain", { body, schema: VaultItem }),
    onSuccess: patch,
    onSettled: invalidate,
  });
}

export function useUpdateVaultItem() {
  const patch = usePatchList();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdateVaultItemRequest }) =>
      api.patch(`/api/v1/keychain/${id}`, { body, schema: VaultItem }),
    onSuccess: patch,
    onSettled: invalidate,
  });
}

export function useSetVaultItemAgents() {
  const patch = usePatchList();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, agentIds }: { id: string; agentIds: string[] }) =>
      api.put(`/api/v1/keychain/${id}/agents`, { body: { agentIds }, schema: VaultItem }),
    onSuccess: patch,
    onSettled: invalidate,
  });
}

export function useDeleteVaultItem() {
  const qc = useQueryClient();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: string) => api.del(`/api/v1/keychain/${id}`, { schema: Ok }),
    onSuccess: (_ok, id) =>
      qc.setQueryData<VaultItemList>(keychainKeys.list, (prev) =>
        prev
          ? {
              ...prev,
              personal: prev.personal.filter((x) => x.id !== id),
              unit: prev.unit.filter((x) => x.id !== id),
            }
          : prev,
      ),
    onSettled: invalidate,
  });
}

/** The organization's private network hosts (`bot.manage`; the API's own gate is authoritative, T-07.4-13-06). */
export function usePrivateHosts(enabled = true) {
  return useQuery({
    enabled,
    queryKey: keychainKeys.privateHosts,
    queryFn: ({ signal }) =>
      api.get("/api/v1/keychain/private-hosts", { schema: PrivateHostsSettings, signal }),
    retry: noRetryOn4xx,
  });
}

export function useSavePrivateHosts() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (hosts: string[]) =>
      api.put("/api/v1/keychain/private-hosts", { body: { hosts }, schema: PrivateHostsSettings }),
    onSuccess: (data) => qc.setQueryData(keychainKeys.privateHosts, data),
  });
}
