import { z } from "zod";
import { Id, IsoDateTime } from "./common";
import {
  AgentChannelSandboxDeleteResponse,
  AgentChannelSandboxExecResponse,
  AgentChannelSandboxReadResponse,
  AgentChannelSandboxWriteResponse,
  AllowHost,
  BrowserSandboxMode,
  SANDBOX_LIMITS,
  SandboxArgv,
  SandboxEgressMode,
  SandboxFileEncoding,
  SandboxFileEntry,
  SandboxFileList,
  SandboxFilePath,
  SandboxProcessId,
  SandboxRelativePath,
  SandboxRuntime,
  SandboxState,
  SandboxStopReason,
  SandboxWriteMode,
} from "./sandbox";

/**
 * The `sandboxd` protocol (Phase 07.8, D-11, P-03, Pattern 1). `sandboxd` is the only holder of the Docker API: it
 * listens on the internal `sandbox-control` network only, takes a bearer token, builds every container from a fixed
 * spec plus the org limits pushed by `policy`, and acts only on objects whose `SANDBOXD_LABELS` match the request. It
 * is policy-free plumbing: the API decides and audits every call before it reaches this protocol. sandboxd never calls
 * the API; the API long-polls `events`.
 *
 * This file imports only `sandbox.ts` and `common.ts`.
 */

// ---------------------------------------------------------------- objects

/** Labels every sandboxd object carries; sandboxd itself never carries the label it kills by (D-14). */
export const SANDBOXD_LABELS = {
  sandbox: "ocw.sandbox",
  namespace: "ocw.namespace",
  org: "ocw.org",
  agent: "ocw.agent",
  kind: "ocw.kind",
} as const;

/**
 * Object kinds: the bot's shell (`sbx`), its browser (`brw`), the shared egress proxy, the short-lived package
 * installer and reviewer, and `files`, a network-none helper for people's file operations on a stopped or killed
 * sandbox.
 */
export const SandboxdKind = z.enum(["sbx", "brw", "egress", "installer", "review", "files"]);
export type SandboxdKind = z.infer<typeof SandboxdKind>;

/** Which bot of which organization; sandboxd refuses an object whose labels name another. */
export const SandboxdTarget = z.strictObject({ orgId: Id, agentId: Id });
export type SandboxdTarget = z.infer<typeof SandboxdTarget>;

/** Container limits computed by the API from the org settings (never caller fields of a container spec). */
export const SandboxdLimits = z.strictObject({
  nanoCpus: z.number().int().positive(),
  memoryBytes: z.number().int().positive(),
  pids: z.number().int().positive().max(65_536),
  diskQuotaBytes: z.number().int().positive(),
  idleStopMs: z.number().int().positive(),
});
export type SandboxdLimits = z.infer<typeof SandboxdLimits>;

/** `POST /v1/policy`: everything sandboxd and the egress proxy enforce for one organization. */
export const SandboxdOrgPolicy = z.strictObject({
  orgId: Id,
  sandboxEgress: SandboxEgressMode,
  browserEgress: SandboxEgressMode,
  allowHosts: z.array(AllowHost).max(SANDBOX_LIMITS.allowHostsMax),
  /** 07.4 `egress_private_hosts`: private hosts the admin allowed (the proxy still refuses bot-network addresses). */
  privateHosts: z.array(z.string().min(1).max(260)).max(SANDBOX_LIMITS.allowHostsMax),
  limits: SandboxdLimits,
  browserLimits: SandboxdLimits,
  killed: z.boolean(),
});
export type SandboxdOrgPolicy = z.infer<typeof SandboxdOrgPolicy>;

/** `GET /v1/info`. `dockerOk` is false below Docker 26 (CVE-2024-29018). */
export const SandboxdInfo = z.object({
  version: z.string().max(64),
  namespace: z.string().min(1).max(64),
  dockerVersion: z.string().max(64),
  dockerOk: z.boolean(),
  runtimes: z.array(z.string().max(64)).max(16),
  runtime: SandboxRuntime,
  /** D-14: Chromium's sandbox posture in `brw`; null until a browser has started. */
  browserSandbox: BrowserSandboxMode.nullable().default(null),
});
export type SandboxdInfo = z.infer<typeof SandboxdInfo>;

/** One bot's sandbox as sandboxd sees it. */
export const SandboxdSandboxStatus = z.object({
  target: SandboxdTarget,
  state: SandboxState,
  runtime: SandboxRuntime.nullable(),
  diskBytes: z.number().int().nonnegative(),
  startedAt: IsoDateTime.nullable(),
  lastActiveAt: IsoDateTime.nullable(),
});
export type SandboxdSandboxStatus = z.infer<typeof SandboxdSandboxStatus>;

