import { z } from "zod";
import { Id, IsoDateTime } from "./common";

/**
 * Bot sandboxes (Phase 07.8; SBX-01…05, D-01, D-02, D-11). Every bot works in its own isolated sandbox. The cell
 * reaches it only through the `ocw_sandbox_*` tools, which post to the Agent Channel API (`/agent-channel/v1/sandbox/*`).
 * The API decides and audits every call and then asks `sandboxd`, the only holder of the Docker API, through the
 * protocol in `sandboxd-protocol.ts`. Every request schema here is a strict object: a model-supplied `userId`,
 * `command` or any other unknown key is refused, never ignored.
 *
 * This file imports only `common.ts`, so the broker, the plugin and the fakes can share it without the rest of the
 * contracts' graph.
 */

// ---------------------------------------------------------------- limits

/** Every bound of the sandbox contracts (T-07.8-01-07). Bytes are UTF-8 bytes unless the name says otherwise. */
export const SANDBOX_LIMITS = {
  /** A command that runs longer yields a process id and keeps running (`ocw_sandbox_process` polls it). */
  execYieldMs: 25_000,
  execTimeoutMaxSeconds: 600,
  argvMax: 64,
  argMaxChars: 8192,
  /** stdout and stderr each keep their last bytes. */
  outputTailBytes: 16_384,
  /** The output tail a turn activity step may show (R2). */
  activityOutputBytes: 4096,
  pathMaxChars: 1024,
  readMaxBytes: 262_144,
  writeMaxBytes: 1_048_576,
  uploadMaxBytes: 52_428_800,
  listMaxEntries: 500,
  previewTextMaxBytes: 262_144,
  previewImageMaxBytes: 5_242_880,
  /** Sandbox and browser calls per turn, separate from `MAX_TOOL_CALLS_PER_TURN` (D-11 F-7). */
  callsPerTurn: 40,
  idleStopMinutes: 15,
  allowHostsMax: 64,
  activityStepsMax: 50,
  packageTreeMaxEntries: 5000,
  packageLockfileMaxBytes: 2_097_152,
} as const;

const utf8Bytes = (s: string) => new TextEncoder().encode(s).length;

/** A string of at most `max` UTF-8 bytes. */
function boundedText(max: number, label: string) {
  return z.string().refine((s) => utf8Bytes(s) <= max, { message: `${label} over ${max} bytes` });
}

// ---------------------------------------------------------------- paths

/**
 * A path inside the bot's `/workspace`, relative and normalised: no leading `/`, no `.` or `..` segment, no empty
 * segment (`a//b`, a trailing `/`), no backslash and no NUL. `""` is the workspace root. sandboxd re-checks every path
 * against the real tree (04, 09); absolute host paths never cross the wire (principle 7).
 */
export const SandboxRelativePath = z
  .string()
  .max(SANDBOX_LIMITS.pathMaxChars)
  .refine(
    (p) => {
      if (p === "") return true;
      if (p.includes("\u0000") || p.includes("\\")) return false;
      return p.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
    },
    { message: "must be a normalised path inside the workspace" },
  );
export type SandboxRelativePath = z.infer<typeof SandboxRelativePath>;

/** A workspace path that names a file or folder, never the root. */
export const SandboxFilePath = SandboxRelativePath.refine((p) => p.length > 0, {
  message: "a path is required",
});
export type SandboxFilePath = z.infer<typeof SandboxFilePath>;

// ---------------------------------------------------------------- enums

/** gVisor where the host has it; otherwise hardened runc, the weaker boundary stated in Settings (D-01, D-11). */
export const SandboxRuntime = z.enum(["gvisor", "hardened-runc"]);
export type SandboxRuntime = z.infer<typeof SandboxRuntime>;

/**
 * Chromium's own sandbox posture in `brw` (D-14, spike i): on gVisor with its sandbox on, on runc with its sandbox on,
 * or `container-only` (`--no-sandbox`, only on runc hosts that restrict unprivileged user namespaces; never silently
 * under gVisor). Shown in Settings and recorded in ADR-0029.
 */
