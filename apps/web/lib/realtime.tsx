"use client";

import {
  aggregatePresence,
  type ConnectionState,
  type ConnectionStatus,
  type PresenceSnapshot,
  type PresentUser,
  RealtimeClient,
  type TopicListener,
} from "@ocw/realtime-client";
import { createContext, type ReactNode, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { clearAccessToken, getAccessToken } from "./auth-token";
import { useRuntimeConfig } from "./config";
import { useMe } from "./queries";

const RealtimeContext = createContext<RealtimeClient | null>(null);

/**
 * One RealtimeClient (one WebSocket) per signed-in browser tab. Created when `/me` resolves, closed on
 * sign-out or when the session (sessionId) changes. The socket authenticates with a short-lived access JWT
 * fetched before every (re)connect (AUTH-06); the cached token is dropped with the client.
 */
export function RealtimeProvider({ children }: { children: ReactNode }) {
  const { wsUrl } = useRuntimeConfig();
  // Observe only: the (app) guard is the one that fetches /me.
  const me = useMe({ enabled: false });
  const sessionId = me.data?.sessionId ?? null;
  const [client, setClient] = useState<RealtimeClient | null>(null);

  useEffect(() => {
    if (!sessionId) return;
    const c = new RealtimeClient({ url: wsUrl, getToken: (o) => getAccessToken(o) });
    c.connect();
    setClient(c);
    return () => {
      c.close();
      clearAccessToken();
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
 * re-subscribing. Pass `topic = null` to skip (e.g. while ids are loading). `opts.presence` marks the view that
 * shows the conversation: the user counts as "here" and `usePresence(topic)` gets data (RT-04).
 */
export function useTopic(
  topic: string | null,
  listener: TopicListener,
  afterSeq?: number,
  onResync?: () => void,
  opts?: { presence?: boolean },
): void {
  const client = useRealtime();
  const listenerRef = useRef(listener);
  const resyncRef = useRef(onResync);
  listenerRef.current = listener;
  resyncRef.current = onResync;

  const presence = opts?.presence === true;
  useEffect(() => {
    if (!client || !topic) return;
    return client.subscribe(topic, (frame) => listenerRef.current(frame), {
      ...(afterSeq !== undefined ? { afterSeq } : {}),
      onResync: () => resyncRef.current?.(),
      ...(presence ? { presence } : {}),
    });
  }, [client, topic, afterSeq, presence]);
}

/** Stand-in store used while there is no client, so the hook order stays stable. */
const idleStore = createStore<ConnectionState>(() => ({ status: "idle", attempt: 0, lastError: null }));

export function useRealtimeStatus(): ConnectionStatus {
  const client = useRealtime();
  return useStore(client?.status ?? idleStore, (s) => s.status);
}

const idlePresence = createStore<PresenceSnapshot>(() => ({ topics: {} }));

/**
 * Who is here now in a `conv:`/`ws:` topic (RT-04), one entry per user (online beats away, online first). The
 * topic must also be subscribed with `useTopic(…, { presence: true })` for the server to send its presence. The selector returns the
 * store's own per-topic object (never a new array: zustand v5 would re-render forever); aggregation is memoised.
 */
export function usePresence(topic: string | null): PresentUser[] {
  const client = useRealtime();
  const conns = useStore(client?.presence ?? idlePresence, (s) => (topic ? s.topics[topic] : undefined));
  return useMemo(() => aggregatePresence(conns), [conns]);
}
