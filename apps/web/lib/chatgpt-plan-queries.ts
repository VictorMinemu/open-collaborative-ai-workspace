"use client";

import {
  type ChatgptPlanStatus,
  ChatgptPlanStatus as ChatgptPlanStatusSchema,
  type ChatgptSignInCompleteRequest,
  ChatgptSignInStartResponse,
} from "@ocw/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { aiKeys } from "./ai-chat-queries";
import { api, isApiError } from "./api";

/**
 * The member's own ChatGPT plan sign-in (D-02, 05-05). The browser only ever sees the authorize URL and a flow id;
 * the pasted loopback address goes to the API in a POST body, which exchanges the code and keeps every token.
 */

export const chatgptPlanKeys = { status: ["ai", "chatgpt-plan"] as const };

const PATH = "/api/v1/me/model-credentials/chatgpt";

export function useChatgptPlan() {
  return useQuery({
    queryKey: chatgptPlanKeys.status,
    queryFn: ({ signal }) => api.get(PATH, { schema: ChatgptPlanStatusSchema, signal }),
    retry: (n, err) => !(isApiError(err) && err.status >= 400 && err.status < 500) && n < 1,
  });
}

/** After any change the card and the AI chat model picker re-read the member's plan state. */
function useApplyStatus() {
  const qc = useQueryClient();
  return (status: ChatgptPlanStatus) => {
    qc.setQueryData(chatgptPlanKeys.status, status);
    void qc.invalidateQueries({ queryKey: aiKeys.models });
  };
}

export function useStartChatgptSignIn() {
  return useMutation({
    mutationFn: (body: { redirectPort?: number } = {}) =>
      api.post(`${PATH}/start`, { body, schema: ChatgptSignInStartResponse }),
  });
}

export function useCompleteChatgptSignIn() {
  const apply = useApplyStatus();
  return useMutation({
    mutationFn: (body: ChatgptSignInCompleteRequest) =>
      api.post(`${PATH}/complete`, { body, schema: ChatgptPlanStatusSchema }),
    onSuccess: apply,
  });
}

export function useDisconnectChatgpt() {
  const apply = useApplyStatus();
  return useMutation({
    mutationFn: () => api.del(PATH, { schema: ChatgptPlanStatusSchema }),
    onSuccess: apply,
  });
}