export const BrowserSandboxMode = z.enum(["chromium+gvisor", "chromium", "container-only"]);
export type BrowserSandboxMode = z.infer<typeof BrowserSandboxMode>;

export const SandboxState = z.enum([
  "absent",
  "starting",
  "running",
  "stopping",
  "stopped",
  "disk_full",
  "killed",
  "unavailable",
]);
export type SandboxState = z.infer<typeof SandboxState>;

/** Why a sandbox stopped (status view and sandboxd state events). */
export const SandboxStopReason = z.enum(["kill_switch", "disk_full", "idle", "user", "service_down"]);
export type SandboxStopReason = z.infer<typeof SandboxStopReason>;

/** Outbound network of the shell or the browser (D-11): defaults `allowlist` for the shell, `public` for the browser. */
export const SandboxEgressMode = z.enum(["off", "allowlist", "public"]);
export type SandboxEgressMode = z.infer<typeof SandboxEgressMode>;

const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const HOST_RE = new RegExp(`^(\\*\\.)?(${LABEL}(?:\\.${LABEL})*)(?::(\\d{1,5}))?$`);

function hostOk(h: string, wildcard: boolean): boolean {
  if (h.length > 260) return false;
  const m = HOST_RE.exec(h);
  if (!m) return false;
  if (m[1] && (!wildcard || !m[2]?.includes("."))) return false;
  if (m[3] !== undefined) {
    const port = Number(m[3]);
    if (port < 1 || port > 65_535) return false;
  }
  return true;
}

/**
 * An allow-list entry of the egress policy: `host`, `host:port` or `*.example.com` (lower case, no scheme, no path,
 * no user info; a wildcard covers at least a registrable-looking `x.y`).
 */
export const AllowHost = z
  .string()
  .refine((h) => hostOk(h, true), { message: "a lower-case host, host:port or *.domain" });
export type AllowHost = z.infer<typeof AllowHost>;

/** An exact site host (lower case, `:port` when not default), e.g. the browser site lock (P-09, P-18). */
export const SiteHost = z
  .string()
  .refine((h) => hostOk(h, false), { message: "a lower-case host or host:port" });
export type SiteHost = z.infer<typeof SiteHost>;

// ---------------------------------------------------------------- refusals

/** Why a sandbox tool call or people's sandbox route was refused (the model reads the code; never the details). */
export const SandboxRefusal = z.enum([
  "no_trigger",
  "sandbox_off",
  "module_off",
  "bot_off",
  "not_allowed",
  "killed",
  "cap_reached",
  "cpu_budget",
  "disk_full",
  "budget_exhausted",
  "tainted",
  "member_data",
  "audience_narrower",
  "approval_required",
  "approval_pending",
  "approval_denied",
  "approval_used",
  "too_many_pending",
  "policy_changed",
  "service_unavailable",
  "timeout",
  "not_found",
  "too_large",
  "invalid_path",
  "busy",
]);
export type SandboxRefusal = z.infer<typeof SandboxRefusal>;

/**
 * HTTP status per refusal: 403 for decisions (switches, modules, the resolver, taint, D-13 member data, budgets), 404
 * for no live turn and unknown objects, 409 for state and approvals, 413 too large, 422 invalid input, 503 when
 * sandboxd does not answer.
 */
export const SANDBOX_REFUSAL_STATUS: Record<SandboxRefusal, 403 | 404 | 409 | 413 | 422 | 503> = {
  no_trigger: 403,
  sandbox_off: 403,
  module_off: 403,
  bot_off: 403,
  not_allowed: 403,
  killed: 403,
  cap_reached: 403,
  cpu_budget: 403,
  disk_full: 409,
  budget_exhausted: 403,
  tainted: 403,
  member_data: 403,
  audience_narrower: 403,
  approval_required: 409,
  approval_pending: 409,
  approval_denied: 409,
  approval_used: 409,
  too_many_pending: 409,
  policy_changed: 409,
  service_unavailable: 503,
  timeout: 503,
  not_found: 404,
  too_large: 413,
  invalid_path: 422,
  busy: 409,
};

