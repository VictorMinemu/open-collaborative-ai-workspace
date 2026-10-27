import { describe, expect, it, vi } from "vitest";
import {
  createSeenStore,
  parseSeenMap,
  pruneSeenMap,
  SEEN_MAX_AGE_MS,
  SEEN_MAX_ENTRIES,
  SEEN_STORAGE_KEY,
} from "./use-seen-sessions";

/**
 * The per-browser seen map behind "Your turn" (07.10-04, UI-SPEC § 3, R10, PD-09): when this browser last opened each
 * session, as session ids and ISO times only, pruned to 7 days and 300 entries, never sent anywhere.
 */

const NOW = Date.parse("2026-10-27T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const iso = (ms: number) => new Date(ms).toISOString();
const id = (n: number) => `01a11635-d6e7-7c87-9f17-${String(n).padStart(12, "0")}`;

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => {
      data.set(k, v);
    },
  };
}

/** A fake `storage` event source: `fire(key, value)` plays another tab's write. */
function events() {
  const handlers = new Set<(key: string | null, value: string | null) => void>();
  return {
    listen: (h: (key: string | null, value: string | null) => void) => {
      handlers.add(h);
      return () => handlers.delete(h);
    },
    fire: (key: string | null, value: string | null) => {
      for (const h of handlers) h(key, value);
    },
    count: () => handlers.size,
  };
}

describe("the seen map", () => {
  it("lives in one versioned localStorage key", () => {
    expect(SEEN_STORAGE_KEY).toBe("ocw.workzone.seen.v1");
    expect(SEEN_MAX_AGE_MS).toBe(7 * DAY);
    expect(SEEN_MAX_ENTRIES).toBe(300);
  });

  it("reads ids to ISO times; corrupt JSON or foreign values read as empty", () => {
    expect(parseSeenMap(null)).toEqual({});
    expect(parseSeenMap("{not json")).toEqual({});
    expect(parseSeenMap("[1,2]")).toEqual({});
    expect(parseSeenMap(JSON.stringify({ a: iso(NOW), b: 3, c: "yesterday", d: null }))).toEqual({
      a: iso(NOW),
    });
  });

  it("prunes entries older than 7 days and keeps the 300 newest", () => {
    const old = { [id(1)]: iso(NOW - 8 * DAY), [id(2)]: iso(NOW - 6 * DAY) };
    expect(pruneSeenMap(old, NOW)).toEqual({ [id(2)]: iso(NOW - 6 * DAY) });
    const many: Record<string, string> = {};
    for (let i = 0; i < 320; i++) many[id(i)] = iso(NOW - i * 1000);
    const kept = pruneSeenMap(many, NOW);
    expect(Object.keys(kept)).toHaveLength(300);
    expect(kept[id(0)]).toBe(iso(NOW));
    expect(kept[id(299)]).toBeDefined();
    expect(kept[id(300)]).toBeUndefined();
  });
});

describe("createSeenStore", () => {
  it("markSeen writes { id: time } to the key, pruned, and notifies this tab's subscribers", () => {
    const storage = memoryStorage({
      [SEEN_STORAGE_KEY]: JSON.stringify({ [id(9)]: iso(NOW - 10 * DAY) }),
    });
    const ev = events();
    const store = createSeenStore(
      () => storage,
      ev.listen,
      () => NOW,
    );
    const seen = vi.fn();
    const off = store.subscribe(seen);
    store.markSeen(id(1));
    expect(JSON.parse(storage.data.get(SEEN_STORAGE_KEY) ?? "")).toEqual({ [id(1)]: iso(NOW) });
    expect(store.read()).toEqual({ [id(1)]: iso(NOW) });
    expect(seen).toHaveBeenCalledTimes(1);
    off();
    expect(ev.count()).toBe(0);
  });

  it("holds ids and times only, and never moves a time backwards", () => {
    const storage = memoryStorage();
    const store = createSeenStore(
      () => storage,
      events().listen,
      () => NOW,
    );
    store.markSeen(id(1), NOW + 5_000);
    store.markSeen(id(1), NOW);
    expect(store.read()).toEqual({ [id(1)]: iso(NOW + 5_000) });
    const raw = storage.data.get(SEEN_STORAGE_KEY) ?? "";
    expect(Object.values(JSON.parse(raw))).toEqual([iso(NOW + 5_000)]);
  });

  it("returns the same snapshot until something changes (useSyncExternalStore)", () => {
    const store = createSeenStore(
      () => memoryStorage(),
      events().listen,
      () => NOW,
    );
    expect(store.read()).toBe(store.read());
    const before = store.read();
    store.markSeen(id(1));
    expect(store.read()).not.toBe(before);
  });

  it("follows another tab through the storage event, and ignores other keys", () => {
    const ev = events();
    const store = createSeenStore(
      () => memoryStorage(),
      ev.listen,
      () => NOW,
    );
    const seen = vi.fn();
    store.subscribe(seen);
    ev.fire("ocw.workzone.sidebar.v1", "{}");
    expect(seen).not.toHaveBeenCalled();
    ev.fire(SEEN_STORAGE_KEY, JSON.stringify({ [id(2)]: iso(NOW) }));
    expect(store.read()).toEqual({ [id(2)]: iso(NOW) });
    expect(seen).toHaveBeenCalledTimes(1);
    // localStorage.clear() in another tab: key null.
    ev.fire(null, null);
    expect(store.read()).toEqual({});
  });

  it("a failing storage keeps an in-memory map for this page", () => {
    const broken = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    const store = createSeenStore(
      () => broken,
      events().listen,
      () => NOW,
    );
    expect(store.read()).toEqual({});
    store.markSeen(id(1));
    expect(store.read()).toEqual({ [id(1)]: iso(NOW) });
    const none = createSeenStore(
      () => null,
      events().listen,
      () => NOW,
    );
    none.markSeen(id(2));
    expect(none.read()).toEqual({ [id(2)]: iso(NOW) });
  });
});
