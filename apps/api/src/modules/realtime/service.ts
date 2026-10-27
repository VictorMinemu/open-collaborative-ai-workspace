import {
  type DurableFrame,
  type EphemeralFrame,
  parseTopic,
  REPLAY_LIMIT,
  type RevokeCause,
  type ServerFrame,
  type TopicPrefix,
} from "@ocw/contracts";
import { type TenantCtx, type TenantDb, type Tx, tenantOf } from "@ocw/db";
import { sql } from "drizzle-orm";
import type { AuthContext } from "../../core";
import type { RedisBus } from "../../lib/redis";

/**
 * A topic authorizer's answer: allowed (`true`), or refused, optionally with the reason as a fixed code (Phase 07.9,
 * D-13) that a live re-decision passes to the client in its `revoked` frame. Never a name.
 */
export type TopicDecision = boolean | { allowed: false; cause?: RevokeCause };

/** Decides whether `auth` may subscribe to `<prefix>:<id>`. Must check organization + membership. */
export type TopicAuthorizer = (auth: AuthContext, id: string) => Promise<TopicDecision> | TopicDecision;

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

/**
 * Which live subscriptions of one organization must be re-decided (RT-01, 03-04 D-05). `userIds` / `topics`
 * absent = every user / every topic. It can only trigger re-decisions through the resolver, never grant access.
 */
export interface SubscriptionInvalidation {
  organizationId: string;
  userIds?: string[];
  topics?: string[];
}

/**
 * Maps a durable event (topic + payload) to the subscriptions it may have invalidated, or null when it changes
 * nobody's access. Runs inside the domain transaction; the invalidation is published after commit.
 */
export type SubscriptionInvalidator = (
  topic: string,
  payload: unknown,
) => { userIds?: string[]; topics?: string[] } | null;

/**
 * Rewrites a stored event's payload when it is replayed (Phase 07.10-07, LO-02): a module that narrowed what its
 * durable stream carries strips, on read, the fields that events stored before the change still hold. It may only
 * remove data, never add any; the live path is unchanged (the module already appends the narrowed payload).
 */
export type ReplayMapper = (type: string, payload: unknown) => unknown;

/**
 * Outcome of re-deciding a live subscription: "error" (lookup failed) never revokes; a denial carries the authorizer's
 * `cause` when it gave one (07.9, D-13).
 */
export type Reauthorization = "allowed" | "error" | { denied: true; cause?: RevokeCause };

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
  /**
   * Locks the streams of these topics, in the order given, until the caller's transaction ends (a missing stream is
   * created at seq 0, as chat's `lockNextSeq` does). Every append locks its stream's row until commit, so two
   * transactions appending to the same streams in different orders deadlock: a transaction that will append to several
   * shared streams, some of them through other modules, calls this first with the order a message post follows (the
   * conversation, then `user:` streams in ascending id order, then the cell; 07.5-16).
   */
  lockStreams(tx: Tx, topics: readonly string[]): Promise<void>;
  /** Current last seq of a topic (0 when the stream does not exist yet). Use for REST snapshots. */
  lastSeq(tx: Tx, topic: string): Promise<number>;
  /** Fire-and-forget ephemeral event (typing, deltas, presence): never persisted, no seq. */
  publishEphemeral(topic: string, type: string, data: unknown): Promise<void>;
  /** Register who may subscribe to topics with this prefix (B1: `conv`, B3: `ws`, …). Last one wins. */
  registerTopicAuthorizer(prefix: TopicPrefix, authorizer: TopicAuthorizer): void;
  authorizeTopic(auth: AuthContext, topic: string): Promise<boolean>;
  replay(ctx: TenantCtx, topic: string, afterSeq: number): Promise<ReplayResult>;
  /** Register the payload rewrite of replayed events on topics with this prefix (07.10-07, LO-02). Last one wins. */
  registerReplayMapper(prefix: TopicPrefix, mapper: ReplayMapper): void;
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
  /**
   * Durable events of `eventType` may change who can read which topics: `appendEvent` computes the invalidator's
   * scope in the transaction and publishes it after commit, before any frame of that transaction (07.9 fan-out).
   * Last one wins.
   */
  registerSubscriptionInvalidator(eventType: string, fn: SubscriptionInvalidator): void;
  /** Publish an invalidation now (non-transactional callers, tests). */
  invalidateSubscriptions(e: SubscriptionInvalidation): Promise<void>;
  /** Subscribe to invalidations from every API instance; malformed messages are ignored. */
  onSubscriptionInvalidation(listener: (e: SubscriptionInvalidation) => void): Promise<() => Promise<void>>;
  /**
   * Re-decide a live subscription with the same topic authorizer as `authorizeTopic`, but tri-state: a throwing
   * authorizer is "error" (keep the subscription, decide again later), never "denied".
   */
  reauthorizeTopic(auth: AuthContext, topic: string): Promise<Reauthorization>;
}

/** Pub/sub channel of the subscription invalidation fan-out (RT-01, 03-04). */
export const AUTHZ_INVALIDATION_CHANNEL = "ocw:realtime:authz-invalidated";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const stringList = (v: unknown): string[] | undefined | null => {
  if (v === undefined) return undefined;
  return Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : null;
};

