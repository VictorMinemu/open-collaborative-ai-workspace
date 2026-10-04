"use client";

import {
  Agent,
  AgentCellStatus,
  AgentList,
  AllowedModelList,
  ChannelList,
  type CreateAgentRequest,
  EphemeralTypes,
  EventTypes,
  ModelProvider,
  ModelProviderList,
  Ok,
  ProviderAuthStatus,
  RotateCellTokenResponse,
  type SubscriptionProviderKind,
  topic,
  type UpdateAgentRequest,
  type UpsertModelProviderRequest,
} from "@ocw/contracts";
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, isApiError } from "./api";
import { useMe } from "./queries";
import { useTopic } from "./realtime";

export const botKeys = {
  agents: ["agents"] as const,
  models: ["models"] as const,
  providers: ["model-providers"] as const,
  cell: ["agent-cell"] as const,
  channels: ["channels"] as const,
  providerAuth: (provider: string) => ["provider-auth", provider] as const,
};

function noRetryOn4xx(failureCount: number, err: unknown): boolean {
  if (isApiError(err) && err.status >= 400 && err.status < 500) return false;
  return failureCount < 1;
}

// ---- bots ----

export function useAgents() {
  return useQuery({
    queryKey: botKeys.agents,
    queryFn: ({ signal }) => api.get("/api/v1/agents", { schema: AgentList, signal }),
    retry: noRetryOn4xx,
    // Realtime pushes status changes; this is only a safety net for an ack that lands before the page
    // subscribed (seen on fast CI runners): while any bot is provisioning, re-read every 3 s.
    refetchInterval: (query) =>
      query.state.data?.agents.some((a) => a.status === "provisioning") ? 3_000 : false,
  });
}

function upsertAgent(qc: QueryClient, agent: Agent) {
  qc.setQueryData<AgentList>(botKeys.agents, (prev) => {
    if (!prev) return prev;
    const current = prev.agents.find((a) => a.id === agent.id);
    // Never let an older snapshot (e.g. the create response) overwrite a newer realtime update.
    if (current && Date.parse(current.updatedAt) > Date.parse(agent.updatedAt)) return prev;
    const agents = current
      ? prev.agents.map((a) => (a.id === agent.id ? agent : a))
      : [...prev.agents, agent];
    return { agents: agents.sort((a, b) => a.name.localeCompare(b.name)) };
  });
}

export function useCreateAgent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateAgentRequest) => api.post("/api/v1/agents", { body, schema: Agent }),
    onSuccess: (agent) => upsertAgent(qc, agent),
  });
}

export function useUpdateAgent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdateAgentRequest }) =>
      api.patch(`/api/v1/agents/${id}`, { body, schema: Agent }),
    onSuccess: (agent) => upsertAgent(qc, agent),
  });
}

export function useDeleteAgent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del(`/api/v1/agents/${id}`, { schema: Ok }),
    onSuccess: (_ok, id) =>
      qc.setQueryData<AgentList>(botKeys.agents, (prev) =>
        prev ? { agents: prev.agents.filter((a) => a.id !== id) } : prev,
      ),
  });
}

// ---- models & providers ----

export function useModels() {
  return useQuery({
    queryKey: botKeys.models,
    queryFn: ({ signal }) => api.get("/api/v1/models", { schema: AllowedModelList, signal }),
    retry: noRetryOn4xx,
  });
}

export function useModelProviders(enabled = true) {
  return useQuery({
    enabled,
    queryKey: botKeys.providers,
    queryFn: ({ signal }) => api.get("/api/v1/model-providers", { schema: ModelProviderList, signal }),
    retry: noRetryOn4xx,
  });
}

export function useUpsertProvider() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: UpsertModelProviderRequest) =>
      api.post("/api/v1/model-providers", { body, schema: ModelProvider }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: botKeys.providers });
      void qc.invalidateQueries({ queryKey: botKeys.models });
    },
  });
}

export function useDeleteProvider() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (provider: string) => api.del(`/api/v1/model-providers/${provider}`, { schema: Ok }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: botKeys.providers });
      void qc.invalidateQueries({ queryKey: botKeys.models });
    },
  });
}

// ---- subscription sign-in (ChatGPT via Codex; runs in the OpenClaw cell) ----

/**
 * Sign-in flow state (admin only; includes the one-time code while pending). Live through
 * `provider.auth.updated` (see useBotsRealtime); polls as a fallback while a flow is active.
 */