// ---------------------------------------------------------------- Agent Channel bodies (the ocw_sandbox_* tools)

/*
 * Bound to a delivered turn like 07.4's connector tools: the body names only the delivery (`eventId`) and the agent.
 * The human is always the stored turn's user, the conversation the turn's conversation. Refusals are HTTP errors with
 * a `SandboxRefusal` code and `SANDBOX_REFUSAL_STATUS`.
 */

const TurnRef = { eventId: Id, agentId: Id };

/** A sandboxd process handle (opaque, never a host pid). */
export const SandboxProcessId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "a process id");
export type SandboxProcessId = z.infer<typeof SandboxProcessId>;

/** One argv item; the first is the program and is never empty. */
const ArgvItem = z.string().max(SANDBOX_LIMITS.argMaxChars);
export const SandboxArgv = z
  .array(ArgvItem)
  .min(1)
  .max(SANDBOX_LIMITS.argvMax)
  .refine((a) => (a[0] ?? "").length > 0, { message: "argv[0] names the program" });
export type SandboxArgv = z.infer<typeof SandboxArgv>;

/**
 * `POST /agent-channel/v1/sandbox/exec`: run an argv array in the bot's sandbox (never a shell string; `sh -c` is just
 * an argv). `background` returns at once with a process id; otherwise the call yields after 25 s with one.
 */
export const AgentChannelSandboxExec = z.strictObject({
  ...TurnRef,
  argv: SandboxArgv,
  cwd: SandboxRelativePath.optional(),
  timeoutSeconds: z.number().int().min(1).max(SANDBOX_LIMITS.execTimeoutMaxSeconds).optional(),
  background: z.boolean().optional(),
});
export type AgentChannelSandboxExec = z.infer<typeof AgentChannelSandboxExec>;

const OutputTail = boundedText(SANDBOX_LIMITS.outputTailBytes, "output");
const ExecCommon = {
  stdout: OutputTail,
  stderr: OutputTail,
  /** True when stdout or stderr kept only its tail. */
  truncated: z.boolean(),
  durationMs: z.number().int().nonnegative(),
};

/** The outcome of an exec or a process poll/kill: finished, or still running under a process id. */
export const AgentChannelSandboxExecResponse = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("exited"), exitCode: z.number().int(), ...ExecCommon }),
  z.strictObject({ status: z.literal("running"), processId: SandboxProcessId, ...ExecCommon }),
]);
export type AgentChannelSandboxExecResponse = z.infer<typeof AgentChannelSandboxExecResponse>;

/** `POST /agent-channel/v1/sandbox/process`: poll or kill a process an exec yielded. */
export const AgentChannelSandboxProcess = z.strictObject({
  ...TurnRef,
  processId: SandboxProcessId,
  action: z.enum(["poll", "kill"]),
});
export type AgentChannelSandboxProcess = z.infer<typeof AgentChannelSandboxProcess>;

export const SandboxFileEncoding = z.enum(["utf8", "base64"]);
export type SandboxFileEncoding = z.infer<typeof SandboxFileEncoding>;

/** `POST /agent-channel/v1/sandbox/read`: a byte range of one file (text as utf8, anything else as base64). */
export const AgentChannelSandboxRead = z.strictObject({
  ...TurnRef,
  path: SandboxFilePath,
  offset: z.number().int().nonnegative().optional(),
  limit: z.number().int().min(1).max(SANDBOX_LIMITS.readMaxBytes).optional(),
});
export type AgentChannelSandboxRead = z.infer<typeof AgentChannelSandboxRead>;

export const AgentChannelSandboxReadResponse = z.object({
  path: SandboxFilePath,
  content: z.string().max(Math.ceil(SANDBOX_LIMITS.readMaxBytes / 3) * 4),
  encoding: SandboxFileEncoding,
  /** The whole file's size. */
  size: z.number().int().nonnegative(),
  truncated: z.boolean(),
});
export type AgentChannelSandboxReadResponse = z.infer<typeof AgentChannelSandboxReadResponse>;

