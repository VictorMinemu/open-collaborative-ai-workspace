import { z } from "zod";
import { LiveInputFrame } from "./browser";
import { Id, IsoDateTime } from "./common";
import {
  AgentChannelSandboxDeleteResponse,
  AgentChannelSandboxExecResponse,
  AgentChannelSandboxReadResponse,
  AgentChannelSandboxWriteResponse,
  AllowHost,
  BrowserSandboxMode,
  ReviewedTreeEntry,
  SANDBOX_LIMITS,
  SandboxArgv,
  SandboxEgressMode,
  SandboxFileEncoding,
  SandboxFileEntry,
  SandboxFileList,
  SandboxFilePath,
  SandboxPackageName,
  SandboxPackageSource,
  SandboxPackageVersion,
  SandboxProcessId,
  SandboxRelativePath,
  SandboxRuntime,
  SandboxState,
  SandboxStopReason,
  SandboxWriteMode,
  Sha256Hex,
  SiteHost,
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

/**
 * `POST /v1/policy`: everything sandboxd and the egress proxy enforce for one organization. sandboxd holds it in memory
 * only and has no default: until the API pushes it (after every settings change, kill and resume, on a new sandboxd
 * boot, and on a `policy_missing` refusal) an op that would start or run a container answers 409 `policy_missing`.
 * `version` is the organization's settings version (`sandbox_policies.version`, 0 before the first save; every kill and
 * resume bumps it): sandboxd keeps the newest push, so a late, stale push can never undo a kill.
 */
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
  version: z.number().int().nonnegative(),
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

const utf8Bytes = (s: string) => new TextEncoder().encode(s).length;

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
  /**
   * Phase 07.17.1.1.2 (D-03, PD-13): a background command the API saw as `running` (sandboxd answered `running` for it)
   * ended: it exited, was killed or timed out. Emitted once per command. Ids and numbers only, never argv, a path or
   * output (T-07.8-09-04); a lost command (a new boot id) is the API's own conclusion, never an event.
   */
  z.object({
    ...EventBase,
    type: z.literal("process"),
    target: SandboxdTarget,
    processId: SandboxProcessId,
    status: z.enum(["exited", "killed", "timed_out"]),
    exitCode: z.number().int().nullable(),
    durationMs: z.number().int().nonnegative(),
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

/**
 * Codes of sandboxd's non-2xx bodies; the API maps them to a `SandboxRefusal` or `BrowserRefusal`. `policy_missing`
 * (409): sandboxd holds no policy for the organization (it restarted); the API's client pushes the current one and
 * retries the call once.
 */
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
  "policy_missing",
  "timeout",
  "docker_unavailable",
  "limit_reached",
  "no_context",
  "element_gone",
  "navigation_refused",
  /** A person holds the takeover lease: the bot's page ops wait (the brw agent's code; additive, 07.8-08). */
  "paused",
  "digest_mismatch",
  "tree_changed",
]);
export type SandboxdErrorCode = z.infer<typeof SandboxdErrorCode>;

export const SandboxdError = z.object({
  error: z.object({ code: SandboxdErrorCode, message: z.string().max(500) }),
});
export type SandboxdError = z.infer<typeof SandboxdError>;

// ---------------------------------------------------------------- browser (D-05, D-07, D-08, D-13, P-10, P-18)

/*
 * The broker's browser primitives, served by the agent in the bot's `brw` container. There is no page-script, DOM,
 * HTML, cookie, HAR or network-log operation, and no operation takes a selector or a script: elements are named only by
 * the refs of the redacted snapshot. A member's storage state travels only in `contextOpen` and `contextExportState`,
 * between the API, sandboxd and the agent, and is never stored unsealed.
 */

const ContextRef = z.strictObject({ target: SandboxdTarget, contextId: Id });

/** An element ref from the redacted snapshot (never a CSS or XPath selector). */
export const SnapshotRef = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "a snapshot ref");
export type SnapshotRef = z.infer<typeof SnapshotRef>;

/** The only value a redacted node may carry. */
export const REDACTED_VALUE = "[redacted]";

/**
 * One node of the agent's redacting serializer over `Accessibility.getFullAXTree` (P-10). A sensitive or human-typed
 * field is `redacted` and its value is exactly `[redacted]`, so a leaked value cannot pass the broker schema (the API
 * runs the same check again before forwarding).
 */
