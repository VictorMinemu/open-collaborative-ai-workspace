"use client";

import { AiChatShare, AiChatShareList, AiShareView } from "@ocw/contracts";
import { type QueryClient, useQuery } from "@tanstack/react-query";
import { api, isApiError } from "./api";

/**
 * Read-only snapshot share links of an AI chat (05-13, AICHAT-09). The owner creates and revokes them from the chat
 * header; colleagues signed in to the same organization open `/share/ai/<id>`. Nothing here works signed out: the
 * API answers 401 and the app's guard sends the visitor to sign in.
 */

export const shareKeys = {
  /** The owner's links of one chat. */
  list: (chatId: string) => ["ai", "shares", chatId] as const,
  /** One snapshot as a reader sees it. */
  view: (shareId: string) => ["ai", "share", shareId] as const,
};

/** The full link to paste elsewhere: this web origin + the share's path (no token, the id only). */
export function shareUrl(path: string): string {
  return typeof window === "undefined" ? path : `${window.location.origin}${path}`;
}

export function useAiChatShares(chatId: string, enabled: boolean) {
  return useQuery({
    queryKey: shareKeys.list(chatId),
    queryFn: ({ signal }) =>
      api.get(`/api/v1/ai-chats/${chatId}/shares`, { schema: AiChatShareList, signal }),
    enabled,
    staleTime: 10_000,
  });
}

export async function createAiShare(qc: QueryClient, chatId: string): Promise<AiChatShare> {
  const share = await api.post(`/api/v1/ai-chats/${chatId}/shares`, { body: {}, schema: AiChatShare });
  qc.setQueryData<AiChatShareList>(shareKeys.list(chatId), (old) => ({
    shares: [share, ...(old?.shares ?? []).filter((s) => s.id !== share.id)],
  }));
  return share;
}

/** A snapshot as a signed-in colleague reads it; missing, revoked and other-org links are the same 404. */
export function useAiShare(shareId: string) {
  const q = useQuery({
    queryKey: shareKeys.view(shareId),
    queryFn: ({ signal }) => api.get(`/api/v1/ai-shares/${shareId}`, { schema: AiShareView, signal }),
    retry: (count, err) => !isApiError(err, 404) && count < 2,
    staleTime: 30_000,
  });
  return { ...q, notFound: isApiError(q.error, 404) };
}

/** Revokes one of the owner's links: it reads as not available at once; the list keeps it, marked revoked. */
export async function revokeAiShare(qc: QueryClient, chatId: string, shareId: string): Promise<AiChatShare> {
  const share = await api.del(`/api/v1/ai-shares/${shareId}`, { schema: AiChatShare });
  qc.setQueryData<AiChatShareList>(shareKeys.list(chatId), (old) => ({
    shares: (old?.shares ?? [share]).map((s) => (s.id === share.id ? share : s)),
  }));
  qc.removeQueries({ queryKey: shareKeys.view(shareId) });
  return share;
}
