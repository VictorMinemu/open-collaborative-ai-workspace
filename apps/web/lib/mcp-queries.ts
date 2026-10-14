"use client";

import {
  type CreateMcpServerRequest,
  McpServer,
  McpServerList,
  Ok,
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
const awaitingCellProbe = (s: McpServer) => s.authMode === "org_secret" && PROBING.has(s.status);

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
