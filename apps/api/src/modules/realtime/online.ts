import type { RedisBus } from "../../lib/redis";
import { PRESENCE_TTL_MS } from "./presence";

/**
 * Organization-level online set for `@here` (CHAT-08, 04-RESEARCH §3). One sorted set per organization, key
 * `ocw:online:<orgId>`, member `<conn>|<userId>|<state>`, score = expiry time in ms (same TTL as presence). The
 * gateway adds a socket when it opens, swaps the state on `presence` frames, re-scores every open socket on the
 * presence heartbeat and removes it on close; an instance that died simply stops refreshing and its entries expire.
 * Only the server reads it (T-04-09-04). Every command goes through `bus.pub` (one connection, program order), so a
 * remove always lands after its add.
 */

export interface OnlineSet {
  set(orgId: string, conn: string, userId: string, state: "online" | "away"): Promise<void>;
  remove(orgId: string, conn: string, userId: string): Promise<void>;
  refresh(
    items: ReadonlyArray<{ orgId: string; conn: string; userId: string; state: "online" | "away" }>,
  ): Promise<void>;
  /** Users with at least one live connection in state `online` (away and expired entries do not count). */
  onlineUserIds(orgId: string): Promise<Set<string>>;
}

const STATES = ["online", "away"] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const onlineKey = (orgId: string) => `ocw:online:${orgId}`;
const memberOf = (conn: string, userId: string, state: string) => `${conn}|${userId}|${state}`;

export function createOnlineSet(
  bus: RedisBus,
  ttlMs: number = PRESENCE_TTL_MS,
  now: () => number = Date.now,
): OnlineSet {
  const redis = bus.pub;
  return {
    async set(orgId, conn, userId, state) {
      const key = onlineKey(orgId);
      await redis
        .multi()
        .zRem(
          key,
          STATES.filter((s) => s !== state).map((s) => memberOf(conn, userId, s)),
        )
        .zAdd(key, { score: now() + ttlMs, value: memberOf(conn, userId, state) })
        .pExpire(key, 2 * ttlMs)
        .exec();
    },

    async remove(orgId, conn, userId) {
      await redis.zRem(
        onlineKey(orgId),
        STATES.map((s) => memberOf(conn, userId, s)),
      );
    },

    async refresh(items) {
      if (items.length === 0) return;
      const score = now() + ttlMs;
      const multi = redis.multi();
      for (const it of items) {
        multi.zAdd(onlineKey(it.orgId), { score, value: memberOf(it.conn, it.userId, it.state) });
      }
      for (const key of new Set(items.map((it) => onlineKey(it.orgId)))) {
        multi.zRemRangeByScore(key, "-inf", now());
        multi.pExpire(key, 2 * ttlMs);
      }
      await multi.exec();
    },

    async onlineUserIds(orgId) {
      const raw = await redis.zRangeByScore(onlineKey(orgId), now(), "+inf");
      const out = new Set<string>();
      for (const r of raw) {
        const [conn, userId, state, ...rest] = String(r).split("|");
        if (rest.length || !conn || !userId || !UUID.test(userId)) continue;
        if (state === "online") out.add(userId);
      }
      return out;
    },
  };
}
