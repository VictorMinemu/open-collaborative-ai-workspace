import type { PresenceFrame } from "@ocw/contracts";

/** One live connection of a user in a topic (D-03). */
export interface PresenceMember {
  userId: string;
  state: "online" | "away";
}

/** topic → conn → member. Replaced (never mutated) on every change, so React selectors stay stable. */
export interface PresenceSnapshot {
  topics: Record<string, Record<string, PresenceMember>>;
}

export interface PresentUser {
  userId: string;
  state: "online" | "away";
}

const same = (a: Record<string, PresenceMember>, b: Record<string, PresenceMember>) => {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => b[k]?.userId === a[k]?.userId && b[k]?.state === a[k]?.state);
};

/**
 * Pure reducer: a `full` frame replaces the topic (offline entries dropped); a delta upserts or deletes one
 * connection per entry. Returns the same object when nothing changed.
 */
export function applyPresenceFrame(s: PresenceSnapshot, f: PresenceFrame): PresenceSnapshot {
  const current = s.topics[f.topic];
  let next: Record<string, PresenceMember>;
  if (f.full) {
    next = {};
    for (const e of f.entries) {
      if (e.state !== "offline") next[e.conn] = { userId: e.userId, state: e.state };
    }
    if (current && same(current, next)) return s;
  } else {
    next = { ...(current ?? {}) };
    let changed = false;
    for (const e of f.entries) {
      const prev = next[e.conn];
      if (e.state === "offline") {
        if (prev) {
          delete next[e.conn];
          changed = true;
        }
      } else if (!prev || prev.userId !== e.userId || prev.state !== e.state) {
        next[e.conn] = { userId: e.userId, state: e.state };
        changed = true;
      }
    }
    if (!changed) return s;
  }
  return { topics: { ...s.topics, [f.topic]: next } };
}

/** Per-user view of a topic: a user with any online connection is online; online first, then away. */
export function aggregatePresence(conns: Record<string, PresenceMember> | undefined): PresentUser[] {
  if (!conns) return [];
  const byUser = new Map<string, PresentUser>();
  for (const m of Object.values(conns)) {
    const prev = byUser.get(m.userId);
    if (!prev || (prev.state === "away" && m.state === "online")) {
      byUser.set(m.userId, { userId: m.userId, state: m.state });
    }
  }
  const out = [...byUser.values()];
  return [...out.filter((u) => u.state === "online"), ...out.filter((u) => u.state === "away")];
}
