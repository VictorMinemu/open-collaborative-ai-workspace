import { z } from "zod";
import { RelativePath } from "./common";
import { RuntimeInfo } from "./device";
import { SessionEvent } from "./session-events";

/**
 * Device Link protocol: frames on `GET /runtime/ws` (Authorization: Bearer <device token>).
 * The daemon connects outbound; the API never connects to devices.
 */

export const DEVICE_LINK_PROTOCOL_VERSION = 1;

export const DeviceProjectAnnouncement = z.object({
  /** Opaque id chosen by the daemon; the absolute path stays in ~/.ocw/projects.json. */
  localId: z.string().min(1).max(128),
  name: z.string().min(1).max(200),
  gitRemote: z.string().max(2048).nullable(),
  defaultBranch: z.string().max(255).nullable(),
});
export type DeviceProjectAnnouncement = z.infer<typeof DeviceProjectAnnouncement>;

export const CommandKind = z.enum([
  "session.start",
  "prompt",
  "interrupt",
  "approval.resolve",
  "session.stop",
  "diff.request",
]);
export type CommandKind = z.infer<typeof CommandKind>;

export const DiffFile = z.object({
  path: RelativePath,
  status: z.enum(["added", "modified", "deleted", "renamed", "untracked"]),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
});
export type DiffFile = z.infer<typeof DiffFile>;

// ---- device → server ----
export const DeviceToServerFrame = z.discriminatedUnion("t", [
  z.object({
    t: z.literal("hello"),
    protocolVersion: z.number().int(),
    device: z.object({ name: z.string(), platform: z.string(), appVersion: z.string().optional() }),
    runtimes: z.array(RuntimeInfo),
  }),
  z.object({ t: z.literal("projects.sync"), projects: z.array(DeviceProjectAnnouncement) }),
  z.object({ t: z.literal("heartbeat"), at: z.string().optional() }),
  z.object({ t: z.literal("ack"), commandId: z.string() }),
  z.object({
    t: z.literal("event"),
    sessionId: z.uuid(),
    /** Daemon-side monotonic counter for offline replay de-duplication. */
    localSeq: z.number().int().nonnegative().optional(),
    event: SessionEvent,
  }),
  z.object({
    t: z.literal("diff.result"),
    requestId: z.string(),
    sessionId: z.uuid(),
    files: z.array(DiffFile),
    patch: z.string().max(2_000_000),
    branch: z.string().nullable().optional(),
  }),
]);
export type DeviceToServerFrame = z.infer<typeof DeviceToServerFrame>;

// ---- server → device ----
export const ServerToDeviceFrame = z.discriminatedUnion("t", [
  z.object({ t: z.literal("welcome"), deviceId: z.uuid(), organizationId: z.uuid() }),
  z.object({
    t: z.literal("command"),
    id: z.string(),
    kind: CommandKind,
    sessionId: z.uuid(),
    payload: z.record(z.string(), z.unknown()),
  }),
  z.object({
    t: z.literal("projects.ack"),
    projects: z.array(z.object({ localId: z.string(), projectId: z.uuid() })),
  }),
  z.object({ t: z.literal("error"), code: z.string(), message: z.string() }),
]);
export type ServerToDeviceFrame = z.infer<typeof ServerToDeviceFrame>;
