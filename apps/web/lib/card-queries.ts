"use client";

import {
  type AgentCard,
  type AgentCardDecisionRequest,
  AgentCard as AgentCardSchema,
  type Message,
  type MessagePage,
  type PinnedMessageList,
  type SavedList,
  type ThreadResponse,
} from "@ocw/contracts";
import { type InfiniteData, type QueryClient, useQuery } from "@tanstack/react-query";
import { mergeCard, shownCard } from "./agent-cards";
import { api } from "./api";
import { chatKeys } from "./chat-queries";

/**
 * Agent Cards for people (06-15, AGENT-04, P-11, P-13). The server decides everything: who may follow or decide
 * (`viewerCan`), whether a decision was taken and by whom. The page keeps one viewer copy per card
 * (`cardKeys.card`): seeded from a REST snapshot, read from `GET /cards/:id` when the card arrived live (realtime
 * carries no viewer fields, P-04), and written by Follow (optimistic, rolled back on error) and by a decision (only
 * once the server confirmed it). Both also patch the card in the cached channel, thread, DM, pins and Saved copies.
 * AI chats hold their messages in their own reducer: their cards read the same viewer copy.
 */

export const cardKeys = {
  card: (messageId: string) => ["chat", "card", messageId] as const,
};

/** Applies `patch` to the card of `messageId` in every cached conversation copy (windows, threads, pins, Saved). */
function patchCachedCard(qc: QueryClient, messageId: string, patch: (card: AgentCard) => AgentCard) {
  const one = (m: Message): Message => (m.id === messageId && m.card ? { ...m, card: patch(m.card) } : m);
  const has = (list: Message[]) => list.some((m) => m.id === messageId && m.card);
  qc.setQueriesData<MessagePage>({ queryKey: chatKeys.allMessages }, (prev) =>
    prev?.messages && has(prev.messages) ? { ...prev, messages: prev.messages.map(one) } : prev,
  );
  qc.setQueriesData<ThreadResponse>({ queryKey: chatKeys.threads }, (prev) =>
    prev?.root && (has([prev.root]) || has(prev.replies))
      ? { ...prev, root: one(prev.root), replies: prev.replies.map(one) }
      : prev,
  );
  qc.setQueriesData<PinnedMessageList>({ queryKey: ["chat", "pins"] }, (prev) =>
    prev?.pins ? { pins: prev.pins.map((p) => ({ ...p, message: one(p.message) })) } : prev,
  );
  qc.setQueriesData<InfiniteData<SavedList>>({ queryKey: chatKeys.saved }, (prev) =>
    prev?.pages
      ? {
          ...prev,
          pages: prev.pages.map((pg) => ({
            ...pg,
            items: pg.items.map((i) => ({ ...i, message: one(i.message) })),
          })),
        }
      : prev,
  );
}

/**
 * The card as this viewer sees it: the conversation's copy (`card`) with the viewer's own copy over it. A card that
 * arrived without viewer fields is read once from `GET /cards/:id`; until then no Follow or Approve is offered.
 */
export function useAgentCard(messageId: string, card: AgentCard): AgentCard {
  const known = card.viewerCan !== undefined;
  const viewer = useQuery({
    queryKey: cardKeys.card(messageId),
    queryFn: ({ signal }) => api.get(`/api/v1/cards/${messageId}`, { schema: AgentCardSchema, signal }),
    enabled: !known,
    ...(known ? { initialData: card } : {}),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 10 * 60_000,
    retry: false,
  });
  return shownCard(card, viewer.data);
}

/** The viewer copy to change: the cached one, else the conversation's copy of the card. */
function viewerCopy(
  qc: QueryClient,
  messageId: string,
  fallback: AgentCard | undefined,
): AgentCard | undefined {
  return qc.getQueryData<AgentCard>(cardKeys.card(messageId)) ?? fallback;
}

/**
 * Follow (`on`) or unfollow a card. Optimistic: the button changes at once and goes back if the server refuses.
 * `current` is the card as shown, used when the page holds no viewer copy yet.
 */
export async function followCard(
  qc: QueryClient,
  messageId: string,
  on: boolean,
  current?: AgentCard,
): Promise<void> {
  const before = viewerCopy(qc, messageId, current);
  const set = (following: boolean) => {
    if (before) {
      qc.setQueryData<AgentCard>(cardKeys.card(messageId), (prev) => ({ ...(prev ?? before), following }));
    }
    patchCachedCard(qc, messageId, (c) => ({ ...c, following }));
  };
  set(on);
  try {
    await (on ? api.post(`/api/v1/cards/${messageId}/follow`) : api.del(`/api/v1/cards/${messageId}/follow`));
  } catch (err) {
    set(before?.following ?? !on);
    throw err;
  }
}

/**
 * Approves or denies a card once. Not optimistic: the card shows the decision only after the server took it (it may
 * refuse: already decided, not an approver, no permission). Returns the decided card as the viewer sees it.
 *
 * A card that mirrors an approval (07.2-17, D-05, UI-SPEC R4) names the action hash it rendered (the server recomputes
 * it and refuses a changed action) and may carry the decider's note; any other card sends `{ outcome }` only, exactly
 * as before.
 */
export async function decideCard(
  qc: QueryClient,
  messageId: string,
  decision: { outcome: "approved" | "denied"; actionHash?: string | undefined; note?: string | undefined },
): Promise<AgentCard> {
  const { outcome, actionHash, note } = decision;
  const body: AgentCardDecisionRequest = actionHash
    ? { outcome, actionHash, ...(note ? { note } : {}) }
    : { outcome };
  const decided = await api.post(`/api/v1/cards/${messageId}/decision`, {
    body,
    schema: AgentCardSchema,
  });
  qc.setQueryData<AgentCard>(cardKeys.card(messageId), decided);
  patchCachedCard(qc, messageId, (c) => mergeCard(c, decided));
  return decided;
}

/** After a refused decision (e.g. someone else decided first): read the card again so the page shows the truth. */
export function refreshCard(qc: QueryClient, messageId: string): Promise<void> {
  return qc
    .fetchQuery({
      queryKey: cardKeys.card(messageId),
      queryFn: () => api.get(`/api/v1/cards/${messageId}`, { schema: AgentCardSchema }),
      staleTime: 0,
    })
    .then((fresh) => patchCachedCard(qc, messageId, (c) => mergeCard(c, fresh)))
    .catch(() => {});
}
