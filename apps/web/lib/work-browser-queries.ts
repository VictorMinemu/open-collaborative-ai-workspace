"use client";

import { workLivePath } from "@ocw/contracts";
import { getRuntimeConfig } from "@/lib/config";

/**
 * The Work Zone browser's client routes (07.13). 16: the live socket of one session's page; 21 adds the member sign-in
 * queries here.
 */

/** `wss://<api>/api/v1/live/work-browser/<id>` on the API's own origin (the JWT goes as a subprotocol, never here). */
export function workLiveSocketUrl(sessionId: string, apiUrl = getRuntimeConfig().apiUrl): string {
  return `${apiUrl.replace(/\/+$/, "").replace(/^http/, "ws")}${workLivePath(encodeURIComponent(sessionId))}`;
}