export const SnapshotNode = z
  .object({
    ref: SnapshotRef,
    role: z.string().min(1).max(64),
    name: z.string().max(200),
    value: z.string().max(2000).nullable(),
    redacted: z.boolean(),
    depth: z.number().int().min(0).max(256),
  })
  .refine((n) => !n.redacted || n.value === REDACTED_VALUE, {
    message: "a redacted node carries only [redacted]",
    path: ["value"],
  });
export type SnapshotNode = z.infer<typeof SnapshotNode>;

export const SnapshotResult = z.object({
  host: z.string().min(1).max(260),
  title: z.string().max(200),
  nodes: z.array(SnapshotNode).max(600),
  text: z.string().max(32_000),
  truncated: z.boolean(),
});
export type SnapshotResult = z.infer<typeof SnapshotResult>;

/** A screenshot for the model, with agent-drawn boxes over every sensitive or human-typed field (`masked` of them). */
export const ScreenshotResult = z.object({
  mimeType: z.enum(["image/jpeg", "image/png"]),
  data: base64Of(SANDBOX_LIMITS.previewImageMaxBytes),
  width: z.number().int().positive().max(4096),
  height: z.number().int().positive().max(4096),
  masked: z.number().int().nonnegative(),
});
export type ScreenshotResult = z.infer<typeof ScreenshotResult>;

/** Playwright `storageState` as JSON text (≤ 2 MiB). Travels only API ↔ sandboxd ↔ agent; sealed at rest (P-09). */
export const StorageStateBlob = z
  .string()
  .refine((s) => utf8Bytes(s) <= 2 * 1024 * 1024, { message: "storage state over 2 MiB" })
  .refine(
    (s) => {
      try {
        const v: unknown = JSON.parse(s);
        return typeof v === "object" && v !== null && !Array.isArray(v);
      } catch {
        return false;
      }
    },
    { message: "a JSON object" },
  );
export type StorageStateBlob = z.infer<typeof StorageStateBlob>;

export const SandboxdViewport = z.strictObject({
  width: z.number().int().min(200).max(4096),
  height: z.number().int().min(200).max(4096),
});
export type SandboxdViewport = z.infer<typeof SandboxdViewport>;

/** An http(s) URL of at most 2000 characters. */
export const SandboxdUrl = z
  .string()
  .max(2000)
  .refine(
    (u) => {
      try {
        const p = new URL(u).protocol;
        return p === "https:" || p === "http:";
      } catch {
        return false;
      }
    },
    { message: "an http(s) URL" },
  );
export type SandboxdUrl = z.infer<typeof SandboxdUrl>;

/** `browserEnsure` output: the bot's `brw` and Chromium's sandbox posture (D-14). */
export const SandboxdBrowserStatus = z.object({
  target: SandboxdTarget,
  state: SandboxState,
  runtime: SandboxRuntime.nullable(),
  browserSandbox: BrowserSandboxMode.nullable(),
});
export type SandboxdBrowserStatus = z.infer<typeof SandboxdBrowserStatus>;

/**
 * A new ephemeral browser context. With a member's sealed session, `memberId` and `storageState` are set and
 * `siteLock` is the session's host: every top-level or pop-up navigation to another host is blocked and reported
 * (D-13, P-18).
 */
export const SandboxdContextOpen = z.strictObject({
  target: SandboxdTarget,
  contextId: Id,
  memberId: Id.optional(),
  storageState: StorageStateBlob.optional(),
  siteLock: SiteHost.optional(),
  viewport: SandboxdViewport,
});
export type SandboxdContextOpen = z.infer<typeof SandboxdContextOpen>;

/** A navigation the site lock stopped: the host only, turned into the requester's approval by the API. */
export const SandboxdBlockedNavigation = z.object({ host: z.string().min(1).max(260) });
export type SandboxdBlockedNavigation = z.infer<typeof SandboxdBlockedNavigation>;

/** `allowCrossSite`: one navigation past the site lock, sent only after the requester approved it. */
export const SandboxdContextNavigate = z.strictObject({
  target: SandboxdTarget,
  contextId: Id,
  url: SandboxdUrl,
  allowCrossSite: z.boolean().optional(),
});
export type SandboxdContextNavigate = z.infer<typeof SandboxdContextNavigate>;

