import {
  DeviceGrant,
  DeviceGrantList,
  DeviceGrantParams,
  EventTypes,
  IdParams,
  Ok,
  PERMISSION_MODE_RANK,
  type PermissionMode,
  PutDeviceGrantRequest,
} from "@ocw/contracts";
import { deviceGrants, devices, orgMembers, orgUnits, type Tx } from "@ocw/db";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { type App, authOf, type Core, tenant } from "../../core";
import { badRequest, conflict, notFound } from "../../lib/errors";
import { memberDirectory, type PermissionService } from "../organization";
import { loadDeviceAccess } from "./access";
import type { DeviceHub } from "./hub";

/**
 * Device grants (Phase 03.2 Plan 05, D-05, ADR-0012 §2): the owner shares a device with chosen members or org
 * units, each capped at a permission mode. Removal is a soft revocation (`revoked_at`) so a removed principal's
 * turns keep being refused (P-07); every change is audited and, when access shrinks, the device's live sessions
 * are re-checked (`onAccessChanged`: stop the ones whose creator lost access, downgrade the others).
 */

export const FULL_ACCESS_OPT_IN_MESSAGE =
  "Turn on Full access on the device first (desktop app › Runtime, or `ocw-runtime full-access on`)";

/** Current (non-revoked) grants of the given devices, with display names (stable ids, principle 11). */
export async function loadGrants(tx: Tx, deviceIds: readonly string[]): Promise<Map<string, DeviceGrant[]>> {
  const out = new Map<string, DeviceGrant[]>();
  if (deviceIds.length === 0) return out;
  // Sequential: one transaction = one connection.
  const rows = await tx
    .select()
    .from(deviceGrants)
    .where(and(inArray(deviceGrants.deviceId, [...deviceIds]), isNull(deviceGrants.revokedAt)))
    .orderBy(asc(deviceGrants.createdAt), asc(deviceGrants.principalId));
  if (rows.length === 0) return out;
  const dir = await memberDirectory(tx);
  const unitIds = rows.filter((r) => r.principalKind === "unit").map((r) => r.principalId);
  const units =
    unitIds.length === 0
      ? new Map<string, string>()
      : new Map(
          (
            await tx
              .select({ id: orgUnits.id, name: orgUnits.name })
              .from(orgUnits)
              .where(inArray(orgUnits.id, unitIds))
          ).map((u) => [u.id, u.name]),
        );
  for (const r of rows) {
    const g: DeviceGrant = {
      principalKind: r.principalKind,
      principalId: r.principalId,
      principalName:
        r.principalKind === "user"
          ? (dir.get(r.principalId)?.displayName ?? null)
          : (units.get(r.principalId) ?? null),
      maxMode: r.maxMode,
      createdAt: new Date(r.createdAt).toISOString(),
    };
    const list = out.get(r.deviceId);
    if (list) list.push(g);
    else out.set(r.deviceId, [g]);
  }
  return out;
}

/** The device's current grants (revoked rows excluded). */
export async function listGrants(tx: Tx, deviceId: string): Promise<DeviceGrant[]> {
  return (await loadGrants(tx, [deviceId])).get(deviceId) ?? [];
}

const lower = (to: PermissionMode, from: PermissionMode) =>
  PERMISSION_MODE_RANK[to] < PERMISSION_MODE_RANK[from];

/** The principal exists in this organization (RLS scopes both reads): an active member or a unit. */
async function assertPrincipal(tx: Tx, kind: "user" | "unit", principalId: string, ownerUserId: string) {
  if (kind === "user") {
    if (principalId === ownerUserId) {
      throw badRequest("The owner already has full use of the device", "owner_principal");
    }
    const [m] = await tx
      .select({ userId: orgMembers.userId })
      .from(orgMembers)
      .where(and(eq(orgMembers.userId, principalId), isNull(orgMembers.deactivatedAt)));
    if (!m) throw badRequest("This person is not an active member of the organization", "unknown_principal");
    return;
  }
  const [u] = await tx.select({ id: orgUnits.id }).from(orgUnits).where(eq(orgUnits.id, principalId));
  if (!u) throw badRequest("This team or department does not exist", "unknown_principal");
}

