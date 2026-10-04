import {
  AGENT_CHANNEL_BASE_PATH,
  AgentChannelClientFrame,
  type AgentChannelServerFrame,
  cellTopic,
  type DurableFrame,
} from "@ocw/contracts";
import type { FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import { markDecided } from "../../authz";
import type { App, Core } from "../../core";
import type { PermissionService } from "../organization";
import type { CellAuth, CellPrincipal } from "./auth";
import type { CellPresence } from "./presence";

const HEARTBEAT_MS = 20_000;

/** Every durable cell event carries its own seq inside `data` too (the plugin's resume cursor). */
function withSeq(frame: DurableFrame): DurableFrame {
  const data = typeof frame.data === "object" && frame.data !== null ? frame.data : {};
  return { ...frame, data: { ...data, seq: frame.seq } };
}

/**
 * `GET /agent-channel/v1/ws` — one outbound WebSocket per OpenClaw cell (A2.1). Bearer cell token checked
 * BEFORE the upgrade; requests carrying a browser `Origin` are refused (no cross-site use). Frames reuse the
 * browser envelope: `sub{topic:'cell:<cellId>', afterSeq?}` → replay from PostgreSQL then live, exactly once
 * per seq; `ping` → `pong`. `sub` WITHOUT afterSeq starts live (no replay). The authenticated cell is then
 * decided as a principal (`cell.sync`) before the upgrade.
 */
export function registerCellGateway(
  app: App,
  core: Core,
  auth: CellAuth,
  presence: CellPresence,
  perms: PermissionService,
) {
  app.get(
    `${AGENT_CHANNEL_BASE_PATH}/ws`,
    {
      websocket: true,
      config: { authz: "cell" },
      schema: { hide: true },
      onRequest: async (req, reply) => {
        if (req.headers.origin) {
          return reply
            .code(403)
            .send({ error: { code: "forbidden_origin", message: "Browsers cannot open the cell channel" } });
        }
        try {
          const cell = await auth.authenticate(req.headers.authorization);
          if (!cell) {
            await auth.auditFailure(req);
            return reply
              .code(401)
              .send({ error: { code: "invalid_cell_token", message: "A valid cell token is required" } });
          }
          req.cell = cell;
          const decision = await core.db.withTenant(
            { organizationId: cell.organizationId, userId: null },
            (tx) => perms.decide(tx, { kind: "cell", cellId: cell.cellId }, "cell.sync"),
          );
          markDecided(req);
          if (!decision.allowed) {
            return reply.code(403).send({
              error: { code: "forbidden", message: "This cell may not sync", details: decision.denial },
            });
          }
        } catch (err) {
          const status = (err as { statusCode?: number }).statusCode ?? 500;
          return reply.code(status).send({ error: { code: "unavailable", message: (err as Error).message } });
        }
      },
    },
    (socket: WebSocket, req: FastifyRequest) => {
      const cell = req.cell as CellPrincipal;
      const topic = cellTopic(cell.cellId);
      const ctx = { organizationId: cell.organizationId, userId: null };
      let phase: "idle" | "replaying" | "live" = "idle";
      let buffer: DurableFrame[] = [];
      let lastSent = 0;
      let generation = 0;
      let stopListening: (() => Promise<void>) | null = null;
      let alive = true;

      const send = (frame: AgentChannelServerFrame) => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame));
      };
      const conn = presence.connect(cell.organizationId).catch((err: unknown) => {
        req.log.warn({ err }, "cell presence connect failed");
        return null;
      });

      const heartbeat = setInterval(() => {
        if (!alive) {
          socket.terminate();
          return;
        }
        alive = false;
        socket.ping();
        void conn.then((c) => c?.touch()).catch(() => {});
      }, HEARTBEAT_MS);
      socket.on("pong", () => {
        alive = true;
      });

      const subscribe = async (afterSeq: number | undefined) => {
        const gen = ++generation;
        await stopListening?.();
        phase = "replaying";
        buffer = [];
        stopListening = await core.realtime.listen(topic, (frame) => {
          if (gen !== generation || frame.op !== "ev") return;
          if (phase === "replaying") buffer.push(frame);
          else if (frame.seq > lastSent) {
            lastSent = frame.seq;
            send(withSeq(frame));
          }
        });
        if (gen !== generation) return;

        let replayLast = 0;
        if (afterSeq === undefined) {
          // Live only: never re-deliver history to a plugin that has no cursor.
          replayLast = await core.db.withTenant(ctx, (tx) => core.realtime.lastSeq(tx, topic));
          lastSent = replayLast;
        } else {
          lastSent = afterSeq;
          const replay = await core.realtime.replay(ctx, topic, afterSeq);
          if (gen !== generation) return;
          replayLast = replay.lastSeq;
          if (replay.truncated) {
            lastSent = replay.lastSeq;
            send({ op: "resync", topic });
          } else {
            for (const ev of replay.events) {
              lastSent = ev.seq;
              send(withSeq(ev));
            }
          }
        }
        for (const ev of buffer.sort((a, b) => a.seq - b.seq)) {
          if (ev.seq > lastSent) {
            lastSent = ev.seq;
            send(withSeq(ev));
          }
        }
        buffer = [];
        phase = "live";
        send({ op: "subscribed", topic, lastSeq: Math.max(lastSent, replayLast) });
      };

      // Attach synchronously so early frames are never dropped (Pitfall 8).
      socket.on("message", (raw) => {
        alive = true;
        let frame: AgentChannelClientFrame;
        try {
          const parsed = AgentChannelClientFrame.safeParse(JSON.parse(String(raw)));
          if (!parsed.success) return send({ op: "err", code: "bad_frame" });
          frame = parsed.data;
        } catch {
          return send({ op: "err", code: "bad_frame" });
        }
        if (frame.op === "ping") {
          void conn.then((c) => c?.touch()).catch(() => {});
          return send({ op: "pong" });
        }
        if (frame.topic !== topic) {
          return send({
            op: "err",
            code: "forbidden",
            topic: frame.topic,
            message: "This token may only subscribe to its own cell topic",
          });
        }
        subscribe(frame.afterSeq).catch((err: unknown) => {
          req.log.error({ err }, "cell subscribe failed");
          send({ op: "err", code: "subscribe_failed", topic });
        });
      });

      socket.on("close", () => {
        clearInterval(heartbeat);
        generation++;
        void stopListening?.();
        void conn.then((c) => c?.disconnect()).catch(() => {});
      });
    },
  );
}
