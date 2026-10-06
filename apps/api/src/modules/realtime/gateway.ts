import { randomUUID } from "node:crypto";
import {
  ClientFrame,
  type DurableFrame,
  isPresenceTopic,
  type PresenceFrame,
  type ServerFrame,
  WS_AUTH_PROTOCOL_PREFIX,
} from "@ocw/contracts";
import type { FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import type { App, AuthContext } from "../../core";
import type { IdentityService } from "../identity";
import type { OnlineSet } from "./online";
import { PRESENCE_HEARTBEAT_MS, type PresenceMember, type PresenceStore } from "./presence";
import type { RealtimeService } from "./service";

interface Subscription {
  phase: "replaying" | "live";
  buffer: DurableFrame[];
  lastSent: number;
  stop: () => Promise<void>;
  /** The presence join was issued (set synchronously before awaiting it, so an unsub always leaves). */
  presenceJoined: boolean;
  /** The full snapshot was sent; presence deltas are forwarded from now on. */
  presenceLive: boolean;
  /** Presence deltas received between listen() and the snapshot, flushed in order after it (Research note 4). */
  presenceBuffer: PresenceFrame[];
}

/** One open socket of this API instance. `id` is the presence `conn`: random, never the session id (D-03). */
interface Connection {
  id: string;
  auth: AuthContext;
  socket: WebSocket;
  subs: Map<string, Subscription>;
  presenceState: "online" | "away";
  /** Times of the presence changes applied in the current rate-limit window (sliding, oldest first). */
  presenceChanges: number[];
  /** Liveness: set by every pong and client frame, cleared (with a ping) on every heartbeat tick. */
  alive: boolean;
  /**
   * Bumped by every invalidation that matches this connection (RT-01, T-03-04-02). A subscribe whose decision
   * started before a bump is re-decided once it is live, so no subscribe slips past a concurrent removal.
   */
  authzEpoch: number;
  send(frame: ServerFrame): void;
  unsub(topic: string): Promise<void>;
}

/**
 * At most `max` presence state changes per socket per `windowMs` are applied (D-04, T-03-02-02); identical states
 * never count. A well-behaved client (500 ms throttle, 1 s input forwarding) stays far below it.
 */
export const PRESENCE_RATE_LIMIT = { max: 30, windowMs: 10_000 } as const;

/** Re-decisions of live subscriptions running at once per API instance (RT-01, T-03-04-04). */
export const REAUTH_CONCURRENCY = 4;

/**
 * Backstop for revocations and invalidations that never reached this instance (Redis down, expiry): Pitfall 5. Each
 * tick checks the session and membership, then re-decides every live subscription of the socket (RT-01).
 */
export const SESSION_RECHECK_MS = 5 * 60_000;
const CLIENT_EPHEMERAL_TYPE = /^user\.[a-z_.]{1,40}$/;

/** The `ocw.auth.<jwt>` entry of a `Sec-WebSocket-Protocol` header, without its prefix. */
function offeredToken(header: string | string[] | undefined): string | null {
  const offered = (Array.isArray(header) ? header.join(",") : (header ?? "")).split(",").map((p) => p.trim());
  const entry = offered.find((p) => p.startsWith(WS_AUTH_PROTOCOL_PREFIX));
  return entry ? entry.slice(WS_AUTH_PROTOCOL_PREFIX.length) || null : null;
}

/**
 * Browser realtime gateway `GET /ws` (research Pattern 5): Origin allowlist + access JWT (subprotocol
 * `ocw.auth.<jwt>`) BEFORE the upgrade, then `sub`/`unsub`/`ping`/`eph` frames. Subscribe = authorize → listen (buffer) → replay from
 * PostgreSQL → flush buffer → live. Exactly-once per (topic, seq) for the client.
 */
export function registerGateway(
  app: App,
  deps: {
    realtime: RealtimeService;
    identity: IdentityService;
    allowedOrigins: Set<string>;
    /** Session/member recheck interval for open sockets (tests lower it). */
    sessionRecheckMs?: number;
    presence: PresenceStore;
    /** Organization-level online set for @here (CHAT-08): one entry per open socket, refreshed on the heartbeat. */
    online: OnlineSet;
    /** Presence refresh interval (default PRESENCE_HEARTBEAT_MS; tests lower it). */
    heartbeatMs?: number;
    /** Presence change limit per socket (default PRESENCE_RATE_LIMIT; tests shorten the window). */
    presenceRateLimit?: { max: number; windowMs: number };
  },
) {
  const rateLimit = deps.presenceRateLimit ?? PRESENCE_RATE_LIMIT;
  const recheckMs = deps.sessionRecheckMs ?? SESSION_RECHECK_MS;
  const presence = deps.presence;
  const online = deps.online;
  // Open sockets of this API instance, so a revocation (Redis fan-out from any instance) closes them at once.
  const open = new Set<Connection>();
  const memberOf = (conn: Connection): PresenceMember => ({
    conn: conn.id,
    userId: conn.auth.userId,
    state: conn.presenceState,
  });

  // Heartbeat (D-02): one tick per PRESENCE_HEARTBEAT_MS for the whole instance.
  //  1. liveness: a socket that did not answer the previous tick's ping (half-open: sleeping laptop, dead
  //     network) is terminated; its close handler leaves presence. Browsers answer protocol pings themselves.
  //  2. refresh: re-score every joined entry so it never expires while its socket lives.
  //  3. sweep: claim and announce entries that expired because their instance died, for every topic this
  //     instance has local subscribers on (somebody here is watching it).
  let ticking = false;
  const tick = async () => {
    if (ticking) return; // a slow Redis never stacks ticks
    ticking = true;
    try {
      const items: Array<{ orgId: string; topic: string; m: PresenceMember }> = [];
      const watched = new Map<string, { orgId: string; topic: string }>();
      for (const conn of open) {
        if (!conn.alive) {
          conn.socket.terminate();
          continue;
        }
        conn.alive = false;
        try {
          conn.socket.ping();
        } catch {
          // closing already: its close handler cleans up
        }
        for (const [topic, sub] of conn.subs) {
          if (!sub.presenceJoined) continue;
          const orgId = conn.auth.organizationId;
          items.push({ orgId, topic, m: memberOf(conn) });
          watched.set(`${orgId}|${topic}`, { orgId, topic });
        }
      }
      await presence.refresh(items).catch((err: unknown) => app.log.warn({ err }, "presence refresh failed"));
      await online
        .refresh(
          [...open].map((c) => ({
            orgId: c.auth.organizationId,
            conn: c.id,
            userId: c.auth.userId,
            state: c.presenceState,
          })),
        )
        .catch((err: unknown) => app.log.warn({ err }, "online set refresh failed"));
      for (const { orgId, topic } of watched.values()) {
        await presence
          .sweep(orgId, topic)
          .catch((err: unknown) => app.log.warn({ err }, "presence sweep failed"));
      }
    } finally {
      ticking = false;
    }
  };
  const heartbeat = setInterval(() => void tick(), deps.heartbeatMs ?? PRESENCE_HEARTBEAT_MS);
  heartbeat.unref();

  let revocations: Promise<() => Promise<void>> | null = null;
  const watchRevocations = () => {
    revocations ??= deps.realtime.onRevocation((e) => {
      for (const conn of open) {
        if (e.sessionIds?.includes(conn.auth.sessionId) || (e.userId && e.userId === conn.auth.userId)) {
          conn.socket.close(4401, "session revoked");
        }
      }
    });
    // A failed subscription is retried by the next connection.
    revocations.catch(() => {
      revocations = null;
    });
    return revocations;
  };
  /**
   * Live re-authorisation (RT-01, 03-04 D-05): an access change re-decides the matching live subscriptions through
   * the same topic authorizers (the resolver) that decided them. "denied" drops the subscription (leaving its
   * presence) and tells the client with `revoked`; "error" keeps it for the next check. At most
   * REAUTH_CONCURRENCY re-decisions run at once on this instance.
   */
  const reauthorize = async (conn: Connection, topic: string) => {
    const sub = conn.subs.get(topic);
    if (!sub) return;
    const verdict = await deps.realtime.reauthorizeTopic(conn.auth, topic);
    // Replaced (a fresh `sub` was decided on its own) or removed meanwhile: nothing to do.
    if (conn.subs.get(topic) !== sub) return;
    if (verdict === "denied") {
      await conn.unsub(topic);
      conn.send({ op: "revoked", topic, reason: "forbidden" });
      app.log.info({ topic, userId: conn.auth.userId }, "live subscription revoked");
    } else if (verdict === "error") {
      app.log.warn({ topic, userId: conn.auth.userId }, "subscription re-decision failed; kept");
    }
  };
  // Coalesced per (connection, topic): a waiting job is never queued twice; a running one is marked to run once
  // more when it finishes (its answer may predate the latest change). Bursts cost at most two decisions.
  interface ReauthJob {
    conn: Connection;
    topic: string;
    running: boolean;
    again: boolean;
  }
  const reauthJobs = new Map<string, ReauthJob>();
  const reauthQueue: ReauthJob[] = [];
  let reauthRunning = 0;
  const jobKey = (conn: Connection, topic: string) => `${conn.id}|${topic}`;
  const pumpReauth = () => {
    while (reauthRunning < REAUTH_CONCURRENCY && reauthQueue.length) {
      const job = reauthQueue.shift() as ReauthJob;
      job.running = true;
      reauthRunning++;
      reauthorize(job.conn, job.topic)
        .catch((err: unknown) => app.log.warn({ err, topic: job.topic }, "subscription re-decision failed"))
        .finally(() => {
          reauthRunning--;
          job.running = false;
          if (job.again && job.conn.subs.has(job.topic)) {
            job.again = false;
            reauthQueue.push(job);
          } else {
            reauthJobs.delete(jobKey(job.conn, job.topic));
          }
          pumpReauth();
        });
    }
  };
  const scheduleReauth = (conn: Connection, topic: string) => {
    const key = jobKey(conn, topic);
    const existing = reauthJobs.get(key);
    if (existing) {
      if (existing.running) existing.again = true;
      return;
    }
    const job: ReauthJob = { conn, topic, running: false, again: false };
    reauthJobs.set(key, job);
    reauthQueue.push(job);
    pumpReauth();
  };

  let invalidations: Promise<() => Promise<void>> | null = null;
  const watchInvalidations = () => {
    invalidations ??= deps.realtime.onSubscriptionInvalidation((e) => {
      for (const conn of open) {
        if (conn.auth.organizationId !== e.organizationId) continue;
        if (e.userIds && !e.userIds.includes(conn.auth.userId)) continue;
        conn.authzEpoch++;
        for (const topic of conn.subs.keys()) {
          if (!e.topics || e.topics.includes(topic)) scheduleReauth(conn, topic);
        }
      }
    });
    invalidations.catch(() => {
      invalidations = null;
    });
    return invalidations;
  };

  app.addHook("onClose", async () => {
    clearInterval(heartbeat);
    // Leave every joined entry so watchers on other instances see this one's people go at once.
    const leaving: Promise<void>[] = [];
    for (const conn of open) {
      leaving.push(online.remove(conn.auth.organizationId, conn.id, conn.auth.userId));
      for (const [topic, sub] of conn.subs) {
        if (sub.presenceJoined) {
          sub.presenceJoined = false;
          leaving.push(presence.leave(conn.auth.organizationId, topic, memberOf(conn)));
        }
      }
    }
    await Promise.allSettled(leaving);
    const stop = await revocations?.catch(() => null);
    await stop?.();
    const stopInvalidations = await invalidations?.catch(() => null);
    await stopInvalidations?.();
  });

  app.get(
    "/ws",
    {
      websocket: true,
      // A user socket: the JWT authenticates it here, and every topic subscription is decided by the
      // resolver's topic authorizers (02-06).
      config: { authz: "user" },
      schema: { hide: true },
      onRequest: async (req, reply) => {
        const origin = req.headers.origin;
        if (!origin || !deps.allowedOrigins.has(origin)) {
          return reply.code(403).send({ error: { code: "forbidden_origin", message: "Origin not allowed" } });
        }
        // AUTH-06: the access JWT arrives as a Sec-WebSocket-Protocol entry and is verified BEFORE the
        // upgrade. Cookies no longer open the socket (D-01, T-02-08-05).
        const token = offeredToken(req.headers["sec-websocket-protocol"]);
        const auth = token ? await deps.identity.verifyAccessToken(token) : null;
        if (!auth)
          return reply.code(401).send({ error: { code: "unauthorized", message: "Sign in required" } });
        // Subscribed before the upgrade completes, so no revocation can slip between accept and register.
        await Promise.all([watchRevocations(), watchInvalidations()]);
        req.auth = auth;
      },
    },
    (socket: WebSocket, req: FastifyRequest) => {
      const auth = req.auth as AuthContext;
      const subs = new Map<string, Subscription>();
      // Per topic, bumped by every `sub` and `unsub` frame: a decision that finishes after a newer frame for the
      // same topic is dropped, so the latest frame always wins (the sidebar watcher and the channel view can
      // send two subs at once; an unsub can arrive while a sub is still being decided).
      const subGen = new Map<string, number>();
      const bumpGen = (topic: string) => {
        const g = (subGen.get(topic) ?? 0) + 1;
        subGen.set(topic, g);
        return g;
      };
      const send = (frame: ServerFrame) => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame));
      };

      const unsub = async (topic: string) => {
        const s = subs.get(topic);
        subs.delete(topic);
        if (s?.presenceJoined) {
          s.presenceJoined = false;
          // The join was queued first on the same Redis connection, so this leave always lands after it.
          presence
            .leave(auth.organizationId, topic, memberOf(conn))
            .catch((err: unknown) => req.log.warn({ err, topic }, "presence leave failed"));
        }
        await s?.stop();
      };

      // The socket outlives its 10-minute JWT by design: it stays tied to the session, which must still
      // exist (not signed out or expired) and belong to an active member.
      const conn: Connection = {
        id: randomUUID(),
        auth,
        socket,
        subs,
        presenceState: "online",
        presenceChanges: [],
        alive: true,
        authzEpoch: 0,
        send,
        unsub,
      };
      open.add(conn);
      // @here (CHAT-08): an open socket is online until it says away or closes.
      online
        .set(auth.organizationId, conn.id, auth.userId, conn.presenceState)
        .catch((err: unknown) => req.log.warn({ err }, "online set add failed"));
      socket.on("pong", () => {
        conn.alive = true;
      });

      const recheck = setInterval(async () => {
        const still = await Promise.all([
          deps.identity.isSessionActive(auth.sessionId),
          deps.identity.isMemberActive(auth.organizationId, auth.userId),
        ]).then(
          ([session, member]) => session && member,
          () => true, // a transient lookup failure is not a revocation; the next recheck decides
        );
        if (!still) {
          socket.close(4401, "session expired");
          return;
        }
        // Backstop for lost invalidations (Redis pub/sub is at-most-once, T-03-06-03): every live subscription is
        // re-decided through the same queue, so a missed access change closes within one interval.
        for (const topic of subs.keys()) scheduleReauth(conn, topic);
      }, recheckMs);

      /**
       * RT-04 away (03-02, T-03-02-01): the frame names no user, topic or connection, so it can only change this
       * socket's own entries. Every joined presence topic is updated; the commands are queued in order on the one
       * Redis connection, so a later change or leave always lands after this one. Joins made afterwards already use
       * `conn.presenceState`.
       */
      const setOwnState = async (to: "online" | "away") => {
        const from = conn.presenceState;
        if (to === from) return;
        const now = Date.now();
        const recent = conn.presenceChanges;
        while (recent.length && (recent[0] as number) <= now - rateLimit.windowMs) recent.shift();
        if (recent.length >= rateLimit.max) {
          send({ op: "err", code: "rate_limited", message: "Too many presence changes" });
          return;
        }
        recent.push(now);
        conn.presenceState = to;
        const updates: Promise<void>[] = [
          online
            .set(auth.organizationId, conn.id, auth.userId, to)
            .catch((err: unknown) => req.log.warn({ err }, "online set state change failed")),
        ];
        for (const [topic, sub] of subs) {
          if (!sub.presenceJoined) continue;
          updates.push(
            presence
              .setState(auth.organizationId, topic, conn.id, auth.userId, from, to)
              .catch((err: unknown) => req.log.warn({ err, topic }, "presence state change failed")),
          );
        }
        await Promise.all(updates);
      };

      /** After `subscribed`: join the topic's presence, send the snapshot, then flush buffered deltas. */
      const joinPresence = async (topic: string, sub: Subscription) => {
        sub.presenceJoined = true;
        try {
          await presence.join(auth.organizationId, topic, memberOf(conn));
          const entries = await presence.snapshot(auth.organizationId, topic);
          if (subs.get(topic) !== sub) return;
          send({ op: "presence", topic, full: true, entries });
        } catch (err) {
          req.log.warn({ err, topic }, "presence join failed");
          if (subs.get(topic) !== sub) return;
        }
        for (const f of sub.presenceBuffer) send(f);
        sub.presenceBuffer = [];
        sub.presenceLive = true;
      };

      const subscribe = async (topic: string, afterSeq: number, wantsPresence: boolean) => {
        const gen = bumpGen(topic);
        await unsub(topic);
        const epoch = conn.authzEpoch;
        const allowed = await deps.realtime.authorizeTopic(auth, topic);
        if (subGen.get(topic) !== gen) return; // superseded by a newer sub/unsub for this topic
        if (!allowed) {
          send({ op: "err", code: "forbidden", topic, message: "Not allowed to subscribe to this topic" });
          return;
        }
        const sub: Subscription = {
          phase: "replaying",
          buffer: [],
          lastSent: afterSeq,
          stop: async () => {},
          presenceJoined: false,
          presenceLive: false,
          presenceBuffer: [],
        };
        subs.set(topic, sub);
        // Only a subscriber that shows the conversation joins its presence and receives it (background unread
        // watchers do not count as "here").
        const withPresence = wantsPresence && isPresenceTopic(topic);
        sub.stop = await deps.realtime.listen(topic, (frame) => {
          if (subs.get(topic) !== sub) return;
          if (frame.op === "eph") return send(frame);
          if (frame.op === "presence") {
            if (!withPresence) return;
            if (sub.presenceLive) send(frame);
            else sub.presenceBuffer.push(frame);
            return;
          }
          if (frame.op !== "ev") return;
          if (sub.phase === "replaying") sub.buffer.push(frame);
          else if (frame.seq > sub.lastSent) {
            sub.lastSent = frame.seq;
            send(frame);
          }
        });
        if (subs.get(topic) !== sub) return sub.stop();

        const replay = await deps.realtime.replay(
          { organizationId: auth.organizationId, userId: auth.userId },
          topic,
          afterSeq,
        );
        if (subs.get(topic) !== sub) return;
        if (replay.truncated) {
          sub.lastSent = replay.lastSeq;
          send({ op: "resync", topic });
        } else {
          for (const ev of replay.events) {
            sub.lastSent = ev.seq;
            send(ev);
          }
        }
        for (const ev of sub.buffer.sort((a, b) => a.seq - b.seq)) {
          if (ev.seq > sub.lastSent) {
            sub.lastSent = ev.seq;
            send(ev);
          }
        }
        sub.buffer = [];
        sub.phase = "live";
        send({ op: "subscribed", topic, lastSeq: Math.max(sub.lastSent, replay.lastSeq) });
        // Presence only after the resolver allowed the subscription and `subscribed` was sent (T-03-01-01).
        if (withPresence) await joinPresence(topic, sub);
        // An invalidation arrived while this was being decided: decide it again now that it is live.
        if (conn.authzEpoch !== epoch && subs.get(topic) === sub) scheduleReauth(conn, topic);
      };

      // Attach synchronously so early frames are never dropped (Pitfall 8).
      socket.on("message", (raw) => {
        conn.alive = true;
        let frame: ClientFrame;
        try {
          const parsed = ClientFrame.safeParse(JSON.parse(String(raw)));
          if (!parsed.success) return send({ op: "err", code: "bad_frame" });
          frame = parsed.data;
        } catch {
          return send({ op: "err", code: "bad_frame" });
        }
        switch (frame.op) {
          case "ping":
            return send({ op: "pong" });
          case "sub":
            subscribe(frame.topic, frame.afterSeq ?? 0, frame.presence === true).catch((err: unknown) => {
              req.log.error({ err, topic: frame.topic }, "ws subscribe failed");
              send({ op: "err", code: "subscribe_failed", topic: frame.topic });
            });
            return;
          case "unsub":
            bumpGen(frame.topic);
            void unsub(frame.topic);
            return;
          case "presence":
            void setOwnState(frame.state);
            return;
          case "eph": {
            if (!subs.has(frame.topic) || !CLIENT_EPHEMERAL_TYPE.test(frame.type)) {
              return send({ op: "err", code: "forbidden", topic: frame.topic });
            }
            const data = typeof frame.data === "object" && frame.data !== null ? frame.data : {};
            void deps.realtime.publishEphemeral(frame.topic, frame.type, { ...data, userId: auth.userId });
            return;
          }
        }
      });

      socket.on("close", () => {
        open.delete(conn);
        clearInterval(recheck);
        online
          .remove(auth.organizationId, conn.id, auth.userId)
          .catch((err: unknown) => req.log.warn({ err }, "online set remove failed"));
        for (const topic of [...subs.keys()]) void unsub(topic);
      });
    },
  );
}
