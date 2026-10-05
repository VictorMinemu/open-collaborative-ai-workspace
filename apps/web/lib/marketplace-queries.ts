"use client";

import {
  type ApprovePluginInstallRequest,
  CellPlugin,
  CellPluginList,
  MarketplacePackageDetail,
  MarketplaceSearchResult,
  type UpdateCellPluginRequest,
} from "@ocw/contracts";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, isApiError } from "./api";
import { capabilityKeys } from "./capability-queries";

/**
 * OpenClaw Marketplace (03.1-11 routes, `plugin.manage`). The API proxies ClawHub, scores every version and
 * re-checks every approval; the web only renders its review and sends the review token back.
 */
export const marketplaceKeys = {
  all: ["marketplace"] as const,
  search: (q: string) => ["marketplace", "search", q] as const,
  detail: (name: string, version: string | null) => ["marketplace", "detail", name, version] as const,
  installed: ["cell-plugins"] as const,
};

const IN_FLIGHT = new Set(["approved", "installing", "uninstalling"]);

function noRetryOn4xx(failureCount: number, err: unknown): boolean {
  if (isApiError(err) && err.status >= 400 && err.status < 500) return false;
  return failureCount < 1;
}

const enc = encodeURIComponent;

/** Search (debounced by the caller); an empty query browses the catalog, most downloaded first. */
export function useMarketplaceSearch(q: string, enabled = true) {
  return useQuery({
    enabled,
    queryKey: marketplaceKeys.search(q),
    queryFn: ({ signal }) =>
      api.get(`/api/v1/marketplace/search?q=${enc(q)}&limit=25`, { schema: MarketplaceSearchResult, signal }),
    placeholderData: keepPreviousData,
    retry: noRetryOn4xx,
    staleTime: 30_000,
  });
}

/** One package with the review of `version` (the latest when null). Always asks the API (live review). */
export function usePluginDetail(name: string | null, version: string | null = null) {
  return useQuery({
    enabled: !!name,
    queryKey: marketplaceKeys.detail(name ?? "", version),
    queryFn: ({ signal }) =>
      api.get(`/api/v1/marketplace/packages/${enc(name ?? "")}${version ? `?version=${enc(version)}` : ""}`, {
        schema: MarketplacePackageDetail,
        signal,
      }),
    placeholderData: keepPreviousData,
    retry: noRetryOn4xx,
    staleTime: 0,
  });
}

/** The organization's plugins; polls while an install, update or uninstall is in flight in the cell. */
export function useCellPlugins(enabled = true) {
  return useQuery({
    enabled,
    queryKey: marketplaceKeys.installed,
    queryFn: ({ signal }) => api.get("/api/v1/cell-plugins", { schema: CellPluginList, signal }),
    retry: noRetryOn4xx,
    refetchInterval: (query) =>
      query.state.data?.plugins.some((p) => IN_FLIGHT.has(p.status)) ? 1500 : false,
  });
}

/** Installed state, search badges and every bot's tool list depend on a plugin change. */
function useInvalidatePlugins() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: marketplaceKeys.installed });
    void qc.invalidateQueries({ queryKey: ["marketplace", "search"] });
    void qc.invalidateQueries({ queryKey: capabilityKeys.all });
  };
}

export function useApprovePluginInstall() {
  const invalidate = useInvalidatePlugins();
  return useMutation({
    mutationFn: (body: ApprovePluginInstallRequest) =>
      api.post("/api/v1/marketplace/installs", { body, schema: CellPlugin }),
    onSettled: invalidate,
  });
}

/** Flags (org / personal / trusted chaining) or an upgrade to another reviewed version. */
export function useUpdateCellPlugin(id: string) {
  const qc = useQueryClient();
  const invalidate = useInvalidatePlugins();
  return useMutation({
    mutationFn: (body: UpdateCellPluginRequest) =>
      api.patch(`/api/v1/cell-plugins/${id}`, { body, schema: CellPlugin }),
    onSuccess: (plugin) => {
      qc.setQueryData<CellPluginList>(marketplaceKeys.installed, (prev) =>
        prev ? { plugins: prev.plugins.map((p) => (p.id === plugin.id ? plugin : p)) } : prev,
      );
    },
    onSettled: invalidate,
  });
}

export function useUninstallPlugin(id: string) {
  const invalidate = useInvalidatePlugins();
  return useMutation({
    mutationFn: () => api.del(`/api/v1/cell-plugins/${id}`, { schema: CellPlugin }),
    onSettled: invalidate,
  });
}