export const SandboxWriteMode = z.enum(["create", "overwrite", "append"]);
export type SandboxWriteMode = z.infer<typeof SandboxWriteMode>;

/** `POST /agent-channel/v1/sandbox/write`: text into one file; `create` refuses an existing file. */
export const AgentChannelSandboxWrite = z.strictObject({
  ...TurnRef,
  path: SandboxFilePath,
  content: boundedText(SANDBOX_LIMITS.writeMaxBytes, "content"),
  mode: SandboxWriteMode,
});
export type AgentChannelSandboxWrite = z.infer<typeof AgentChannelSandboxWrite>;

export const AgentChannelSandboxWriteResponse = z.object({
  path: SandboxFilePath,
  size: z.number().int().nonnegative(),
});
export type AgentChannelSandboxWriteResponse = z.infer<typeof AgentChannelSandboxWriteResponse>;

/** One entry of a folder listing. `size` is null for folders. */
export const SandboxFileEntry = z.object({
  path: SandboxFilePath,
  name: z.string().min(1).max(255),
  kind: z.enum(["file", "dir"]),
  size: z.number().int().nonnegative().nullable(),
  modifiedAt: IsoDateTime,
  /** Dot files and folders (shown collapsed by the UI). */
  hidden: z.boolean(),
});
export type SandboxFileEntry = z.infer<typeof SandboxFileEntry>;

/** A folder listing: at most 500 entries, `more` counts the rest. */
export const SandboxFileList = z.object({
  path: SandboxRelativePath,
  entries: z.array(SandboxFileEntry).max(SANDBOX_LIMITS.listMaxEntries),
  more: z.number().int().nonnegative(),
});
export type SandboxFileList = z.infer<typeof SandboxFileList>;

/** `POST /agent-channel/v1/sandbox/list`: one folder (`""` = the workspace root). */
export const AgentChannelSandboxList = z.strictObject({ ...TurnRef, path: SandboxRelativePath });
export type AgentChannelSandboxList = z.infer<typeof AgentChannelSandboxList>;

/** `POST /agent-channel/v1/sandbox/delete`: a file, or a folder with `recursive`. Never the root. */
export const AgentChannelSandboxDelete = z.strictObject({
  ...TurnRef,
  path: SandboxFilePath,
  recursive: z.boolean().optional(),
});
export type AgentChannelSandboxDelete = z.infer<typeof AgentChannelSandboxDelete>;

export const AgentChannelSandboxDeleteResponse = z.object({
  path: SandboxFilePath,
  /** Files and folders removed. */
  deleted: z.number().int().nonnegative(),
});
export type AgentChannelSandboxDeleteResponse = z.infer<typeof AgentChannelSandboxDeleteResponse>;

/** `POST /agent-channel/v1/sandbox/share`: a workspace file becomes an attachment of the turn's conversation. */
export const AgentChannelSandboxShare = z.strictObject({ ...TurnRef, path: SandboxFilePath });
export type AgentChannelSandboxShare = z.infer<typeof AgentChannelSandboxShare>;

export const AgentChannelSandboxShareResponse = z.object({
  attachmentId: Id,
  name: z.string().min(1).max(255),
  size: z.number().int().nonnegative(),
});
export type AgentChannelSandboxShareResponse = z.infer<typeof AgentChannelSandboxShareResponse>;

/**
 * `POST /agent-channel/v1/sandbox/import`: a conversation attachment copied into the workspace, only when the
 * conversation's audience already covers the workspace's (F-8, `audience_narrower` otherwise). No path = `downloads/`.
 */
export const AgentChannelSandboxImport = z.strictObject({
  ...TurnRef,
  attachmentId: Id,
  path: SandboxFilePath.optional(),
});
export type AgentChannelSandboxImport = z.infer<typeof AgentChannelSandboxImport>;

export const AgentChannelSandboxImportResponse = z.object({
  path: SandboxFilePath,
  size: z.number().int().nonnegative(),
});
export type AgentChannelSandboxImportResponse = z.infer<typeof AgentChannelSandboxImportResponse>;

