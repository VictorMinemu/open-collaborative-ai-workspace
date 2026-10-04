// authz-legacy: 02-05 migrates this file to the resolver
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
import { and, asc, count, eq, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { type App, authOf, type Core, tenant } from "../../core";
import { randomToken, sha256Hex } from "../../lib/crypto";
import { badRequest, conflict, forbidden, gone, notFound } from "../../lib/errors";
import { memberDirectory } from "../organization";
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

/** Devices a user may start sessions on: their own, or shared by their owner. */
export function canUseDevice(row: Pick<DeviceRow, "ownerUserId" | "shared" | "revokedAt">, userId: string) {
  return row.revokedAt === null && (row.ownerUserId === userId || row.shared);
}

export async function listDevices(tx: Tx): Promise<Device[]> {
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
  return rows.map((r) => toDevice(r, dir.get(r.ownerUserId)?.displayName ?? null, byDevice.get(r.id) ?? 0));
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
    lastSeenAt: r.lastSeenAt ? new Date(r.lastSeenAt).toISOString() : null,
    runtimes: runtimesOf(r.runtimeInfo),
    daemonVersion: r.daemonVersion,
    projectCount,
    revokedAt: r.revokedAt ? new Date(r.revokedAt).toISOString() : null,
    createdAt: new Date(r.createdAt).toISOString(),
  };
}

/** Projects on devices the user may use (own or shared), newest device first. */
export async function listUsableProjects(tx: Tx, userId: string): Promise<Project[]> {
  const rows = await tx
    .select({ p: projects, d: devices })
    .from(projects)
    .innerJoin(devices, eq(devices.id, projects.deviceId))
    .where(and(isNull(devices.revokedAt), or(eq(devices.ownerUserId, userId), eq(devices.shared, true))))
    .orderBy(asc(projects.name));
  return rows.map(({ p, d }) => ({
    id: p.id,
    deviceId: d.id,
    deviceName: d.name,
    deviceOnline: d.status === "online",
    name: p.name,
    gitRemote: p.gitRemote,
    defaultBranch: p.defaultBranch,
    available: p.removedAt === null,
    createdAt: new Date(p.createdAt).toISOString(),
  }));
}

export function registerDeviceRoutes(app: App, core: Core, hub: DeviceHub): void {
  const user = { preHandler: core.identity.requireUser };

  app.post(
    "/devices/enrollments",
    { ...user, schema: { tags: ["device"], response: { 200: CreateEnrollmentResponse } } },
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
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
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
    { ...user, schema: { tags: ["device"], response: { 200: DeviceList } } },
    async (req) => ({
      devices: await core.db.withTenant(tenant(req), listDevices),
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
        if (row.ownerUserId !== auth.userId) throw forbidden("Only the device owner can change it");
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
        const isAdmin = auth.role === "admin";
        if (row.ownerUserId !== auth.userId && !isAdmin)
          throw forbidden("Only the owner or an admin can revoke");
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
    { ...user, schema: { tags: ["device"], response: { 200: ProjectList } } },
    async (req) => ({
      projects: await core.db.withTenant(tenant(req), (tx) => listUsableProjects(tx, authOf(req).userId)),
    }),
  );
}
