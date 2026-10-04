import { PRESENCE_SNAPSHOT_LIMIT, type PresenceFrame } from "@ocw/contracts";
import type { RedisBus } from "../../lib/redis";
import { topicChannel } from "./service";

/**
 * Presence store (RT-04, 03-01 D-02). One sorted set per (organization, topic), key
 * `ocw:presence:<orgId>:<topic>`, member `<conn>|<userId>|<state>`, score = expiry time in ms. The API instance
 * that owns a connection re-scores its entries every PRESENCE_HEARTBEAT_MS; an entry whose owner died stops being
 * refreshed and is swept (and announced `offline`) by any instance that still has local subscribers on the topic.
 * The key itself expires after 2 × TTL without writes. Deltas travel on the topic's own Redis channel, so the
 * existing per-topic fan-out carries them to authorised subscribers only.
 *
 * Ordering: every command goes through `bus.pub` (one connection, program order). `join` and `leave` publish
 * their delta inside the same MULTI as the write, so a leave can never overtake its join's announcement.
 */

export interface PresenceMember {
  conn: string;
  userId: string;
  state: "online" | "away";
}

export interface PresenceStore {
  /** Adds (or re-scores) the connection and announces it to the topic's subscribers. */
  join(orgId: string, topic: string, m: PresenceMember): Promise<void>;
  /**
   * The connection's own state changed (RT-04 away, 03-02): one MULTI swaps the stored member (`from` → `to`) with a
   * fresh expiry and announces the new state, so watchers never see the change before it is stored.
   */
  setState(
    orgId: string,
    topic: string,
    conn: string,
    userId: string,
    from: PresenceMember["state"],
    to: PresenceMember["state"],
  ): Promise<void>;
  /** Removes the connection (whatever state it was stored with) and announces it `offline`. */
  leave(orgId: string, topic: string, m: PresenceMember): Promise<void>;
  /** Live (unexpired) entries, newest first, at most PRESENCE_SNAPSHOT_LIMIT. Malformed members are skipped. */
  snapshot(orgId: string, topic: string): Promise<PresenceMember[]>;
  /** Heartbeat: re-scores every item in one MULTI; an item that had vanished (swept, key lost) is re-announced. */
  refresh(items: ReadonlyArray<{ orgId: string; topic: string; m: PresenceMember }>): Promise<void>;
  /**
   * Claims every expired entry of the topic (one MULTI reads and removes them, so exactly one instance wins
   * each), announces them `offline` and returns how many it claimed.
   */
  sweep(orgId: string, topic: string): Promise<number>;
}

/** Heartbeat (refresh, sweep and WebSocket ping) interval. */
export const PRESENCE_HEARTBEAT_MS = 15_000;
/** An entry not refreshed for this long is expired: 3 heartbeats. */
export const PRESENCE_TTL_MS = 45_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STORED_STATES = ["online", "away"] as const;

export const presenceKey = (orgId: string, topic: string) => `ocw:presence:${orgId}:${topic}`;
const memberOf = (m: PresenceMember) => `${m.conn}|${m.userId}|${m.state}`;

function parseMember(raw: string): PresenceMember | null {
  const [conn, userId, state, ...rest] = raw.split("|");
  if (rest.length || !conn || !userId || !UUID.test(conn) || !UUID.test(userId)) return null;
  const s = STORED_STATES.find((x) => x === state);
  return s ? { conn, userId, state: s } : null;
}

const delta = (topic: string, entries: PresenceFrame["entries"]): string =>
  JSON.stringify({ op: "presence", topic, full: false, entries } satisfies PresenceFrame);

export function createPresenceStore(deps: {
  bus: RedisBus;
  ttlMs?: number;
  now?: () => number;
}): PresenceStore {
  const ttl = deps.ttlMs ?? PRESENCE_TTL_MS;
  const now = deps.now ?? Date.now;
  const redis = deps.bus.pub;

  return {
    async join(orgId, topic, m) {
      const key = presenceKey(orgId, topic);
      await redis
        .multi()
        .zAdd(key, { score: now() + ttl, value: memberOf(m) })
        .pExpire(key, 2 * ttl)
        .publish(topicChannel(topic), delta(topic, [{ conn: m.conn, userId: m.userId, state: m.state }]))
        .exec();
    },

    async setState(orgId, topic, conn, userId, from, to) {
      const key = presenceKey(orgId, topic);
      await redis
        .multi()
        .zRem(key, memberOf({ conn, userId, state: from }))
        .zAdd(key, { score: now() + ttl, value: memberOf({ conn, userId, state: to }) })
        .pExpire(key, 2 * ttl)
        .publish(topicChannel(topic), delta(topic, [{ conn, userId, state: to }]))
        .exec();
    },

    async leave(orgId, topic, m) {
      const key = presenceKey(orgId, topic);
      await redis
        .multi()
        .zRem(
          key,
          STORED_STATES.map((state) => memberOf({ ...m, state })),
        )
        .publish(topicChannel(topic), delta(topic, [{ conn: m.conn, userId: m.userId, state: "offline" }]))
        .exec();
    },

    async snapshot(orgId, topic) {
      const raw = await redis.zRange(presenceKey(orgId, topic), "+inf", now(), {
        BY: "SCORE",
        REV: true,
        LIMIT: { offset: 0, count: PRESENCE_SNAPSHOT_LIMIT },
      });
      const out: PresenceMember[] = [];
      for (const r of raw) {
        const m = parseMember(String(r));
        if (m) out.push(m);
      }
      return out;
    },

    async refresh(items) {
      if (items.length === 0) return;
      const score = now() + ttl;
      const multi = redis.multi();
      for (const it of items) multi.zAdd(presenceKey(it.orgId, it.topic), { score, value: memberOf(it.m) });
      for (const key of new Set(items.map((it) => presenceKey(it.orgId, it.topic))))
        multi.pExpire(key, 2 * ttl);
      const replies = await multi.exec();
      // ZADD replies with the number of NEW members: 1 means the entry had been swept or its key had expired.
      const readded = items.filter((_, i) => Number(replies[i]) === 1);
      await Promise.all(
        readded.map((it) =>
          deps.bus.publish(
            topicChannel(it.topic),
            delta(it.topic, [{ conn: it.m.conn, userId: it.m.userId, state: it.m.state }]),
          ),
        ),
      );
    },
    async sweep(orgId, topic) {
      const key = presenceKey(orgId, topic);
      const t = now();
      const [expired] = await redis
        .multi()
        .zRangeByScore(key, "-inf", t)
        .zRemRangeByScore(key, "-inf", t)
        .exec();
      const claimed = Array.isArray(expired) ? expired.map((r) => String(r)) : [];
      const entries: PresenceFrame["entries"] = [];
      for (const raw of claimed) {
        const m = parseMember(raw);
        if (m) entries.push({ conn: m.conn, userId: m.userId, state: "offline" });
      }
      // One frame per PRESENCE_SNAPSHOT_LIMIT entries (the contract's cap).
      for (let i = 0; i < entries.length; i += PRESENCE_SNAPSHOT_LIMIT) {
        await deps.bus.publish(
          topicChannel(topic),
          delta(topic, entries.slice(i, i + PRESENCE_SNAPSHOT_LIMIT)),
        );
      }
      return claimed.length;
    },
  };
}
