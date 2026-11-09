"use client";

import {
  type ClientCredentialsInput,
  ConnectorAuthFailure,
  type CreateMcpServerRequest,
  McpServer,
  McpServerList,
  type OAuthTestRequest,
  OAuthTestResponse,
  Ok,
  rendersInCell,
  type UpdateMcpServerRequest,
} from "@ocw/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, isApiError } from "./api";
import { capabilityKeys } from "./capability-queries";

/**
 * MCP server registry (03.1-09 routes, `mcp.manage`). Header credentials are write-only: requests may carry a
 * new value, responses only ever carry `{ name, hasValue }`. Tools come from the cell's probe. Phase 07.4: each
 * server has an auth mode; an OAuth client secret is write-only too (`hasSecret`), and a PATCH or DELETE that would
 * disconnect members answers 409 `connections_exist {count}` until `clearConnections` confirms.
 */
export const mcpKeys = { servers: ["mcp-servers"] as const };

const PROBING = new Set(["pending", "probing"]);

/**
 * Only the cell probes, and only organization-secret servers: a per-member connector stays `pending` until a member
 * connects (07.4-10), so it never keeps the list polling.
 */
const awaitingCellProbe = (s: McpServer) => rendersInCell(s.authMode) && PROBING.has(s.status);

function noRetryOn4xx(failureCount: number, err: unknown): boolean {
  if (isApiError(err) && err.status >= 400 && err.status < 500) return false;
  return failureCount < 1;
}

/** Every server with its tools and status, plus the stdio sandbox; polls while a probe is running. */
export function useMcpServers(enabled = true) {
  return useQuery({
    enabled,
    queryKey: mcpKeys.servers,
    queryFn: ({ signal }) => api.get("/api/v1/mcp-servers", { schema: McpServerList, signal }),
    retry: noRetryOn4xx,
    refetchInterval: (query) => (query.state.data?.servers.some(awaitingCellProbe) ? 1500 : false),
  });
}

/** Servers feed every bot's tool list: a change refetches the registry and every capability view. */
function useInvalidateMcp() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: mcpKeys.servers });
    void qc.invalidateQueries({ queryKey: capabilityKeys.all });
  };
}

function useReplaceServer() {
  const qc = useQueryClient();
  return (server: McpServer) =>
    qc.setQueryData<McpServerList>(mcpKeys.servers, (prev) =>
      prev
        ? {
            ...prev,
            servers: prev.servers.some((s) => s.id === server.id)
              ? prev.servers.map((s) => (s.id === server.id ? server : s))
              : [...prev.servers, server],
          }
        : prev,
    );
}

export function useCreateMcpServer() {
  const replace = useReplaceServer();
  const invalidate = useInvalidateMcp();
  return useMutation({
    mutationFn: (body: CreateMcpServerRequest) =>
      api.post("/api/v1/mcp-servers", { body, schema: McpServer }),
    onSuccess: replace,
    onSettled: invalidate,
  });
}

export function useUpdateMcpServer(id: string) {
  const replace = useReplaceServer();
  const invalidate = useInvalidateMcp();
  return useMutation({
    mutationFn: (body: UpdateMcpServerRequest) =>
      api.patch(`/api/v1/mcp-servers/${id}`, { body, schema: McpServer }),
    onSuccess: replace,
    onSettled: invalidate,
  });
}

export function useDeleteMcpServer(id: string) {
  const qc = useQueryClient();
  const invalidate = useInvalidateMcp();
  return useMutation({
    mutationFn: (opts: { clearConnections?: boolean } = {}) =>
      api.del(`/api/v1/mcp-servers/${id}${opts.clearConnections ? "?clearConnections=true" : ""}`, {
        schema: Ok,
      }),
    onSuccess: () =>
      qc.setQueryData<McpServerList>(mcpKeys.servers, (prev) =>
        prev ? { ...prev, servers: prev.servers.filter((s) => s.id !== id) } : prev,
      ),
    onSettled: invalidate,
  });
}

export function useProbeMcpServer(id: string) {
  const replace = useReplaceServer();
  const invalidate = useInvalidateMcp();
  return useMutation({
    mutationFn: () => api.post(`/api/v1/mcp-servers/${id}/probe`, { schema: McpServer }),
    onSuccess: replace,
    onSettled: invalidate,
  });
}

/** The member count of a 409 `connections_exist` (the fallback when the DTO count was stale, UI-SPEC R4). */
export function connectionsExistCount(err: unknown): number | null {
  if (!isApiError(err, 409) || err.code !== "connections_exist") return null;
  const count = (err.details as { count?: unknown } | undefined)?.count;
  return typeof count === "number" && count > 0 ? count : null;
}

/** A PATCH refused with 409 `org_connection_exists` (the organization connected since the list loaded, PD-11). */
export function isOrgConnectionExists(err: unknown): boolean {
  return isApiError(err, 409) && err.code === "org_connection_exists";
}

/**
 * A client-credentials save the provider refused (409 whose code is a D-10 failure): the step it stopped at, never the
 * provider's text. The API also records it as the server's `authFailure`.
 */
export class CredentialsRefusedError extends Error {
  constructor(readonly failure: ConnectorAuthFailure) {
    super(`client credentials refused: ${failure}`);
    this.name = "CredentialsRefusedError";
  }
}

/**
 * `PUT /api/v1/connectors/:id/org-connection/client-credentials` (07.14 D-03, mcp.manage): the API discovers the token
 * endpoint, runs one grant, seals the client and lists the tools; the answer replaces the server in the list. The
 * secret is write-only (omitted = keep the stored one). A refused grant throws `CredentialsRefusedError`; the list is
 * refetched either way, so the row shows the stored failure or the connection.
 */
export function useSaveClientCredentials() {
  const replace = useReplaceServer();
  const invalidate = useInvalidateMcp();
  return useMutation({
    mutationFn: async ({ serverId, body }: { serverId: string; body: ClientCredentialsInput }) => {
      try {
        return await api.put(`/api/v1/connectors/${serverId}/org-connection/client-credentials`, {
          body,
          schema: McpServer,
        });
      } catch (err) {
        const failure = isApiError(err, 409) ? ConnectorAuthFailure.safeParse(err.code) : null;
        if (failure?.success) throw new CredentialsRefusedError(failure.data);
        throw err;
      }
    },
    onSuccess: replace,
    onSettled: invalidate,
  });
}

/**
 * `POST /api/v1/connectors/oauth-test` (07.14 D-10, D-18): dry-runs a sign-in for the dialog's current values or the
 * saved server. It stores and registers nothing; the answer names steps by closed codes only.
 */
export function useOAuthTest() {
  return useMutation({
    mutationFn: (body: OAuthTestRequest) =>
      api.post("/api/v1/connectors/oauth-test", { body, schema: OAuthTestResponse }),
  });
}
