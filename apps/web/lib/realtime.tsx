"use client";

import {
  type ConnectionState,
  type ConnectionStatus,
  RealtimeClient,
  type TopicListener,
} from "@ocw/realtime-client";
import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { useRuntimeConfig } from "./config";
import { useMe } from "./queries";

const RealtimeContext = createContext<RealtimeClient | null>(null);

/**
 * One RealtimeClient (one WebSocket) per signed-in browser tab. Created when `/me` resolves, closed on
 * sign-out or when the session (sessionId) changes.
 */
export function RealtimeProvider({ children }: { children: ReactNode }) {
  const { wsUrl } = useRuntimeConfig();
  // Observe only: the (app) guard is the one that fetches /me.
  const me = useMe({ enabled: false });
  const sessionId = me.data?.sessionId ?? null;
  const [client, setClient] = useState<RealtimeClient | null>(null);

  useEffect(() => {
    if (!sessionId) return;
    const c = new RealtimeClient({ url: wsUrl });
    c.connect();
    setClient(c);
    return () => {
      c.close();
      setClient(null);
    };
  }, [sessionId, wsUrl]);

  return <RealtimeContext.Provider value={client}>{children}</RealtimeContext.Provider>;
}

/** The live client, or null while signed out / before `/me` resolves. */
export function useRealtime(): RealtimeClient | null {
  return useContext(RealtimeContext);
}

/**
 * Subscribe to a topic for the lifetime of the component. The listener can change between renders without
 * re-subscribing. Pass `topic = null` to skip (e.g. while ids are loading).
 */
export function useTopic(
  topic: string | null,
  listener: TopicListener,
  afterSeq?: number,
  onResync?: () => void,
): void {
  const client = useRealtime();
  const listenerRef = useRef(listener);
  const resyncRef = useRef(onResync);
  listenerRef.current = listener;
  resyncRef.current = onResync;

  useEffect(() => {
    if (!client || !topic) return;
    return client.subscribe(topic, (frame) => listenerRef.current(frame), {
      ...(afterSeq !== undefined ? { afterSeq } : {}),
      onResync: () => resyncRef.current?.(),
    });
  }, [client, topic, afterSeq]);
}

/** Stand-in store used while there is no client, so the hook order stays stable. */
const idleStore = createStore<ConnectionState>(() => ({ status: "idle", attempt: 0, lastError: null }));

export function useRealtimeStatus(): ConnectionStatus {
  const client = useRealtime();
  return useStore(client?.status ?? idleStore, (s) => s.status);
}
