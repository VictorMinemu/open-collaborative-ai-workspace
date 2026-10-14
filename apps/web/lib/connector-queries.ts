"use client";

import {
  ConnectStartResponse,
  type CreateMemberAccountShareRequest,
  isAgentCardRoute,
  McpServer,
  MemberAccountShare,
  MemberAccountShareList,
  MemberConnector,
  MemberConnectorList,
  ReadersPreview,
} from "@ocw/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ApiRequestError, api, isApiError } from "./api";
import { capabilityKeys } from "./capability-queries";
import { mcpKeys } from "./mcp-queries";

/**
 * Settings › Connections (07.4-13; D-01, D-03, CONN-01, CONN-03). The member's own connections to per-member
 * connectors and their member-account shares. The browser only ever sees states: a connect start returns the
 * provider's authorize URL (the flow state stays server-side), a key is write-only (`PUT …/secret`), and no response
 * carries a token or a key.
 */
export const connectorKeys = {
  list: ["connectors"] as const,
  shares: ["member-account-shares"] as const,
  preview: (conversationId: string) => ["member-account-shares", "preview", conversationId] as const,
};

function noRetryOn4xx(failureCount: number, err: unknown): boolean {
  if (isApiError(err) && err.status >= 400 && err.status < 500) return false;
  return failureCount < 1;
}

export function useConnectors(enabled = true) {
  return useQuery({
    enabled,
    queryKey: connectorKeys.list,
    queryFn: ({ signal }) => api.get("/api/v1/connectors", { schema: MemberConnectorList, signal }),
    retry: noRetryOn4xx,
  });
}

/** Replaces one connector in the cached list (after a key save) without refetching the page. */
function useReplaceConnector() {
  const qc = useQueryClient();
  return (c: MemberConnector) =>
    qc.setQueryData<MemberConnectorList>(connectorKeys.list, (prev) =>
      prev ? { ...prev, connectors: prev.connectors.map((x) => (x.serverId === c.serverId ? c : x)) } : prev,
    );
}

/** A connection change can fill a connector's catalog (first probe) and the bots' tool lists. */
function useInvalidateConnections() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: connectorKeys.list });
    void qc.invalidateQueries({ queryKey: connectorKeys.shares });
    void qc.invalidateQueries({ queryKey: mcpKeys.servers });
    void qc.invalidateQueries({ queryKey: capabilityKeys.all });
  };
}

/** `POST /connectors/:id/connect` → the authorize URL; the caller sends the whole page there (no popup). */
export function useConnect() {
  return useMutation({
    mutationFn: (serverId: string) =>
      api.post(`/api/v1/connectors/${serverId}/connect`, { schema: ConnectStartResponse }),
  });
}

/** `PUT /connectors/:id/secret`: the member's own key (write-only; the response is the connector's new state). */
export function useConnectSecret() {
  const replace = useReplaceConnector();
  const invalidate = useInvalidateConnections();
  return useMutation({
    mutationFn: ({ serverId, value }: { serverId: string; value: string }) =>
      api.put(`/api/v1/connectors/${serverId}/secret`, { body: { value }, schema: MemberConnector }),
    onSuccess: replace,
    onSettled: invalidate,
  });
}

/** `DELETE /connectors/:id/connection` (204): revokes at the provider and deletes the member's credential. */
export function useDisconnect() {
  const invalidate = useInvalidateConnections();
  return useMutation({
    mutationFn: (serverId: string) => api.del(`/api/v1/connectors/${serverId}/connection`),
    onSettled: invalidate,
  });
}

/** Settings › MCP servers Re-probe of a per-member connector: with the admin's OWN connection (409 without one). */
export function useProbeConnector(serverId: string) {
  const qc = useQueryClient();
  const invalidate = useInvalidateConnections();
  return useMutation({
    mutationFn: () => api.post(`/api/v1/connectors/${serverId}/probe`, { schema: McpServer }),
    onSuccess: (server) =>
      qc.setQueryData<{ servers: McpServer[] }>(mcpKeys.servers, (prev) =>
        prev ? { ...prev, servers: prev.servers.map((s) => (s.id === server.id ? server : s)) } : prev,
      ),
    onSettled: invalidate,
  });
}

