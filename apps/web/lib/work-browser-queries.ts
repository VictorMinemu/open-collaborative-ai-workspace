"use client";

import { WORK_BROWSER_SIGNIN_ROUTES, WorkBrowserSignInList, workLivePath } from "@ocw/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, isApiError } from "@/lib/api";
import { getRuntimeConfig } from "@/lib/config";

/**
 * The Work Zone browser's client routes (07.13). 16: the live socket of one session's page. 21: the member's own Work
 * Zone sign-ins (Settings › Keychain, D-23) and their revoke. The list is owner-only in the API and the database; the
 * web never asks for anyone else's, and the DTO carries no cookie, value or account name.
 */

/** `wss://<api>/api/v1/live/work-browser/<id>` on the API's own origin (the JWT goes as a subprotocol, never here). */
export function workLiveSocketUrl(sessionId: string, apiUrl = getRuntimeConfig().apiUrl): string {
  return `${apiUrl.replace(/\/+$/, "").replace(/^http/, "ws")}${workLivePath(encodeURIComponent(sessionId))}`;
}

export const workBrowserKeys = {
  signins: ["work-browser-signins"] as const,
};

/** `DELETE` route of one sign-in. */
export function workSignInPath(id: string): string {
  return WORK_BROWSER_SIGNIN_ROUTES.revoke.replace(":id", encodeURIComponent(id));
}

function noRetryOn4xx(failureCount: number, err: unknown): boolean {
  if (isApiError(err) && err.status >= 400 && err.status < 500) return false;
  return failureCount < 1;
}

export function useWorkSignIns(enabled = true) {
  return useQuery({
    enabled,
    queryKey: workBrowserKeys.signins,
    queryFn: ({ signal }) =>
      api.get(WORK_BROWSER_SIGNIN_ROUTES.list, { schema: WorkBrowserSignInList, signal }),
    retry: noRetryOn4xx,
  });
}

/**
 * Revokes one of the member's Work Zone sign-ins (a page using it closes on the device). No optimistic removal: the
 * row goes once the server answered and the list was read again, so a refused revoke never looks done.
 */
export function useRevokeWorkSignIn() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del(workSignInPath(id)),
    onSuccess: () => qc.invalidateQueries({ queryKey: workBrowserKeys.signins }),
  });
}
