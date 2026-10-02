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
}

const channelOf = (topic: string) => `ocw:rt:${topic}`;

export function createRealtimeService(deps: { db: TenantDb; bus: RedisBus }): RealtimeService {
  const authorizers = new Map<TopicPrefix, TopicAuthorizer>();
  // Defaults: personal and org-wide topics.
  authorizers.set("user", (auth, id) => auth.userId === id);
  authorizers.set("org", (auth, id) => auth.organizationId === id);

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
  };
}
