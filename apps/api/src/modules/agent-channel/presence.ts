import { randomUUID } from "node:crypto";
import { type AgentCellStatus, EphemeralTypes } from "@ocw/contracts";
import type { Core } from "../../core";

/** A connection that has not refreshed for this long counts as gone (API crash, network split). */
const STALE_MS = 60_000;

interface ConnEntry {
  connectedAt: string;
  lastSeenAt: string;
}

const connsKey = (org: string) => `ocw:cell:${org}:conns`;
const lastSeenKey = (org: string) => `ocw:cell:${org}:last_seen`;

/**
 * OpenClaw cell presence in Redis (shared by every API instance): one hash field per open plugin
 * WebSocket, refreshed by the gateway heartbeat, plus a durable "last seen" timestamp. Changes are pushed
 * to browsers as an ephemeral `cell.presence` event on `org:<id>`.
 */
export function createCellPresence(core: Core) {
  const redis = core.bus.pub;

  async function status(org: string, uiTokenCreatedAt: string | null): Promise<AgentCellStatus> {
    const raw = await redis.hGetAll(connsKey(org));
    const now = Date.now();
    const fresh: ConnEntry[] = [];
    const stale: string[] = [];
    for (const [field, value] of Object.entries(raw)) {
      try {
        const entry = JSON.parse(value) as ConnEntry;
        if (now - new Date(entry.lastSeenAt).getTime() < STALE_MS) fresh.push(entry);
        else stale.push(field);
      } catch {
        stale.push(field);
      }
    }
    if (stale.length) await redis.hDel(connsKey(org), stale);
    const lastSeen = await redis.get(lastSeenKey(org));
    const connectedAt = fresh.map((e) => e.connectedAt).sort()[0] ?? null;
    return {
      cellId: org,
      connected: fresh.length > 0,
      connections: fresh.length,
      connectedAt,
      lastSeenAt: lastSeen ?? null,
      envTokenConfigured: !!core.env.OCW_CELL_TOKEN,
      uiTokenCreatedAt,
    };
  }

  async function broadcast(org: string) {
    const s = await status(org, null);
    // uiTokenCreatedAt is admin detail; browsers refetch the full status on this hint.
    await core.realtime.publishEphemeral(`org:${org}`, EphemeralTypes.cellPresence, {
      connected: s.connected,
      connections: s.connections,
      connectedAt: s.connectedAt,
      lastSeenAt: s.lastSeenAt,
    });
  }

  return {
    status,
    /** Register a new plugin connection; returns its handle. */
    async connect(org: string) {
      const id = randomUUID();
      const now = new Date().toISOString();
      await redis.hSet(connsKey(org), id, JSON.stringify({ connectedAt: now, lastSeenAt: now }));
      await redis.set(lastSeenKey(org), now);
      await broadcast(org).catch(() => {});
      return {
        async touch() {
          const t = new Date().toISOString();
          await redis.hSet(connsKey(org), id, JSON.stringify({ connectedAt: now, lastSeenAt: t }));
          await redis.set(lastSeenKey(org), t);
        },
        async disconnect() {
          await redis.hDel(connsKey(org), id);
          await redis.set(lastSeenKey(org), new Date().toISOString());
          await broadcast(org).catch(() => {});
        },
      };
    },
  };
}

export type CellPresence = ReturnType<typeof createCellPresence>;
