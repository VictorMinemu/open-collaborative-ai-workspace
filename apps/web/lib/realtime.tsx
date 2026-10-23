"use client";

import type { RevokedFrame } from "@ocw/contracts";
import {
  aggregatePresence,
  type ConnectionState,
  type ConnectionStatus,
  createActivityMonitor,
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

/** Input events that count as activity (RT-04 away); forwarded at most once per second. */
const ACTIVITY_EVENTS = ["pointerdown", "pointermove", "keydown", "wheel", "touchstart", "focus"] as const;
const ACTIVITY_FORWARD_MS = 1000;

/**
 * Reports this tab's Away/Active state to the client (RT-04, 03-02 D-04): hidden tab → away at once; 5 minutes
 * without input in a visible tab → away; input or showing the tab again → online. Returns the cleanup.
 */
function reportActivity(client: RealtimeClient): () => void {
  const monitor = createActivityMonitor({ onChange: (s) => client.setPresence(s) });
  const onVisibility = () => monitor.visibility(document.visibilityState === "hidden");
  let lastForward = 0;
  const onActivity = () => {
    const now = Date.now();
    if (now - lastForward < ACTIVITY_FORWARD_MS) return;
    lastForward = now;
    monitor.activity();
  };
  onVisibility();
  document.addEventListener("visibilitychange", onVisibility);
  for (const type of ACTIVITY_EVENTS) window.addEventListener(type, onActivity, { passive: true });
  return () => {
    document.removeEventListener("visibilitychange", onVisibility);
    for (const type of ACTIVITY_EVENTS) window.removeEventListener(type, onActivity);
    monitor.dispose();
  };
}

/**
 * Tells the client about the browser's network (`offline` / `online`): offline drops the socket at once (a dead network
 * can keep it "open" for minutes), online reconnects at once and replays from the cursors (07.1-09, D-03). Returns the
 * cleanup.
 */
function followNetwork(client: RealtimeClient): () => void {
  const onOnline = () => client.setNetwork(true);
  const onOffline = () => client.setNetwork(false);
  window.addEventListener("online", onOnline);
  window.addEventListener("offline", onOffline);
  if (!navigator.onLine) client.setNetwork(false);
  return () => {
    window.removeEventListener("online", onOnline);
    window.removeEventListener("offline", onOffline);
  };
}

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
    const stopReporting = reportActivity(c);
    c.connect();
    const stopFollowing = followNetwork(c);
    setClient(c);
    return () => {
      stopFollowing();
      stopReporting();
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
 * shows the conversation: the user counts as "here" and `usePresence(topic)` gets data (RT-04). `opts.onRevoked`
 * runs when the server drops the topic because access was lost (RT-01); like the listener, it may change between
 * renders without re-subscribing.
 */
export function useTopic(
  topic: string | null,
  listener: TopicListener,
  afterSeq?: number,
  onResync?: () => void,
  opts?: { presence?: boolean; onRevoked?: (frame: RevokedFrame) => void },
): void {
  const client = useRealtime();
  const listenerRef = useRef(listener);
  const resyncRef = useRef(onResync);
  const revokedRef = useRef(opts?.onRevoked);
  listenerRef.current = listener;
  resyncRef.current = onResync;
  revokedRef.current = opts?.onRevoked;

  const presence = opts?.presence === true;
  useEffect(() => {
    if (!client || !topic) return;
    return client.subscribe(topic, (frame) => listenerRef.current(frame), {
      ...(afterSeq !== undefined ? { afterSeq } : {}),
      onResync: () => resyncRef.current?.(),
      onRevoked: (frame) => revokedRef.current?.(frame),
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
