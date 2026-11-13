import {
  DEVICE_LINK_PROTOCOL_VERSION,
  type DeviceProjectAnnouncement,
  DeviceToServerFrame,
  EventTypes,
  type ServerToDeviceFrame,
} from "@ocw/contracts";
import { projects } from "@ocw/db";
import { and, eq, isNull, notInArray, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import type { App, Core } from "../../core";
import { sha256Hex } from "../../lib/crypto";
import { createPermissionService } from "../organization";
import { authenticateDeviceJwt } from "./auth";
import type { DeviceHub, DeviceRef } from "./hub";
import { bearerValue, looksLikeJwt } from "./token";

/** A device still using its raw token is warned and audited at most once per this window. */
export const LEGACY_TOKEN_AUDIT_EVERY_MS = 60 * 60_000;
const HELLO_TIMEOUT_MS = 10_000;
const IDLE_TIMEOUT_MS = 60_000;
const TOUCH_EVERY_MS = 30_000;

/** Anything that looks like a host path (POSIX, home, Windows drive, UNC, file URL). */
export function looksAbsolute(value: string): boolean {
  return /^(\/|~|[A-Za-z]:[\\/]|\\\\|file:)/i.test(value.trim());
}

/** Project announcements that may be stored: never an absolute path in any field (AGENTS principle 7). */
export function sanitizeAnnouncements(list: DeviceProjectAnnouncement[]): DeviceProjectAnnouncement[] {
  const out: DeviceProjectAnnouncement[] = [];
  for (const p of list) {
    if (looksAbsolute(p.localId) || looksAbsolute(p.name) || /[\\/]/.test(p.name)) continue;
    out.push({ ...p, gitRemote: p.gitRemote && looksAbsolute(p.gitRemote) ? null : p.gitRemote });
  }
  return out;
}

/**
 * `GET /runtime/ws` — the Device Link. The credential is verified BEFORE the upgrade:
 * - a 10-minute device JWT (aud `ocw:device-link`, from `POST /api/v1/devices/token`) verified against the
 *   JWKS, then the device row re-checked (a revoked device is refused even with a JWT it still holds), through
 *   `authenticateDeviceJwt` (`auth.ts`, shared with the file transfer route, 07.17.1.1 PD-05);
 * - the raw device token (SHA-256 lookup), only while `OCW_ACCEPT_LEGACY_DEVICE_TOKEN` is true, for desktop
 *   apps built before Phase 2 (D-03): warned and audited (`device.legacy_token_used`) once per device per hour.
 * Either way the resolver decides `device.link` for the device principal. A user JWT never verifies here.
 * The first frame must be `hello`; afterwards frames are processed strictly in order.
 */
export function registerDeviceLink(app: App, core: Core, hub: DeviceHub): void {
  const perms = createPermissionService(core);
  const acceptLegacyToken = core.env.OCW_ACCEPT_LEGACY_DEVICE_TOKEN;
  /** deviceId → when its legacy-token use was last warned and audited (this API instance). */
  const legacyAuditedAt = new Map<string, number>();

  /** Raw device token (pre-Phase 2 desktop apps) → its non-revoked device, with `device.link` decided. */
  async function deviceFromLegacyToken(req: FastifyRequest, token: string): Promise<DeviceRef | null> {
    if (!acceptLegacyToken) return null;
    const found = await core.db.lookups.deviceByTokenHash(sha256Hex(token));
    if (!found) return null;
    req.device = found;
    const allowed = await core.db.withTenant({ organizationId: found.organizationId, userId: null }, (tx) =>
      perms.can(req, tx, "device.link"),
    );
    if (!allowed) return null;
    await noteLegacyUse(req, found);
    return found;
  }

  /** Warn and audit a legacy-token connection, at most once per device per hour. Never fails the upgrade. */
  async function noteLegacyUse(req: FastifyRequest, device: DeviceRef): Promise<void> {
    const now = Date.now();
    const last = legacyAuditedAt.get(device.deviceId);
    if (last !== undefined && now - last < LEGACY_TOKEN_AUDIT_EVERY_MS) return;
    legacyAuditedAt.set(device.deviceId, now);
    req.log.warn(
      { deviceId: device.deviceId },
      "device connected with its legacy device token; rebuild the desktop app (OCW_ACCEPT_LEGACY_DEVICE_TOKEN)",
    );
    try {
      await core.db.withTenant({ organizationId: device.organizationId, userId: null }, (tx) =>
        core.audit.record(tx, {
          action: "device.legacy_token_used",
          resourceType: "device",
          resourceId: device.deviceId,
          actorKind: "device",
          actorId: device.deviceId,
          deviceId: device.deviceId,
          userId: null,
          result: "success",
        }),
      );
    } catch (err) {
      legacyAuditedAt.delete(device.deviceId);
      req.log.warn({ err, deviceId: device.deviceId }, "could not audit a legacy device token use");
    }
  }

  app.get(
    "/runtime/ws",
    {
      websocket: true,
      config: { authz: "device" },
      schema: { hide: true },
      onRequest: async (req, reply) => {
        const token = bearerValue(req.headers);
        const found = !token
          ? null
          : looksLikeJwt(token)
            ? await authenticateDeviceJwt(core, perms, req, token)
            : await deviceFromLegacyToken(req, token);
        if (!found) {
          req.device = undefined;
          return reply.code(401).send({ error: { code: "unauthorized", message: "Invalid device token" } });
        }
        req.device = found;
      },
    },
    (socket: WebSocket, req: FastifyRequest) => {
      const device = req.device as DeviceRef;
      const log = req.log.child({ deviceId: device.deviceId });
      let helloDone = false;
      let lastFrameAt = Date.now();
      let lastTouch = Date.now();
      let chain: Promise<void> = Promise.resolve();

      const send = (frame: ServerToDeviceFrame) => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame));
      };

      const helloTimer = setTimeout(() => {
        if (!helloDone) socket.close(4400, "hello expected");
      }, HELLO_TIMEOUT_MS);
      const idleTimer = setInterval(() => {
        if (Date.now() - lastFrameAt > IDLE_TIMEOUT_MS) socket.terminate();
      }, 15_000);

      const handle = async (raw: string) => {
        let json: unknown;
        try {
          json = JSON.parse(raw);
        } catch {
          return send({ type: "error", code: "bad_frame", message: "frames must be JSON" });
        }
        const parsed = DeviceToServerFrame.safeParse(json);
        if (!parsed.success) {
          const type = (json as { type?: unknown } | null)?.type;
          log.warn({ type: String(type) }, "invalid device frame");
          return send({ type: "error", code: "invalid_frame", message: `invalid ${String(type)} frame` });
        }
        const frame = parsed.data;
        if (!helloDone && frame.type !== "hello") {
          return send({ type: "error", code: "hello_required", message: "send hello first" });
        }
        switch (frame.type) {
          case "hello": {
            if (frame.protocolVersion !== DEVICE_LINK_PROTOCOL_VERSION) {
              send({
                type: "error",
                code: "protocol_version",
                message: `server speaks Device Link v${DEVICE_LINK_PROTOCOL_VERSION}`,
              });
              socket.close(4426, "unsupported protocol version");
              return;
            }
            helloDone = true;
            clearTimeout(helloTimer);
            await hub.attach(device, socket, frame);
            return;
          }
          case "projects.sync":
            return syncProjects(frame.projects);
          case "heartbeat":
            if (Date.now() - lastTouch > TOUCH_EVERY_MS) {
              lastTouch = Date.now();
              await hub.touch(device);
            }
            return;
          case "ack":
            return hub.onAck(device, frame);
          case "event":
            return hub.sessionHandler?.onEvent(device, frame);
          case "diff.result":
            return hub.onDiffResult(device, frame);
          case "title.result":
            return hub.onTitleResult(device, frame);
          case "capabilities":
            return hub.onCapabilities(device, frame);
          case "runtime.maintenance":
            return hub.onRuntimeMaintenance(device, frame);
          case "runtime.update.run":
            return hub.onRuntimeUpdateRun(device, frame);
        }
      };

      const syncProjects = async (announced: DeviceProjectAnnouncement[]) => {
        const list = sanitizeAnnouncements(announced);
        const acked = await core.db.withTenant(
          { organizationId: device.organizationId, userId: device.ownerUserId },
          async (tx) => {
            const out: Array<{ localId: string; projectId: string }> = [];
            for (const p of list) {
              const [row] = await tx
                .insert(projects)
                .values({
                  organizationId: device.organizationId,
                  deviceId: device.deviceId,
                  localId: p.localId,
                  name: p.name,
                  gitRemote: p.gitRemote,
                  defaultBranch: p.defaultBranch,
                  git: p.git ?? null,
                  createdBy: device.ownerUserId,
                })
                .onConflictDoUpdate({
                  target: [projects.deviceId, projects.localId],
                  set: {
                    name: p.name,
                    gitRemote: p.gitRemote,
                    defaultBranch: p.defaultBranch,
                    git: p.git ?? null,
                    removedAt: null,
                  },
                })
                .returning({ id: projects.id });
              out.push({ localId: p.localId, projectId: row!.id });
            }
            const keep = list.map((p) => p.localId);
            await tx
              .update(projects)
              .set({ removedAt: sql`now()` })
              .where(
                and(
                  eq(projects.deviceId, device.deviceId),
                  isNull(projects.removedAt),
                  ...(keep.length > 0 ? [notInArray(projects.localId, keep)] : []),
                ),
              );
            await core.realtime.appendEvent(tx, `org:${device.organizationId}`, EventTypes.projectUpdated, {
              deviceId: device.deviceId,
              count: out.length,
            });
            return out;
          },
        );
        send({ type: "projects.ack", projects: acked });
      };

      socket.on("message", (data) => {
        lastFrameAt = Date.now();
        const raw = data.toString();
        chain = chain
          .then(() => handle(raw))
          .catch((err) => {
            log.error({ err }, "device frame handling failed");
          });
      });
      socket.on("close", () => {
        clearTimeout(helloTimer);
        clearInterval(idleTimer);
        if (helloDone) hub.detach(device, socket);
      });
      socket.on("error", (err) => log.warn({ err }, "device socket error"));
    },
  );
}