export function useProviderAuth(provider: SubscriptionProviderKind, enabled = true) {
  return useQuery({
    enabled,
    queryKey: botKeys.providerAuth(provider),
    queryFn: ({ signal }) =>
      api.get(`/api/v1/model-providers/${provider}/auth`, { schema: ProviderAuthStatus, signal }),
    retry: noRetryOn4xx,
    refetchInterval: (q) => {
      const state = q.state.data?.state;
      return state === "starting" || state === "pending" ? 4_000 : false;
    },
  });
}

function onAuthStatus(qc: QueryClient, status: ProviderAuthStatus) {
  qc.setQueryData(botKeys.providerAuth(status.provider), status);
  if (status.state === "connected" || status.state === "idle") {
    void qc.invalidateQueries({ queryKey: botKeys.providers });
    void qc.invalidateQueries({ queryKey: botKeys.models });
  }
}

export function useStartProviderAuth(provider: SubscriptionProviderKind) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (opts: { restart?: boolean } = {}) =>
      api.post(`/api/v1/model-providers/${provider}/auth`, { body: opts, schema: ProviderAuthStatus }),
    onSuccess: (status) => onAuthStatus(qc, status),
    onError: () => void qc.invalidateQueries({ queryKey: botKeys.providerAuth(provider) }),
  });
}

export function useCancelProviderAuth(provider: SubscriptionProviderKind) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.del(`/api/v1/model-providers/${provider}/auth`, { schema: ProviderAuthStatus }),
    onSuccess: (status) => onAuthStatus(qc, status),
  });
}

// ---- bots runtime (OpenClaw cell) ----

export function useCellStatus(enabled = true) {
  return useQuery({
    enabled,
    queryKey: botKeys.cell,
    queryFn: ({ signal }) => api.get("/api/v1/agent-cell", { schema: AgentCellStatus, signal }),
    retry: noRetryOn4xx,
    refetchInterval: 30_000,
  });
}

export function useRotateCellToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post("/api/v1/agent-cell/token", { schema: RotateCellTokenResponse }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: botKeys.cell }),
  });
}

// ---- channels (owned by chat; tolerated when chat is not deployed) ----

/** `data === null` when this server has no chat module (404). */
export function useChannels(enabled = true) {
  return useQuery({
    enabled,
    queryKey: botKeys.channels,
    queryFn: async ({ signal }) => {
      try {
        return await api.get("/api/v1/channels", { schema: ChannelList, signal });
      } catch (err) {
        if (isApiError(err, 404)) return null;
        throw err;
      }
    },
    retry: noRetryOn4xx,
  });
}

export function useAddAgentToChannel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ channelId, agentId }: { channelId: string; agentId: string }) =>
      api.post(`/api/v1/channels/${channelId}/members`, { body: { kind: "agent", id: agentId } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: botKeys.channels }),
  });
}

/**
 * Live org updates for the bots surfaces: agent created/updated/deleted (status chips), provider changes and
 * OpenClaw cell presence.
 */
export function useBotsRealtime() {
  const qc = useQueryClient();
  const me = useMe({ enabled: false });
  const orgId = me.data?.organization.id ?? null;
  useTopic(orgId ? topic("org", orgId) : null, (frame) => {
    if (frame.op === "eph") {
      if (frame.type === EphemeralTypes.cellPresence) {
        void qc.invalidateQueries({ queryKey: botKeys.cell });
        void qc.invalidateQueries({ queryKey: ["provider-auth"] });
      } else if (frame.type === EphemeralTypes.providerAuth) {
        // Only {provider, state} travels on the socket; admins refetch the code over REST.
        const data = frame.data as { provider?: string; state?: string } | null;
        if (data?.provider) void qc.invalidateQueries({ queryKey: botKeys.providerAuth(data.provider) });
        if (data?.state === "connected" || data?.state === "idle") {
          void qc.invalidateQueries({ queryKey: botKeys.providers });
          void qc.invalidateQueries({ queryKey: botKeys.models });
        }
      }
      return;
    }
    if (frame.op !== "ev") return;
    if (frame.type === EventTypes.agentCreated || frame.type === EventTypes.agentUpdated) {
      const parsed = Agent.safeParse(frame.data);
      if (parsed.success) upsertAgent(qc, parsed.data);
      else void qc.invalidateQueries({ queryKey: botKeys.agents });
    } else if (frame.type === EventTypes.agentDeleted) {
      const id = (frame.data as { id?: string } | null)?.id;
      qc.setQueryData<AgentList>(botKeys.agents, (prev) =>
        prev ? { agents: prev.agents.filter((a) => a.id !== id) } : prev,
      );
    } else if (frame.type === EventTypes.modelProvidersUpdated) {
      void qc.invalidateQueries({ queryKey: botKeys.models });
      void qc.invalidateQueries({ queryKey: botKeys.providers });
    }
  });
}
