import {
  type DurableFrame,
  type EphemeralFrame,
  parseTopic,
  REPLAY_LIMIT,
  type ServerFrame,
  type TopicPrefix,
} from "@ocw/contracts";
import { type TenantCtx, type TenantDb, type Tx, tenantOf } from "@ocw/db";
import { sql } from "drizzle-orm";
import type { AuthContext } from "../../core";
import type { RedisBus } from "../../lib/redis";

/** Decides whether `auth` may subscribe to `<prefix>:<id>`. Must check organization + membership. */
export type TopicAuthorizer = (auth: AuthContext, id: string) => Promise<boolean> | boolean;

/** Why sessions stopped being valid; consumers close sockets and refuse bearer tokens (02-07/08/09). */
export type RevocationReason =
  | "signed_out"
  | "session_revoked"
  | "password_reset"
  | "password_changed"
  | "deactivated";

/** A revocation fanned out to every API instance: specific sessions, every session of a user, or both. */
export interface RevocationEvent {
  sessionIds?: string[];
  userId?: string;
  reason: RevocationReason;
}

export interface ReplayResult {
  events: DurableFrame[];
  lastSeq: number;
  truncated: boolean;
}

export interface RealtimeService {
  /**
   * Append a durable event to a topic's stream inside the caller's withTenant() transaction. Allocates the
   * next per-stream seq under a row lock and publishes to Redis only AFTER COMMIT. Returns the seq.
   */
  appendEvent(
    tx: Tx,
    topic: string,
    type: string,
    payload: unknown,
    opts?: { actorUserId?: string | null },
  ): Promise<number>;
  /** Current last seq of a topic (0 when the stream does not exist yet). Use for REST snapshots. */
  lastSeq(tx: Tx, topic: string): Promise<number>;
  /** Fire-and-forget ephemeral event (typing, deltas, presence): never persisted, no seq. */
  publishEphemeral(topic: string, type: string, data: unknown): Promise<void>;
  /** Register who may subscribe to topics with this prefix (B1: `conv`, B3: `ws`, …). Last one wins. */
  registerTopicAuthorizer(prefix: TopicPrefix, authorizer: TopicAuthorizer): void;
  authorizeTopic(auth: AuthContext, topic: string): Promise<boolean>;
  replay(ctx: TenantCtx, topic: string, afterSeq: number): Promise<ReplayResult>;
  /** Low-level fan-out subscription (used by the /ws gateway and server-side consumers). */
  listen(topic: string, listener: (frame: ServerFrame) => void): Promise<() => Promise<void>>;
  /**
   * Flags each session id as revoked for longer than an access JWT lives, then publishes the event to every
   * API instance. Call it AFTER the deleting transaction commits.
   */
  publishRevocation(e: RevocationEvent): Promise<void>;
  /** Subscribe to revocations (sockets close on them); malformed messages are ignored. */
  onRevocation(listener: (e: RevocationEvent) => void): Promise<() => Promise<void>>;
  /** True while the revoked-session flag for `sessionId` is set (checked on every bearer verify). */
  isSessionRevoked(sessionId: string): Promise<boolean>;
}

/** Pub/sub channel and per-session flag prefix of the revocation fan-out (T-02-03-07). */
export const REVOCATION_CHANNEL = "ocw:auth:revoked";
const revokedSidKey = (sid: string) => `ocw:auth:revoked-sid:${sid}`;
/** 15 minutes: longer than the 10-minute access JWT, so a revoked session's JWT never verifies again. */
export const REVOKED_SID_TTL_SECONDS = 900;

const REVOCATION_REASONS: readonly RevocationReason[] = [
  "signed_out",
  "session_revoked",
  "password_reset",
  "password_changed",
  "deactivated",
];

function parseRevocation(raw: string): RevocationEvent | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const reason = REVOCATION_REASONS.find((r) => r === o.reason);
  if (!reason) return null;
  const sessionIds =
    Array.isArray(o.sessionIds) && o.sessionIds.every((s) => typeof s === "string")
      ? (o.sessionIds as string[])
      : undefined;
  const userId = typeof o.userId === "string" ? o.userId : undefined;
  if (!sessionIds?.length && !userId) return null;
  return { ...(sessionIds ? { sessionIds } : {}), ...(userId ? { userId } : {}), reason };
}

const channelOf = (topic: string) => `ocw:rt:${topic}`;

