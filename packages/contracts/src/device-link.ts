import { z } from "zod";
import { IsoDateTime, RelativePath } from "./common";
import { DeviceHostKind, RuntimeInfo } from "./device";
import {
  InstallMethod,
  RuntimeBuild,
  RuntimeCompatibilityManifest,
  RuntimeMaintenanceStatus,
  RuntimeSelfStatus,
  RuntimeUpdateOutcome,
  RuntimeUpdateOutputText,
  RuntimeUpdatesLevel,
  RuntimeUpdatesLevelSource,
  RuntimeUpdateTarget,
  RuntimeUpdateTrigger,
  RuntimeVersion,
} from "./runtime-maintenance";
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
  /** False when the project folder is in no git repository (the Work Zone works without git). Absent on older devices. */
  git: z.boolean().optional(),
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
  /**
   * Run this device's own detected update for one runtime (Phase 07.11, D-05): payload `RuntimeUpdatePayload` only;
   * acked when accepted, the result arrives as `runtime.update.run` frames.
   */
  "runtime.update",
  /**
   * 07.17.1.1 (D-04, D-08, D-13): write one file of an active, idle session from `GET <serverUrl>/api/v1/runtime/files/
   * <command id>` under the device's own token; payload `SessionFileWritePayload` (a path and bounds, never bytes or a
   * URL). An older daemon acks `invalid command frame`, read as `runtime_too_old`.
   */
  "session.file.write",
  /**
   * 07.17.1.1 (D-03, D-04, D-08): stream one regular file of an active session to `PUT …/<command id>`; payload
   * `SessionFileReadPayload`.
   */
  "session.file.read",
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
  /** 07.16 (PD-18): how the daemon runs. Optional so older daemons stay on protocol v1 (absent = unknown). */
  host: DeviceHostKind.optional(),
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
  /**
   * 07.16 (D-19): the device owner's LOCAL isolated-server mark, honoured by the API only for `service` hosts. Optional
   * so older daemons stay on protocol v1 (absent = false). Never settable from the server or the web.
   */
  isolatedServer: z.boolean().optional(),
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
  /**
   * 07.16 (D-19): the device owner's local isolated-server mark, re-sent when it changes; honoured by the API only for
   * `service` hosts, never settable from the server or the web. Optional for older daemons (absent = off).
   */
  isolatedServer: z.boolean().optional(),
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
  /** False when the project has no git repository: no files, no patch, nothing to compare. Absent on older devices. */
  git: z.boolean().optional(),
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

/**
 * Phase 07.11 (PD-03): the device's runtime maintenance snapshot (versions, install method, update state, the
 * device-local level). Sent in the handshake and on change, only while connected (like `projects.sync`; the next
 * handshake covers offline changes). `runtimeInfo` refreshes the versions the hub otherwise only learns at `hello`.
 * No host path: locations are `~`-relative and display commands path-free by schema.
 */
export const RuntimeMaintenanceFrame = z.object({
  type: z.literal("runtime.maintenance"),
  runtimes: z.array(RuntimeMaintenanceStatus).max(4),
  runtimeInfo: z.array(RuntimeInfo).max(4),
  localLevel: RuntimeUpdatesLevel,
  localLevelSource: RuntimeUpdatesLevelSource,
  effectiveLevel: RuntimeUpdatesLevel,
  /** False until a `runtime.config` arrived (the org level then counts as `notify`, D-10). */
  orgLevelReceived: z.boolean(),
  /**
   * 07.17.1 (PD-04): the device's own OCW runtime, strict. Old APIs strip it (this frame is a plain `z.object`); the
   * API never sends an `ocw-runtime` update command to a daemon whose snapshot lacks it.
   */
  self: RuntimeSelfStatus.optional(),
});
export type RuntimeMaintenanceFrame = z.infer<typeof RuntimeMaintenanceFrame>;

/**
 * Phase 07.11 (PD-03, PD-06): one update run on the device, `started` then `finished` (with its `outcome`; a `started`
 * frame never carries one). Goes through the offline log so no audit is lost; idempotent by the device-generated
 * `runId`. `commandId` ties it to the "Update now" command it answers. `output` is sanitised on the device and scrubbed
 * of host paths again when parsed.
 */