/** What a person sees when opening a file on the bot page (D-04). Images are fetched through the API, never inline. */
export const SandboxPreviewImageType = z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]);
export type SandboxPreviewImageType = z.infer<typeof SandboxPreviewImageType>;

export const SandboxFilePreview = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("text"),
    text: boundedText(SANDBOX_LIMITS.previewTextMaxBytes, "preview"),
    size: z.number().int().nonnegative(),
    modifiedAt: IsoDateTime,
  }),
  z.object({
    kind: z.literal("image"),
    mimeType: SandboxPreviewImageType,
    size: z.number().int().nonnegative().max(SANDBOX_LIMITS.previewImageMaxBytes),
    modifiedAt: IsoDateTime,
  }),
  z.object({ kind: z.literal("too_large"), size: z.number().int().nonnegative(), modifiedAt: IsoDateTime }),
  z.object({ kind: z.literal("binary"), size: z.number().int().nonnegative(), modifiedAt: IsoDateTime }),
]);
export type SandboxFilePreview = z.infer<typeof SandboxFilePreview>;

// ---------------------------------------------------------------- organization settings (D-09, D-12)

export const SandboxLimitsSettings = z.object({
  maxSandboxes: z.number().int().min(0).max(100),
  maxBrowsers: z.number().int().min(0).max(50),
  cpuMinutesPerDay: z.number().int().min(1).max(100_000),
  diskPerBotMb: z.number().int().min(64).max(102_400),
  diskTotalMb: z.number().int().min(64).max(1_048_576),
});
export type SandboxLimitsSettings = z.infer<typeof SandboxLimitsSettings>;

const PersonRef = z.object({ id: Id, displayName: z.string() });

/**
 * Settings › Sandbox & Browser. `enabled` is the organization switch (D-12, off by default: nothing runs anywhere while
 * it is off); `killed` is the admins' kill switch, set by `POST /sandbox/kill` and cleared by `POST /sandbox/resume`.
 */
export const SandboxSettings = z.object({
  enabled: z.boolean(),
  sandboxEgress: SandboxEgressMode,
  browserEgress: SandboxEgressMode,
  allowHosts: z.array(AllowHost).max(SANDBOX_LIMITS.allowHostsMax),
  limits: SandboxLimitsSettings,
  browserSessionMaxDays: z.number().int().min(1).max(90),
  killed: z.object({ at: IsoDateTime, by: PersonRef.nullable() }).nullable(),
  version: z.number().int().nonnegative(),
  /** null = no row saved yet (the defaults apply). */
  updatedAt: IsoDateTime.nullable(),
});
export type SandboxSettings = z.infer<typeof SandboxSettings>;

/** Defaults when an organization has no `sandbox_policies` row (mirrors plan 02's column defaults). */
export const DEFAULT_SANDBOX_SETTINGS: Omit<SandboxSettings, "version" | "updatedAt"> = {
  enabled: false,
  sandboxEgress: "allowlist",
  browserEgress: "public",
  allowHosts: [],
  limits: {
    maxSandboxes: 10,
    maxBrowsers: 3,
    cpuMinutesPerDay: 600,
    diskPerBotMb: 2048,
    diskTotalMb: 51_200,
  },
  browserSessionMaxDays: 30,
  killed: null,
};

/** `PUT /api/v1/sandbox/settings`: the version read (409 `settings_version_conflict` otherwise) and ≥ 1 change. */
export const UpdateSandboxSettingsRequest = z
  .strictObject({
    expectedVersion: z.number().int().nonnegative(),
    enabled: z.boolean().optional(),
    sandboxEgress: SandboxEgressMode.optional(),
    browserEgress: SandboxEgressMode.optional(),
    allowHosts: z.array(AllowHost).max(SANDBOX_LIMITS.allowHostsMax).optional(),
    limits: SandboxLimitsSettings.optional(),
    browserSessionMaxDays: z.number().int().min(1).max(90).optional(),
  })
  .refine(
    (v) => Object.keys(v).some((k) => k !== "expectedVersion" && v[k as keyof typeof v] !== undefined),
    {
      message: "Change at least one setting",
    },
  );