export const SandboxdNavigateResult = z.object({
  host: z.string().min(1).max(260),
  secure: z.boolean(),
  title: z.string().max(200),
  blockedNavigation: SandboxdBlockedNavigation.nullable(),
});
export type SandboxdNavigateResult = z.infer<typeof SandboxdNavigateResult>;

export const SandboxdActAction = z.enum(["click", "type", "select", "press", "scroll"]);
export type SandboxdActAction = z.infer<typeof SandboxdActAction>;

/** One action on a snapshot ref. Typed text is never logged or audited. */
export const SandboxdContextAct = z.strictObject({
  target: SandboxdTarget,
  contextId: Id,
  action: SandboxdActAction,
  ref: SnapshotRef.optional(),
  text: z.string().max(2000).optional(),
  key: z
    .string()
    .regex(/^[A-Za-z0-9+]{1,32}$/, "a key name")
    .optional(),
  option: z.string().max(200).optional(),
  direction: z.enum(["up", "down", "left", "right"]).optional(),
  allowCrossSite: z.boolean().optional(),
});
export type SandboxdContextAct = z.infer<typeof SandboxdContextAct>;

export const SandboxdActResult = z.object({
  navigated: z.boolean(),
  blockedNavigation: SandboxdBlockedNavigation.nullable(),
  download: SandboxdDownloadRef.nullable(),
});
export type SandboxdActResult = z.infer<typeof SandboxdActResult>;

export const SandboxdContextWait = z.strictObject({
  target: SandboxdTarget,
  contextId: Id,
  for: z.enum(["load", "text", "time"]),
  text: z.string().max(200).optional(),
  ms: z.number().int().min(0).max(30_000).optional(),
});
export type SandboxdContextWait = z.infer<typeof SandboxdContextWait>;

export const SandboxdWaitResult = z.object({ ok: z.boolean(), host: z.string().min(1).max(260) });
export type SandboxdWaitResult = z.infer<typeof SandboxdWaitResult>;

/** The context's storage state after a sign-in or at the end of a turn, re-sealed by the API (P-09). */
export const SandboxdExportStateResult = z.object({ storageState: StorageStateBlob });
export type SandboxdExportStateResult = z.infer<typeof SandboxdExportStateResult>;

/** Keep the page open (up to 15 minutes) while a sign-in card or an approval is pending (D-12 U-5). */
export const SandboxdContextHold = z.strictObject({
  target: SandboxdTarget,
  contextId: Id,
  hold: z.boolean(),
  reason: z.enum(["approval", "signin"]).nullable(),
});
export type SandboxdContextHold = z.infer<typeof SandboxdContextHold>;

/**
 * 07.8-21 (additive; D-08, D-13, P-18): site-locks an open context in place, after a member signed in to it by hand
 * (the takeover of a sign-in card). From then on it behaves as a context opened with a sealed session: every top-level
 * or pop-up navigation to another host is blocked and reported, and the state export keeps that host's cookies only.
 * Idempotent for the same host; another host than the one already locked is refused (`invalid_request`).
 */
export const SandboxdContextLock = z.strictObject({
  target: SandboxdTarget,
  contextId: Id,
  memberId: Id,
  siteLock: SiteHost,
});
export type SandboxdContextLock = z.infer<typeof SandboxdContextLock>;

/** A person holds the lease: bot actions answer `paused`; fields that receive input are redacted from then on. */
export const SandboxdContextTakeover = z.strictObject({
  target: SandboxdTarget,
  contextId: Id,
  active: z.boolean(),
});
export type SandboxdContextTakeover = z.infer<typeof SandboxdContextTakeover>;

/**
 * `mode` (07.8-13, additive): the live view's R10 size. `phone` also turns on mobile emulation and touch at the given
 * size; without it the agent uses `small` or `expanded` for their fixed sizes and a plain viewport otherwise.
 */
export const SandboxdContextResize = z.strictObject({
  target: SandboxdTarget,
  contextId: Id,
  width: z.number().int().min(200).max(4096),
  height: z.number().int().min(200).max(4096),
  mode: z.enum(["small", "expanded", "phone"]).optional(),
});
export type SandboxdContextResize = z.infer<typeof SandboxdContextResize>;

/** `GET /v1/browsers/contexts/frames?orgId=&agentId=&contextId=`: the frame stream of one context. */
export const SandboxdFramesQuery = z.strictObject({ orgId: Id, agentId: Id, contextId: Id });
export type SandboxdFramesQuery = z.infer<typeof SandboxdFramesQuery>;