export const RuntimeUpdateRunFrame = z
  .object({
    type: z.literal("runtime.update.run"),
    runId: z.uuid(),
    /** 07.17.1 (PD-04): a runtime CLI or the OCW runtime itself (then `method: "ocw_bundle"`). */
    runtime: RuntimeUpdateTarget,
    trigger: RuntimeUpdateTrigger,
    commandId: z.uuid().optional(),
    phase: z.enum(["started", "finished"]),
    outcome: RuntimeUpdateOutcome.optional(),
    fromVersion: RuntimeVersion.nullable(),
    toVersion: RuntimeVersion.nullable(),
    candidate: RuntimeVersion.nullable(),
    method: InstallMethod,
    output: RuntimeUpdateOutputText.optional(),
    /** 07.17.1: the OCW runtime's builds before and after (12 hex); absent on CLI runs and from older daemons. */
    fromBuild: RuntimeBuild.nullable().optional(),
    toBuild: RuntimeBuild.nullable().optional(),
    at: IsoDateTime,
  })
  .refine((f) => (f.phase === "finished") === (f.outcome !== undefined), {
    message: "a finished run carries an outcome; a started run does not",
    path: ["outcome"],
  });
export type RuntimeUpdateRunFrame = z.infer<typeof RuntimeUpdateRunFrame>;

export const DeviceToServerFrame = z.discriminatedUnion("type", [
  HelloFrame,
  ProjectsSyncFrame,
  HeartbeatFrame,
  AckFrame,
  EventFrame,
  DiffResultFrame,
  CapabilitiesFrame,
  TitleResultFrame,
  RuntimeMaintenanceFrame,
  RuntimeUpdateRunFrame,
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

/**
 * Phase 07.11 (PD-03): the org's runtime updates level and the Control Plane's compatibility manifest. Ephemeral
 * (never queued): sent right after `welcome` and again when the org's level changes; latest wins. It names no command,
 * path or version to install (D-05). Older daemons ignore it.
 */
export const RuntimeConfigFrame = z.object({
  type: z.literal("runtime.config"),
  policy: RuntimeUpdatesLevel,
  manifest: RuntimeCompatibilityManifest,
});
export type RuntimeConfigFrame = z.infer<typeof RuntimeConfigFrame>;

export const ServerToDeviceFrame = z.discriminatedUnion("type", [
  z.object({ type: z.literal("welcome"), deviceId: z.uuid(), organizationId: z.uuid() }),
  CommandFrame,
  z.object({
    type: z.literal("projects.ack"),
    projects: z.array(z.object({ localId: z.string(), projectId: z.uuid() })),
  }),
  z.object({ type: z.literal("error"), code: z.string(), message: z.string() }),
  RuntimeConfigFrame,
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
/** Decoded bytes actually sent per image (the original or its rendition, P-02). */
export const WORK_PROMPT_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
/**
 * The largest server → device frame (P-01): the daemon's WebSocket `maxPayload` and the hub's guard on every outbound
 * frame. A frame above the daemon's limit closes the link (1009) and redelivery would loop, so neither side exceeds it.
 */
export const DEVICE_LINK_MAX_COMMAND_FRAME_BYTES = 32 * 1024 * 1024;
/**
 * 07.17.1.1 (D-14): the largest device → server frame, the API's inbound WebSocket `maxPayload`. A bigger frame closes
 * the link with 1009, so the daemon bounds what it sends (a `diff.result` patch is cut and marked `truncated`).
 */
export const DEVICE_LINK_MAX_DEVICE_FRAME_BYTES = 256 * 1024;
const IMAGE_BASE64_MAX_CHARS = Math.ceil(WORK_PROMPT_IMAGE_MAX_BYTES / 3) * 4;

export const PromptImage = z.object({
  mediaType: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
  dataBase64: z.string().min(1).max(IMAGE_BASE64_MAX_CHARS),
});
export type PromptImage = z.infer<typeof PromptImage>;

const IMAGE_DATA_REMOVED = "[image data removed]";
const DATA_URL = /data:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=_-]*/gi;
const BASE64_RUN = /[A-Za-z0-9+/_-]{200,}={0,2}/g;

/**
 * Removes image bytes from text that may be logged, stored or shown (P-11): base64 data URLs and any base64 run of
 * 200 characters or more become `[image data removed]`. Hashes (64 hex chars) and ordinary text are kept. Used on
 * ack errors, command-failure logs and `session.error` messages, which a runtime may echo an image into.
 */
export function stripImageData(text: string): string {
  return text.replace(DATA_URL, IMAGE_DATA_REMOVED).replace(BASE64_RUN, IMAGE_DATA_REMOVED);
}

export const PromptPayload = z.object({
  promptId: z.string().min(1).max(128),
  text: z.string(),
  images: z.array(PromptImage).max(WORK_PROMPT_MAX_IMAGES).optional(),
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