export type UpdateSandboxSettingsRequest = z.infer<typeof UpdateSandboxSettingsRequest>;

/** The isolation level in use, shown in Settings (D-01, D-11, D-14). */
export const SandboxIsolationInfo = z.object({
  status: z.enum(["ok", "service_down", "docker_too_old"]),
  runtime: SandboxRuntime.nullable(),
  dockerVersion: z.string().max(64).nullable(),
  running: z.object({ sandboxes: z.number().int().nonnegative(), browsers: z.number().int().nonnegative() }),
  /** D-14: Chromium's sandbox posture; null while no browser has started or sandboxd is down. */
  browserSandbox: BrowserSandboxMode.nullable().default(null),
});
export type SandboxIsolationInfo = z.infer<typeof SandboxIsolationInfo>;

/** `GET /api/v1/sandbox/settings`. */
export const SandboxSettingsView = z.object({
  settings: SandboxSettings,
  isolation: SandboxIsolationInfo,
  usage: z.object({
    cpuMinutesToday: z.number().nonnegative(),
    diskBytesTotal: z.number().int().nonnegative(),
  }),
});
export type SandboxSettingsView = z.infer<typeof SandboxSettingsView>;

/** `GET /api/v1/agents/:id/sandbox`: the bot page's Sandbox tab header (R4). */
export const SandboxStatusView = z.object({
  agentId: Id,
  state: SandboxState,
  runtime: SandboxRuntime.nullable(),
  lastActiveAt: IsoDateTime.nullable(),
  diskBytes: z.number().int().nonnegative(),
  diskQuotaBytes: z.number().int().nonnegative(),
  cpuMsToday: z.number().int().nonnegative(),
  org: z.object({ cpuMinutesToday: z.number().nonnegative(), cpuMinutesPerDay: z.number().int().positive() }),
  limits: z.object({
    cpus: z.number().positive(),
    memoryBytes: z.number().int().positive(),
    pids: z.number().int().positive(),
    idleStopMinutes: z.number().int().positive(),
  }),
  /** Approved sandbox packages installed in this bot's sandbox. */
  packages: z.number().int().nonnegative(),
  teamBot: z.boolean(),
  stopReason: SandboxStopReason.nullable(),
  viewerCan: z.object({ files: z.boolean(), control: z.boolean() }),
});
export type SandboxStatusView = z.infer<typeof SandboxStatusView>;

// ---------------------------------------------------------------- turn activity (R2, UI-SPEC Surface 5)

/** What a step did, as the chat shows it ("Ran …", "Opened …", "Blocked …"). */
export const ActivityVerb = z.enum([
  "ran",
  "checked_process",
  "stopped_process",
  "read",
  "listed",
  "wrote",
  "deleted",
  "shared",
  "imported",
  "opened",
  "read_page",
  "screenshot",
  "clicked",
  "typed",
  "chose",
  "pressed",
  "scrolled",
  "waited",
  "asked_signin",
  "closed",
  "blocked_egress",
  "blocked",
  "paused",
]);
export type ActivityVerb = z.infer<typeof ActivityVerb>;

/**
 * One confined call of a turn, composed by the API from the call it decided. Every string is masked server-side
 * (07.5 `maskForDisplay`), paths are relative to `/workspace`, sites are hosts only; typed text is never shown.
 */
export const ActivityStep = z.object({
  id: z.string().min(1).max(64),
  tool: z.string().min(1).max(64),
  verb: ActivityVerb,
  /** Masked: a relative path, a host, a short command or an element name. */
  target: z.string().max(200),
  outcome: z.object({
    kind: z.enum(["ok", "error", "running", "approval", "blocked"]),
    /** A `SandboxRefusal` / `BrowserRefusal` or approval code, when there is one. */
    code: z.string().max(64).nullable(),
    exitCode: z.number().int().nullable(),
    durationMs: z.number().int().nonnegative().nullable(),
  }),
  /** The step ran with a member's sealed browser session loaded. */
  signedIn: z.boolean(),
  contextId: Id.nullable(),
  /**
   * 07.8-22 (additive): whether the step's page is still open, computed when the reply is served (never stored), so a
   * reader sees `Watch` only while there is something to watch. Absent on steps without a page.
   */
  contextOpen: z.boolean().optional(),
  /** The approval card's message route while the step waits for one. */
  approvalMessageRoute: z.string().max(500).nullable(),
  /** Exec only: the masked command, its folder, exit code and the last lines of output (≤ 4 KB). */
  details: z
    .object({
      command: z.string().max(2000).optional(),
      cwd: z.string().max(SANDBOX_LIMITS.pathMaxChars).optional(),
      exitCode: z.number().int().optional(),
      outputTail: boundedText(SANDBOX_LIMITS.activityOutputBytes, "output tail").optional(),
    })
    .nullable(),
});
export type ActivityStep = z.infer<typeof ActivityStep>;

