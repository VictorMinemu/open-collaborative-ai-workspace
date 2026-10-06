"use client";

import { AiChatPolicy, AiUsageToday, type UpdateAiChatPolicyRequest } from "@ocw/contracts";
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { aiKeys } from "./ai-chat-queries";
import { api, isApiError } from "./api";

/**
 * AI chat usage and policy data (05-08, AICHAT-07, D-06): the member's usage today against the organization's daily
 * caps (`GET /me/ai-usage/today`) and the admin AI chat policy (`GET|PUT /ai-chat/policy`, `provider.manage`).
 * 05-09 adds the 30-day reports here.
 */

export const aiUsageKeys = {
  today: ["ai", "usage", "today"] as const,
  policy: ["ai", "policy"] as const,
};

const noRetryOn4xx = (n: number, err: unknown) => !(isApiError(err) && err.status < 500) && n < 2;

/** The member's own counters for today and the caps that apply (refetched after every send). */
export function useAiUsageToday(enabled = true) {
  return useQuery({
    enabled,
    queryKey: aiUsageKeys.today,
    queryFn: ({ signal }) => api.get("/api/v1/me/ai-usage/today", { schema: AiUsageToday, signal }),
    staleTime: 15_000,
    retry: noRetryOn4xx,
  });
}

/** A send was counted (or refused at a cap): today's counters move. */
export function refreshAiUsageToday(qc: QueryClient): void {
  void qc.invalidateQueries({ queryKey: aiUsageKeys.today });
}

export function useAiChatPolicy(enabled = true) {
  return useQuery({
    enabled,
    queryKey: aiUsageKeys.policy,
    queryFn: ({ signal }) => api.get("/api/v1/ai-chat/policy", { schema: AiChatPolicy, signal }),
    retry: noRetryOn4xx,
  });
}

/** Saving the policy changes what members may pick and their caps: the model list and today's view refetch. */
export function useUpdateAiChatPolicy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateAiChatPolicyRequest) =>
      api.put("/api/v1/ai-chat/policy", { body, schema: AiChatPolicy }),
    onSuccess: (policy) => {
      qc.setQueryData(aiUsageKeys.policy, policy);
      void qc.invalidateQueries({ queryKey: aiKeys.models });
      refreshAiUsageToday(qc);
    },
  });
}

/** The cap a model's backend class has reached today, or null (what the composer notice says). */
export type ReachedLimit =
  | { kind: "generations"; backendClass: "org_key" | "chatgpt_plan"; max: number; resetsAt: string }
  | { kind: "cost"; backendClass: "org_key"; max: number; resetsAt: string };

export function reachedLimit(
  today: AiUsageToday | undefined,
  backend: "org_key" | "chatgpt_plan" | "mock",
): ReachedLimit | null {
  if (!today) return null;
  if (backend === "chatgpt_plan") {
    const max = today.limits.planGenerations;
    return max !== null && today.chatgptPlan.generations >= max
      ? { kind: "generations", backendClass: "chatgpt_plan", max, resetsAt: today.resetsAt }
      : null;
  }
  const max = today.limits.orgKeyGenerations;
  if (max !== null && today.orgKey.generations >= max) {
    return { kind: "generations", backendClass: "org_key", max, resetsAt: today.resetsAt };
  }
  const cost = today.limits.orgKeyCostMicros;
  if (cost !== null && today.orgKey.costMicrosUsd >= cost) {
    return { kind: "cost", backendClass: "org_key", max: cost, resetsAt: today.resetsAt };
  }
  return null;
}

/**
 * Answers left today on organization models when the cap is close (at most a fifth of it, or 1), else null: the
 * quiet line under the composer (members see their usage against the cap before they reach it).
 */
export function orgAnswersLeft(today: AiUsageToday | undefined): { left: number; max: number } | null {
  const max = today?.limits.orgKeyGenerations ?? null;
  if (!today || max === null) return null;
  const left = Math.max(0, max - today.orgKey.generations);
  return left > 0 && left <= Math.max(1, Math.ceil(max / 5)) ? { left, max } : null;
}