const TargetOnly = z.strictObject({ target: SandboxdTarget });
const Removed = z.object({ removed: z.number().int().nonnegative() });
const Applied = z.object({ ok: z.literal(true) });

// ---------------------------------------------------------------- exec

/**
 * `POST /v1/sandboxes/exec`: argv in the bot's `sbx` as its non-root user, in `/workspace/<cwd>`. No environment from
 * the caller (`env` is refused); `yieldMs` returns a process id for a command still running.
 */
export const SandboxdExec = z.strictObject({
  target: SandboxdTarget,
  argv: SandboxArgv,
  cwd: SandboxRelativePath,
  timeoutMs: z
    .number()
    .int()
    .min(1000)
    .max(SANDBOX_LIMITS.execTimeoutMaxSeconds * 1000),
  yieldMs: z.number().int().min(0).max(SANDBOX_LIMITS.execYieldMs),
  env: z.never().optional(),
});
export type SandboxdExec = z.infer<typeof SandboxdExec>;

/** The exec response union of `sandbox.ts`, unchanged end to end. */
export const SandboxdExecResult = AgentChannelSandboxExecResponse;
export type SandboxdExecResult = z.infer<typeof SandboxdExecResult>;

export const SandboxdProcess = z.strictObject({
  target: SandboxdTarget,
  processId: SandboxProcessId,
  action: z.enum(["poll", "kill"]),
});
export type SandboxdProcess = z.infer<typeof SandboxdProcess>;

// ---------------------------------------------------------------- lifecycle and usage

export const SandboxdStop = z.strictObject({ target: SandboxdTarget, reason: SandboxStopReason });
export type SandboxdStop = z.infer<typeof SandboxdStop>;

export const SandboxdKillOrg = z.strictObject({ orgId: Id });
export type SandboxdKillOrg = z.infer<typeof SandboxdKillOrg>;

export const SandboxdUsageRequest = z.strictObject({ orgId: Id });
export type SandboxdUsageRequest = z.infer<typeof SandboxdUsageRequest>;

export const SandboxdUsage = z.object({
  orgId: Id,
  running: z.object({ sandboxes: z.number().int().nonnegative(), browsers: z.number().int().nonnegative() }),
  items: z
    .array(
      z.object({
        agentId: Id,
        kind: z.enum(["sbx", "brw"]),
        state: SandboxState,
        diskBytes: z.number().int().nonnegative(),
        /** Cumulative CPU time since the container started. */
        cpuMs: z.number().int().nonnegative(),
      }),
    )
    .max(1000),
});
export type SandboxdUsage = z.infer<typeof SandboxdUsage>;

// ---------------------------------------------------------------- files

/** Base64 text whose decoded size is at most `maxBytes`. */
function base64Of(maxBytes: number) {
  return z
    .string()
    .max(Math.ceil(maxBytes / 3) * 4)
    .regex(/^[A-Za-z0-9+/]*={0,2}$/, "base64");
}

export const SandboxdFilesList = z.strictObject({
  target: SandboxdTarget,
  path: SandboxRelativePath,
  /** Include dot files (the people's tree shows them collapsed; the bot sees everything). */
  hidden: z.boolean().default(true),
});
export type SandboxdFilesList = z.infer<typeof SandboxdFilesList>;

export const SandboxdFilePathRequest = z.strictObject({ target: SandboxdTarget, path: SandboxFilePath });
export type SandboxdFilePathRequest = z.infer<typeof SandboxdFilePathRequest>;

export const SandboxdFilesRead = z.strictObject({
  target: SandboxdTarget,
  path: SandboxFilePath,
  offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(SANDBOX_LIMITS.readMaxBytes).default(SANDBOX_LIMITS.readMaxBytes),
});
export type SandboxdFilesRead = z.infer<typeof SandboxdFilesRead>;

export const SandboxdFilesWrite = z.strictObject({
  target: SandboxdTarget,
  path: SandboxFilePath,
  content: z.string().max(Math.ceil(SANDBOX_LIMITS.writeMaxBytes / 3) * 4),
  encoding: SandboxFileEncoding,
  mode: SandboxWriteMode,
});
export type SandboxdFilesWrite = z.infer<typeof SandboxdFilesWrite>;

export const SandboxdFilesDelete = z.strictObject({
  target: SandboxdTarget,
  path: SandboxFilePath,
  recursive: z.boolean().default(false),
});
export type SandboxdFilesDelete = z.infer<typeof SandboxdFilesDelete>;