/** A turn's activity: at most 50 steps (`more` counts the rest), whether it still runs and what it does now. */
export const BotTurnActivity = z.object({
  eventId: Id,
  steps: z.array(ActivityStep).max(SANDBOX_LIMITS.activityStepsMax),
  more: z.number().int().nonnegative(),
  running: z.boolean(),
  current: z.string().max(80).nullable(),
  /**
   * 07.8-21 (WINDOWS #265): the person the bot acted for in this turn (the asker), so sign-in and paused rows say
   * "Asked you" / "Asked Sam". Every reader of the reply already sees who asked. Optional: older snapshots have none.
   */
  requester: z
    .object({ id: Id, displayName: z.string().max(200) })
    .nullable()
    .optional(),
});
export type BotTurnActivity = z.infer<typeof BotTurnActivity>;

/** Streamed to the conversation's readers while the turn runs; the reply message then carries `activity`. */
export const TurnActivityEvent = z.object({
  type: z.literal("turn.activity"),
  conversationId: Id,
  threadRootMessageId: Id.nullable(),
  agentId: Id,
  activity: BotTurnActivity,
});
export type TurnActivityEvent = z.infer<typeof TurnActivityEvent>;

// ---------------------------------------------------------------- sandbox packages (P-12; ADR-0011's model)

export const SandboxPackageSource = z.enum(["npm", "pypi", "debian", "clawhub"]);
export type SandboxPackageSource = z.infer<typeof SandboxPackageSource>;

/** Lower-case hex sha256. */
export const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, "a lower-case sha256");
export type Sha256Hex = z.infer<typeof Sha256Hex>;

/**
 * An exact package name of any source: an optional npm scope, then letters, digits and `._+-`, starting with a letter or
 * digit (no spaces, paths, flags or shell syntax).
 */
export const SandboxPackageName = z
  .string()
  .min(1)
  .max(214)
  .regex(/^(@[a-z0-9][a-z0-9._-]*\/)?[A-Za-z0-9][A-Za-z0-9._+-]*$/, "a package name");
export type SandboxPackageName = z.infer<typeof SandboxPackageName>;

/** An exact version (npm, PEP 440 and Debian shapes), never a range or a wildcard. */
export const SandboxPackageVersion = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9.+:~_-]*$/, "an exact version");
export type SandboxPackageVersion = z.infer<typeof SandboxPackageVersion>;

/** One resolved dependency with its integrity: npm `sha512-<base64>` or `sha256:<hex>` (PyPI, Debian, ClawHub). */
export const PackageTreeEntry = z.object({
  name: SandboxPackageName,
  version: SandboxPackageVersion,
  integrity: z
    .string()
    .regex(/^(sha512-[A-Za-z0-9+/]{86}==|sha256:[0-9a-f]{64})$/, "sha512 or sha256 integrity"),
});
export type PackageTreeEntry = z.infer<typeof PackageTreeEntry>;

/**
 * One entry of a tree as sandboxd resolved it (07.8-18, WINDOWS #233): like `PackageTreeEntry`, but a well-formed npm
 * `sha1-<base64>` integrity is also carried, so an old lockfile whose dependencies have only sha1 reaches the API, which
 * scores the package `refuse` with a reason (sha1 cannot pin it) instead of failing the parse. Nothing with sha1 is
 * ever approved or installed.
 */
