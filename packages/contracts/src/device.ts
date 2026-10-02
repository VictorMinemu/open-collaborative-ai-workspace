import { z } from "zod";
import { Id, IsoDateTime } from "./common";
import { RuntimeId } from "./session-events";

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

export const Device = z.object({
  id: Id,
  ownerUserId: Id,
  ownerName: z.string().nullable(),
  name: z.string(),
  platform: z.string(),
  status: DeviceStatus,
  /** The owner lets other members of the organization start sessions on this device. */
  shared: z.boolean(),
  lastSeenAt: IsoDateTime.nullable(),
  runtimes: z.array(RuntimeInfo),
  daemonVersion: z.string().nullable(),
  projectCount: z.number().int().nonnegative(),
  revokedAt: IsoDateTime.nullable(),
  createdAt: IsoDateTime,
});
export type Device = z.infer<typeof Device>;

export const DeviceList = z.object({ devices: z.array(Device) });
export type DeviceList = z.infer<typeof DeviceList>;

export const UpdateDeviceRequest = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  shared: z.boolean().optional(),
});
export type UpdateDeviceRequest = z.infer<typeof UpdateDeviceRequest>;

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
