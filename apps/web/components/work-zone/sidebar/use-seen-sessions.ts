"use client";

import { useSyncExternalStore } from "react";
import type { SeenMap } from "./model";

/**
 * When this browser last opened each Work Zone session (Phase 07.10-04, UI-SPEC § 3, R10, PD-09): the seen map behind
 * "Your turn". One map `{ [sessionId]: isoTime }` in localStorage, written by the session view's data hook on open and
 * at each turn end (`markSeen`), read by the sidebar (`useSeenSessions`). It holds session ids and times only, never a
 * title; it is pruned to 7 days and 300 entries on every write and never leaves the browser. Other tabs follow through
 * the `storage` event. Corrupt JSON reads as empty; a storage that refuses reads or writes keeps a map for this page.
 */

export const SEEN_STORAGE_KEY = "ocw.workzone.seen.v1";
export const SEEN_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const SEEN_MAX_ENTRIES = 300;

const EMPTY: SeenMap = Object.freeze({});

/** The stored map, keeping only values that are times; anything else reads as never seen. */
export function parseSeenMap(raw: string | null): SeenMap {
  if (!raw) return EMPTY;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return EMPTY;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(value)) {
      if (typeof v === "string" && Number.isFinite(Date.parse(v))) out[k] = v;
    }
    return out;
  } catch {
    return EMPTY;
  }
}

/** Drops entries older than 7 days, then keeps the 300 most recent. */
export function pruneSeenMap(map: SeenMap, now: number): SeenMap {
  const fresh = Object.entries(map)
    .map(([k, v]) => [k, v, Date.parse(v)] as const)
    .filter(([, , t]) => now - t <= SEEN_MAX_AGE_MS)
    .sort((a, b) => b[2] - a[2])
    .slice(0, SEEN_MAX_ENTRIES);
  return Object.fromEntries(fresh.map(([k, v]) => [k, v]));
}

/** The part of `Storage` the store uses. */
export type SeenStorage = Pick<Storage, "getItem" | "setItem">;

/** Another tab wrote `key` (null: storage cleared): the `storage` event, reduced to what the store needs. */
export type SeenListen = (onChange: (key: string | null, value: string | null) => void) => () => void;

export interface SeenStore {
  /** The current map; the same object until something changes (a `useSyncExternalStore` snapshot). */
  read(): SeenMap;
  /** Records that the session was seen at `at` (default now); a time never moves backwards. */
  markSeen(sessionId: string, at?: number): void;
  subscribe(onChange: () => void): () => void;
}

export function createSeenStore(
  storage: () => SeenStorage | null,
  listen: SeenListen,
  clock: () => number = Date.now,
): SeenStore {
  let cache: SeenMap | undefined;
  const subscribers = new Set<() => void>();
  let unlisten: (() => void) | null = null;
  const notify = () => {
    for (const fn of subscribers) fn();
  };
  const read = (): SeenMap => {
    if (cache === undefined) {
      try {
        cache = parseSeenMap(storage()?.getItem(SEEN_STORAGE_KEY) ?? null);
      } catch {
        cache = EMPTY;
      }
    }
    return cache;
  };
  return {
    read,
    markSeen(sessionId, at) {
      const prev = read();
      const before = prev[sessionId] ? Date.parse(prev[sessionId]) : Number.NEGATIVE_INFINITY;
      const when = Math.max(at ?? clock(), before);
      cache = pruneSeenMap({ ...prev, [sessionId]: new Date(when).toISOString() }, clock());
      try {
        storage()?.setItem(SEEN_STORAGE_KEY, JSON.stringify(cache));
      } catch {
        // Private mode or quota: the map still applies on this page.
      }
      notify();
    },
    subscribe(onChange) {
      subscribers.add(onChange);
      unlisten ??= listen((key, value) => {
        if (key !== null && key !== SEEN_STORAGE_KEY) return;
        cache = parseSeenMap(value);
        notify();
      });
      return () => {
        subscribers.delete(onChange);
        if (subscribers.size === 0 && unlisten) {
          unlisten();
          unlisten = null;
        }
      };
    },
  };
}

function browserStorage(): SeenStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

const listenWindow: SeenListen = (onChange) => {
  if (typeof window === "undefined") return () => {};
  const handler = (e: StorageEvent) => onChange(e.key, e.newValue);
  window.addEventListener("storage", handler);
  return () => window.removeEventListener("storage", handler);
};

const store = createSeenStore(browserStorage, listenWindow);

/** The session view saw `sessionId` (on open, at each turn end), at `at` or now. Local only, never sent. */
export function markSeen(sessionId: string, at?: number): void {
  store.markSeen(sessionId, at);
}

const serverSnapshot = () => EMPTY;

/** The seen map, live across this tab and the others. Empty on the server and before hydration. */
export function useSeenSessions(): SeenMap {
  return useSyncExternalStore(store.subscribe, store.read, serverSnapshot);
}
