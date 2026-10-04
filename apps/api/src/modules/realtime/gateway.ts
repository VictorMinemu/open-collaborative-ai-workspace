import { ClientFrame, type DurableFrame, type ServerFrame } from "@ocw/contracts";
import type { FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import type { App, AuthContext } from "../../core";
import type { IdentityService } from "../identity";
import type { RealtimeService } from "./service";

interface Subscription {
  phase: "replaying" | "live";
  buffer: DurableFrame[];
  lastSent: number;
  stop: () => Promise<void>;
}

const SESSION_RECHECK_MS = 5 * 60_000;
const CLIENT_EPHEMERAL_TYPE = /^user\.[a-z_.]{1,40}$/;

/**
 * Browser realtime gateway `GET /ws` (research Pattern 5): Origin allowlist + cookie session BEFORE the
 * upgrade, then `sub`/`unsub`/`ping`/`eph` frames. Subscribe = authorize → listen (buffer) → replay from
 * PostgreSQL → flush buffer → live. Exactly-once per (topic, seq) for the client.
 */
export function registerGateway(
  app: App,
  deps: { realtime: RealtimeService; identity: IdentityService; allowedOrigins: Set<string> },
) {
  app.get(
    "/ws",
    {
      websocket: true,
      schema: { hide: true },
      onRequest: async (req, reply) => {
        const origin = req.headers.origin;
        if (!origin || !deps.allowedOrigins.has(origin)) {
          return reply.code(403).send({ error: { code: "forbidden_origin", message: "Origin not allowed" } });
        }
        const auth = await deps.identity.authenticate(req.headers);
        if (!auth)
          return reply.code(401).send({ error: { code: "unauthorized", message: "Sign in required" } });
        req.auth = auth;
      },
    },
    (socket: WebSocket, req: FastifyRequest) => {
      const auth = req.auth as AuthContext;
      const subs = new Map<string, Subscription>();
      const send = (frame: ServerFrame) => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame));
      };

      const recheck = setInterval(async () => {
        const still = await deps.identity.authenticate(req.headers).catch(() => null);
        if (!still) socket.close(4401, "session expired");
      }, SESSION_RECHECK_MS);

      const unsub = async (topic: string) => {
        const s = subs.get(topic);
        subs.delete(topic);
        await s?.stop();
      };

      const subscribe = async (topic: string, afterSeq: number) => {
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
        };
        subs.set(topic, sub);
        sub.stop = await deps.realtime.listen(topic, (frame) => {
          if (subs.get(topic) !== sub) return;
          if (frame.op === "eph") return send(frame);
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
            subscribe(frame.topic, frame.afterSeq ?? 0).catch((err: unknown) => {
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
        clearInterval(recheck);
        for (const topic of [...subs.keys()]) void unsub(topic);
      });
    },
  );
}
