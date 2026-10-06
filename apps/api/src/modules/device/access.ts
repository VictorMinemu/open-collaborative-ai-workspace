import { minMode, PERMISSION_MODE_RANK, type PermissionMode } from "@ocw/contracts";
import { deviceGrants, type devices, type Tx } from "@ocw/db";
import { deviceResource, loadPrincipalFacts, type ResourceFacts } from "../organization";

/**
 * A member's cap on a device (Phase 03.2, ADR-0012, P-06, P-07). The pure functions decide; `loadDeviceAccess`
 * loads the organization's grants and the member's unit paths once per request (RLS scopes both reads).
 */

export interface GrantRow {
  deviceId: string;
  principalKind: "user" | "unit";
  principalId: string;
  maxMode: PermissionMode;
  revokedAt: string | null;
}

export interface CapPrincipal {
  userId: string;
  /** Ancestor path (root→self) of every unit the member belongs to. */
  memberUnitPaths: readonly (readonly string[])[];
}

export interface CapDevice {
  /** When given, grant rows of any other device are ignored. */
  id?: string;
  ownerUserId: string;
  shared: boolean;
  shareMaxMode: PermissionMode;
}

/** The P-07 upper bound of the floor for controllers with no relation to the device (mirrors controls.ts). */
const FLOOR_BOUND: PermissionMode = "acceptEdits";

const higher = (a: PermissionMode | null, b: PermissionMode): PermissionMode =>
  a === null || PERMISSION_MODE_RANK[b] > PERMISSION_MODE_RANK[a] ? b : a;

/** The row names this member: their user grant, or a unit grant on one of their unit paths. */
function matches(g: GrantRow, p: CapPrincipal): boolean {
  if (g.principalKind === "user") return g.principalId === p.userId;
  return p.memberUnitPaths.some((path) => path.includes(g.principalId));
}

/**
 * PURE (P-06). Owner → fullAccess; otherwise the highest of `shareMaxMode` (when shared with everyone) and every
 * matching current grant on the device. Revoked rows never match. null = no access.
 */
export function deviceModeCap(
  device: CapDevice,
  grants: readonly GrantRow[],
  principal: CapPrincipal,
): PermissionMode | null {
  if (device.ownerUserId === principal.userId) return "fullAccess";
  let cap: PermissionMode | null = device.shared ? device.shareMaxMode : null;
  for (const g of current(device, grants)) {
    if (matches(g, principal)) cap = higher(cap, g.maxMode);
  }
  return cap;
}

/**
 * PURE (P-07). The cap of an in-session controller with no relation to the device:
 * min(acceptEdits, shareMaxMode, the lowest maxMode among the device's current grants), so an unlisted member
 * never gets more than any listed grantee and the owner can lower it with `shareMaxMode`.
 */
export function deviceControllerFloor(
  device: { id?: string; shareMaxMode: PermissionMode },
  grants: readonly GrantRow[],
): PermissionMode {
  let floor = minMode(FLOOR_BOUND, device.shareMaxMode);
  for (const g of current(device, grants)) floor = minMode(floor, g.maxMode);
  return floor;
}

/** PURE. A revoked row (of the device's rows) names this member (user row, or unit row on one of their paths). */
export function isRevokedPrincipal(grants: readonly GrantRow[], principal: CapPrincipal): boolean {
  return grants.some((g) => g.revokedAt !== null && matches(g, principal));
}

/** The device's current (non-revoked) rows. */
function current(device: { id?: string }, grants: readonly GrantRow[]): GrantRow[] {
  return grants.filter((g) => g.revokedAt === null && (device.id === undefined || g.deviceId === device.id));
}

type DeviceRow = Pick<
  typeof devices.$inferSelect,
  "id" | "ownerUserId" | "shared" | "shareMaxMode" | "revokedAt"
>;

/** One member's access to every device of the organization (loaded once per request). */
export interface DeviceAccess {
  readonly principal: CapPrincipal;
  /** The member's cap on the device (P-06); null = no access of their own. */
  capOf(row: DeviceRow): PermissionMode | null;
  /** The device's floor for unlisted in-session controllers (P-07). */
  floorOf(row: DeviceRow): PermissionMode;
  /** A revoked grant on the device names the member. */
  revokedOn(row: DeviceRow): boolean;
  /** Resolver facts with the member's cap (owner / grantee / full_access_grantee, revoked state). */
  facts(row: DeviceRow): ResourceFacts;
}

export async function loadDeviceAccess(tx: Tx, userId: string): Promise<DeviceAccess> {
  // Sequential: one transaction = one connection.
  const rows = await tx
    .select({
      deviceId: deviceGrants.deviceId,
      principalKind: deviceGrants.principalKind,
      principalId: deviceGrants.principalId,
      maxMode: deviceGrants.maxMode,
      revokedAt: deviceGrants.revokedAt,
    })
    .from(deviceGrants);
  const facts = await loadPrincipalFacts(tx, { kind: "user", userId });
  const principal: CapPrincipal = { userId, memberUnitPaths: facts.memberUnitPaths };
  const byDevice = new Map<string, GrantRow[]>();
  for (const r of rows) {
    const g: GrantRow = { ...r, revokedAt: r.revokedAt ? new Date(r.revokedAt).toISOString() : null };
    const list = byDevice.get(g.deviceId);
    if (list) list.push(g);
    else byDevice.set(g.deviceId, [g]);
  }
  const of = (row: DeviceRow) => byDevice.get(row.id) ?? [];
  const capOf = (row: DeviceRow) => deviceModeCap(row, of(row), principal);
  return {
    principal,
    capOf,
    floorOf: (row) => deviceControllerFloor(row, of(row)),
    revokedOn: (row) => isRevokedPrincipal(of(row), principal),
    facts: (row) =>
      deviceResource(
        {
          ownerUserId: row.ownerUserId,
          shared: row.shared,
          revoked: row.revokedAt !== null,
          cap: capOf(row),
        },
        userId,
      ),
  };
}
