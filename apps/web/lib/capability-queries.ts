"use client";

import {
  Agent,
  BotCapabilityView,
  BotGovernanceList,
  BotPolicyView,
  type MemoryItem,
  MemoryList,
  Ok,
  type UpdateBotCapabilitiesRequest,
  type UpdateBotPolicyRequest,
} from "@ocw/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, isApiError } from "./api";

/**
 * Bot capabilities, the organization bot policy and personal-bot governance (03.1-03 routes). The web only
 * renders what the API decided (`effective`, `reason`, `viewerCan`); it never re-implements the policy.
 */
export const capabilityKeys = {
  all: ["bot-capabilities"] as const,
  bot: (id: string) => ["bot-capabilities", id] as const,
  policy: ["bot-policy"] as const,
  governance: ["bot-governance"] as const,
  memories: (id: string) => ["bot-memories", id] as const,
};

function noRetryOn4xx(failureCount: number, err: unknown): boolean {
  if (isApiError(err) && err.status >= 400 && err.status < 500) return false;
  return failureCount < 1;
}

/** The bot's toggles, what is effective for the caller (with reasons), its tools and today's usage. */
export function useBotCapabilities(agentId: string | null) {
  return useQuery({
    enabled: !!agentId,
    queryKey: capabilityKeys.bot(agentId ?? ""),
    queryFn: ({ signal }) =>
      api.get(`/api/v1/agents/${agentId}/capabilities`, { schema: BotCapabilityView, signal }),
    retry: noRetryOn4xx,
  });
}

/**
 * Optimistic: the toggles flip at once, roll back on error, and the server's view (with its reasons) replaces
 * them on success.
 */
export function useUpdateBotCapabilities(agentId: string) {
  const qc = useQueryClient();
  const key = capabilityKeys.bot(agentId);
  return useMutation({
    mutationFn: (body: UpdateBotCapabilitiesRequest) =>
      api.patch(`/api/v1/agents/${agentId}/capabilities`, { body, schema: BotCapabilityView }),
    onMutate: async (body) => {
      await qc.cancelQueries({ queryKey: key });
      const previous = qc.getQueryData<BotCapabilityView>(key);
      if (previous) {
        const { tools: _tools, ...toggles } = body;
        qc.setQueryData<BotCapabilityView>(key, {
          ...previous,
          capabilities: { ...previous.capabilities, ...toggles },
        });
      }
      return { previous };
    },
    onError: (_err, _body, ctx) => {
      if (ctx?.previous) qc.setQueryData(key, ctx.previous);
    },
    onSuccess: (view) => {
      qc.setQueryData(key, view);
      void qc.invalidateQueries({ queryKey: capabilityKeys.governance });
    },
  });
}

export function useBotPolicy(enabled = true) {
  return useQuery({
    enabled,
    queryKey: capabilityKeys.policy,
    queryFn: ({ signal }) => api.get("/api/v1/bot-policy", { schema: BotPolicyView, signal }),
    retry: noRetryOn4xx,
  });
}

/** A policy change re-decides every bot: every capability view and the governance list refetch. */
export function useUpdateBotPolicy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateBotPolicyRequest) =>
      api.put("/api/v1/bot-policy", { body, schema: BotPolicyView }),
    onSuccess: (policy) => {
      qc.setQueryData(capabilityKeys.policy, policy);
      void qc.invalidateQueries({ queryKey: capabilityKeys.all });
      void qc.invalidateQueries({ queryKey: capabilityKeys.governance });
    },
  });
}

/** Personal bots of every member: metadata and usage only (never instructions, chats or memory). */
export function useBotGovernance(enabled = true) {
  return useQuery({
    enabled,
    queryKey: capabilityKeys.governance,
    queryFn: ({ signal }) => api.get("/api/v1/bot-governance", { schema: BotGovernanceList, signal }),
    retry: noRetryOn4xx,
  });
}

/**
 * Governance actions on someone else's personal bot (03.1-02 routes): switch it off / on or delete it. Never
 * touches the caller's own bots cache: the admin does not "have" these bots, the governance list refetches.
 */
export function useGovernBot() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (action: { id: string; kind: "disable" | "enable" | "delete" }): Promise<void> => {
      if (action.kind === "delete") await api.del(`/api/v1/agents/${action.id}`, { schema: Ok });
      else {
        await api.patch(`/api/v1/agents/${action.id}`, {
          body: { enabled: action.kind === "enable" },
          schema: Agent,
        });
      }
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: capabilityKeys.governance }),
  });
}

/** What this bot remembers about the caller (D-10): always the caller's own notes, newest first. */
export function useBotMemories(agentId: string | null) {
  return useQuery({
    enabled: !!agentId,
    queryKey: capabilityKeys.memories(agentId ?? ""),
    queryFn: ({ signal }) => api.get(`/api/v1/agents/${agentId}/memories`, { schema: MemoryList, signal }),
    retry: noRetryOn4xx,
  });
}

/**
 * Forget one note (`memoryId`) or all of them. Optimistic: the note leaves the list at once and comes back
 * if the API refuses; the list refetches either way.
 */
export function useClearBotMemory(agentId: string) {
  const qc = useQueryClient();
  const key = capabilityKeys.memories(agentId);
  return useMutation({
    mutationFn: async (memoryId?: string) => {
      const path = memoryId
        ? `/api/v1/agents/${agentId}/memories/${memoryId}`
        : `/api/v1/agents/${agentId}/memories`;
      await api.del(path, { schema: Ok });
    },
    onMutate: async (memoryId) => {
      await qc.cancelQueries({ queryKey: key });
      const previous = qc.getQueryData<MemoryList>(key);
      if (previous) {
        const items: MemoryItem[] = memoryId ? previous.items.filter((i) => i.id !== memoryId) : [];
        qc.setQueryData<MemoryList>(key, { items });
      }
      return { previous };
    },
    onError: (_err, _id, ctx) => {
      if (ctx?.previous) qc.setQueryData(key, ctx.previous);
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: key }),
  });
}
