"use client";

import {
  AgentMessagingSettings,
  AgentMessagingView,
  type SetAgentMessagingRequest,
  type UpdateAgentMessagingSettingsRequest,
} from "@ocw/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, isApiError } from "./api";

/**
 * Who may consult whom (07.7-08; A2A-02, D-04, P-03, P-04): the organization switch "Bots may consult each other" and
 * each team bot's consult rules, on 07.7-03's routes. The API decides everything, including the "Right now" line
 * (`effective`); the web renders the view it answers and never computes what a bot may do.
 */
export const agentMessagingKeys = {
  settings: ["agent-messaging"] as const,
  bot: (id: string) => ["agent-messaging", id] as const,
};

/** A cached per-bot view (`["agent-messaging", id]`), not the organization switch. */
const isBotView = (q: { queryKey: readonly unknown[] }) => q.queryKey.length === 2;

function noRetryOn4xx(failureCount: number, err: unknown): boolean {
  if (isApiError(err) && err.status >= 400 && err.status < 500) return false;
  return failureCount < 1;
}

/** `GET /agent-messaging`: the organization switch. A 403 means the caller has no `rule.read`. */
export function useAgentMessagingSettings(enabled = true) {
  return useQuery({
    enabled,
    queryKey: agentMessagingKeys.settings,
    queryFn: ({ signal }) => api.get("/api/v1/agent-messaging", { schema: AgentMessagingSettings, signal }),
    retry: noRetryOn4xx,
  });
}

/**
 * `PUT /agent-messaging`. The answer replaces the cached switch; every bot view is invalidated too, since `orgDefault`
 * and each bot's "Right now" line follow the switch.
 */
export function useUpdateAgentMessagingSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateAgentMessagingSettingsRequest) =>
      api.put("/api/v1/agent-messaging", { body, schema: AgentMessagingSettings }),
    onSuccess: (settings) => {
      qc.setQueryData(agentMessagingKeys.settings, settings);
      void qc.invalidateQueries({ queryKey: agentMessagingKeys.settings, predicate: isBotView });
    },
    onError: () => void qc.invalidateQueries({ queryKey: agentMessagingKeys.settings }),
  });
}

/** `GET /agents/:id/messaging`: one team bot's consult rules and its "Right now" summary. */
export function useAgentMessaging(agentId: string | null, opts: { enabled?: boolean } = {}) {
  return useQuery({
    enabled: !!agentId && (opts.enabled ?? true),
    queryKey: agentMessagingKeys.bot(agentId ?? ""),
    queryFn: ({ signal }) =>
      api.get(`/api/v1/agents/${agentId}/messaging`, { schema: AgentMessagingView, signal }),
    retry: noRetryOn4xx,
  });
}

/**
 * `PUT /agents/:id/messaging` with the full desired state (outbound and inbound). The answer replaces this bot's view;
 * the other bots' views are invalidated, because their "Right now" lines change with this bot's inbound switch.
 */
export function useSetAgentMessaging(agentId: string) {
  const qc = useQueryClient();
  const key = agentMessagingKeys.bot(agentId);
  return useMutation({
    mutationFn: (body: SetAgentMessagingRequest) =>
      api.put(`/api/v1/agents/${agentId}/messaging`, { body, schema: AgentMessagingView }),
    onSuccess: (view) => {
      qc.setQueryData(key, view);
      void qc.invalidateQueries({
        queryKey: agentMessagingKeys.settings,
        predicate: (q) => isBotView(q) && q.queryKey[1] !== agentId,
      });
    },
    // The server state comes back: the section always shows what the API holds.
    onError: () => void qc.invalidateQueries({ queryKey: key }),
  });
}
