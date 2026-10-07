"use client";

import { AiChatGrant, AiChatGrantList, type CreateAiChatGrantRequest } from "@ocw/contracts";
import { type QueryClient, useQuery } from "@tanstack/react-query";
import { aiKeys } from "./ai-chat-queries";
import { api } from "./api";

/**
 * Sharing an AI chat in place (06-03, MULTI-01, D-03): the owner's grants on one chat. The API decides everything
 * (owner-only, active members only, idempotent per subject, a level change updates the same grant); the dialog only
 * renders its answers.
 */

export const grantKeys = {
  /** The grants of one chat, as its owner sees them. */
  list: (chatId: string) => ["ai", "grants", chatId] as const,
};

export function useAiChatGrants(chatId: string, enabled: boolean) {
  return useQuery({
    queryKey: grantKeys.list(chatId),
    queryFn: ({ signal }) =>
      api.get(`/api/v1/ai-chats/${chatId}/grants`, { schema: AiChatGrantList, signal }),
    enabled,
    staleTime: 10_000,
  });
}

/**
 * Grants `body.subject` access at `body.level`. The answer replaces any grant with the same id in the list (a level
 * change), and the chat is re-read so its `shared` state and roster follow.
 */
export async function createAiChatGrant(
  qc: QueryClient,
  chatId: string,
  body: CreateAiChatGrantRequest,
): Promise<AiChatGrant> {
  const grant = await api.post(`/api/v1/ai-chats/${chatId}/grants`, { body, schema: AiChatGrant });
  qc.setQueryData<AiChatGrantList>(grantKeys.list(chatId), (old) => ({
    grants: [...(old?.grants ?? []).filter((g) => g.id !== grant.id), grant],
  }));
  void qc.invalidateQueries({ queryKey: grantKeys.list(chatId) });
  void qc.invalidateQueries({ queryKey: aiKeys.chat(chatId) });
  return grant;
}
