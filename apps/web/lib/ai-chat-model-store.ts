"use client";

import { type ModelRef, modelRefKey } from "@ocw/contracts";
import { useCallback } from "react";
import { create } from "zustand";

/**
 * The model the member picked for each AI chat (AICHAT-02: per message, per chat). Keyed by chat id, or "new" for
 * `/chat/ai/new` (handed over to the created chat on the first send). Nothing here is persisted: on a reload the
 * chat's `lastModel` (server) is the default again, which is what the member last used there.
 */
interface ModelStore {
  byChat: Record<string, ModelRef>;
  set(chatKey: string, ref: ModelRef): void;
}

const useStore = create<ModelStore>((set) => ({
  byChat: {},
  set: (chatKey, ref) =>
    set((s) => {
      const current = s.byChat[chatKey];
      if (current && modelRefKey(current) === modelRefKey(ref)) return s;
      return { byChat: { ...s.byChat, [chatKey]: ref } };
    }),
}));

/** The chat's selected model (or `fallback` until the member picks one) and its setter. */
export function useAiChatModel(
  chatKey: string,
  fallback: ModelRef | null,
): [ModelRef | null, (ref: ModelRef) => void] {
  const picked = useStore((s) => s.byChat[chatKey]);
  const setRef = useStore((s) => s.set);
  const set = useCallback((ref: ModelRef) => setRef(chatKey, ref), [chatKey, setRef]);
  return [picked ?? fallback, set];
}

/** Selects `ref` for a chat from outside the composer (e.g. 05-07's "Use an organization model"). */
export function setAiChatModel(chatKey: string, ref: ModelRef): void {
  useStore.getState().set(chatKey, ref);
}

/**
 * Forgets a chat's selection. `/chat/ai/new` clears it once its first send created the chat (that chat's `lastModel`
 * carries the choice), so the next New chat starts from the member's default again.
 */
export function clearAiChatModel(chatKey: string): void {
  const { byChat } = useStore.getState();
  if (!(chatKey in byChat)) return;
  const next = { ...byChat };
  delete next[chatKey];
  useStore.setState({ byChat: next });
}
