import { z } from "zod";
import { RelativePath } from "./common";
import { RuntimeInfo } from "./device";
import { PermissionMode, RuntimeId, SessionEvent } from "./session-events";
import { ContextWindow, EffortLevel, RuntimeCatalog, SessionSettingsPatch } from "./session-settings";
import { TITLE_PROMPT_MAX_CHARS } from "./session-title";

/**
 * Device Link protocol: JSON frames on `GET /runtime/ws` (Authorization: Bearer <device token>).
 * The daemon connects outbound; the API never connects to devices and the daemon never listens on TCP.
 * Frames are discriminated by `type`.
 *
 * Delivery guarantees:
 * - server → device commands are persisted and redelivered (at-least-once) until acked; the daemon
 *   treats a repeated command id as done and acks it again.
 * - device → server events carry a per-session monotonic `localSeq`; the server ignores any event whose
 *   `localSeq` is not greater than the last one it stored for that session (offline-log replay dedupe).
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
  /** Apply settings between turns (D-07, D-14); the device answers with a `session.settings` event. */
  "session.configure",
  /** Ask the session runtime's small model for a short title (D-18, P-15); answered by a `title.result` frame. */
  "session.title",
]);
export type CommandKind = z.infer<typeof CommandKind>;

export const DiffFileStatus = z.enum([
  "added",
  "modified",
  "deleted",
  "renamed",
  "untracked",
  "copied",
  "unmerged",
]);
export type DiffFileStatus = z.infer<typeof DiffFileStatus>;

export const DiffFile = z.object({
  path: z.string().max(1024),
  status: DiffFileStatus,
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  /** Previous path of a rename. */
  oldPath: z.string().max(1024).optional(),
});
export type DiffFile = z.infer<typeof DiffFile>;

export const DeviceInfo = z.object({
  name: z.string().max(200),
  platform: z.string().max(32),
  arch: z.string().max(32).optional(),
  daemonVersion: z.string().max(64).optional(),
  appVersion: z.string().max(64).optional(),
});
export type DeviceInfo = z.infer<typeof DeviceInfo>;

// ---- device → server ----
export const HelloFrame = z.object({
  type: z.literal("hello"),
  protocolVersion: z.number().int(),
  device: DeviceInfo,
  runtimes: z.array(RuntimeInfo),
  /** Work session ids currently alive on the device (lets the server re-attach after a daemon restart). */
  sessions: z.array(z.string().max(128)).max(1000).optional(),
  /**
   * The device owner's LOCAL full-access opt-in (ADR-0012, P-12). Optional so older daemons stay on protocol v1
   * (absent = false). Never settable from the server or the web.
   */
  fullAccessOptIn: z.boolean().optional(),
});
export type HelloFrame = z.infer<typeof HelloFrame>;

/**
 * What each installed runtime offers on this device (P-05): sent after connect and whenever it changes.
 * Collecting it never sends a model turn. Sanitised on the device (no absolute paths, no account e-mail).
 */
export const CapabilitiesFrame = z.object({
  type: z.literal("capabilities"),
  catalogs: z.array(RuntimeCatalog).max(4),
  fullAccessOptIn: z.boolean(),
});
export type CapabilitiesFrame = z.infer<typeof CapabilitiesFrame>;

export const ProjectsSyncFrame = z.object({
  type: z.literal("projects.sync"),
  projects: z.array(DeviceProjectAnnouncement).max(500),
});
export const HeartbeatFrame = z.object({ type: z.literal("heartbeat") });
export const AckFrame = z.object({
  type: z.literal("ack"),
  commandId: z.string().max(128),
  /** Command outcome (absent = ok). */
  ok: z.boolean().optional(),
  error: z.string().max(4000).optional(),
});
export type AckFrame = z.infer<typeof AckFrame>;

export const EventFrame = z.object({
  type: z.literal("event"),
  sessionId: z.uuid(),
  event: SessionEvent,
  /** Per-session monotonic sequence assigned by the device, for de-duplication on replay. */
  localSeq: z.number().int().nonnegative().optional(),
});
export type EventFrame = z.infer<typeof EventFrame>;

export const DiffResultFrame = z.object({
  type: z.literal("diff.result"),
  /** The id of the `diff.request` command this answers. */
  requestId: z.string().max(128),
  sessionId: z.uuid().optional(),
  files: z.array(DiffFile).max(5000),
  patch: z.string().max(2_000_000),
  truncated: z.boolean().optional(),
  branch: z.string().max(255).nullable().optional(),
  headSha: z.string().max(64).nullable().optional(),
});
export type DiffResultFrame = z.infer<typeof DiffResultFrame>;

/**
 * The answer to a `session.title` command (P-15), sent before its ok ack. Lenient bounds on purpose: the API
 * validates the title with `SessionTitle` and refuses (and audits) anything out of shape.
 */
