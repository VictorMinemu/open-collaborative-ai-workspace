import { z } from "zod";
import { Id, IsoDateTime } from "./common";
import { Permission } from "./permissions";
import { DeviceRuntimeCompatibility, DeviceRuntimeMaintenance } from "./runtime-maintenance";
import { PermissionMode, RuntimeId } from "./session-events";
import { RepoTeamProject } from "./work-projects";

export const DevicePlatform = z.enum(["darwin", "linux", "win32"]);
export type DevicePlatform = z.infer<typeof DevicePlatform>;
/**
 * How the daemon runs (07.16, D-03, PD-18): `service` = a headless daemon run by systemd or launchd (ADR-0033);
 * `desktop` = supervised by the desktop app. Reported by the device only (`DeviceInfo.host` on the Device Link hello);
 * no server or web route sets it. Lives here, not in `device-link.ts`, because `device-link.ts` imports this module.
 */
export const DeviceHostKind = z.enum(["desktop", "service"]);
export type DeviceHostKind = z.infer<typeof DeviceHostKind>;

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
  /**
   * 07.16 (D-03, PD-18): how the daemon runs (`service` = headless systemd/launchd, `desktop` = desktop app); reported by
   * the daemon only. null = not reported yet (older daemons); absent on older payloads.
   */
  hostKind: DeviceHostKind.nullable().optional(),
  /**
   * 07.16 (D-19): the device owner marked it an isolated server (reported by the daemon only; the API honours it only
   * for `service` hosts). Absent = false.
   */
  isolatedServer: z.boolean().optional(),
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
  /**
   * Phase 07.11: runtime versions, install method, update state; the device owner and admins only (`device.maintain`,
   * D-06, D-11); filled by the API from the device's own reports. Absent for everyone else and for older payloads.
   */
  runtimeMaintenance: DeviceRuntimeMaintenance.optional(),
  /**
   * Phase 07.11: per runtime, what the Control Plane's manifest says about the installed version; everyone who sees
   * the device (D-04).
   */
  runtimeCompatibility: DeviceRuntimeCompatibility.optional(),
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
  // Phase 07.12 (D-06): filled by the API for both pairing paths (typed code and device code) since 07.12; older APIs
  // omit them. The runtime keeps them in runtime.json so `setup` and `doctor` can say which device this is, where its
  // Settings › Devices page is and whom it was paired with.
  /** The device's name as stored (the approver may have changed the proposed one). */
  name: z.string().max(80).optional(),
  /** The workspace's web origin (`OCW_PUBLIC_WEB_URL`), for the Settings › Devices link. */
  webUrl: z.url().optional(),
  /** The organization the device now belongs to. */
  organizationName: z.string().max(200).optional(),
  /** The member who owns the device (who created the code or approved the pairing). */
  ownerName: z.string().max(200).optional(),
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
  /**
   * Phase 07.9 (R5): the team project the repository is linked to and the default its new sessions take; null = a
   * personal repository. Optional so older payloads parse.
   */
  teamProject: RepoTeamProject.nullable().optional(),
  /**
   * Phase 07.9 (D-14): true when the repository is linked to a team project the caller cannot open. Only its device
   * owner lists it then, without the project (`teamProject` is null) and without a way to start a session on it
   * ("Linked to a project you can't open"). Absent = false.
   */
  teamProjectHidden: z.boolean().optional(),
});
export type Project = z.infer<typeof Project>;

export const ProjectList = z.object({ projects: z.array(Project) });
export type ProjectList = z.infer<typeof ProjectList>;