/** Defensive parse (the channel is shared by every stack on the same Redis server, Research note 8). */
export function parseInvalidation(raw: string): SubscriptionInvalidation | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.organizationId !== "string" || !UUID.test(o.organizationId)) return null;
  const userIds = stringList(o.userIds);
  const topics = stringList(o.topics);
  if (userIds === null || topics === null) return null;
  return {
    organizationId: o.organizationId,
    ...(userIds ? { userIds } : {}),
    ...(topics ? { topics } : {}),
  };
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

/** Redis pub/sub channel of a topic: every frame for `topic` (durable, ephemeral, presence) travels on it. */
export function topicChannel(topic: string): string {
  return `ocw:rt:${topic}`;
}

export function createRealtimeService(deps: { db: TenantDb; bus: RedisBus }): RealtimeService {
  // No built-in authorizers: every prefix is decided by the module that owns it (`org` and `user` by the
  // organization module's resolver); a prefix nobody registered stays denied.
  const authorizers = new Map<TopicPrefix, TopicAuthorizer>();
  const invalidators = new Map<string, SubscriptionInvalidator>();
  const replayMappers = new Map<TopicPrefix, ReplayMapper>();

  const publish = (topic: string, frame: ServerFrame) =>
    deps.bus.publish(topicChannel(topic), JSON.stringify(frame));

  /**
   * Invalidations of a transaction (its savepoints included) not yet published, by its root. Privacy first (07.9
   * fan-out): every access invalidation a transaction caused is published BEFORE any of its frames, whatever the order
   * of the appends, so every gateway holds the affected subscriptions before a frame of that commit reaches them (one
   * publisher and one subscriber connection per process keep the Redis order). The invalidation of a savepoint rolled
   * back later is still published: it can only cause a re-decision, never grant access.
   */
  const unpublished = new WeakMap<object, SubscriptionInvalidation[]>();
  const publishInvalidations = async (root: object) => {
    const list = unpublished.get(root);
    if (!list) return;
    unpublished.delete(root);
    for (const e of list) await deps.bus.publish(AUTHZ_INVALIDATION_CHANNEL, JSON.stringify(e));
  };

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
      const invalidator = invalidators.get(type);
      if (invalidator) {
        try {
          const scope = invalidator(topic, payload);
          if (scope) {
            const list = unpublished.get(ctx.root) ?? [];
            list.push({ organizationId: ctx.organizationId, ...scope });
            unpublished.set(ctx.root, list);
          }
        } catch (err) {
          // Never fail the domain write: the periodic backstop re-decides anything missed.
          console.error("subscription invalidator failed", { type, topic, err });
        }
      }
      ctx.afterCommit(async () => {
        await publishInvalidations(ctx.root);
        await publish(topic, frame);
      });
      return seq;
    },

    async lockStreams(tx, topics) {
      const ctx = tenantOf(tx);
      for (const topic of topics) {
        if (!parseTopic(topic)) throw new Error(`invalid topic ${topic}`);
        await tx.execute(sql`
          insert into app.streams (id, organization_id, last_seq) values (${topic}, ${ctx.organizationId}, 0)
          on conflict (id) do nothing`);
        await tx.execute(sql`select 1 from app.streams where id = ${topic} for update`);
      }
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
        return (await fn(auth, parsed.id)) === true;
      } catch {
        return false;
      }
    },

    async reauthorizeTopic(auth, topic) {
      const parsed = parseTopic(topic);
      if (!parsed) return { denied: true };
      const fn = authorizers.get(parsed.prefix);
      if (!fn) return { denied: true };
      let decision: TopicDecision;
      try {
        decision = await fn(auth, parsed.id);
      } catch {
        return "error";
      }
      if (decision === true) return "allowed";
      return typeof decision === "object" && decision.cause
        ? { denied: true, cause: decision.cause }
        : { denied: true };
    },

    registerSubscriptionInvalidator(eventType, fn) {
      invalidators.set(eventType, fn);
    },

    registerReplayMapper(prefix, mapper) {
      replayMappers.set(prefix, mapper);
    },

    async invalidateSubscriptions(e) {
      const event: SubscriptionInvalidation = {
        organizationId: e.organizationId,
        ...(e.userIds ? { userIds: e.userIds } : {}),
        ...(e.topics ? { topics: e.topics } : {}),
      };
      await deps.bus.publish(AUTHZ_INVALIDATION_CHANNEL, JSON.stringify(event));
    },

    async onSubscriptionInvalidation(listener) {
      return deps.bus.subscribe(AUTHZ_INVALIDATION_CHANNEL, (msg) => {
        const e = parseInvalidation(msg);
        if (e) listener(e);
      });
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
        const prefix = parseTopic(topic)?.prefix;
        const mapper = prefix ? replayMappers.get(prefix) : undefined;
        const events = (rows.rows as Array<{ seq: number | string; type: string; payload: unknown }>)
          .slice(0, REPLAY_LIMIT)
          .map((r) => ({
            op: "ev" as const,
            topic,
            seq: Number(r.seq),
            type: r.type,
            data: mapper ? mapper(r.type, r.payload) : r.payload,
          }));
        return { events, lastSeq, truncated };
      });
    },

    async listen(topic, listener) {
      return deps.bus.subscribe(topicChannel(topic), (msg) => {
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