export const TitleResultFrame = z.object({
  type: z.literal("title.result"),
  /** The id of the `session.title` command this answers. */
  requestId: z.string().max(128),
  sessionId: z.uuid(),
  title: z.string().max(200),
  model: z.string().max(200),
});
export type TitleResultFrame = z.infer<typeof TitleResultFrame>;

export const DeviceToServerFrame = z.discriminatedUnion("type", [
  HelloFrame,
  ProjectsSyncFrame,
  HeartbeatFrame,
  AckFrame,
  EventFrame,
  DiffResultFrame,
  CapabilitiesFrame,
  TitleResultFrame,
]);
export type DeviceToServerFrame = z.infer<typeof DeviceToServerFrame>;

// ---- server → device ----
export const CommandFrame = z.object({
  type: z.literal("command"),
  id: z.string().max(128),
  kind: CommandKind,
  /** Platform work session id (always a uuid from the server; parsed leniently on the device). */
  sessionId: z.string().min(1).max(128),
  payload: z.unknown().optional(),
});
export type CommandFrame = z.infer<typeof CommandFrame>;

export const ServerToDeviceFrame = z.discriminatedUnion("type", [
  z.object({ type: z.literal("welcome"), deviceId: z.uuid(), organizationId: z.uuid() }),
  CommandFrame,
  z.object({
    type: z.literal("projects.ack"),
    projects: z.array(z.object({ localId: z.string(), projectId: z.uuid() })),
  }),
  z.object({ type: z.literal("error"), code: z.string(), message: z.string() }),
]);
export type ServerToDeviceFrame = z.infer<typeof ServerToDeviceFrame>;

// ---- command payloads ----
export const SessionStartPayload = z.object({
  projectLocalId: z.string().min(1).max(128),
  runtime: RuntimeId.default("claude-code"),
  /**
   * Explicitly rejects anything outside the allowed set, including `bypassPermissions` and every other runtime
   * bypass literal. The daemon also refuses a mode outside its adapter's `supportsPermissionModes`.
   */
  permissionMode: PermissionMode.default("default"),
  model: z.string().max(200).optional(),
  effort: EffortLevel.optional(),
  fastMode: z.boolean().optional(),
  contextWindow: ContextWindow.optional(),
  /** Run in a dedicated git worktree (`<repo>/.ocw-worktrees/<session>`). */
  worktree: z.boolean().optional(),
  resumeRuntimeSessionId: z.string().max(256).optional(),
});
export type SessionStartPayload = z.infer<typeof SessionStartPayload>;

/**
 * Phase 06.1 (P-01): images on a Work Zone prompt. At most 4 per prompt, each at most 2 MiB as sent to the device
 * (decoded bytes), so a prompt frame stays near 11 MiB of base64 + text, a third of the command frame limit.
 */
export const WORK_PROMPT_MAX_IMAGES = 4;

export const PromptImage = z.object({
  mediaType: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
  dataBase64: z.string(),
});

export const PromptPayload = z.object({
  promptId: z.string().min(1).max(128),
  text: z.string(),
  images: z.array(PromptImage).optional(),
  /** `steer` adds the input to the running turn when the runtime supports it (Codex); otherwise queued. */
  delivery: z.enum(["queue", "steer"]).optional(),
  /**
   * P-07: the most permissive mode this turn may run in (min of the session mode and the author's cap). The
   * adapter lowers to it before the turn and refuses the turn if it cannot.
   */
  permissionMode: PermissionMode.optional(),
});
export type PromptPayload = z.infer<typeof PromptPayload>;

/** `session.configure`: authorized settings (changed keys only), applied by the adapter between turns. */
export const SessionConfigurePayload = z.object({
  settings: SessionSettingsPatch,
  reason: z.enum(["user", "slash_command", "policy", "access_changed", "device_opt_out"]),
});
export type SessionConfigurePayload = z.infer<typeof SessionConfigurePayload>;

export const ApprovalResolvePayload = z.object({
  approvalId: z.string(),
  decision: z.enum(["once", "session", "deny"]),
  comment: z.string().max(2000).optional(),
});
export type ApprovalResolvePayload = z.infer<typeof ApprovalResolvePayload>;

export const DiffRequestPayload = z.object({
  /** Optional when the session is active on this device; required otherwise. */
  projectLocalId: z.string().optional(),
});
export type DiffRequestPayload = z.infer<typeof DiffRequestPayload>;

/** `session.title`: the session runtime, its small model and the start of the first prompt (P-15). */
export const SessionTitlePayload = z.object({
  runtime: RuntimeId,
  model: z.string().min(1).max(200),
  prompt: z.string().min(1).max(TITLE_PROMPT_MAX_CHARS),
});
export type SessionTitlePayload = z.infer<typeof SessionTitlePayload>;

/** Keep only repo-relative paths (server-side defence in depth for AGENTS principle 7). */
export function onlyRelativePaths(paths: readonly string[]): string[] {
  return paths.filter((p) => RelativePath.safeParse(p).success);
}
