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
  send(frame: ServerFrame): void;
  unsub(topic: string): Promise<void>;
}

/** Backstop for revocations that never reached this instance (Redis down, expiry): Pitfall 5. */
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
    /** Presence refresh interval (default PRESENCE_HEARTBEAT_MS; tests lower it). */
    heartbeatMs?: number;
  },
) {
  const recheckMs = deps.sessionRecheckMs ?? SESSION_RECHECK_MS;
  const presence = deps.presence;
  // Open sockets of this API instance, so a revocation (Redis fan-out from any instance) closes them at once.
  const open = new Set<Connection>();
  const memberOf = (conn: Connection): PresenceMember => ({
    conn: conn.id,
    userId: conn.auth.userId,
    state: conn.presenceState,
  });

  // Heartbeat: re-score every joined entry of this instance so it never expires while the socket lives (D-02).
  const heartbeat = setInterval(() => {
    const items: Array<{ orgId: string; topic: string; m: PresenceMember }> = [];
    for (const conn of open) {
      for (const [topic, sub] of conn.subs) {
        if (sub.presenceJoined) items.push({ orgId: conn.auth.organizationId, topic, m: memberOf(conn) });
      }
    }
    presence.refresh(items).catch((err: unknown) => app.log.warn({ err }, "presence heartbeat failed"));
  }, deps.heartbeatMs ?? PRESENCE_HEARTBEAT_MS);
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
  app.addHook("onClose", async () => {
    clearInterval(heartbeat);
    // Leave every joined entry so watchers on other instances see this one's people go at once.
    const leaving: Promise<void>[] = [];
    for (const conn of open) {
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
        await watchRevocations();
        req.auth = auth;
      },
    },
    (socket: WebSocket, req: FastifyRequest) => {
      const auth = req.auth as AuthContext;
      const subs = new Map<string, Subscription>();
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
        send,
        unsub,
      };
      open.add(conn);

      const recheck = setInterval(async () => {
        const still = await Promise.all([
          deps.identity.isSessionActive(auth.sessionId),
          deps.identity.isMemberActive(auth.organizationId, auth.userId),
        ]).then(
          ([session, member]) => session && member,
          () => true, // a transient lookup failure is not a revocation; the next recheck decides
        );
        if (!still) socket.close(4401, "session expired");
      }, recheckMs);

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
        await unsub(topic);
        if (!(await deps.realtime.authorizeTopic(auth, topic))) {
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
      };

      // Attach synchronously so early frames are never dropped (Pitfall 8).
      socket.on("message", (raw) => {
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
            void unsub(frame.topic);
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
        for (const topic of [...subs.keys()]) void unsub(topic);
      });
    },
  );
}