/** True for the 409 of a member route that needs the caller's own connection first. */
export function isNotConnected(err: unknown): err is ApiRequestError {
  return isApiError(err, 409) && (err.code === "not_connected" || err.code === "needs_reconnect");
}

// ---------------------------------------------------------------- member-account shares (D-03, UI-SPEC R7)

export function useShares(enabled = true) {
  return useQuery({
    enabled,
    queryKey: connectorKeys.shares,
    queryFn: ({ signal }) =>
      api.get("/api/v1/member-account-shares", { schema: MemberAccountShareList, signal }),
    retry: noRetryOn4xx,
  });
}

/** Who would read results in a conversation: loaded before the confirm button is enabled (T-07.4-13-03). */
export function useSharePreview(conversationId: string | null) {
  return useQuery({
    enabled: conversationId !== null,
    queryKey: connectorKeys.preview(conversationId ?? ""),
    queryFn: ({ signal }) =>
      api.get(
        `/api/v1/member-account-shares/preview?conversationId=${encodeURIComponent(conversationId ?? "")}`,
        { schema: ReadersPreview, signal },
      ),
    retry: false,
    staleTime: 0,
  });
}

export function useCreateShare() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateMemberAccountShareRequest) =>
      api.post("/api/v1/member-account-shares", { body, schema: MemberAccountShare }),
    onSuccess: (share) =>
      qc.setQueryData<MemberAccountShareList>(connectorKeys.shares, (prev) =>
        prev ? { shares: [share, ...prev.shares.filter((s) => s.id !== share.id)] } : prev,
      ),
    onSettled: () => void qc.invalidateQueries({ queryKey: connectorKeys.shares }),
  });
}

export function useRevokeShare() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del(`/api/v1/member-account-shares/${id}`),
    onSuccess: (_res, id) =>
      qc.setQueryData<MemberAccountShareList>(connectorKeys.shares, (prev) =>
        prev ? { shares: prev.shares.filter((s) => s.id !== id) } : prev,
      ),
    onSettled: () => void qc.invalidateQueries({ queryKey: connectorKeys.shares }),
  });
}

// ---------------------------------------------------------------- return route across the OAuth redirect (R8)

/** sessionStorage key for `{serverId, return}` kept across the provider round trip (UI-SPEC R8). */
export const CONNECT_RETURN_KEY = "ocw:connect-return";
/** sessionStorage key for a share link that waits for the member to connect first (UI-SPEC R7). */
export const PENDING_SHARE_KEY = "ocw:connect-pending-share";

export interface ConnectReturn {
  serverId: string;
  return: string;
}

/** Stores the chat route to come back to; anything that is not an internal app route is never stored (T-07.4-13-04). */
export function rememberConnectReturn(serverId: string, route: string | null): void {
  try {
    if (route && isAgentCardRoute(route)) {
      sessionStorage.setItem(CONNECT_RETURN_KEY, JSON.stringify({ serverId, return: route }));
    } else {
      sessionStorage.removeItem(CONNECT_RETURN_KEY);
    }
  } catch {
    // Storage blocked (private mode): the banner just omits Back to chat.
  }
}

/** Reads and clears the stored return route for `serverId`; re-validated before it is ever rendered. */
export function takeConnectReturn(serverId: string): string | null {
  try {
    const raw = sessionStorage.getItem(CONNECT_RETURN_KEY);
    sessionStorage.removeItem(CONNECT_RETURN_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ConnectReturn>;
    if (parsed.serverId !== serverId || typeof parsed.return !== "string") return null;
    return isAgentCardRoute(parsed.return) ? parsed.return : null;
  } catch {
    return null;
  }
}

export interface PendingShare {
  share: string;
  connector: string | null;
  key: string | null;
}

export function rememberPendingShare(p: PendingShare): void {
  try {
    sessionStorage.setItem(PENDING_SHARE_KEY, JSON.stringify(p));
  } catch {
    // Storage blocked: the member opens the link again after connecting.
  }
}

export function takePendingShare(): PendingShare | null {
  try {
    const raw = sessionStorage.getItem(PENDING_SHARE_KEY);
    sessionStorage.removeItem(PENDING_SHARE_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<PendingShare>;
    if (typeof p.share !== "string") return null;
    return {
      share: p.share,
      connector: typeof p.connector === "string" ? p.connector : null,
      key: typeof p.key === "string" ? p.key : null,
    };
  } catch {
    return null;
  }
}
