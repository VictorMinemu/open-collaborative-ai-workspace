"use client";

import {
  AiChatGrant,
  AiChatGrantList,
  type AiChatParticipants,
  AiParticipant,
  type CreateAiChatGrantRequest,
  type UpdateAiChatGrantRequest,
} from "@ocw/contracts";
import type { QueryClient, UseQueryResult } from "@tanstack/react-query";
import { useQuery } from "@tanstack/react-query";
import { aiKeys, useAiParticipants } from "./ai-chat-queries";
import { api } from "./api";

/**
 * Sharing an AI chat in place (06-03, 06-12; MULTI-01, D-03): the owner's grants on one chat, and who takes part in it
 * (people and agents). The API decides everything (owner-only, active members only, idempotent per subject, a level
 * change updates the same grant, agents only the owner may `bot.read`); the UI only renders its answers.
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

/** After any access change: the grants, the people, the chat (its `shared` state and roster) and the lists follow. */
function accessChanged(qc: QueryClient, chatId: string): void {
  void qc.invalidateQueries({ queryKey: grantKeys.list(chatId) });
  void qc.invalidateQueries({ queryKey: aiKeys.participants(chatId) });
  void qc.invalidateQueries({ queryKey: aiKeys.chat(chatId) });
  void qc.invalidateQueries({ queryKey: aiKeys.list(false) });
}

/** Puts one grant into the cached list (replacing the same id), or removes it when `remove` is set. */
function patchGrants(
  qc: QueryClient,
  chatId: string,
  grant: AiChatGrant | { id: string },
  remove = false,
): void {
  qc.setQueryData<AiChatGrantList>(grantKeys.list(chatId), (old) => {
    if (!old) return old;
    const rest = old.grants.filter((g) => g.id !== grant.id);
    return { grants: remove ? rest : [...rest, grant as AiChatGrant] };
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
  if (!qc.getQueryData(grantKeys.list(chatId))) {
    qc.setQueryData<AiChatGrantList>(grantKeys.list(chatId), { grants: [grant] });
  } else {
    patchGrants(qc, chatId, grant);
  }
  accessChanged(qc, chatId);
  return grant;
}

/** Changes the level of one grant (06-12): the list shows the answer at once. */
export async function updateAiChatGrant(
  qc: QueryClient,
  chatId: string,
  grantId: string,
  body: UpdateAiChatGrantRequest,
): Promise<AiChatGrant> {
  const grant = await api.patch(`/api/v1/ai-chats/${chatId}/grants/${grantId}`, {
    body,
    schema: AiChatGrant,
  });
  patchGrants(qc, chatId, grant);
  accessChanged(qc, chatId);
  return grant;
}

/** Removes one grant (06-12): whoever it covered loses the chat at once (their stream is closed by the server). */
export async function revokeAiChatGrant(qc: QueryClient, chatId: string, grantId: string): Promise<void> {
  await api.del(`/api/v1/ai-chats/${chatId}/grants/${grantId}`);
  patchGrants(qc, chatId, { id: grantId }, true);
  accessChanged(qc, chatId);
}

/**
 * Who takes part in a chat (06-10, 06-12; `channel.read`): the owner, the people who can read it (also those a team or
 * the organization covers who never opened it), its agents, and how wide the audience is. The same query (and cache)
 * as the composer's @ suggestions.
 */
export function useAiChatParticipants(chatId: string, enabled: boolean): UseQueryResult<AiChatParticipants> {
  return useAiParticipants(chatId, enabled);
}

/** Adds an agent persona to the chat (06-10 route, owner only). 200 when it was already there. */
export async function addAiChatAgent(
  qc: QueryClient,
  chatId: string,
  agentId: string,
): Promise<AiParticipant> {
  const added = await api.post(`/api/v1/ai-chats/${chatId}/agents`, {
    body: { agentId },
    schema: AiParticipant,
  });
  accessChanged(qc, chatId);
  return added;
}

/** Removes an agent persona from the chat (owner only). */
export async function removeAiChatAgent(qc: QueryClient, chatId: string, agentId: string): Promise<void> {
  await api.del(`/api/v1/ai-chats/${chatId}/agents/${agentId}`);
  qc.setQueryData<AiChatParticipants>(aiKeys.participants(chatId), (old) =>
    old
      ? { ...old, participants: old.participants.filter((p) => !(p.kind === "agent" && p.id === agentId)) }
      : old,
  );
  accessChanged(qc, chatId);
}