/** People's upload and the F-8 import of a conversation attachment: bytes the API already holds, base64. */
export const SandboxdFilesUpload = z.strictObject({
  target: SandboxdTarget,
  path: SandboxFilePath,
  data: base64Of(SANDBOX_LIMITS.uploadMaxBytes),
  /** false → `exists` when the file is there (`upload_exists` 409 for people). */
  overwrite: z.boolean().default(false),
});
export type SandboxdFilesUpload = z.infer<typeof SandboxdFilesUpload>;

export const SandboxdFilesDownload = z.object({
  path: SandboxFilePath,
  name: z.string().min(1).max(255),
  size: z.number().int().nonnegative(),
  data: base64Of(SANDBOX_LIMITS.uploadMaxBytes),
});
export type SandboxdFilesDownload = z.infer<typeof SandboxdFilesDownload>;

const PathSize = z.object({ path: SandboxFilePath, size: z.number().int().nonnegative() });

// ---------------------------------------------------------------- events (long poll)

/** `GET /v1/events?after=&waitMs=`: query strings, so numbers are coerced. */
export const SandboxdEventsQuery = z.strictObject({
  after: z.coerce.number().int().nonnegative().default(0),
  waitMs: z.coerce.number().int().min(0).max(30_000).default(25_000),
});
export type SandboxdEventsQuery = z.infer<typeof SandboxdEventsQuery>;

/** A browser download waiting in `brw`, fetched once with its token (`contextDownload`). */
export const SandboxdDownloadToken = z.string().regex(/^[A-Za-z0-9_-]{16,128}$/, "a download token");
export type SandboxdDownloadToken = z.infer<typeof SandboxdDownloadToken>;

export const SandboxdDownloadRef = z.object({
  name: z.string().min(1).max(255),
  size: z.number().int().nonnegative(),
  token: SandboxdDownloadToken,
});
export type SandboxdDownloadRef = z.infer<typeof SandboxdDownloadRef>;

const EventBase = { seq: z.number().int().positive(), at: IsoDateTime };

export const SandboxdEvent = z.discriminatedUnion("type", [
  z.object({
    ...EventBase,
    type: z.literal("state"),
    target: SandboxdTarget,
    kind: SandboxdKind,
    state: SandboxState,
    reason: SandboxStopReason.nullable(),
  }),
  z.object({
    ...EventBase,
    type: z.literal("usage"),
    target: SandboxdTarget,
    /** CPU time since the previous usage event of this target. */
    cpuMs: z.number().int().nonnegative(),
    diskBytes: z.number().int().nonnegative(),
  }),
  z.object({
    ...EventBase,
    type: z.literal("egress"),
    target: SandboxdTarget,
    kind: SandboxdKind,
    /** Host only: never a path, query or header. */
    host: z.string().min(1).max(260),
    allowed: z.boolean(),
  }),
  z.object({
    ...EventBase,
    type: z.literal("browser"),
    target: SandboxdTarget,
    contextId: Id,
    event: z.enum(["navigated", "download", "crashed", "closed", "focus_sensitive"]),
    host: z.string().min(1).max(260).optional(),
    download: SandboxdDownloadRef.optional(),
  }),
]);
export type SandboxdEvent = z.infer<typeof SandboxdEvent>;

export const SandboxdEventsResponse = z.object({
  /** Random per sandboxd start: a new boot id resets the API's cursor. */
  bootId: z.uuid(),
  events: z.array(SandboxdEvent).max(500),
  nextSeq: z.number().int().nonnegative(),
});
export type SandboxdEventsResponse = z.infer<typeof SandboxdEventsResponse>;

// ---------------------------------------------------------------- errors

/** Codes of sandboxd's non-2xx bodies; the API maps them to a `SandboxRefusal` or `BrowserRefusal`. */
export const SandboxdErrorCode = z.enum([
  "unauthorized",
  "invalid_request",
  "label_mismatch",
  "not_found",
  "exists",
  "invalid_path",
  "too_large",
  "disk_full",
  "busy",
  "killed",
  "timeout",
  "docker_unavailable",
  "limit_reached",
  "no_context",
  "element_gone",
  "navigation_refused",
  "digest_mismatch",
  "tree_changed",
]);
export type SandboxdErrorCode = z.infer<typeof SandboxdErrorCode>;

export const SandboxdError = z.object({
  error: z.object({ code: SandboxdErrorCode, message: z.string().max(500) }),
});
export type SandboxdError = z.infer<typeof SandboxdError>;

// ---------------------------------------------------------------- browser (completed in Task 2)

const ContextRef = z.strictObject({ target: SandboxdTarget, contextId: Id });

