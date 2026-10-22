"use client";

import { BrowserSessionList, BrowserTabView } from "@ocw/contracts";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, isApiError } from "./api";

/**
 * The people's browser routes (07.8-21, 07.8-27; D-06, D-08, R7, UI-SPEC § 3.6 and § 4.5):
 * - Settings › Keychain › Browser sessions: the member's OWN sealed sign-ins (site, bot, dates, status; never anything
 *   sealed) and their revoke. The list is owner-only in the API and the database; the web never asks for anyone else's.
 * - The bot page's Browser tab: the pages the viewer may watch, private rows, and host-level activity, 20 at a time.
 */
export const browserKeys = {
  sessions: ["browser-sessions"] as const,
  tab: (agentId: string) => ["agent-browser", agentId] as const,
};

/** The Browser tab refreshes its open pages while it is shown (pages open and close without a chat event). */
const TAB_REFRESH_MS = 10_000;

function noRetryOn4xx(failureCount: number, err: unknown): boolean {
  if (isApiError(err) && err.status >= 400 && err.status < 500) return false;
  return failureCount < 1;
}

export function useBrowserSessions(enabled = true) {
  return useQuery({
    enabled,
    queryKey: browserKeys.sessions,
    queryFn: ({ signal }) => api.get("/api/v1/browser-sessions", { schema: BrowserSessionList, signal }),
    retry: noRetryOn4xx,
  });
}

/**
 * Revokes (or removes, once expired) one of the member's sign-ins. No optimistic removal: the row goes when the server
 * has answered and the list was read again, so a refused revoke never looks done.
 */
export function useRevokeBrowserSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del(`/api/v1/browser-sessions/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: browserKeys.sessions }),
  });
}

export function useBrowserTab(agentId: string, opts: { enabled?: boolean } = {}) {
  return useInfiniteQuery({
    enabled: opts.enabled ?? true,
    queryKey: browserKeys.tab(agentId),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      api.get(
        `/api/v1/agents/${agentId}/browser${pageParam ? `?cursor=${encodeURIComponent(pageParam)}` : ""}`,
        { schema: BrowserTabView, signal },
      ),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: (query) => (query.state.status === "success" ? TAB_REFRESH_MS : false),
    retry: noRetryOn4xx,
  });
}
