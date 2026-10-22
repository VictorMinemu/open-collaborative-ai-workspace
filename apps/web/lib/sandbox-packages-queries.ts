"use client";

import {
  type ApproveSandboxPackageRequest,
  type ReviewSandboxPackageRequest,
  SandboxPackage,
  SandboxPackageList,
  SandboxPackageReview,
  type UpdateSandboxPackageRequest,
} from "@ocw/contracts";
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, isApiError } from "./api";

/**
 * Sandbox packages (07.8-23 over 07.8-18's routes; D-03, D-11, P-12): the organization's approved packages, a live
 * review of one exact release, approval with the review token, the two switches and removal. The API asks sandboxd for
 * the whole tree, scores the risk and re-checks every approval; the page only renders its answers and sends the review
 * token back. Listing needs `bot.manage`; everything else `plugin.manage` (`viewerCan.manage`).
 */

const BASE = "/api/v1/sandbox/packages";

export const sandboxPackagesKey = ["sandbox-packages"] as const;
export const packageReviewKey = (r: ReviewSandboxPackageRequest) =>
  ["sandbox-package-review", r.source, r.name, r.version] as const;

function noRetryOn4xx(failureCount: number, err: unknown): boolean {
  if (isApiError(err) && err.status >= 400 && err.status < 500) return false;
  return failureCount < 1;
}

/** In flight: installs pending, or approved and waiting for each sandbox's next start, or leaving them. */
const inFlight = (p: SandboxPackage) =>
  !p.changedUpstream &&
  (p.installing > 0 || (p.enabled ? p.installedIn === 0 && p.failed === 0 : p.installedIn > 0));

/** The list; polls while a package is on its way into (or out of) the sandboxes. */
export function useSandboxPackages(enabled = true) {
  return useQuery({
    enabled,
    queryKey: sandboxPackagesKey,
    queryFn: ({ signal }) => api.get(BASE, { schema: SandboxPackageList, signal }),
    retry: noRetryOn4xx,
    refetchInterval: (q) => (q.state.data?.items.some(inFlight) ? 5_000 : false),
  });
}

/**
 * A live review of one release. Every review asks the registry through sandboxd (and is audited), so a review is never
 * refetched by itself: the Add dialog always fetches a fresh one (its errors belong to the form) and the sheet reads it
 * from the cache; a row's Review… forgets the cached one first.
 */
export function fetchPackageReview(qc: QueryClient, req: ReviewSandboxPackageRequest) {
  return qc.fetchQuery({
    queryKey: packageReviewKey(req),
    queryFn: ({ signal }) => api.post(`${BASE}/review`, { body: req, schema: SandboxPackageReview, signal }),
    staleTime: 0,
    retry: false,
  });
}

export function usePackageReview(req: ReviewSandboxPackageRequest | null) {
  return useQuery({
    enabled: req !== null,
    queryKey: req ? packageReviewKey(req) : ["sandbox-package-review", "none"],
    queryFn: ({ signal }) => api.post(`${BASE}/review`, { body: req, schema: SandboxPackageReview, signal }),
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  });
}

/** Forgets a review so the next look asks the registry again (a row's Review…, a closed sheet). */
export function forgetPackageReview(qc: QueryClient, req: ReviewSandboxPackageRequest) {
  qc.removeQueries({ queryKey: packageReviewKey(req), exact: true });
}

/** The refreshed review a 409 `package_changed_upstream` carries, if any. */
export function refreshedReview(err: unknown): SandboxPackageReview | null {
  if (!isApiError(err, 409) || err.code !== "package_changed_upstream") return null;
  const parsed = SandboxPackageReview.safeParse((err.details as { review?: unknown } | null)?.review);
  return parsed.success ? parsed.data : null;
}

/**
 * `POST /sandbox/packages` with the review token (and the typed acknowledgement for high risk). A release that changed
 * upstream since the review answers 409 with the refreshed review, which replaces the cached one.
 */
export function useApproveSandboxPackage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ApproveSandboxPackageRequest) => api.post(BASE, { body, schema: SandboxPackage }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: sandboxPackagesKey }),
    onError: (err) => {
      const fresh = refreshedReview(err);
      if (fresh) qc.setQueryData(packageReviewKey(fresh), fresh);
      void qc.invalidateQueries({ queryKey: sandboxPackagesKey });
    },
  });
}

/** `PATCH /sandbox/packages/:id`: shown at once, restored when the API refuses. */
export function useUpdateSandboxPackage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: UpdateSandboxPackageRequest }) =>
      api.patch(`${BASE}/${encodeURIComponent(id)}`, { body: patch, schema: SandboxPackage }),
    onMutate: async ({ id, patch }) => {
      await qc.cancelQueries({ queryKey: sandboxPackagesKey });
      const previous = qc.getQueryData<SandboxPackageList>(sandboxPackagesKey);
      qc.setQueryData<SandboxPackageList>(sandboxPackagesKey, (list) =>
        list ? { ...list, items: list.items.map((p) => (p.id === id ? { ...p, ...patch } : p)) } : list,
      );
      return { previous };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.previous) qc.setQueryData(sandboxPackagesKey, ctx.previous);
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: sandboxPackagesKey }),
  });
}

/** `DELETE /sandbox/packages/:id`: every sandbox drops it at its next start; the list no longer has it. */
export function useRemoveSandboxPackage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del(`${BASE}/${encodeURIComponent(id)}`),
    onSettled: () => void qc.invalidateQueries({ queryKey: sandboxPackagesKey }),
  });
}
