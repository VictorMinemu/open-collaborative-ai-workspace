import { z } from "zod";
import { Id, IsoDateTime } from "./common";
import { Permission } from "./permissions";
import { PermissionMode, RuntimeId } from "./session-events";

export const DevicePlatform = z.enum(["darwin", "linux", "win32"]);
export type DevicePlatform = z.infer<typeof DevicePlatform>;
export const DeviceStatus = z.enum(["online", "offline"]);
export type DeviceStatus = z.infer<typeof DeviceStatus>;

export const RuntimeInfo = z.object({
  id: RuntimeId,
  installed: z.boolean(),
  version: z.string().nullable(),
  /** Logged in with the user's own subscription (Claude Pro/Max, ChatGPT). */
  loggedIn: z.boolean(),
});
export type RuntimeInfo = z.infer<typeof RuntimeInfo>;

/** Who a device is shared with (P-06): a member or an org unit (stable ids, principle 11). */
export const DeviceGrantPrincipalKind = z.enum(["user", "unit"]);
export type DeviceGrantPrincipalKind = z.infer<typeof DeviceGrantPrincipalKind>;

export const DeviceGrant = z.object({
  principalKind: DeviceGrantPrincipalKind,
  principalId: Id,
  principalName: z.string().nullable(),
  /** Highest permission mode this principal may use on the device (up to fullAccess with the opt-in). */
  maxMode: PermissionMode,
  createdAt: IsoDateTime,
});
export type DeviceGrant = z.infer<typeof DeviceGrant>;

export const Device = z.object({
  id: Id,
  ownerUserId: Id,
  ownerName: z.string().nullable(),
  name: z.string(),
  platform: z.string(),
  status: DeviceStatus,
  /** The owner lets other members of the organization start sessions on this device. */
  shared: z.boolean(),
  /** The device owner enabled full access on the device itself (reported by the daemon only, ADR-0012). */
  fullAccessOptIn: z.boolean(),
  /** Cap for everyone when `shared` (and the floor for unlisted controllers, P-07). */
  shareMaxMode: PermissionMode,
  /** The caller's cap on this device (Plan 05 fills it). */
  viewerMaxMode: PermissionMode.nullable().optional(),
  /** Explicit grants; owner / admin only (Plan 05 fills it). */
  grants: z.array(DeviceGrant).optional(),
  lastSeenAt: IsoDateTime.nullable(),
  runtimes: z.array(RuntimeInfo),
  daemonVersion: z.string().nullable(),
  projectCount: z.number().int().nonnegative(),
  revokedAt: IsoDateTime.nullable(),
  createdAt: IsoDateTime,
  /** Permissions the caller holds on this resource, decided by the API resolver (UI gating only). */
  viewerCan: z.array(Permission).optional(),
});
export type Device = z.infer<typeof Device>;

/** `POST /api/v1/devices/token`: a 10-minute device JWT exchanged for the long-lived device token (D-03). */
export const DeviceAccessToken = z.object({ token: z.string(), expiresAt: IsoDateTime });
export type DeviceAccessToken = z.infer<typeof DeviceAccessToken>;

export const DeviceList = z.object({ devices: z.array(Device) });
export type DeviceList = z.infer<typeof DeviceList>;

export const UpdateDeviceRequest = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  shared: z.boolean().optional(),
  shareMaxMode: PermissionMode.optional(),
});
export type UpdateDeviceRequest = z.infer<typeof UpdateDeviceRequest>;

/** `PUT /api/v1/devices/:id/grants/:kind/:principalId`. */
export const PutDeviceGrantRequest = z.object({ maxMode: PermissionMode });
export type PutDeviceGrantRequest = z.infer<typeof PutDeviceGrantRequest>;

export const DeviceGrantParams = z.object({ id: Id, kind: DeviceGrantPrincipalKind, principalId: Id });
export type DeviceGrantParams = z.infer<typeof DeviceGrantParams>;

export const DeviceGrantList = z.object({ grants: z.array(DeviceGrant) });
export type DeviceGrantList = z.infer<typeof DeviceGrantList>;

export const CreateEnrollmentResponse = z.object({
  /** Short human-typeable pairing code (`XXXX-XXXX`), valid 10 minutes, single use. */
  code: z.string(),
  expiresAt: IsoDateTime,
});
export type CreateEnrollmentResponse = z.infer<typeof CreateEnrollmentResponse>;

export const EnrollDeviceRequest = z.object({
  code: z.string().trim().min(4).max(32),
  name: z.string().trim().min(1).max(80),
  platform: DevicePlatform,
});
export type EnrollDeviceRequest = z.infer<typeof EnrollDeviceRequest>;

export const EnrollDeviceResponse = z.object({
  deviceId: Id,
  organizationId: Id,
  /** Returned exactly once; the API stores only its sha256. */
  deviceToken: z.string(),
});
export type EnrollDeviceResponse = z.infer<typeof EnrollDeviceResponse>;

/** A repository registered by a device. No absolute path ever (AGENTS principle 7). */
export const Project = z.object({
  id: Id,
  deviceId: Id,
  deviceName: z.string(),
  deviceOnline: z.boolean(),
  name: z.string(),
  gitRemote: z.string().nullable(),
  defaultBranch: z.string().nullable(),
  /** False once the device stopped announcing it (removed locally). */
  available: z.boolean(),
  createdAt: IsoDateTime,
});
export type Project = z.infer<typeof Project>;

export const ProjectList = z.object({ projects: z.array(Project) });
export type ProjectList = z.infer<typeof ProjectList>;
