import { z } from "zod";
import { Id, IsoDateTime } from "./common";

export const DevicePlatform = z.enum(["darwin", "linux", "win32"]);
export const DeviceStatus = z.enum(["online", "offline"]);
export type DeviceStatus = z.infer<typeof DeviceStatus>;

export const RuntimeId = z.enum(["claude-code"]);
export type RuntimeId = z.infer<typeof RuntimeId>;

export const RuntimeInfo = z.object({
  id: RuntimeId,
  installed: z.boolean(),
  version: z.string().nullable(),
  loggedIn: z.boolean(),
});
export type RuntimeInfo = z.infer<typeof RuntimeInfo>;

export const Device = z.object({
  id: Id,
  ownerUserId: Id,
  name: z.string(),
  platform: DevicePlatform,
  status: DeviceStatus,
  lastSeenAt: IsoDateTime.nullable(),
  runtimes: z.array(RuntimeInfo),
  revokedAt: IsoDateTime.nullable(),
  createdAt: IsoDateTime,
});
export type Device = z.infer<typeof Device>;

export const DeviceList = z.object({ devices: z.array(Device) });

export const CreateEnrollmentResponse = z.object({
  /** Short human-typeable pairing code, valid 10 minutes, single use. */
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
  name: z.string(),
  gitRemote: z.string().nullable(),
  defaultBranch: z.string().nullable(),
  createdAt: IsoDateTime,
});
export type Project = z.infer<typeof Project>;

export const ProjectList = z.object({ projects: z.array(Project) });
