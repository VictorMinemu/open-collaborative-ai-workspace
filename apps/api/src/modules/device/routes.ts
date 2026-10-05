import { randomInt } from "node:crypto";
import {
  CreateEnrollmentResponse,
  type Device,
  DeviceList,
  EnrollDeviceRequest,
  EnrollDeviceResponse,
  EventTypes,
  IdParams,
  Ok,
  type Project,
  ProjectList,
  RuntimeInfo,
  UpdateDeviceRequest,
} from "@ocw/contracts";
import { deviceEnrollments, devices, projects, type Tx } from "@ocw/db";
import { and, asc, count, eq, isNull, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { type App, authOf, type Core, tenant } from "../../core";
import { randomToken, sha256Hex } from "../../lib/crypto";
import { badRequest, conflict, gone, notFound } from "../../lib/errors";
import {
  createPermissionService,
  deviceResource,
  memberDirectory,
  type PermissionService,
} from "../organization";
import type { DeviceHub } from "./hub";

export const ENROLLMENT_TTL_MS = 10 * 60_000;
/** Crockford-ish alphabet without look-alikes (0/O, 1/I/L). */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function generatePairingCode(): string {
  let raw = "";
  for (let i = 0; i < 8; i++) raw += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

/** Case/separator-insensitive form that is hashed (users type codes by hand). */
export function normalizePairingCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

const runtimesOf = (value: unknown) => z.array(RuntimeInfo).catch([]).parse(value);

type DeviceRow = typeof devices.$inferSelect;

/** Resolver facts for a device row: owner / grantee (shared) relations and the revoked state. */
export function deviceFacts(row: Pick<DeviceRow, "ownerUserId" | "shared" | "revokedAt">, userId: string) {
  return deviceResource(
    { ownerUserId: row.ownerUserId, shared: row.shared, revoked: row.revokedAt !== null },
    userId,
  );
}

/** Permissions a device card renders controls for (`Device.viewerCan`). */
const DEVICE_VIEWER_CAN = ["device.use", "device.update", "device.revoke"] as const;

async function listDevices(
  req: FastifyRequest,
  tx: Tx,
  perms: PermissionService,
  userId: string,
): Promise<Device[]> {
  const [rows, dir, counts] = await Promise.all([
    tx.select().from(devices).where(isNull(devices.revokedAt)).orderBy(asc(devices.createdAt)),
    memberDirectory(tx),
    tx
      .select({ deviceId: projects.deviceId, n: count() })
      .from(projects)
      .where(isNull(projects.removedAt))
      .groupBy(projects.deviceId),
  ]);
  const byDevice = new Map(counts.map((c) => [c.deviceId, Number(c.n)]));
  const out: Device[] = [];
  for (const r of rows) {
    out.push({
      ...toDevice(r, dir.get(r.ownerUserId)?.displayName ?? null, byDevice.get(r.id) ?? 0),
      viewerCan: await perms.viewerCan(req, tx, deviceFacts(r, userId), DEVICE_VIEWER_CAN),
    });
  }
  return out;
}

export function toDevice(r: DeviceRow, ownerName: string | null, projectCount: number): Device {
  return {
    id: r.id,
    ownerUserId: r.ownerUserId,
    ownerName,
    name: r.name,
    platform: r.platform,
    status: r.status,
    shared: r.shared,
    fullAccessOptIn: r.fullAccessOptIn,
    shareMaxMode: r.shareMaxMode,
    lastSeenAt: r.lastSeenAt ? new Date(r.lastSeenAt).toISOString() : null,
    runtimes: runtimesOf(r.runtimeInfo),
    daemonVersion: r.daemonVersion,
    projectCount,
    revokedAt: r.revokedAt ? new Date(r.revokedAt).toISOString() : null,
    createdAt: new Date(r.createdAt).toISOString(),
  };
}

function toProject({ p, d }: { p: typeof projects.$inferSelect; d: DeviceRow }): Project {
  return {
    id: p.id,
    deviceId: d.id,
    deviceName: d.name,
    deviceOnline: d.status === "online",
    name: p.name,
    gitRemote: p.gitRemote,
    defaultBranch: p.defaultBranch,
    available: p.removedAt === null,
    createdAt: new Date(p.createdAt).toISOString(),
  };
}

export function registerDeviceRoutes(app: App, core: Core, hub: DeviceHub): void {
  const perms = createPermissionService(core);
  const requireUser = core.identity.requireUser;
  const user = { config: { authz: "user" as const }, preHandler: requireUser };

  app.post(
    "/devices/enrollments",
    {
      config: { authz: "user" },
      preHandler: [requireUser, perms.requirePermission("device.pair")],
      schema: { tags: ["device"], response: { 200: CreateEnrollmentResponse } },
    },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        const auth = authOf(req);
        const code = generatePairingCode();
        const expiresAt = new Date(Date.now() + ENROLLMENT_TTL_MS).toISOString();
        await tx.insert(deviceEnrollments).values({
          codeHash: sha256Hex(normalizePairingCode(code)),
          organizationId: auth.organizationId,
          userId: auth.userId,
          expiresAt,
        });
        await core.audit.record(tx, {
          action: "device.enrollment_created",
          resourceType: "device_enrollment",
          metadata: { expiresAt },
        });
        return { code, expiresAt };
      }),
  );

  app.post(
    "/devices/enroll",
    {
      // Authenticated by the one-time pairing code itself (no session yet).
      config: { authz: "public", rateLimit: { max: 20, timeWindow: "1 minute" } },
      schema: { tags: ["device"], body: EnrollDeviceRequest, response: { 200: EnrollDeviceResponse } },
    },
    async (req) => {
      const { code, name, platform } = req.body;
      const codeHash = sha256Hex(normalizePairingCode(code));
      const enrollment = await core.db.lookups.deviceEnrollmentByCodeHash(codeHash);
      if (!enrollment) throw badRequest("This pairing code is not valid", "invalid_code");
      if (enrollment.consumedAt) throw gone("This pairing code was already used", "code_used");
      if (new Date(enrollment.expiresAt).getTime() < Date.now()) {
        throw gone("This pairing code expired. Create a new one in Settings › Devices", "code_expired");
      }
      const deviceToken = `ocwd_${randomToken(32)}`;
      return core.db.withTenant(
        { organizationId: enrollment.organizationId, userId: enrollment.userId },
        async (tx) => {
          const consumed = await tx
            .update(deviceEnrollments)
            .set({ consumedAt: sql`now()` })
            .where(and(eq(deviceEnrollments.codeHash, codeHash), isNull(deviceEnrollments.consumedAt)))
            .returning({ codeHash: deviceEnrollments.codeHash });
          if (consumed.length === 0) throw gone("This pairing code was already used", "code_used");
          const [row] = await tx
            .insert(devices)
            .values({
              organizationId: enrollment.organizationId,
              ownerUserId: enrollment.userId,
              name,
              platform,
              tokenHash: sha256Hex(deviceToken),
            })
            .returning();
          await core.audit.record(tx, {
            action: "device.enrolled",
            resourceType: "device",
            resourceId: row!.id,
            deviceId: row!.id,
            metadata: { name, platform },
          });
          await core.realtime.appendEvent(tx, `org:${enrollment.organizationId}`, EventTypes.deviceUpdated, {
            deviceId: row!.id,
            status: row!.status,
            changed: true,
          });
          return { deviceId: row!.id, organizationId: enrollment.organizationId, deviceToken };
        },
      );
    },
  );

  app.get(
    "/devices",
    {
      config: { authz: "user" },
      preHandler: [requireUser, perms.requirePermission("device.read")],
      schema: { tags: ["device"], response: { 200: DeviceList } },
    },
    async (req) => ({
      devices: await core.db.withTenant(tenant(req), (tx) => listDevices(req, tx, perms, authOf(req).userId)),
    }),
  );

  app.patch(
    "/devices/:id",
    {
      ...user,
      schema: { tags: ["device"], params: IdParams, body: UpdateDeviceRequest, response: { 200: Ok } },
    },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        const auth = authOf(req);
        const [row] = await tx.select().from(devices).where(eq(devices.id, req.params.id));
        if (!row || row.revokedAt) throw notFound("Device not found");
        await perms.assertCan(req, tx, "device.update", deviceFacts(row, auth.userId));
        await tx
          .update(devices)
          .set({
            ...(req.body.name !== undefined ? { name: req.body.name } : {}),
            ...(req.body.shared !== undefined ? { shared: req.body.shared } : {}),
          })
          .where(eq(devices.id, row.id));
        await core.audit.record(tx, {
          action: "device.updated",
          resourceType: "device",
          resourceId: row.id,
          deviceId: row.id,
          metadata: { ...req.body },
        });
        await core.realtime.appendEvent(tx, `org:${auth.organizationId}`, EventTypes.deviceUpdated, {
          deviceId: row.id,
          status: row.status,
          changed: true,
        });
        return { ok: true as const };
      }),
  );

  app.delete(
    "/devices/:id",
    { ...user, schema: { tags: ["device"], params: IdParams, response: { 200: Ok } } },
    async (req) => {
      const auth = authOf(req);
      const revoked = await core.db.withTenant(tenant(req), async (tx) => {
        const [row] = await tx.select().from(devices).where(eq(devices.id, req.params.id));
        if (!row) throw notFound("Device not found");
        if (row.revokedAt) throw conflict("Device already revoked");
        // The owner (relation) or an admin (role).
        await perms.assertCan(req, tx, "device.revoke", deviceFacts(row, auth.userId));
        await tx
          .update(devices)
          .set({ revokedAt: sql`now()`, status: "offline" })
          .where(eq(devices.id, row.id));
        await core.audit.record(tx, {
          action: "device.revoked",
          resourceType: "device",
          resourceId: row.id,
          deviceId: row.id,
          metadata: { name: row.name, ownerUserId: row.ownerUserId },
        });
        await core.realtime.appendEvent(tx, `org:${auth.organizationId}`, EventTypes.deviceUpdated, {
          deviceId: row.id,
          status: "revoked",
          changed: true,
        });
        return { deviceId: row.id, organizationId: row.organizationId, ownerUserId: row.ownerUserId };
      });
      await hub.disconnect(revoked.deviceId, 4403, "device revoked");
      await hub.sessionHandler?.onOffline(revoked);
      return { ok: true as const };
    },
  );

  app.get(
    "/projects",
    {
      config: { authz: "user" },
      preHandler: [requireUser, perms.requirePermission("work_session.read")],
      schema: { tags: ["device"], response: { 200: ProjectList } },
    },
    async (req) => ({
      projects: await core.db.withTenant(tenant(req), async (tx) => {
        const userId = authOf(req).userId;
        const rows = await tx
          .select({ p: projects, d: devices })
          .from(projects)
          .innerJoin(devices, eq(devices.id, projects.deviceId))
          .where(isNull(devices.revokedAt))
          .orderBy(asc(projects.name));
        // Projects on devices the caller may use: their own, or shared by the owner (device.use).
        const usable = await perms.filter(req, tx, rows, "device.use", ({ d }) => deviceFacts(d, userId));
        return usable.map(toProject);
      }),
    }),
  );
}
