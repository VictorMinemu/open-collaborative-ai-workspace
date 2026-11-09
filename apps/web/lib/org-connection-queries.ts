"use client";

import { ConnectStartResponse, McpServer, type McpServerList } from "@ocw/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import { capabilityKeys } from "./capability-queries";
import { mcpKeys } from "./mcp-queries";

/**
 * The organization's connection on Settings › MCP servers (07.14 D-02, D-08, D-11; `mcp.manage`). Connect returns the
 * provider's authorize URL only (the flow state stays server-side) and the browser goes there; the response of every
 * call is a server state, never a token or a secret.
 */

/** The registry and every bot's tool list follow the organization's connection. */
function useInvalidate() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: mcpKeys.servers });
    void qc.invalidateQueries({ queryKey: capabilityKeys.all });
  };
}

/**
 * `POST /connectors/:id/org-connection/connect` → the whole page goes to the provider (no popup). A refused start
 * (409 with a closed code) records the failing step on the server, so the list is refetched to show it.
 */
export function useStartOrgConnect(serverId: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: () =>
      api.post(`/api/v1/connectors/${serverId}/org-connection/connect`, { schema: ConnectStartResponse }),
    onSuccess: ({ authorizeUrl }) => window.location.assign(authorizeUrl),
    onError: invalidate,
  });
}

/** `DELETE /connectors/:id/org-connection` (204): signs out at the provider when it can, then forgets the account. */
export function useDisconnectOrg(serverId: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: () => api.del(`/api/v1/connectors/${serverId}/org-connection`),
    onSettled: invalidate,
  });
}

/** `POST /connectors/:id/probe`: an organization-account server is probed with the organization's own token. */
export function useReprobeConnector(serverId: string) {
  const qc = useQueryClient();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: () => api.post(`/api/v1/connectors/${serverId}/probe`, { schema: McpServer }),
    onSuccess: (server) =>
      qc.setQueryData<McpServerList>(mcpKeys.servers, (prev) =>
        prev ? { ...prev, servers: prev.servers.map((s) => (s.id === server.id ? server : s)) } : prev,
      ),
    onSettled: invalidate,
  });
}