// ---------------------------------------------------------------- live frames

/**
 * The frame stream from `brw` through sandboxd to the API (`contextFrames`): each frame is a 4-byte big-endian payload
 * length, a 1-byte type and the payload. Type 0 is one screencast JPEG, type 1 a JSON control message. Frames are never
 * persisted or logged.
 */
export const FRAME_HEADER_BYTES = 5;
export const FRAME_TYPES = { jpeg: 0, control: 1 } as const;
export type FrameType = (typeof FRAME_TYPES)[keyof typeof FRAME_TYPES];
export const FRAME_MAX_PAYLOAD_BYTES = 1_048_576;

const FRAME_TYPE_VALUES: ReadonlySet<number> = new Set(Object.values(FRAME_TYPES));

/** One encoded frame. Throws `RangeError` on an unknown type or a payload over `FRAME_MAX_PAYLOAD_BYTES`. */
export function encodeFrame(type: FrameType, payload: Uint8Array): Uint8Array {
  if (!FRAME_TYPE_VALUES.has(type)) throw new RangeError("unknown frame type");
  if (payload.length > FRAME_MAX_PAYLOAD_BYTES) throw new RangeError("frame payload too large");
  const out = new Uint8Array(FRAME_HEADER_BYTES + payload.length);
  new DataView(out.buffer).setUint32(0, payload.length, false);
  out[4] = type;
  out.set(payload, FRAME_HEADER_BYTES);
  return out;
}

/**
 * The header at the start of `bytes`, or null while fewer than `FRAME_HEADER_BYTES` arrived. Throws `RangeError` on an
 * unknown type or a declared length over `FRAME_MAX_PAYLOAD_BYTES` (the reader drops the stream).
 */
export function decodeFrameHeader(bytes: Uint8Array): { length: number; type: FrameType } | null {
  if (bytes.length < FRAME_HEADER_BYTES) return null;
  const length = new DataView(bytes.buffer, bytes.byteOffset, FRAME_HEADER_BYTES).getUint32(0, false);
  const type = bytes[4] as number;
  if (!FRAME_TYPE_VALUES.has(type)) throw new RangeError("unknown frame type");
  if (length > FRAME_MAX_PAYLOAD_BYTES) throw new RangeError("frame payload too large");
  return { length, type: type as FrameType };
}

// ---------------------------------------------------------------- routes

export const SandboxdOp = z.enum([
  "info",
  "ensure",
  "exec",
  "process",
  "stop",
  "restart",
  "kill",
  "killOrg",
  "purge",
  "usage",
  "policy",
  "filesList",
  "filesStat",
  "filesRead",
  "filesWrite",
  "filesDelete",
  "filesUpload",
  "filesDownload",
  "filesImport",
  "events",
  "browserEnsure",
  "contextOpen",
  "contextNavigate",
  "contextSnapshot",
  "contextAct",
  "contextScreenshot",
  "contextWait",
  "contextExportState",
  "contextClose",
  "contextHold",
  "contextTakeover",
  "contextResize",
  "contextFrames",
  "contextInput",
  "contextDownload",
  "packageReview",
  "packageInstall",
  "packageRemove",
]);
export type SandboxdOp = z.infer<typeof SandboxdOp>;

export interface SandboxdRoute {
  method: "GET" | "POST";
  path: `/v1/${string}`;
  /** JSON body for POST, query string for GET. */
  input: z.ZodType;
  /** JSON response; for a `stream` route, the JSON control message (frame type 1). */
  output: z.ZodType;
  /** The response is a frame stream (`encodeFrame`), not JSON. */
  stream?: true;
}