export function createRealtimeService(deps: { db: TenantDb; bus: RedisBus }): RealtimeService {
  // No built-in authorizers: every prefix is decided by the module that owns it (`org` and `user` by the
  // organization module's resolver); a prefix nobody registered stays denied.
  const authorizers = new Map<TopicPrefix, TopicAuthorizer>();

  const publish = (topic: string, frame: ServerFrame) =>
    deps.bus.publish(channelOf(topic), JSON.stringify(frame));

  return {
    async appendEvent(tx, topic, type, payload, opts) {
      if (!parseTopic(topic)) throw new Error(`invalid topic ${topic}`);
      const ctx = tenantOf(tx);
      const res = await tx.execute(sql`
        insert into app.streams (id, organization_id, last_seq) values (${topic}, ${ctx.organizationId}, 1)
        on conflict (id) do update set last_seq = app.streams.last_seq + 1
        returning last_seq`);
      const seq = Number((res.rows[0] as { last_seq: number | string }).last_seq);
      await tx.execute(sql`
        insert into app.stream_events (stream_id, seq, organization_id, type, payload, actor_user_id)
        values (${topic}, ${seq}, ${ctx.organizationId}, ${type}, ${JSON.stringify(payload ?? null)}::jsonb, ${opts?.actorUserId ?? ctx.userId ?? null})`);
      const frame: DurableFrame = { op: "ev", topic, seq, type, data: payload ?? null };
      ctx.afterCommit(() => publish(topic, frame));
      return seq;
    },

    async lastSeq(tx, topic) {
      const res = await tx.execute(sql`select last_seq from app.streams where id = ${topic}`);
      const row = res.rows[0] as { last_seq: number | string } | undefined;
      return row ? Number(row.last_seq) : 0;
    },

    async publishEphemeral(topic, type, data) {
      const frame: EphemeralFrame = { op: "eph", topic, type, data };
      await publish(topic, frame);
    },

    registerTopicAuthorizer(prefix, authorizer) {
      authorizers.set(prefix, authorizer);
    },

    async authorizeTopic(auth, topic) {
      const parsed = parseTopic(topic);
      if (!parsed) return false;
      const fn = authorizers.get(parsed.prefix);
      if (!fn) return false;
      try {
        return await fn(auth, parsed.id);
      } catch {
        return false;
      }
    },

    async replay(ctx, topic, afterSeq) {
      return deps.db.withTenant(ctx, async (tx) => {
        const rows = await tx.execute(sql`
          select seq, type, payload from app.stream_events
          where stream_id = ${topic} and seq > ${afterSeq}
          order by seq limit ${REPLAY_LIMIT + 1}`);
        const last = await tx.execute(sql`select last_seq from app.streams where id = ${topic}`);
        const lastSeq = Number((last.rows[0] as { last_seq: number | string } | undefined)?.last_seq ?? 0);
        const truncated = rows.rows.length > REPLAY_LIMIT;
        const events = (rows.rows as Array<{ seq: number | string; type: string; payload: unknown }>)
          .slice(0, REPLAY_LIMIT)
          .map((r) => ({ op: "ev" as const, topic, seq: Number(r.seq), type: r.type, data: r.payload }));
        return { events, lastSeq, truncated };
      });
    },

    async listen(topic, listener) {
      return deps.bus.subscribe(channelOf(topic), (msg) => {
        try {
          listener(JSON.parse(msg) as ServerFrame);
        } catch {
          // ignore malformed frames
        }
      });
    },

    async publishRevocation(e) {
      const sessionIds = e.sessionIds ?? [];
      await Promise.all(
        sessionIds.map((sid) =>
          deps.bus.pub.set(revokedSidKey(sid), "1", {
            expiration: { type: "EX", value: REVOKED_SID_TTL_SECONDS },
          }),
        ),
      );
      const event: RevocationEvent = {
        ...(sessionIds.length ? { sessionIds } : {}),
        ...(e.userId ? { userId: e.userId } : {}),
        reason: e.reason,
      };
      await deps.bus.publish(REVOCATION_CHANNEL, JSON.stringify(event));
    },

    async onRevocation(listener) {
      return deps.bus.subscribe(REVOCATION_CHANNEL, (msg) => {
        const e = parseRevocation(msg);
        if (e) listener(e);
      });
    },

    async isSessionRevoked(sessionId) {
      return (await deps.bus.pub.exists(revokedSidKey(sessionId))) > 0;
    },
  };
}
