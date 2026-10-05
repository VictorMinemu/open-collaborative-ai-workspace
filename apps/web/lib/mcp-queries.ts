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
 * new value, responses only ever carry `{ name, hasValue }`. Tools come from the cell's probe.
 */
export const mcpKeys = { servers: ["mcp-servers"] as const };

const PROBING = new Set(["pending", "probing"]);

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
    refetchInterval: (query) => (query.state.data?.servers.some((s) => PROBING.has(s.status)) ? 1500 : false),
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
    mutationFn: () => api.del(`/api/v1/mcp-servers/${id}`, { schema: Ok }),
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
