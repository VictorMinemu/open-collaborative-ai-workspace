"use client";

import { AccountPoolPreview } from "@ocw/contracts";
import { useQuery } from "@tanstack/react-query";
import { api } from "./api";

/**
 * The subscription account pool (Phase 07.18). Members read only the preview: what a new Work Zone session on a device
 * would run on (the pool and its strategy, the device's own login, or nothing ready), with no label, id or token
 * (D-11, PD-19). Admin queries for Settings › Account pool join these keys.
 */
export const poolKeys = {
  all: ["account-pool"] as const,
  preview: (deviceId: string) => ["account-pool", "preview", deviceId] as const,
};

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