export function registerDeviceGrantRoutes(
  app: App,
  core: Core,
  hub: DeviceHub,
  perms: PermissionService,
): void {
  const requireUser = core.identity.requireUser;
  const user = { config: { authz: "user" as const }, preHandler: requireUser };
  const tags = ["device"];

  /** A visible, non-revoked device of the caller's organization (404 otherwise), locked for a change. */
  async function loadDevice(tx: Tx, id: string, lock: boolean) {
    const q = tx.select().from(devices).where(eq(devices.id, id));
    const [row] = lock ? await q.for("update") : await q;
    if (!row || row.revokedAt) throw notFound("Device not found");
    return row;
  }

  /** Re-check the device's live sessions once the change is committed (the handler opens its own transaction). */
  async function accessShrank(device: { id: string; organizationId: string }) {
    await hub.sessionHandler?.onAccessChanged(
      { deviceId: device.id, organizationId: device.organizationId },
      "access_changed",
    );
  }

  app.get(
    "/devices/:id/grants",
    { ...user, schema: { tags, params: IdParams, response: { 200: DeviceGrantList } } },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        const auth = authOf(req);
        const row = await loadDevice(tx, req.params.id, false);
        const facts = (await loadDeviceAccess(tx, auth.userId)).facts(row);
        // The owner manages the list; an admin (device.revoke) may read it. Grantees see only their own cap.
        const can = await perms.viewerCan(req, tx, facts, ["device.update", "device.revoke"]);
        if (can.length === 0) await perms.assertCan(req, tx, "device.update", facts);
        return { grants: await listGrants(tx, row.id) };
      }),
  );

  app.put(
    "/devices/:id/grants/:kind/:principalId",
    {
      ...user,
      schema: {
        tags,
        params: DeviceGrantParams,
        body: PutDeviceGrantRequest,
        response: { 200: DeviceGrant },
      },
    },
    async (req) => {
      const { id, kind, principalId } = req.params;
      const { maxMode } = req.body;
      const result = await core.db.withTenant(tenant(req), async (tx) => {
        const auth = authOf(req);
        const row = await loadDevice(tx, id, true);
        await perms.assertCan(req, tx, "device.update", (await loadDeviceAccess(tx, auth.userId)).facts(row));
        await assertPrincipal(tx, kind, principalId, row.ownerUserId);
        // D-05 / D-02: a Full access cap only while the device itself reports the owner's local opt-in.
        if (maxMode === "fullAccess" && !row.fullAccessOptIn) {
          throw conflict(FULL_ACCESS_OPT_IN_MESSAGE, "device_opt_in");
        }
        const [prev] = await tx
          .select({ maxMode: deviceGrants.maxMode, revokedAt: deviceGrants.revokedAt })
          .from(deviceGrants)
          .where(
            and(
              eq(deviceGrants.deviceId, row.id),
              eq(deviceGrants.principalKind, kind),
              eq(deviceGrants.principalId, principalId),
            ),
          );
        const current = prev && prev.revokedAt === null ? prev : null;
        if (current) {
          await tx
            .update(deviceGrants)
            .set({ maxMode })
            .where(
              and(
                eq(deviceGrants.deviceId, row.id),
                eq(deviceGrants.principalKind, kind),
                eq(deviceGrants.principalId, principalId),
              ),
            );
        } else {
          // A new grant, or a re-grant after a removal (an add: the revocation is cleared).
          await tx
            .insert(deviceGrants)
            .values({
              organizationId: auth.organizationId,
              deviceId: row.id,
              principalKind: kind,
              principalId,
              maxMode,
              createdBy: auth.userId,
            })
            .onConflictDoUpdate({
              target: [deviceGrants.deviceId, deviceGrants.principalKind, deviceGrants.principalId],
              set: {
                maxMode,
                createdBy: auth.userId,
                createdAt: sql`now()`,
                revokedAt: null,
                revokedBy: null,
              },
            });
        }
        if (!current || current.maxMode !== maxMode) {
          await core.audit.record(tx, {
            action: current ? "device.grant_updated" : "device.grant_added",
            resourceType: "device",
            resourceId: row.id,
            deviceId: row.id,
            metadata: {
              principalKind: kind,
              principalId,
              maxMode,
              ...(current ? { previousMaxMode: current.maxMode } : {}),
            },
          });
          await core.realtime.appendEvent(tx, `org:${auth.organizationId}`, EventTypes.deviceUpdated, {
            deviceId: row.id,
            status: row.status,
            changed: true,
          });
        }
        const grant = (await listGrants(tx, row.id)).find(
          (g) => g.principalKind === kind && g.principalId === principalId,
        );
        return { row, grant: grant!, shrank: current !== null && lower(maxMode, current.maxMode) };
      });
      if (result.shrank) await accessShrank(result.row);
      return result.grant;
    },
  );

  app.delete(
    "/devices/:id/grants/:kind/:principalId",
    { ...user, schema: { tags, params: DeviceGrantParams, response: { 200: Ok } } },
    async (req) => {
      const { id, kind, principalId } = req.params;
      const row = await core.db.withTenant(tenant(req), async (tx) => {
        const auth = authOf(req);
        const device = await loadDevice(tx, id, true);
        await perms.assertCan(
          req,
          tx,
          "device.update",
          (await loadDeviceAccess(tx, auth.userId)).facts(device),
        );
        // Soft revocation: the row stays so the revoked principal's turns are refused, never floored (P-07).
        const [removed] = await tx
          .update(deviceGrants)
          .set({ revokedAt: sql`now()`, revokedBy: auth.userId })
          .where(
            and(
              eq(deviceGrants.deviceId, device.id),
              eq(deviceGrants.principalKind, kind),
              eq(deviceGrants.principalId, principalId),
              isNull(deviceGrants.revokedAt),
            ),
          )
          .returning({ maxMode: deviceGrants.maxMode });
        if (!removed) throw notFound("Grant not found");
        await core.audit.record(tx, {
          action: "device.grant_removed",
          resourceType: "device",
          resourceId: device.id,
          deviceId: device.id,
          metadata: { principalKind: kind, principalId, maxMode: removed.maxMode },
        });
        await core.realtime.appendEvent(tx, `org:${auth.organizationId}`, EventTypes.deviceUpdated, {
          deviceId: device.id,
          status: device.status,
          changed: true,
        });
        return device;
      });
      await accessShrank(row);
      return { ok: true as const };
    },
  );
}