/** Every sandboxd operation, so `client.call(op, input)` in the API is generic and no later plan edits the client. */
export const SANDBOXD_ROUTES = {
  info: { method: "GET", path: "/v1/info", input: z.strictObject({}), output: SandboxdInfo },
  ensure: { method: "POST", path: "/v1/sandboxes/ensure", input: TargetOnly, output: SandboxdSandboxStatus },
  exec: { method: "POST", path: "/v1/sandboxes/exec", input: SandboxdExec, output: SandboxdExecResult },
  process: {
    method: "POST",
    path: "/v1/sandboxes/process",
    input: SandboxdProcess,
    output: SandboxdExecResult,
  },
  stop: { method: "POST", path: "/v1/sandboxes/stop", input: SandboxdStop, output: SandboxdSandboxStatus },
  restart: {
    method: "POST",
    path: "/v1/sandboxes/restart",
    input: TargetOnly,
    output: SandboxdSandboxStatus,
  },
  kill: { method: "POST", path: "/v1/sandboxes/kill", input: TargetOnly, output: Removed },
  killOrg: { method: "POST", path: "/v1/orgs/kill", input: SandboxdKillOrg, output: Removed },
  purge: { method: "POST", path: "/v1/sandboxes/purge", input: TargetOnly, output: Removed },
  usage: { method: "POST", path: "/v1/usage", input: SandboxdUsageRequest, output: SandboxdUsage },
  policy: { method: "POST", path: "/v1/policy", input: SandboxdOrgPolicy, output: Applied },
  filesList: { method: "POST", path: "/v1/files/list", input: SandboxdFilesList, output: SandboxFileList },
  filesStat: {
    method: "POST",
    path: "/v1/files/stat",
    input: SandboxdFilePathRequest,
    output: SandboxFileEntry,
  },
  filesRead: {
    method: "POST",
    path: "/v1/files/read",
    input: SandboxdFilesRead,
    output: AgentChannelSandboxReadResponse,
  },
  filesWrite: {
    method: "POST",
    path: "/v1/files/write",
    input: SandboxdFilesWrite,
    output: AgentChannelSandboxWriteResponse,
  },
  filesDelete: {
    method: "POST",
    path: "/v1/files/delete",
    input: SandboxdFilesDelete,
    output: AgentChannelSandboxDeleteResponse,
  },
  filesUpload: { method: "POST", path: "/v1/files/upload", input: SandboxdFilesUpload, output: PathSize },
  filesDownload: {
    method: "POST",
    path: "/v1/files/download",
    input: SandboxdFilePathRequest,
    output: SandboxdFilesDownload,
  },
  filesImport: { method: "POST", path: "/v1/files/import", input: SandboxdFilesUpload, output: PathSize },
  events: { method: "GET", path: "/v1/events", input: SandboxdEventsQuery, output: SandboxdEventsResponse },
  browserEnsure: { method: "POST", path: "/v1/browsers/ensure", input: TargetOnly, output: Applied },
  contextOpen: { method: "POST", path: "/v1/browsers/contexts/open", input: ContextRef, output: Applied },
  contextNavigate: {
    method: "POST",
    path: "/v1/browsers/contexts/navigate",
    input: ContextRef,
    output: Applied,
  },
  contextSnapshot: {
    method: "POST",
    path: "/v1/browsers/contexts/snapshot",
    input: ContextRef,
    output: Applied,
  },
  contextAct: { method: "POST", path: "/v1/browsers/contexts/act", input: ContextRef, output: Applied },
  contextScreenshot: {
    method: "POST",
    path: "/v1/browsers/contexts/screenshot",
    input: ContextRef,
    output: Applied,
  },
  contextWait: { method: "POST", path: "/v1/browsers/contexts/wait", input: ContextRef, output: Applied },
  contextExportState: {
    method: "POST",
    path: "/v1/browsers/contexts/export-state",
    input: ContextRef,
    output: Applied,
  },
  contextClose: { method: "POST", path: "/v1/browsers/contexts/close", input: ContextRef, output: Applied },
  contextHold: { method: "POST", path: "/v1/browsers/contexts/hold", input: ContextRef, output: Applied },
  contextTakeover: {
    method: "POST",
    path: "/v1/browsers/contexts/takeover",
    input: ContextRef,
    output: Applied,
  },
  contextResize: { method: "POST", path: "/v1/browsers/contexts/resize", input: ContextRef, output: Applied },
  contextFrames: {
    method: "GET",
    path: "/v1/browsers/contexts/frames",
    input: ContextRef,
    output: Applied,
    stream: true,
  },
  contextInput: { method: "POST", path: "/v1/browsers/contexts/input", input: ContextRef, output: Applied },
  contextDownload: {
    method: "POST",
    path: "/v1/browsers/contexts/download",
    input: ContextRef,
    output: Applied,
  },
  packageReview: { method: "POST", path: "/v1/packages/review", input: TargetOnly, output: Applied },
  packageInstall: { method: "POST", path: "/v1/packages/install", input: TargetOnly, output: Applied },
  packageRemove: { method: "POST", path: "/v1/packages/remove", input: TargetOnly, output: Applied },
} as const satisfies Record<SandboxdOp, SandboxdRoute>;

/** The request body (POST) or query (GET) an op takes, before parsing. */
export type SandboxdInput<Op extends SandboxdOp> = z.input<(typeof SANDBOXD_ROUTES)[Op]["input"]>;
/** The parsed response of an op. */
export type SandboxdOutput<Op extends SandboxdOp> = z.output<(typeof SANDBOXD_ROUTES)[Op]["output"]>;