/** The JSON control message of a frame stream (frame type 1). */
export const SandboxdFrameControl = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("size"),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }),
  z.object({ kind: z.literal("navigated"), host: z.string().min(1).max(260), secure: z.boolean() }),
  z.object({ kind: z.literal("focus"), sensitive: z.boolean() }),
  z.object({ kind: z.literal("closed") }),
]);
export type SandboxdFrameControl = z.infer<typeof SandboxdFrameControl>;

/**
 * Takeover input, forwarded by the API from the controller's live-view socket: each event is the live view's own
 * `LiveInputFrame` (07.8-16 tightened it from a loose record), so sandboxd and the agent receive only the closed set of
 * key, text, mouse, wheel and touch events. Never logged by Fastify, OpenTelemetry, sandboxd or the agent.
 */
export const SandboxdContextInput = z.strictObject({
  target: SandboxdTarget,
  contextId: Id,
  events: z.array(LiveInputFrame).min(1).max(64),
});
export type SandboxdContextInput = z.infer<typeof SandboxdContextInput>;

export const SandboxdContextDownload = z.strictObject({
  target: SandboxdTarget,
  contextId: Id,
  token: SandboxdDownloadToken,
});
export type SandboxdContextDownload = z.infer<typeof SandboxdContextDownload>;

export const SandboxdDownloadContent = z.object({
  name: z.string().min(1).max(255),
  size: z.number().int().nonnegative(),
  mimeType: z.string().max(200).nullable(),
  data: base64Of(SANDBOX_LIMITS.uploadMaxBytes),
});
export type SandboxdDownloadContent = z.infer<typeof SandboxdDownloadContent>;

// ---------------------------------------------------------------- sandbox packages (P-12)

/** Review in a throwaway container through the egress proxy with a registries-only policy. */
export const SandboxdPackageReviewRequest = z.strictObject({
  orgId: Id,
  source: SandboxPackageSource,
  name: SandboxPackageName,
  version: SandboxPackageVersion,
});
export type SandboxdPackageReviewRequest = z.infer<typeof SandboxdPackageReviewRequest>;

const Lockfile = z
  .string()
  .refine((s) => utf8Bytes(s) <= SANDBOX_LIMITS.packageLockfileMaxBytes, { message: "lockfile over 2 MiB" });

/**
 * The resolved tree: every (name, version, integrity) entry, the lockfile (npm `package-lock.json`, the PyPI
 * requirement set with hashes, the Debian closure or the ClawHub tarball record) and `treeSha256` over
 * `packageTreeCanonical(entries)`. The API scores the risk and mints the review token.
 */
export const SandboxdPackageReviewResult = z.object({
  source: SandboxPackageSource,
  name: SandboxPackageName,
  version: SandboxPackageVersion,
  sha256: Sha256Hex,
  sizeBytes: z.number().int().nonnegative(),
  license: z.string().max(100).nullable(),
  publisher: z.string().max(200).nullable(),
  hasInstallScript: z.boolean(),
  dependencyCount: z.number().int().min(0).max(SANDBOX_LIMITS.packageTreeMaxEntries),
  treeSha256: Sha256Hex,
  entries: z.array(ReviewedTreeEntry).max(SANDBOX_LIMITS.packageTreeMaxEntries),
  lockfile: Lockfile,
});
export type SandboxdPackageReviewResult = z.infer<typeof SandboxdPackageReviewResult>;

/** Install the recorded sets only, in a short-lived installer container, into the bot's packages volume. */
export const SandboxdPackageInstall = z.strictObject({
  target: SandboxdTarget,
  packages: z
    .array(
      z.strictObject({
        id: Id,
        source: SandboxPackageSource,
        name: SandboxPackageName,
        version: SandboxPackageVersion,
        sha256: Sha256Hex,
        treeSha256: Sha256Hex,
        lockfile: Lockfile,
      }),
    )
    .min(1)
    .max(200),
});
export type SandboxdPackageInstall = z.infer<typeof SandboxdPackageInstall>;

/**
 * Per package; `digest_mismatch` / `tree_changed` mark the package `package_changed_upstream`. `timeout` (07.8-17): the
 * install outlasted sandboxd's deadline (under the API's 600 s), nothing was written; a later start tries again.
 */
