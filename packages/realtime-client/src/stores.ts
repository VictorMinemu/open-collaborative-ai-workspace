import type { DurableFrame } from "@ocw/contracts";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { RealtimeClient } from "./client";

/**
 * A keyed collection kept in sync with a topic: seed it with a REST snapshot, then apply durable events.
 * Usable from React (`useStore(store, selector)`) and from Node (desktop, daemon, tests).
 */
export interface CollectionState<T> {
  items: Map<string, T>;
  lastSeq: number;
}

export function createCollectionStore<T>(): StoreApi<CollectionState<T>> {
  return createStore<CollectionState<T>>(() => ({ items: new Map(), lastSeq: 0 }));
}

export function bindCollection<T>(
  client: RealtimeClient,
  topic: string,
  store: StoreApi<CollectionState<T>>,
  reducer: (frame: DurableFrame, items: Map<string, T>) => Map<string, T> | undefined,
  opts: { onResync?: () => void } = {},
): () => void {
  return client.subscribe(
    topic,
    (frame) => {
      if (frame.op !== "ev") return;
      const next = reducer(frame, new Map(store.getState().items));
      store.setState({ items: next ?? store.getState().items, lastSeq: frame.seq });
    },
    { afterSeq: store.getState().lastSeq, ...(opts.onResync ? { onResync: opts.onResync } : {}) },
  );
}
