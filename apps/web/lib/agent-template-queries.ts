"use client";

import {
  Agent,
  AgentTemplate,
  AgentTemplateLink,
  AgentTemplateList,
  AgentTemplateOptions,
  AgentTemplatePreview,
  type CreateAgentTemplateRequest,
  type InstantiateAgentTemplateRequest,
  InstantiateAgentTemplateResponse,
  type PublishAgentTemplateVersionRequest,
  type UpdateAgentTemplateRequest,
} from "@ocw/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, isApiError } from "./api";
import { botKeys } from "./bots-queries";

/**
 * Agent templates (07.4-08, D-05): the Bots page lists the templates the caller may see, previews what their own
 * agent would get, starts one, and (owners only) reviews and applies a newer version of their agent's template.
 */
/** The short tool name shown to people (`<safe>__read_invoice` → `read_invoice`). */
export const shortTool = (name: string) => name.split("__").pop() ?? name;

export const agentTemplateKeys = {
  list: ["agent-templates"] as const,
  preview: (id: string) => ["agent-templates", "preview", id] as const,
  options: (unitId: string | null) => ["agent-templates", "options", unitId ?? "org"] as const,
  link: (agentId: string) => ["agent-template-link", agentId] as const,
};

function noRetryOn4xx(failureCount: number, err: unknown): boolean {
  if (isApiError(err) && err.status >= 400 && err.status < 500) return false;
  return failureCount < 1;
}

export function useAgentTemplates() {
  return useQuery({
    queryKey: agentTemplateKeys.list,
    queryFn: ({ signal }) => api.get("/api/v1/agent-templates", { schema: AgentTemplateList, signal }),
    retry: noRetryOn4xx,
  });
}

/** What the caller's agent would get from the template's current version (skips, connectors, the cap). */
export function useTemplatePreview(id: string | null) {
  return useQuery({
    enabled: !!id,
    queryKey: agentTemplateKeys.preview(id ?? ""),
    queryFn: ({ signal }) =>
      api.get(`/api/v1/agent-templates/${id}/preview`, { schema: AgentTemplatePreview, signal }),
    retry: noRetryOn4xx,
    staleTime: 0,
  });
}

/** The editor's choices for one unit (`null` = an organization template). */
export function useTemplateOptions(unitId: string | null, enabled: boolean) {
  return useQuery({
    enabled,
    queryKey: agentTemplateKeys.options(unitId),
    queryFn: ({ signal }) =>
      api.get(`/api/v1/agent-templates/options${unitId ? `?unitId=${unitId}` : ""}`, {
        schema: AgentTemplateOptions,
        signal,
      }),
    retry: noRetryOn4xx,
  });
}

export function useInstantiateTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: InstantiateAgentTemplateRequest }) =>
      api.post(`/api/v1/agent-templates/${id}/instantiate`, {
        body,
        schema: InstantiateAgentTemplateResponse,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: botKeys.agents });
      void qc.invalidateQueries({ queryKey: ["chat", "dms"] });
      void qc.invalidateQueries({ queryKey: ["chat", "agents"] });
      void qc.invalidateQueries({ queryKey: agentTemplateKeys.list });
    },
  });
}

export function useCreateTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateAgentTemplateRequest) =>
      api.post("/api/v1/agent-templates", { body, schema: AgentTemplate }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: agentTemplateKeys.list }),
  });
}

export function usePublishTemplateVersion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: PublishAgentTemplateVersionRequest }) =>
      api.post(`/api/v1/agent-templates/${id}/versions`, { body, schema: AgentTemplate }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: agentTemplateKeys.list });
      void qc.invalidateQueries({ queryKey: ["agent-template-link"] });
    },
  });
}

export function useUpdateTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdateAgentTemplateRequest }) =>
      api.patch(`/api/v1/agent-templates/${id}`, { body, schema: AgentTemplate }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: agentTemplateKeys.list }),
  });
}

/**
 * The template an agent was started from (owner only). `null` when the bot has no template, or the caller is not its
 * owner (the API answers 404 to both, so nobody learns more).
 */
export function useAgentTemplateLink(agentId: string | null, enabled: boolean) {
  return useQuery({
    enabled: !!agentId && enabled,
    queryKey: agentTemplateKeys.link(agentId ?? ""),
    queryFn: async ({ signal }) => {
      try {
        return await api.get(`/api/v1/agents/${agentId}/template`, { schema: AgentTemplateLink, signal });
      } catch (err) {
        if (isApiError(err, 404)) return null;
        throw err;
      }
    },
    retry: noRetryOn4xx,
  });
}

export function useApplyTemplateUpdate(agentId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (toVersion: number) =>
      api.post(`/api/v1/agents/${agentId}/template/apply`, { body: { toVersion }, schema: Agent }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: agentTemplateKeys.link(agentId) });
      void qc.invalidateQueries({ queryKey: botKeys.agents });
      void qc.invalidateQueries({ queryKey: ["bot-capabilities", agentId] });
    },
  });
}