export const SandboxdPackageInstallResult = z.object({
  results: z
    .array(
      z.object({
        id: Id,
        status: z.enum(["installed", "failed"]),
        detail: z.string().max(200),
        code: z.enum(["digest_mismatch", "tree_changed", "timeout"]).optional(),
      }),
    )
    .max(200),
});
export type SandboxdPackageInstallResult = z.infer<typeof SandboxdPackageInstallResult>;

export const SandboxdPackageRemove = z.strictObject({
  target: SandboxdTarget,
  ids: z.array(Id).min(1).max(200),
});
export type SandboxdPackageRemove = z.infer<typeof SandboxdPackageRemove>;

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
  "contextLock",
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
  browserEnsure: {
    method: "POST",
    path: "/v1/browsers/ensure",
    input: TargetOnly,
    output: SandboxdBrowserStatus,
  },
  contextOpen: {
    method: "POST",
    path: "/v1/browsers/contexts/open",
    input: SandboxdContextOpen,
    output: z.object({ contextId: Id }),
  },
  contextNavigate: {
    method: "POST",
    path: "/v1/browsers/contexts/navigate",
    input: SandboxdContextNavigate,
    output: SandboxdNavigateResult,
  },
  contextSnapshot: {
    method: "POST",
    path: "/v1/browsers/contexts/snapshot",
    input: ContextRef,
    output: SnapshotResult,
  },
  contextAct: {
    method: "POST",
    path: "/v1/browsers/contexts/act",
    input: SandboxdContextAct,
    output: SandboxdActResult,
  },
  contextScreenshot: {
    method: "POST",
    path: "/v1/browsers/contexts/screenshot",
    input: ContextRef,
    output: ScreenshotResult,
  },
  contextWait: {
    method: "POST",
    path: "/v1/browsers/contexts/wait",
    input: SandboxdContextWait,
    output: SandboxdWaitResult,
  },
  contextExportState: {
    method: "POST",
    path: "/v1/browsers/contexts/export-state",
    input: ContextRef,
    output: SandboxdExportStateResult,
  },
  contextClose: {
    method: "POST",
    path: "/v1/browsers/contexts/close",
    input: ContextRef,
    output: z.object({ closed: z.literal(true) }),
  },
  contextHold: {
    method: "POST",
    path: "/v1/browsers/contexts/hold",
    input: SandboxdContextHold,
    output: z.object({ held: z.boolean() }),
  },
  contextLock: {
    method: "POST",
    path: "/v1/browsers/contexts/lock",
    input: SandboxdContextLock,
    output: z.object({ locked: z.literal(true) }),
  },
  contextTakeover: {
    method: "POST",
    path: "/v1/browsers/contexts/takeover",
    input: SandboxdContextTakeover,
    output: z.object({ active: z.boolean() }),
  },
  contextResize: {
    method: "POST",
    path: "/v1/browsers/contexts/resize",
    input: SandboxdContextResize,
    output: Applied,
  },
  contextFrames: {
    method: "GET",
    path: "/v1/browsers/contexts/frames",
    input: SandboxdFramesQuery,
    output: SandboxdFrameControl,
    stream: true,
  },
  contextInput: {
    method: "POST",
    path: "/v1/browsers/contexts/input",
    input: SandboxdContextInput,
    output: z.object({ accepted: z.number().int().nonnegative() }),
  },
  contextDownload: {
    method: "POST",
    path: "/v1/browsers/contexts/download",
    input: SandboxdContextDownload,
    output: SandboxdDownloadContent,
  },
  packageReview: {
    method: "POST",
    path: "/v1/packages/review",
    input: SandboxdPackageReviewRequest,
    output: SandboxdPackageReviewResult,
  },
  packageInstall: {
    method: "POST",
    path: "/v1/packages/install",
    input: SandboxdPackageInstall,
    output: SandboxdPackageInstallResult,
  },
  packageRemove: {
    method: "POST",
    path: "/v1/packages/remove",
    input: SandboxdPackageRemove,
    output: Removed,
  },
} as const satisfies Record<SandboxdOp, SandboxdRoute>;

/** The request body (POST) or query (GET) an op takes, before parsing. */
export type SandboxdInput<Op extends SandboxdOp> = z.input<(typeof SANDBOXD_ROUTES)[Op]["input"]>;
/** The parsed response of an op. */
export type SandboxdOutput<Op extends SandboxdOp> = z.output<(typeof SANDBOXD_ROUTES)[Op]["output"]>;