export const ReviewedTreeEntry = z.object({
  name: SandboxPackageName,
  version: SandboxPackageVersion,
  integrity: z
    .string()
    .regex(
      /^(sha512-[A-Za-z0-9+/]{86}==|sha256:[0-9a-f]{64}|sha1-[A-Za-z0-9+/]{27}=)$/,
      "sha512, sha256 or sha1 integrity",
    ),
});
export type ReviewedTreeEntry = z.infer<typeof ReviewedTreeEntry>;

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The canonical text of a dependency tree: entries sorted by (name, version, integrity) by code unit, serialised as
 * `[{name, version, integrity}, …]`. The API and sandboxd hash it with `node:crypto` sha256 into `treeSha256`;
 * contracts take no crypto dependency.
 */
export function packageTreeCanonical(entries: readonly (PackageTreeEntry | ReviewedTreeEntry)[]): string {
  const sorted = [...entries].sort(
    (x, y) => cmp(x.name, y.name) || cmp(x.version, y.version) || cmp(x.integrity, y.integrity),
  );
  return JSON.stringify(sorted.map((e) => ({ name: e.name, version: e.version, integrity: e.integrity })));
}

export const SandboxPackageRisk = z.enum(["low", "medium", "high", "refuse"]);
export type SandboxPackageRisk = z.infer<typeof SandboxPackageRisk>;

/** `POST /api/v1/sandbox/packages/review`. */
export const ReviewSandboxPackageRequest = z.strictObject({
  source: SandboxPackageSource,
  name: SandboxPackageName,
  version: SandboxPackageVersion,
});
export type ReviewSandboxPackageRequest = z.infer<typeof ReviewSandboxPackageRequest>;

/** The review sheet; `reviewToken` binds (source, name, version, sha256, treeSha256). */
export const SandboxPackageReview = z.object({
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
  risk: SandboxPackageRisk,
  riskReasons: z.array(z.string().max(200)).max(10),
  reviewToken: z.string().min(1).max(2048),
});
export type SandboxPackageReview = z.infer<typeof SandboxPackageReview>;

/** `POST /api/v1/sandbox/packages`: approve a review; a high risk needs the typed acknowledgement. */
export const ApproveSandboxPackageRequest = z.strictObject({
  reviewToken: z.string().min(1).max(2048),
  acknowledge: z.literal("install anyway").optional(),
});
export type ApproveSandboxPackageRequest = z.infer<typeof ApproveSandboxPackageRequest>;

/** `PATCH /api/v1/sandbox/packages/:id`: at least one change. */
export const UpdateSandboxPackageRequest = z
  .strictObject({ enabled: z.boolean().optional(), personalAllowed: z.boolean().optional() })
  .refine((v) => v.enabled !== undefined || v.personalAllowed !== undefined, {
    message: "Change at least one setting",
  });
export type UpdateSandboxPackageRequest = z.infer<typeof UpdateSandboxPackageRequest>;

/** One approved package. `changedUpstream`: a re-resolution or an install found a different tree (refused). */
export const SandboxPackage = z.object({
  id: Id,
  source: SandboxPackageSource,
  name: SandboxPackageName,
  version: SandboxPackageVersion,
  sha256: Sha256Hex,
  dependencyCount: z.number().int().min(0).max(SANDBOX_LIMITS.packageTreeMaxEntries),
  treeSha256: Sha256Hex,
  risk: SandboxPackageRisk,
  enabled: z.boolean(),
  personalAllowed: z.boolean(),
  installedIn: z.number().int().nonnegative(),
  installing: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  changedUpstream: z.boolean(),
  newerVersion: z.string().max(128).nullable(),
  approvedBy: PersonRef.nullable(),
  approvedAt: IsoDateTime,
});
export type SandboxPackage = z.infer<typeof SandboxPackage>;

export const SandboxPackageList = z.object({
  items: z.array(SandboxPackage).max(200),
  viewerCan: z.object({ manage: z.boolean() }),
});
export type SandboxPackageList = z.infer<typeof SandboxPackageList>;
