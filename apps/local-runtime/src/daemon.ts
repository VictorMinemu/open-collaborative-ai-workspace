// Local Runtime daemon core: config + project registry, outbound Device Link, command handling
// with acks, event forwarding through sanitizeEvent(), and the local control socket.
//
// Full access (ADR-0012, D-02, P-12): the device owner's LOCAL opt-in (runtime.json `fullAccess.optIn`, or
// OCW_ALLOW_FULL_ACCESS) is the daemon's own gate. Every `fullAccess` start, configure and turn is refused here,
// before any adapter call, while it is off, so a compromised or buggy server alone can never turn it on. The
// adapters get the same gate (`allowFullAccess`) and check it again.
//
// Prompt images (06.1, D-05, P-10, P-11): a prompt's images are parsed within the contract bounds and handed to the
// adapter in memory only (never written to disk, a worktree or tmp); a runtime without `supportsImages` refuses them
// visibly. Ack errors, the command-failure log and every `session.error` pass through `stripImageData`, so a runtime
// that echoes its input never sends image bytes back.
//
// Runtime CLI updates (07.11, D-02, D-03, D-09, D-10, PD-03, PD-07, PD-19): one `RuntimeGate` per runtime and one
// `RuntimeMaintenance` that keeps the CLIs current by itself. The server's `runtime.config` sets the org level; this
// device's level comes from runtime.json or `OCW_RUNTIME_UPDATES`. Snapshots go out only while connected, run frames
// through the offline log. Maintenance runs only when the daemon drives its real adapters, or in fake-CLI mode with a
// scratch `HOME`, or when a test passes `DaemonOptions.maintenance`: a test or demo daemon never touches a real CLI.
//
// Runtime self-update (07.17.1, ADR-0040, D-03, D-04, D-05, D-07, PD-09, PD-12, PD-18, PD-19): a `SelfUpdate` exists only
// where `RuntimeMaintenance` does and `cli.ts run` passed `exitForUpdate`. The `ocw-runtime` command reads only
// `runtime`; the new build comes from `config.serverUrl`. Every `runtime.maintenance` frame then carries `self`; the
// boot reconcile's frames go first after `hello`; a held turn is told the OCW runtime is restarting; and once the
// switch is done the daemon's stop is a hand-over: the link closes first, nothing reopens a gate, no run frame goes out.
//
// Work Zone browser (07.13, ADR-0035, D-02, D-10, D-18, D-19, PD-08 … PD-10, PD-20, PD-24): one `BrowserManager` owns
// every session's browser and decides every call. The daemon only feeds it: each start's and prompt's grant
// (`onPrompt`), the turns it sees in `forwardEvent` (`onTurnStarted` / `onTurnEnded`), session ends, the owner's local
// opt-in (re-read by `reloadConfig`; off closes every page), the `browser.*` server frames, browser approval answers
// (before the adapter's) and the shim's `browserCall` on the control socket. Adapters get `StartSessionOptions.browser`.

import { realpathSync } from "node:fs";
import { arch, homedir, platform, userInfo } from "node:os";
import { join } from "node:path";
import {
  AccountLoginPayload,
  AccountLogoutPayload,
  ApprovalResolvePayload,
  type BrowserServerFrame,
  type CommandFrame,
  DEVICE_ACCOUNT_POOL_VERSION,
  DEVICE_BROWSER_VERSION,
  DEVICE_LINK_MAX_DEVICE_FRAME_BYTES,
  DEVICE_LINK_PROTOCOL_VERSION,
  DEVICE_PROMPT_FILES_VERSION,
  DeviceAccessToken,
  type DeviceBrowserReport,
  type DeviceHostKind,
  type DeviceToServerFrame,
  DiffRequestPayload,
  type DiffResultFrame,
  minMode,
  OCW_RUNTIME_TARGET,
  type PermissionMode,
  PROMPT_FILE_FAILURE_PREFIX,
  type PromptFile,
  PromptPayload,
  promptFileCollisionPath,
  RUNTIME_BYPASS_LITERALS,
  RUNTIME_FILE_LAND_WITHIN_HEADER,
  RUNTIME_FILE_ROUTE,
  RuntimeCatalog,
  RuntimeFilePutAnswer,
  type RuntimeId,
  type RuntimeInfo,
  type RuntimeMaintenanceFrame,
  RuntimeUpdatePayload,
  type RuntimeUpdatesLevel,
  type RuntimeUpdatesLevelSource,
  type ServerToDeviceFrame,
  type SessionAccount,
  SessionConfigurePayload,
  type SessionEvent,
  type SessionFileFailure,
  SessionFileReadPayload,
  SessionFileWritePayload,
  SessionStartPayload,
  SessionTitlePayload,
  stripImageData,
  TITLE_TIMEOUT_MS,
  transferDeadlineMs,
  WORK_BROWSER_SIGNIN_ROUTES,
  WORK_PROMPT_UPLOADS_DIR,
  withPromptFilesNote,
} from "@ocw/contracts";
import {
  CodexLoginError,
  codexAccountSpawner,
  logoutCodex,
  runCodexDeviceLogin,
} from "./accounts/codex-login.js";
import { CodexSlotStore } from "./accounts/codex-slots.js";
import { inContainer, resolveChromiumSandbox } from "./browser/agent/sandbox.js";
import { sweepRunDirs } from "./browser/child.js";
import { browsersRoot } from "./browser/install.js";
import { BrowserManager, type BrowserManagerOptions } from "./browser/manager.js";
import { ClaudeCodeRuntime } from "./claude/claude-runtime.js";
import { CodexRuntime, type SpawnAppServer } from "./codex/codex-runtime.js";
import {
  type BrowserOptInSource,
  type BrowserSandboxMode,
  deviceName,
  ensureOcwHome,
  type FullAccessSource,
  type IsolatedServerSource,
  type LocalProject,
  loadConfig,
  loadDeviceToken,
  ocwHome,
  ProjectRegistry,
  type RuntimeConfig,
  resolveBrowser,
  resolveFullAccess,
  resolveHostKind,
  resolveIsolatedServer,
  resolveRuntimeUpdates,
  toWebSocketUrl,
} from "./config.js";
import { type ControlRequest, ControlSocketServer, controlSocketPath } from "./control-socket.js";
import { DeviceLink, type DeviceLinkOptions } from "./device-link.js";
import { boundDiffFrame } from "./diff-frame.js";
import { findExecutable } from "./exec-path.js";
import { FakeRuntime } from "./fake/fake-runtime.js";
import {
  changedFiles,
  ensureSessionWorktree,
  excludePromptUploads,
  isGitRepo,
  repoInfo,
  unifiedPatch,
} from "./git.js";
import { createLogger, errorMessage, type Logger } from "./logger.js";
import { AppRestartHold } from "./maintenance/app-restart-hold.js";
import { RuntimeGate } from "./maintenance/gate.js";
import {
  RuntimeMaintenance,
  type RuntimeMaintenanceOptions,
  type UpdateRequestAnswer,
} from "./maintenance/maintenance.js";
import { defaultLockDir } from "./maintenance/runner.js";
import { removeSelfUpdateMarker } from "./maintenance/self-update.js";
import {
  clearStaging,
  pruneRuntimeVersions,
  readFailedBuild,
  reconcileSelfUpdate,
  type SelfUpdateBoot,
} from "./maintenance/self-update-boot.js";
import { SelfUpdate, type SelfUpdateOptions } from "./maintenance/self-update-job.js";
import { isSupervised, runningBuild } from "./maintenance/supervision.js";
import type { AccountSignal, AgentRuntime, RuntimeAccount } from "./runtime.js";
import { sanitizeEvent, sanitizeString, sanitizeValue } from "./sanitize.js";
import {
  openSessionFileForRead,
  removeLandedSessionFile,
  SessionFileError,
  writeSessionFile,
} from "./session-files.js";
import { runTitle } from "./title.js";
import { RUNTIME_VERSION } from "./version.js";

/** The bundle's version (07.12; `0.0.0-dev` under tsx), sent as `hello.device.daemonVersion`. */
export const DAEMON_VERSION = RUNTIME_VERSION;
const DETECT_CACHE_MS = 60_000;
const MAX_REMEMBERED_COMMANDS = 1000;
/** A cached device JWT is replaced once fewer than this many milliseconds of validity remain. */
export const ACCESS_TOKEN_REFRESH_MARGIN_MS = 60_000;
const TOKEN_EXCHANGE_TIMEOUT_MS = 10_000;

/** `POST {serverUrl}/api/v1/devices/token`: device token → 10-minute device JWT (keeps any path prefix). */
export function toDeviceTokenUrl(serverUrl: string): string {
  const u = new URL(serverUrl);
  u.pathname = `${u.pathname.replace(/\/$/, "")}/api/v1/devices/token`;
  u.search = "";
  u.hash = "";
  return u.toString();
}

const SEMVER = /^\d{1,9}\.\d{1,9}\.\d{1,9}(?:-[0-9A-Za-z.-]{1,40})?(?:\+[0-9A-Za-z.-]{1,40})?$/;

/** 07.13 (D-18, PD-21): the desktop app's version from `OCW_APP_VERSION`, only when it is a semver (else none). */
export function appVersionOf(env: NodeJS.ProcessEnv): string | null {
  const v = env.OCW_APP_VERSION?.trim();
  return v && v.length <= 64 && SEMVER.test(v) ? v : null;
}

function isBrowserServerFrame(frame: { type: string }): frame is BrowserServerFrame {
  return frame.type.startsWith("browser.");
}

/** 07.13 (PD-19): the browsers root under this daemon's own OCW home (`OCW_BROWSERS_DIR` still names another place). */
function daemonBrowsersRoot(env: NodeJS.ProcessEnv, home: string): string {
  try {
    return browsersRoot({ ...env, OCW_HOME: home });
  } catch {
    return join(home, "browsers");
  }
}

const UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
/** 07.13 (PD-15, PD-17): the only paths the browser manager may PUT to: the sign-in routes with uuid ids. */
const BROWSER_PUT_PATHS: readonly RegExp[] = [
  WORK_BROWSER_SIGNIN_ROUTES.upload,
  WORK_BROWSER_SIGNIN_ROUTES.reseal,
].map((route) => new RegExp(`^${route.replace(/:[A-Za-z]+/g, UUID_PATTERN)}$`, "i"));
const BROWSER_PUT_TIMEOUT_MS = 30_000;

/**
 * 07.13: `{serverUrl}{path}` for a browser sign-in PUT (keeping the server URL's path prefix); throws for any path but
 * the sign-in routes with uuid ids, so nothing from a payload ever names where the device sends a storage state.
 */
export function toBrowserApiUrl(serverUrl: string, path: string): string {
  if (!BROWSER_PUT_PATHS.some((re) => re.test(path))) throw new Error("invalid browser api path");
  const u = new URL(serverUrl);
  u.pathname = `${u.pathname.replace(/\/$/, "")}${path}`;
  u.search = "";
  u.hash = "";
  return u.toString();
}

/** A transfer id as the server mints it (a command id: a uuid in production); anything else is never fetched. */
const TRANSFER_ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * 07.17.1.1 (D-08, PD-05, P3): `{serverUrl}/api/v1/runtime/files/<transfer id>`, the only URL a file command ever
 * fetches. Built from the daemon's own server URL (keeping its path prefix, like `toDeviceTokenUrl`) and the command
 * id; never from a payload value.
 */
export function toRuntimeFileUrl(serverUrl: string, transferId: string): string {
  if (!TRANSFER_ID.test(transferId)) throw new Error("invalid transfer id");
  const u = new URL(serverUrl);
  u.pathname = `${u.pathname.replace(/\/$/, "")}${RUNTIME_FILE_ROUTE}/${encodeURIComponent(transferId)}`;
  u.search = "";
  u.hash = "";
  return u.toString();
}

/**
 * 07.17.1.1 (PD-05): the waits before retrying a transfer the server answered 503 (its stream counter was full and the
 * transfer stays pending); after the last one a 503 is `transfer_failed`.
 */
export const FILE_TRANSFER_RETRY_DELAYS_MS: readonly number[] = [1_000, 3_000];

/** The server refused the device token (revoked or unknown device); retried with the link's backoff. */
export class DeviceTokenRejectedError extends Error {
  constructor(readonly status: number) {
    super(`device token rejected by server (HTTP ${status})`);
  }
}

/** The refusal a prompt with images gets on a runtime that cannot take them (P-10): never silently dropped. */
export const IMAGES_NOT_SUPPORTED_MESSAGE = "This runtime can't receive images";

/** ADR-0045: names tried for one prompt file (`spec.pdf`, then `spec-1.pdf` … `spec-99.pdf`) before it fails. */
export const PROMPT_FILE_MAX_NAMES = 100;

const PROMPT_FILE_FAILURE_TEXT: Partial<Record<SessionFileFailure, string>> = {
  busy: "a turn is running",
  exists: "no free name is left",
  expired: "the transfer expired",
  mismatch: "the bytes did not match",
  no_space: "the disk is full",
  path_not_allowed: "the name is not allowed",
  invalid_path: "the name is not allowed",
  not_a_file: "a folder is in the way",
  too_large: "it is too large",
};

/**
 * ADR-0045: the one sentence a prompt fails with when one of its files did not land (the ack error, the session's
 * `lastError`). It names the file by its base name and says why in plain words; never an absolute path.
 */
export function promptFileFailedMessage(path: string, code: SessionFileFailure): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const why = PROMPT_FILE_FAILURE_TEXT[code] ?? "the transfer failed";
  return `${PROMPT_FILE_FAILURE_PREFIX}${name} into the working tree (${why}). The prompt was not run.`;
}

/** The refusal every fullAccess request gets while the device's own opt-in is off. */
export const FULL_ACCESS_OFF_MESSAGE =
  "Full access is not enabled on this device (its owner turns it on in the desktop app or with `ocw-runtime full-access on`)";

/** 07.11: the ack of a `runtime.update` command whose payload is anything but `{ runtime }` (D-05). */
export const INVALID_PAYLOAD_MESSAGE = "invalid payload";
/** 07.11 (PD-19): a daemon that does not maintain its CLIs (test runtimes, fake mode without a scratch HOME). */
export const RUNTIME_UPDATES_UNAVAILABLE_MESSAGE = "runtime updates are not available on this device";
/** 07.17.1 (PD-26): the ack of an `ocw-runtime` update on a daemon that cannot update itself. */
export const SELF_UPDATE_UNAVAILABLE_MESSAGE = "runtime self-update is not available on this device";

/** The daemon's Full access gate, shared with every adapter it builds (read on every call). */
interface FullAccessGate {
  optIn: boolean;
  source: FullAccessSource;
}

/** What the daemon hands the adapters it builds (and a test's runtime factory). */
export interface RuntimeFactoryContext {
  /**
   * 07.18 (D-02): the `CODEX_HOME` of the first signed-in Codex account slot, or null. The Codex adapter asks only when
   * the device's own Codex login is signed out, to collect its model catalog under that slot (no turn).
   */
  codexCatalogHome: () => Promise<string | null>;
}

/**
 * 07.18 (D-02): the first slot (creation order) whose `auth.json` exists. The file is only tested for existence, never
 * read; the home stays on the device.
 */
async function firstSignedInSlotHome(slots: CodexSlotStore): Promise<string | null> {
  const first = (await slots.report().catch(() => [])).find((s) => s.signedIn);
  return first ? slots.homeOf(first.slotId) : null;
}

export interface DaemonOptions {
  /** Defaults to OCW_HOME or ~/.ocw */
  home?: string;
  env?: NodeJS.ProcessEnv;
  config?: Partial<RuntimeConfig>;
  /** Override the token (tests); otherwise OCW_DEVICE_TOKEN or the token file. */
  token?: string | null;
  /** Adapters to drive (tests), or a factory that receives the daemon's Full access gate and the runtime context. */
  runtimes?:
    | AgentRuntime[]
    | ((allowFullAccess: () => boolean, ctx: RuntimeFactoryContext) => AgentRuntime[]);
  logger?: Logger;
  link?: Partial<
    Pick<DeviceLinkOptions, "heartbeatMs" | "backoffMinMs" | "backoffMaxMs" | "maxOfflineFrames">
  >;
  /** Socket path override, or false to disable the control socket. */
  controlSocket?: string | false;
  /** The daemon's own deadline for a `session.title` call (default TITLE_TIMEOUT_MS; lowered in tests). */
  titleTimeoutMs?: number;
  /**
   * Tests only (07.11, PD-19): runtime update maintenance for test-supplied runtimes runs only when this is given,
   * with `userHome` (a scratch home) and usually `which`, a registry URL in `env` and short timers.
   */
  maintenance?: Partial<RuntimeMaintenanceOptions>;
  /**
   * 07.17.1 (D-05, PD-08): the only way the daemon restarts itself after a self-update switched `current`: stop
   * cleanly, then exit with `code` (75) so the service manager starts the new build. `cli.ts run` passes it; without it
   * no `SelfUpdate` exists and an `ocw-runtime` update is refused with `SELF_UPDATE_UNAVAILABLE_MESSAGE`.
   */
  exitForUpdate?: (code: number) => Promise<void>;
  /**
   * Tests only (07.17.1, PD-19): overrides for the `SelfUpdate` (the stub's URL, the running build, supervision, the
   * fake npm through `prepare`, short polls). The exit, the lock directory and the scratch-home rule always come from
   * the daemon and its maintenance scope.
   */
  selfUpdate?: Partial<SelfUpdateOptions>;
  /** Tests only (07.17.1.1): the waits before retrying a 503 transfer (default `FILE_TRANSFER_RETRY_DELAYS_MS`). */
  fileRetryDelaysMs?: readonly number[];
  /**
   * Tests only (07.18-08): how the app-servers of Codex account slots are spawned (a scripted fake) and a shorter
   * sign-in bound. Without it the daemon spawns the configured or detected `codex` (in fake mode only a configured one).
   */
  codexAccounts?: { spawn?: SpawnAppServer; loginTimeoutMs?: number };
  /**
   * Tests only (07.13-12): the browser manager's seams (a scratch browsers root, the pinned browser from the test
   * cache, a scripted child, the child's entry, a shorter idle close). Every rule stays the manager's.
   */
  browser?: Partial<
    Pick<BrowserManagerOptions, "root" | "browsers" | "createChild" | "childEntry" | "idleMs">
  >;
}

/** Where runtime update maintenance may run (PD-19), or null: never against a real install from a test or a demo. */
interface MaintenanceScope {
  userHome: string;
  requireScratchHome: boolean;
}

function sameDirectory(a: string, b: string): boolean {
  return realpathOr(a) === realpathOr(b);
}

function osUserHome(): string | null {
  try {
    return userInfo().homedir;
  } catch {
    return null;
  }
}

/**
 * PD-19: real adapters → the user's home; fake runtimes → only with `OCW_RUNTIME_FAKE_CLI=1` and a `HOME` that is not
 * the OS user's real home (scratch mode: installs outside it are refused); test-supplied runtimes → only when the test
 * passes `DaemonOptions.maintenance.userHome`.
 */
function maintenanceScope(
  opts: DaemonOptions,
  env: NodeJS.ProcessEnv,
  fake: boolean,
): MaintenanceScope | null {
  if (opts.runtimes !== undefined) {
    const userHome = opts.maintenance?.userHome;
    if (!userHome) return null;
    return { userHome, requireScratchHome: opts.maintenance?.requireScratchHome ?? true };
  }
  if (fake) {
    const home = env.HOME;
    const real = osUserHome();
    if (env.OCW_RUNTIME_FAKE_CLI !== "1" || !home || real === null || sameDirectory(home, real)) return null;
    return { userHome: home, requireScratchHome: true };
  }
  return {
    userHome: opts.maintenance?.userHome ?? homedir(),
    requireScratchHome: opts.maintenance?.requireScratchHome ?? false,
  };
}

interface ActiveSession {
  sessionId: string;
  runtime: AgentRuntime;
  project: LocalProject;
  cwd: string;
  worktreeBranch: string | null;
  /** The session mode the server last authorized here (start / configure); per-turn caps only lower it. */
  mode: PermissionMode;
  /** 07.18 (PD-03): the pool account ref the session runs on (null = the device's own login). Never the token. */
  accountRef: string | null;
}

/** 07.18 (D-02, T-07.18-08-05): one sign-in per slot at a time. */
export const SIGN_IN_RUNNING_MESSAGE = "a sign-in is already running for this account slot";

/** 07.18 (T-07.18-08-06): the user code never leaves in a failure message (it went to the admin in the code frame). */
function withoutUserCode(message: string, userCode: string | null): string {
  return userCode ? message.split(userCode).join("[code]") : message;
}

/** 07.18 (D-02): a `device_slot` account whose slot is not in this device's slot store. */
export const ACCOUNT_SLOT_NOT_FOUND_MESSAGE = "account slot not found on this device";

/**
 * 07.18 (D-02, PD-03, PD-10): the wire account of a start or prompt → what the adapter gets. Absent or null = the
 * device's own login. A token is passed on in memory only; the daemon keeps just the ref. A slot account resolves to
 * that slot's `CODEX_HOME` through the store (device-local, never sent back); an unknown slot is refused.
 */
async function runtimeAccountOf(
  wire: SessionAccount | null | undefined,
  slots: CodexSlotStore,
): Promise<RuntimeAccount | null> {
  if (!wire) return null;
  if (wire.kind === "device_slot") {
    const slot = await slots.get(wire.slotId).catch(() => undefined);
    if (!slot) throw new Error(ACCOUNT_SLOT_NOT_FOUND_MESSAGE);
    return {
      kind: "device_slot",
      ref: wire.accountId,
      label: wire.label,
      slotId: slot.slotId,
      codexHome: slots.homeOf(slot.slotId),
    };
  }
  return { kind: "token", ref: wire.accountId, label: wire.label, oauthToken: wire.oauthToken };
}

/** 07.18 (T-07.18-06-04): an account kind the adapter cannot run is refused before the adapter sees it. */
function refuseAccountKind(runtime: AgentRuntime, account: RuntimeAccount): void {
  if (!runtime.capabilities.supportsAccounts?.includes(account.kind)) {
    throw new Error(`${runtime.id} cannot run a session on a ${account.kind} account`);
  }
}

function realpathOr(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** 07.17.1.1: a file command payload the contract refuses: its path → `invalid_path`, anything else → `transfer_failed`. */
function payloadRefusal(issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey> }>): SessionFileError {
  return new SessionFileError(issues.some((i) => i.path[0] === "path") ? "invalid_path" : "transfer_failed");
}

/** Waits `ms`; false when `signal` aborted first (the transfer's deadline passed). */
function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** What `reloadConfig` answers (control socket): the levels it now enforces, never a value it was sent. */
export type ReloadConfigResult = {
  fullAccessOptIn: boolean;
  fullAccessSource: FullAccessSource;
  /** 07.11 (D-02): this device's runtime updates level and where it comes from. */
  runtimeUpdatesLevel: RuntimeUpdatesLevel;
  runtimeUpdatesSource: RuntimeUpdatesLevelSource;
  /** The lower of the organization's and this device's levels; absent where runtime updates are not maintained. */
  runtimeUpdatesEffectiveLevel?: RuntimeUpdatesLevel;
  /** 07.16 (D-19): the owner's local isolated-server mark and where it comes from; `host` decides if it is reported. */
  isolatedServer: boolean;
  isolatedServerSource: IsolatedServerSource;
  host: DeviceHostKind | null;
  /** 07.13 (D-10, PD-27): the owner's local browser opt-in and where it comes from. */
  browserOptIn: boolean;
  browserOptInSource: BrowserOptInSource;
};

export class Daemon {
  readonly registry: ProjectRegistry;
  /** 07.18 (D-02, PD-10): the Codex account slots on this device (shared with `ocw-runtime account`). */
  readonly codexSlots: CodexSlotStore;
  private link: DeviceLink | null = null;
  private control: ControlSocketServer | null = null;
  private readonly runtimes = new Map<RuntimeId, AgentRuntime>();
  /** 07.11 (PD-07): one gate per runtime; held commands of that runtime wait while its CLI updates. */
  private readonly gates = new Map<RuntimeId, RuntimeGate>();
  /** 07.11: runtime CLI update maintenance; null when PD-19 does not allow it here. */
  private maintenance: RuntimeMaintenance | null = null;
  /** 07.11 (PD-07): per runtime, the sessions told `runtime.update` `waiting` during the current update. */
  private readonly heldSessions = new Map<RuntimeId, Set<string>>();
  /** 07.17.1: the OCW runtime's own update; null unless maintenance runs here and `exitForUpdate` was given. */
  private selfUpdate: SelfUpdate | null = null;
  /** 07.17.1 (PD-12): the run a self-update restart carried over, reported once in the handshake. */
  private boot: { report: SelfUpdateBoot; running: { version: string; sha256: string } | null } | null = null;
  /** 07.17.1 (PD-18): sessions told the OCW runtime is restarting during the current hold (once each), and their runtime. */
  private readonly selfHeldSessions = new Map<string, RuntimeId>();
  /**
   * 07.13.1 (D-07): the desktop app's restart hold on the same gates (`appUpdateHold` / `appUpdateRelease`, local
   * control socket only).
   */
  private readonly appHold: AppRestartHold;
  /** 07.13.1 (D-07): sessions told the OCW runtime is restarting during the app's current hold (once each). */
  private readonly appHeldSessions = new Map<string, RuntimeId>();
  /** `stop()` began: a hold that ends now is the daemon going away, not an update that did not run (review IN-04). */
  private stopping = false;
  /** Snapshots with `self` go out in the order their status was read. */
  private snapshotChain: Promise<void> = Promise.resolve();
  private readonly sessions = new Map<string, ActiveSession>();
  /** Roots per session survive session end so late events are still contained. */
  private readonly rootsBySession = new Map<string, string[]>();
  private readonly seqBySession = new Map<string, number>();
  private readonly processedCommands = new Set<string>();
  /** Review CR-03: file commands running now, by id (= transfer id); a redelivered copy is not run or answered. */
  private readonly fileInFlight = new Set<string>();
  /** Review CR-03: finished file commands' outcomes (bounded like `processedCommands`), answered again on redelivery. */
  private readonly fileOutcomes = new Map<string, { error: string | undefined }>();
  /**
   * Per-session order for `session.configure` and `prompt` (D-14): a prompt queued right after a settings change
   * reaches the runtime only once the change was handed over. Other commands stay immediate.
   */
  private readonly sessionChains = new Map<string, Promise<void>>();
  /** 07.17.1.1 (D-13): sessions whose turn runs now (`trackTurn`); a file write into them is refused `busy`. */
  private readonly turnsRunning = new Set<string>();
  private detectCache: { at: number; value: RuntimeInfo[] } | null = null;
  private started = false;
  /** The current device JWT (never logged). */
  private accessToken: { token: string; expiresAtMs: number } | null = null;
  private legacyServerWarned = false;
  /** 07.16 (PD-18): how this daemon runs, resolved once at start (`resolveHostKind`). */
  private hostKind: DeviceHostKind | null = null;
  /** 07.16 (D-19): the owner's local isolated-server mark, re-read on `reloadConfig`. */
  private isolated: { on: boolean; source: IsolatedServerSource } = { on: false, source: "config" };
  /** 07.18 (T-07.18-08-05): the Codex sign-ins running now, by slot id; aborted on stop. */
  private readonly accountLogins = new Map<string, AbortController>();
  /** 07.13 (D-10, PD-18, PD-27): the owner's local browser opt-in and sandbox mode, re-read on `reloadConfig`. */
  private browserCfg: { optIn: boolean; source: BrowserOptInSource; sandbox: BrowserSandboxMode };
  /** 07.13: where browsers and the sessions' run dirs live (`browsersRoot` under this daemon's OCW home). */
  private readonly browserRoot: string;
  /** 07.13: every session's Work Zone browser (one manager per daemon). */
  readonly browser: BrowserManager;
  /** 07.13 (D-18, PD-21): `OCW_APP_VERSION` (the desktop app's version) when it is a semver, read once. */
  private readonly appVersion: string | null;

  private constructor(
    readonly home: string,
    readonly config: RuntimeConfig,
    private readonly token: string | null,
    runtimes: AgentRuntime[],
    private readonly log: Logger,
    private readonly opts: DaemonOptions,
    private readonly env: NodeJS.ProcessEnv,
    private readonly gate: FullAccessGate,
    codexSlots: CodexSlotStore,
  ) {
    this.registry = new ProjectRegistry(home);
    this.codexSlots = codexSlots;
    for (const r of runtimes) {
      this.runtimes.set(r.id, r);
      this.gates.set(r.id, new RuntimeGate());
    }
    // 07.13.1 (D-07): the app's hold decides on the same gates and turn counts as the self-update (ADR-0040 § 7), and
    // never closes a gate while a 07.11 CLI job is past `pending` or the self-update holds (both read at each request).
    this.appHold = new AppRestartHold({
      gates: this.gates,
      activeTurns: (r) => this.runtimes.get(r)?.activeTurns() ?? 0,
      runtimeUpdateBusy: () => (this.maintenance?.jobActive ?? false) || (this.selfUpdate?.holding ?? false),
      onChange: () => this.onAppHoldChange(),
    });
    this.browserCfg = resolveBrowser(config, env);
    this.appVersion = appVersionOf(env);
    this.browserRoot = opts.browser?.root ?? daemonBrowsersRoot(env, home);
    this.browser = new BrowserManager({
      root: this.browserRoot,
      // `browser.event` is not kept in the offline log (a browser runs only while connected).
      link: {
        send: (frame) => {
          if (this.isConnected) this.send(frame);
        },
        sendBinary: (bytes) => this.link?.sendBinary(bytes) ?? false,
      },
      api: { put: (path, body) => this.browserApiPut(path, body) },
      optIn: () => this.browserCfg.optIn,
      sandbox: () =>
        resolveChromiumSandbox({ configured: this.browserCfg.sandbox, inContainer: inContainer() }),
      emit: (sessionId, event) => this.forwardEvent(sessionId, event),
      fullAccessAllowed: () => this.gate.optIn,
      log,
      ...(opts.browser?.browsers ? { browsers: opts.browser.browsers } : {}),
      ...(opts.browser?.createChild ? { createChild: opts.browser.createChild } : {}),
      ...(opts.browser?.childEntry ? { childEntry: opts.browser.childEntry } : {}),
      ...(opts.browser?.idleMs !== undefined ? { idleMs: opts.browser.idleMs } : {}),
    });
  }

  static async create(opts: DaemonOptions = {}): Promise<Daemon> {
    const env = opts.env ?? process.env;
    const home = opts.home ?? ocwHome(env);
    await ensureOcwHome(home);
    const loaded = await loadConfig(home, env);
    const config = { ...loaded, ...opts.config };
    const log = opts.logger ?? createLogger(config.logLevel);
    const token = opts.token !== undefined ? opts.token : await loadDeviceToken(home, config, env);
    const gate: FullAccessGate = resolveFullAccess(config, env);
    if (gate.optIn) log.warn("Full access is enabled on this device", { source: gate.source });
    const allowFullAccess = () => gate.optIn;
    const fake = env.OCW_RUNTIME_FAKE === "1";
    if (fake) log.warn("OCW_RUNTIME_FAKE=1: using the fake runtime (tests/demos only, no model is called)");
    const delay = env.OCW_RUNTIME_FAKE_DELAY_MS ? Number(env.OCW_RUNTIME_FAKE_DELAY_MS) : undefined;
    const codexSlots = new CodexSlotStore(home, env);
    const ctx: RuntimeFactoryContext = { codexCatalogHome: () => firstSignedInSlotHome(codexSlots) };
    const runtimes = (typeof opts.runtimes === "function"
      ? opts.runtimes(allowFullAccess, ctx)
      : opts.runtimes) ??
      (fake
        ? [
            new FakeRuntime("claude-code", delay, { allowFullAccess }),
            new FakeRuntime("codex", delay, { allowFullAccess }),
          ]
        : null) ?? [
        new ClaudeCodeRuntime({
          logger: log,
          useApiKey: config.claude.useApiKey,
          allowFullAccess,
          ...(config.claude.path ? { claudePath: config.claude.path } : {}),
        }),
        new CodexRuntime({
          logger: log,
          useApiKey: config.codex.useApiKey,
          allowFullAccess,
          catalogHome: ctx.codexCatalogHome,
          ...(config.codex.path ? { codexPath: config.codex.path } : {}),
        }),
      ];
    const daemon = new Daemon(home, config, token, runtimes, log, opts, env, gate, codexSlots);
    // 07.16 (PD-18): the entry is the running script; it is compared with the installed bundle here only.
    daemon.hostKind = await resolveHostKind({ env, home, entry: process.argv[1] });
    daemon.isolated = resolveIsolatedServer(config, env);
    if (daemon.reportedIsolated)
      log.warn("This device is marked as an isolated server", { source: daemon.isolated.source });
    await daemon.registry.load();
    const scope = maintenanceScope(opts, env, fake && opts.runtimes === undefined);
    if (scope) {
      daemon.maintenance = daemon.buildMaintenance(scope);
      if (opts.exitForUpdate) await daemon.buildSelfUpdate(daemon.maintenance, scope, opts.exitForUpdate);
    } else if (fake)
      log.info("runtime updates are off: fake runtime without OCW_RUNTIME_FAKE_CLI=1 and a scratch HOME");
    return daemon;
  }

  /**
   * 07.17.1 (D-05, D-07, PD-09, PD-12, PD-19): the running build (hashed once), supervision, the boot reconcile of a
   * run the last restart carried over and the staging left by an interrupted prepare, then the `SelfUpdate` on the
   * same gates. The lock directory is the maintenance scope's (`defaultLockDir(scope.userHome)`), never the OS user's
   * home from a test.
   */
  private async buildSelfUpdate(
    maintenance: RuntimeMaintenance,
    scope: MaintenanceScope,
    exit: (code: number) => Promise<void>,
  ): Promise<void> {
    const over = this.opts.selfUpdate ?? {};
    const argv1 = process.argv[1];
    const running =
      over.running !== undefined
        ? over.running
        : await runningBuild({ argv1, ocwHome: this.home, version: RUNTIME_VERSION });
    const supervision =
      over.supervision ??
      (await isSupervised({
        env: this.env,
        platform: process.platform,
        argv1,
        ocwHome: this.home,
        // A unit an older installer wrote (no OCW_RUNTIME_HOST) is read from the scope's home, never another one.
        unit: { userHome: scope.userHome },
      }));
    const report = await reconcileSelfUpdate({ ocwHome: this.home, running });
    await clearStaging(this.home).catch(() => 0);
    // Review CR-01: a build that came back on the previous version (this boot, or an earlier one) never runs again
    // automatically while the workspace serves it.
    const failedBuild = await readFailedBuild(this.home);
    const selfUpdate = new SelfUpdate({
      ocwHome: this.home,
      serverUrl: this.config.serverUrl,
      env: this.env,
      running,
      supervision,
      failedBuild,
      gates: this.gates,
      activeTurns: (r) => this.runtimes.get(r)?.activeTurns() ?? 0,
      // 07.13.1 (D-07): the app's restart hold excludes the self-update as a CLI job does (PD-09, both directions).
      cliBusy: () => maintenance.jobActive || this.appHold.active,
      level: () => maintenance.effectiveLevel,
      sendRun: (frame) => this.send(frame),
      publish: () => this.onSelfUpdateChange(),
      log: this.log,
      ...over,
      exit,
      requireScratchHome: scope.requireScratchHome,
      lockDir: this.opts.maintenance?.lockDir ?? defaultLockDir(scope.userHome),
    });
    this.selfUpdate = selfUpdate;
    if (report) {
      this.boot = { report, running };
      selfUpdate.adoptBoot(report);
      this.log.info("runtime self-update: reporting the run the restart carried over", {
        outcome: report.outcome,
      });
    }
  }

  /**
   * The self-update's status changed: a fresh snapshot (while connected). A hold that ended without the restart (the
   * update failed, was cancelled or gave up waiting) tells each session it held that the update did not run, so its
   * "Restarting…" line is taken back (review IN-04); on a daemon stop nothing is said (the next daemon runs the turn).
   */
  private onSelfUpdateChange(): void {
    const su = this.selfUpdate;
    if (!su) return;
    if (!su.holding && this.selfHeldSessions.size > 0) {
      const held = [...this.selfHeldSessions];
      this.selfHeldSessions.clear();
      if (!this.stopping) {
        for (const [sessionId, runtime] of held) {
          this.forwardEvent(sessionId, {
            type: "runtime.update",
            runtime,
            phase: "failed",
            subject: OCW_RUNTIME_TARGET,
          });
        }
      }
    }
    const m = this.maintenance;
    if (!m || !this.isConnected) return;
    const self = su.status();
    this.snapshotChain = this.snapshotChain
      .then(async () => {
        const frame = await m.snapshot();
        if (this.isConnected) this.send({ ...frame, self });
      })
      .catch((err: unknown) =>
        this.log.warn("runtime self status snapshot failed", {
          error: sanitizeString(errorMessage(err), []),
        }),
      );
  }

  /**
   * 07.13.1 (D-07): the app's restart hold changed state. A hold that ended without the restart (released, timed out
   * or auto-released) tells each session it held that the restart did not happen, so its "Restarting…" line is taken
   * back; on a daemon stop nothing is said (the server re-queues the held prompt after the restart, PD-27).
   */
  private onAppHoldChange(): void {
    if (this.appHold.active || this.appHeldSessions.size === 0) return;
    const held = [...this.appHeldSessions];
    this.appHeldSessions.clear();
    if (this.stopping) return;
    for (const [sessionId, runtime] of held) {
      this.forwardEvent(sessionId, {
        type: "runtime.update",
        runtime,
        phase: "failed",
        subject: OCW_RUNTIME_TARGET,
      });
    }
  }

  /** Every `runtime.maintenance` frame carries `self` exactly when a SelfUpdate exists. */
  private withSelf(frame: RuntimeMaintenanceFrame): RuntimeMaintenanceFrame {
    return this.selfUpdate ? { ...frame, self: this.selfUpdate.status() } : frame;
  }

  private buildMaintenance(scope: MaintenanceScope): RuntimeMaintenance {
    const level = resolveRuntimeUpdates(this.config, this.env);
    const configuredPaths: Partial<Record<RuntimeId, string>> = {
      ...(this.config.claude.path ? { "claude-code": this.config.claude.path } : {}),
      ...(this.config.codex.path ? { codex: this.config.codex.path } : {}),
    };
    return new RuntimeMaintenance({
      runtimes: [...this.runtimes.values()],
      gates: this.gates,
      env: this.env,
      configuredPaths,
      localLevel: level.level,
      localLevelSource: level.source,
      log: this.log,
      runtimeInfo: async ({ fresh }) => {
        if (fresh) this.detectCache = null;
        return this.detectRuntimes();
      },
      // PD-03: a snapshot only while connected (the handshake carries one on every connect); runs never get lost.
      // 07.17.1: with a SelfUpdate it carries `self` and keeps its place behind the self-update's own snapshots.
      sendSnapshot: (frame) => {
        if (!this.selfUpdate) {
          if (this.isConnected) this.send(frame);
          return;
        }
        // Review IN-06: one failed send never breaks the chain for the snapshots after it, nor `stop()`'s await.
        this.snapshotChain = this.snapshotChain
          .then(() => {
            if (this.isConnected) this.send(this.withSelf(frame));
          })
          .catch((err: unknown) =>
            this.log.warn("runtime maintenance snapshot failed", {
              error: sanitizeString(errorMessage(err), []),
            }),
          );
      },
      sendRun: (frame) => this.send(frame),
      notifySession: (runtime, phase, version) => this.notifyHeldSessions(runtime, phase, version),
      afterRun: async () => {
        this.detectCache = null;
        if (this.isConnected) this.send(await this.capabilitiesFrame());
      },
      // 07.17.1 (PD-09): no CLI job starts while the OCW runtime's self-update holds the gates; 07.13.1 (D-07): nor
      // while the desktop app's restart hold drains or holds.
      exclusive: () => (this.selfUpdate?.holding ?? false) || this.appHold.active,
      ...this.opts.maintenance,
      userHome: scope.userHome,
      requireScratchHome: scope.requireScratchHome,
    });
  }

  /**
   * 07.16 (D-19, PD-18): what the daemon reports as its isolated-server mark: the owner's local mark, only on a headless
   * service host (the server applies the same rule again).
   */
  private get reportedIsolated(): boolean {
    return this.hostKind === "service" && this.isolated.on;
  }

  /** The device's own Full access opt-in, as the daemon enforces it right now. */
  get fullAccessOn(): boolean {
    return this.gate.optIn;
  }

  get isConnected(): boolean {
    return this.link?.connected ?? false;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    // 07.13 (PD-19, Pitfall 1): a crash or a kill leaves run dirs (throwaway profiles) behind; none of them is alive.
    await sweepRunDirs(this.browserRoot, new Set(this.sessions.keys())).catch(() => undefined);
    if (this.opts.controlSocket !== false) {
      const path = this.opts.controlSocket ?? controlSocketPath(this.home);
      this.control = new ControlSocketServer(path, (req) => this.handleControl(req), this.log);
      await this.control.listen();
      this.log.info("control socket listening");
    }
    if (!this.token) {
      this.log.warn(
        "no device token found; pair this device with `ocw-runtime setup` (or from the desktop app), then restart the runtime",
      );
      // A headless, unpaired daemon still keeps its CLIs checked and reports locally (`notify`, D-10).
      this.maintenance?.start({ paired: false });
      return;
    }
    this.link = new DeviceLink({
      url: toWebSocketUrl(this.config.serverUrl),
      token: this.token,
      getAccessToken: ({ refresh }) => this.getAccessToken(refresh),
      onOpenFrames: () => this.handshakeFrames(),
      onCommand: (cmd) => void this.handleCommand(cmd),
      onServerFrame: (frame) => this.onServerFrame(frame),
      logger: this.log,
      ...this.opts.link,
    });
    this.link.start();
    this.log.info("connecting to server", { serverUrl: this.config.serverUrl });
    this.maintenance?.start({ paired: true });
    this.selfUpdate?.start();
  }

  /**
   * Server frames besides commands (PD-03): `runtime.config` sets the org level and the manifest; 07.17.1 (PD-10): the
   * self-update then checks what the workspace serves (nothing at `off`).
   */
  private onServerFrame(frame: Exclude<ServerToDeviceFrame, CommandFrame>): void {
    // 07.13 (PD-12 … PD-17): the six ephemeral browser frames go to the manager, never queued and never acked.
    if (isBrowserServerFrame(frame)) {
      void this.browser.onServerFrame(frame).catch((err: unknown) =>
        this.log.warn("browser server frame failed", {
          type: frame.type,
          error: err instanceof Error ? err.name : "error",
        }),
      );
      return;
    }
    if (frame.type !== "runtime.config") return;
    this.maintenance?.setOrgPolicy(frame.policy, frame.manifest);
    void this.selfUpdate?.onConfig();
  }

  /**
   * Stops the daemon. 07.17.1 (E29): the SelfUpdate stops first; a run not yet switched is cancelled there (gates
   * reopen, `finished failed`). Once it switched (the exit hand-over, gates still held) the link closes right after the
   * last snapshot went out: no ack, run frame or session event from the teardown reaches the server, and nothing
   * reopens a gate on an open socket. The next daemon reports the run from the marker.
   *
   * Review WR-01: every gate is sealed first, so nothing held (by the self-update or a 07.11 CLI update) or newly
   * arriving starts a turn in a daemon that is stopping; the server re-queues those prompts after the restart (PD-27).
   */
  async stop(): Promise<void> {
    this.stopping = true;
    // 07.18: a sign-in in progress is cancelled at Codex (its slot removed); the admin starts it again.
    for (const login of this.accountLogins.values()) login.abort();
    for (const gate of this.gates.values()) gate.seal();
    // 07.13.1 (D-07): the app's hold keeps its gates sealed; no timer reopens anything and nobody is told.
    this.appHold.stop();
    await this.selfUpdate?.stop();
    if (this.selfUpdate?.holding) {
      await this.snapshotChain;
      await this.link?.stop();
    }
    this.maintenance?.stop();
    await Promise.all([...this.runtimes.values()].map((r) => r.stopAll().catch(() => undefined)));
    this.sessions.clear();
    await this.browser.stopAll();
    await this.link?.stop();
    await this.control?.close();
    this.started = false;
  }

  async status(): Promise<Record<string, unknown>> {
    return {
      paired: this.token !== null,
      connected: this.isConnected,
      serverUrl: this.config.serverUrl,
      deviceName: deviceName(this.config),
      queuedFrames: this.link?.queuedFrames ?? 0,
      runtimes: await this.detectRuntimes(),
      projects: this.registry.list().length,
      fullAccessOptIn: this.gate.optIn,
      fullAccessSource: this.gate.source,
      isolatedServer: this.isolated.on,
      isolatedServerSource: this.isolated.source,
      host: this.hostKind,
      // 07.13 (D-10, PD-27): the browser opt-in as the daemon enforces it (the desktop menu reads it here).
      browser: {
        optIn: this.browserCfg.optIn,
        source: this.browserCfg.source,
        sandbox: this.browserCfg.sandbox,
        openPages: this.browser.openPages,
      },
      ...(this.maintenance ? { runtimeUpdates: this.runtimeUpdatesStatus(this.maintenance) } : {}),
      // 07.13.1 (D-07): the app's restart hold, for its "Waiting for N sessions…" line (states and counts only).
      appUpdate: this.appHold.status(),
      sessions: [...this.sessions.values()].map((s) => ({
        sessionId: s.sessionId,
        projectLocalId: s.project.localId,
        runtime: s.runtime.id,
        worktreeBranch: s.worktreeBranch,
      })),
    };
  }

  /** 07.11 (D-06): the levels and each runtime's status, exactly as the snapshot reports them. */
  private runtimeUpdatesStatus(m: RuntimeMaintenance) {
    return {
      localLevel: m.localLevel,
      localLevelSource: m.localLevelSource,
      effectiveLevel: m.effectiveLevel,
      orgLevelReceived: m.orgLevelReceived,
      runtimes: m.statuses(),
    };
  }

  // -------------------------------------------------------------------------------------------
  // Device Link

  /**
   * Bearer credential for the next Device Link connect: a 10-minute device JWT exchanged for the device
   * token, cached until fewer than 60 s remain. A server without the exchange (404, built before Phase 2)
   * gets the raw device token. A refused device token (401/403) is logged and rethrown so the link backs
   * off. Neither token is ever logged.
   */
  private async getAccessToken(refresh = false): Promise<string> {
    const deviceToken = this.token;
    if (!deviceToken) throw new Error("device is not paired");
    const cached = this.accessToken;
    if (!refresh && cached && cached.expiresAtMs - Date.now() > ACCESS_TOKEN_REFRESH_MARGIN_MS) {
      return cached.token;
    }
    this.accessToken = null;
    const res = await fetch(toDeviceTokenUrl(this.config.serverUrl), {
      method: "POST",
      headers: { Authorization: `Bearer ${deviceToken}` },
      signal: AbortSignal.timeout(TOKEN_EXCHANGE_TIMEOUT_MS),
    });
    if (res.status === 404) {
      await res.body?.cancel();
      if (!this.legacyServerWarned) {
        this.legacyServerWarned = true;
        this.log.warn("server has no device token exchange; connecting with the device token");
      }
      return deviceToken;
    }
    if (res.status === 401 || res.status === 403) {
      await res.body?.cancel();
      this.log.error("device token rejected by server", { status: res.status });
      throw new DeviceTokenRejectedError(res.status);
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new Error(`device token exchange failed (HTTP ${res.status})`);
    }
    const parsed = DeviceAccessToken.safeParse(await res.json().catch(() => null));
    if (!parsed.success) throw new Error("device token exchange returned an invalid answer");
    this.accessToken = { token: parsed.data.token, expiresAtMs: Date.parse(parsed.data.expiresAt) };
    return parsed.data.token;
  }

  private async detectRuntimes(): Promise<RuntimeInfo[]> {
    if (this.detectCache && Date.now() - this.detectCache.at < DETECT_CACHE_MS) return this.detectCache.value;
    const value = await Promise.all(
      [...this.runtimes.values()].map((r) =>
        r.detect().catch((): RuntimeInfo => ({ id: r.id, installed: false, version: null, loggedIn: false })),
      ),
    );
    this.detectCache = { at: Date.now(), value };
    return value;
  }

  /**
   * The catalogs of every installed, signed-in runtime (P-05). Collecting one never sends a model turn; an adapter
   * that fails to answer is skipped (logged). Sanitised like every outbound value (no absolute paths).
   */
  private async collectCatalogs(): Promise<RuntimeCatalog[]> {
    const infos = await this.detectRuntimes();
    const roots = [this.home, ...this.registry.list().map((p) => p.path)];
    const out: RuntimeCatalog[] = [];
    for (const r of this.runtimes.values()) {
      const info = infos.find((i) => i.id === r.id);
      if (!info?.installed || !r.catalog) continue;
      // 07.18 (D-02): a signed-out Codex still has a catalog when one of its account slots is signed in; 07.18-19 R1.8:
      // a signed-out Claude when a pool token is in its adapter's memory.
      if (!info.loggedIn && !(await this.catalogWithoutOwnLogin(r))) continue;
      // 07.11 (PD-07): never while this runtime's CLI updates; the capabilities sent after the run cover it.
      const gate = this.gates.get(r.id);
      if (gate && !gate.isOpen) continue;
      const collect = r.catalog.bind(r);
      try {
        const catalog = await (gate ? gate.admit(collect) : collect());
        if (!catalog) continue;
        const parsed = RuntimeCatalog.safeParse(sanitizeValue(catalog, roots));
        if (parsed.success) {
          // The catalog never offers fullAccess while this device's opt-in is off, whatever an adapter says.
          if (!this.gate.optIn) {
            parsed.data.permissionModes = parsed.data.permissionModes.filter((m) => m !== "fullAccess");
          }
          out.push(parsed.data);
        } else this.log.warn("runtime catalog rejected", { runtime: r.id });
      } catch (err) {
        this.log.warn("runtime catalog unavailable", {
          runtime: r.id,
          error: sanitizeString(errorMessage(err), roots),
        });
      }
    }
    return out;
  }

  /** 07.18 (D-02), 07.18-19 R1.8: a runtime whose own login is signed out can still describe what a pool account offers. */
  private async catalogWithoutOwnLogin(r: AgentRuntime): Promise<boolean> {
    if (r.id === "codex") return (await firstSignedInSlotHome(this.codexSlots)) !== null;
    return r.catalogReadyWithoutLogin?.() === true;
  }

  /**
   * 07.18-19 R1.8: a pool session just made a catalog possible on a runtime signed out on this device (a pool-only
   * device): the server hears it now, so the new-session dialog can offer models. Nothing when the device is signed in.
   */
  private async announcePoolCatalog(runtime: AgentRuntime): Promise<void> {
    if (!this.isConnected || runtime.id === "codex" || !runtime.catalogReadyWithoutLogin?.()) return;
    const info = (await this.detectRuntimes()).find((i) => i.id === runtime.id);
    if (!info || info.loggedIn) return;
    const frame = await this.capabilitiesFrame();
    if (this.isConnected) this.send(frame);
  }

  private async handshakeFrames(): Promise<DeviceToServerFrame[]> {
    const hello: DeviceToServerFrame = {
      type: "hello",
      protocolVersion: DEVICE_LINK_PROTOCOL_VERSION,
      device: {
        name: deviceName(this.config),
        platform: platform(),
        arch: arch(),
        daemonVersion: DAEMON_VERSION,
        // 07.13 (D-18, PD-21): the desktop app's version, when it launched this daemon (a semver only).
        ...(this.appVersion ? { appVersion: this.appVersion } : {}),
        ...(this.hostKind ? { host: this.hostKind } : {}),
      },
      runtimes: await this.detectRuntimes(),
      sessions: [...this.sessions.keys()],
      // ADR-0012 / P-12: the device owner's local opt-in, reported as is; the server never sets it.
      fullAccessOptIn: this.gate.optIn,
      // 07.16 (D-19): the owner's isolated-server mark, reported only for a service host; the server never sets it.
      isolatedServer: this.reportedIsolated,
      // 07.18 (PD-04): this daemon can run a session on a pool account.
      accountPool: DEVICE_ACCOUNT_POOL_VERSION,
      // 07.13 (D-19, PD-20): this daemon can run a Work Zone browser, and the owner's local opt-in as it is now.
      browser: this.browserReport,
      // 07.13 review MD-01: the pages open now and whether a sign-in is loaded in each; the API reconciles its rows.
      browserPages: this.browser.pages().slice(0, 1000),
      // ADR-0045: this daemon copies a prompt's files into the working tree before the turn.
      promptFiles: DEVICE_PROMPT_FILES_VERSION,
    };
    await this.refreshProjectsGit();
    const frames: DeviceToServerFrame[] = [
      hello,
      // 07.17.1 (PD-12): the run the last restart carried over, right after hello, until it went out once.
      ...(this.boot ? this.boot.report.frames : []),
      { type: "projects.sync", projects: this.registry.toSynced() },
      await this.capabilitiesFrame(),
      // 07.18 (D-02, PD-10): every Codex slot, after capabilities; offline changes go with this frame on reconnect.
      await this.accountsSyncFrame(),
      ...(this.maintenance ? [this.withSelf(await this.maintenance.snapshot())] : []),
    ];
    // The link writes these frames right after this resolves; once they went out on an open socket, the marker goes.
    if (this.boot) setImmediate(() => void this.afterBootReported());
    return frames;
  }

  /**
   * 07.17.1 (PD-12): the boot frames were written on an open socket: the marker is removed and `versions/` pruned
   * (keeping the running build and the one the run came from), once. Still disconnected: the next handshake sends
   * them again.
   */
  private async afterBootReported(): Promise<void> {
    const boot = this.boot;
    if (!boot || !this.isConnected) return;
    this.boot = null;
    try {
      await removeSelfUpdateMarker(this.home);
      if (boot.running) {
        await pruneRuntimeVersions({
          ocwHome: this.home,
          keep: [boot.running.sha256.slice(0, 12), boot.report.marker.from.sha256.slice(0, 12)],
        });
      }
    } catch (err) {
      this.log.warn("runtime self-update: cleanup after the restart failed", {
        error: sanitizeString(errorMessage(err), [this.home]),
      });
    }
  }

  private async capabilitiesFrame(): Promise<DeviceToServerFrame> {
    const catalogs = await this.collectCatalogs();
    return {
      type: "capabilities",
      catalogs,
      fullAccessOptIn: this.gate.optIn,
      isolatedServer: this.reportedIsolated,
      browser: this.browserReport,
    };
  }

  /** 07.13 (PD-20): what hello and capabilities say about the browser. */
  private get browserReport(): DeviceBrowserReport {
    return { version: DEVICE_BROWSER_VERSION, optIn: this.browserCfg.optIn };
  }

  private send(frame: DeviceToServerFrame): void {
    this.link?.send(frame);
  }

  /**
   * 07.18 (D-02, P2): the slots as the server may see them: id, label, origin, signed in, plan, usage. Never a path, an
   * e-mail or anything from `auth.json`. A slot file that cannot be read reports no slots (logged).
   */
  private async accountsSyncFrame(): Promise<DeviceToServerFrame> {
    const codexSlots = await this.codexSlots.report().catch((err: unknown) => {
      this.log.warn("account slots unreadable", { error: sanitizeString(errorMessage(err), [this.home]) });
      return [];
    });
    return { type: "accounts.sync", codexSlots };
  }

  /** 07.18: a slot changed: the server hears it now while connected; offline, the next handshake carries it. */
  private async sendAccountsSync(): Promise<void> {
    if (!this.isConnected) return;
    const frame = await this.accountsSyncFrame();
    if (this.isConnected) this.send(frame);
  }

  private async syncProjects(): Promise<void> {
    // Offline changes are covered by the handshake on reconnect; never queue a stale list.
    if (!this.isConnected) return;
    await this.refreshProjectsGit();
    if (!this.isConnected) return;
    this.send({ type: "projects.sync", projects: this.registry.toSynced() });
  }

  /**
   * Quick 261119-ngw: every announcement carries each project's git as it is now (the server runs a bot session in
   * place when a project has no git). A failure keeps the flags as they were and never holds the announcement back.
   */
  private async refreshProjectsGit(): Promise<void> {
    try {
      await this.registry.refreshGit();
    } catch (err) {
      this.log.warn("project git check failed", {
        error: sanitizeString(errorMessage(err), [this.home, ...this.registry.list().map((p) => p.path)]),
      });
    }
  }

  private rootsFor(cwd: string, project?: LocalProject): string[] {
    const roots = [cwd, realpathOr(cwd)];
    if (project) roots.push(project.path, realpathOr(project.path));
    return roots;
  }

  /** The only path by which runtime events leave the device. */
  forwardEvent(sessionId: string, event: SessionEvent): void {
    const roots = this.rootsBySession.get(sessionId) ?? [];
    // Seeded from the clock (µs-scale) so a restarted daemon never reuses a localSeq the server has
    // already stored for this session; the server drops events whose localSeq is not increasing.
    const localSeq = (this.seqBySession.get(sessionId) ?? Date.now() * 1000) + 1;
    this.seqBySession.set(sessionId, localSeq);
    // P-11: a runtime may echo an attached image into its error text; other events and diffs are left as they are.
    const out: SessionEvent =
      event.type === "session.error" ? { ...event, message: stripImageData(event.message) } : event;
    this.send({ type: "event", sessionId, event: sanitizeEvent(out, roots), localSeq });
    this.trackTurn(sessionId, event);
    // 07.13 (PD-09): the browser's calls use the grant of the turn running now.
    if (event.type === "prompt.started") this.browser.onTurnStarted(sessionId, event.promptId);
    else if (event.type === "prompt.completed") this.browser.onTurnEnded(sessionId, event.promptId);
    // 07.11 (PD-07): a turn ended or a session changed state: a pending update may take this idle moment.
    if (event.type === "prompt.completed" || event.type === "session.state") {
      const runtime = this.sessions.get(sessionId)?.runtime.id;
      if (runtime) this.maintenance?.onRuntimeActivity(runtime);
    }
  }

  /**
   * 07.17.1.1 (D-13, PD-08): whether a turn of the session runs, from the events it forwards: `prompt.started` (or a
   * `running` / `waiting_approval` state) begins one; `prompt.completed`, or any other state, ends it. A file write is
   * refused `busy` meanwhile, the second line behind the API's own check.
   */
  private trackTurn(sessionId: string, event: SessionEvent): void {
    if (event.type === "prompt.started") this.turnsRunning.add(sessionId);
    else if (event.type === "prompt.completed") this.turnsRunning.delete(sessionId);
    else if (event.type === "session.state") {
      if (event.status === "running" || event.status === "waiting_approval") this.turnsRunning.add(sessionId);
      else this.turnsRunning.delete(sessionId);
    }
  }

  /** A session left this device (stopped, completed, failed or never started): its turn is forgotten too. */
  private endSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.turnsRunning.delete(sessionId);
    // 07.13 (PD-24): its page closes and its run dir goes.
    void this.browser.endSession(sessionId);
  }

  /**
   * 07.11 (PD-07, D-03): runs a command that starts or shapes a turn of `runtime` through that runtime's gate. While
   * its CLI updates the command waits (it is never refused or dropped) and its session is told once (`runtime.update`
   * `waiting`); the other runtime is never held. Without a known runtime it runs as before (and fails as before).
   */
  private admit<T>(runtime: RuntimeId | undefined, sessionId: string, fn: () => Promise<T>): Promise<T> {
    const gate = runtime ? this.gates.get(runtime) : undefined;
    if (!runtime || !gate) return fn();
    return gate.admit(fn, () => this.tellWaiting(runtime, sessionId));
  }

  private tellWaiting(runtime: RuntimeId, sessionId: string): void {
    // 07.17.1 (PD-18): the OCW runtime's own restart holds this turn; told once per hold, never `done` (the next
    // daemon does not know the holds; the server runs the held prompt after the restart, PD-27).
    if (this.selfUpdate?.holding) {
      if (this.selfHeldSessions.has(sessionId)) return;
      this.selfHeldSessions.set(sessionId, runtime);
      this.forwardEvent(sessionId, {
        type: "runtime.update",
        runtime,
        phase: "waiting",
        subject: OCW_RUNTIME_TARGET,
      });
      return;
    }
    // 07.13.1 (D-07): the desktop app's restart holds this turn; for the session it is the OCW runtime restarting.
    if (this.appHold.active) {
      if (this.appHeldSessions.has(sessionId)) return;
      this.appHeldSessions.set(sessionId, runtime);
      this.forwardEvent(sessionId, {
        type: "runtime.update",
        runtime,
        phase: "waiting",
        subject: OCW_RUNTIME_TARGET,
      });
      return;
    }
    let held = this.heldSessions.get(runtime);
    if (!held) {
      held = new Set();
      this.heldSessions.set(runtime, held);
    }
    if (held.has(sessionId)) return;
    held.add(sessionId);
    this.forwardEvent(sessionId, { type: "runtime.update", runtime, phase: "waiting" });
  }

  /** The update ended: every session told `waiting` gets `done` (with the version now installed) or `failed`. */
  private notifyHeldSessions(runtime: RuntimeId, phase: "done" | "failed", version?: string): void {
    const held = this.heldSessions.get(runtime);
    if (!held) return;
    this.heldSessions.delete(runtime);
    for (const sessionId of held) {
      this.forwardEvent(sessionId, {
        type: "runtime.update",
        runtime,
        phase,
        ...(version ? { version } : {}),
      });
    }
  }

  private ack(commandId: string, error?: string, roots: string[] = []): void {
    if (error === undefined) this.send({ type: "ack", commandId, ok: true });
    else
      this.send({ type: "ack", commandId, ok: false, error: sanitizeString(stripImageData(error), roots) });
  }

  private remember(commandId: string): void {
    this.processedCommands.add(commandId);
    if (this.processedCommands.size > MAX_REMEMBERED_COMMANDS) {
      const first = this.processedCommands.values().next().value;
      if (first !== undefined) this.processedCommands.delete(first);
    }
  }

  /** Review CR-03: the finished outcome of a file command (`undefined` error = ok), answered again on redelivery. */
  private rememberFileOutcome(commandId: string, error: string | undefined): void {
    this.fileOutcomes.set(commandId, { error });
    if (this.fileOutcomes.size > MAX_REMEMBERED_COMMANDS) {
      const first = this.fileOutcomes.keys().next().value;
      if (first !== undefined) this.fileOutcomes.delete(first);
    }
  }

  /**
   * Review CR-03: a file command is keyed by its id (= the transfer id). A copy redelivered while the first still runs
   * is not answered (the running one acks with its real outcome); a copy of a finished one gets that outcome again.
   * Never a blind `ok`: the API would report and audit a file that may never have landed.
   */
  private async handleFileCommand(cmd: CommandFrame): Promise<void> {
    if (this.fileInFlight.has(cmd.id)) return;
    const done = this.fileOutcomes.get(cmd.id);
    if (done) {
      this.ack(cmd.id, done.error, this.rootsBySession.get(cmd.sessionId) ?? []);
      return;
    }
    this.fileInFlight.add(cmd.id);
    try {
      // 07.17.1.1 (D-13, principle 4): a write is handed over between turns, never beside a prompt or configure.
      if (cmd.kind === "session.file.write")
        await this.inSessionOrder(cmd.sessionId, () => this.execute(cmd));
      else await this.execute(cmd);
    } finally {
      this.fileInFlight.delete(cmd.id);
    }
  }

  async handleCommand(cmd: CommandFrame): Promise<void> {
    if (cmd.kind === "session.file.read" || cmd.kind === "session.file.write") {
      return this.handleFileCommand(cmd);
    }
    if (this.processedCommands.has(cmd.id)) {
      this.ack(cmd.id); // replayed command; already executed
      return;
    }
    this.remember(cmd.id);
    if (cmd.kind !== "prompt" && cmd.kind !== "session.configure") {
      return this.execute(cmd);
    }
    return this.inSessionOrder(cmd.sessionId, () => this.execute(cmd));
  }

  /** Runs `fn` after every earlier configure / prompt / file write of this session (D-14 order; writes since 07.17.1.1). */
  private inSessionOrder<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.sessionChains.get(sessionId) ?? Promise.resolve();
    const run = prev.then(fn);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.sessionChains.set(sessionId, tail);
    void tail.then(() => {
      if (this.sessionChains.get(sessionId) === tail) this.sessionChains.delete(sessionId);
    });
    return run;
  }

  // -------------------------------------------------------------------------------------------
  // Full access opt-in (ADR-0012, D-02, P-12)

  /**
   * Re-reads runtime.json (the desktop Runtime menu and `ocw-runtime full-access` write it; the environment still
   * wins). Turning the opt-in OFF takes effect at once: the gate closes for every adapter, running full-access turns
   * are interrupted, the server gets `capabilities` with `fullAccessOptIn: false`, and those sessions are lowered to
   * acceptEdits here (the server's own downgrade follows). Turning it on is only reported.
   *
   * 07.11 (D-02): it also re-reads the device's runtime updates level (`OCW_RUNTIME_UPDATES` still wins) and hands a
   * change to maintenance, which drops a pending (not running) automatic update when the effective level falls below
   * `automatic`, stops registry requests at `off`, and sends the server a fresh `runtime.maintenance` snapshot.
   *
   * 07.16 (D-19): it also re-reads the isolated-server mark (`OCW_ISOLATED_SERVER` still wins); when what is reported
   * changes (service hosts only), the server gets `capabilities` at once, so turning it off lowers bot sessions now.
   */
  async reloadConfig(): Promise<ReloadConfigResult> {
    const loaded = await loadConfig(this.home, this.env);
    const merged = { ...loaded, ...this.opts.config };
    const updates = resolveRuntimeUpdates(merged, this.env);
    const m = this.maintenance;
    if (m && (m.localLevel !== updates.level || m.localLevelSource !== updates.source)) {
      this.log.info("runtime updates level changed on this device", {
        level: updates.level,
        source: updates.source,
      });
      m.setLocalLevel(updates.level, updates.source);
    }
    // 07.16 (D-19): the isolated-server mark; a change of what is reported reaches the server at once.
    const wasIsolated = this.reportedIsolated;
    this.isolated = resolveIsolatedServer(merged, this.env);
    const isolatedChanged = wasIsolated !== this.reportedIsolated;
    if (isolatedChanged) {
      this.log.warn(
        this.reportedIsolated
          ? "This device is marked as an isolated server"
          : "The isolated-server mark is off",
        { source: this.isolated.source },
      );
    }
    // 07.13 (D-10, PD-20, PD-27): the browser opt-in; off closes every open page now and refuses the next call.
    const browserWas = this.browserCfg.optIn;
    this.browserCfg = resolveBrowser(merged, this.env);
    const browserChanged = browserWas !== this.browserCfg.optIn;
    if (browserChanged) {
      this.log.warn(
        this.browserCfg.optIn
          ? "The Work Zone browser is enabled on this device"
          : "The Work Zone browser is disabled on this device",
        { source: this.browserCfg.source },
      );
      await this.browser.onOptInChanged();
    }
    const next = resolveFullAccess(merged, this.env);
    const was = this.gate.optIn;
    this.gate.optIn = next.optIn;
    this.gate.source = next.source;
    if (was !== next.optIn) {
      this.log.warn(
        next.optIn ? "Full access enabled on this device" : "Full access disabled on this device",
        {
          source: next.source,
        },
      );
      const full = next.optIn ? [] : [...this.sessions.values()].filter((s) => s.mode === "fullAccess");
      await Promise.all(
        full.map((s) =>
          s.runtime.interrupt(s.sessionId).catch((err: unknown) =>
            this.log.warn("could not interrupt a full-access turn", {
              sessionId: s.sessionId,
              error: sanitizeString(errorMessage(err), this.rootsBySession.get(s.sessionId) ?? []),
            }),
          ),
        ),
      );
      if (this.isConnected) this.send(await this.capabilitiesFrame());
      // 07.11 review ME-06: lowering goes through the runtime's gate. A session whose CLI is updating is lowered once
      // the update ends (the adapters refuse its fullAccess turns meanwhile); the reload answers now rather than then.
      const lowering = Promise.all(full.map((s) => this.leaveFullAccess(s).catch(() => undefined)));
      if (full.every((s) => this.gates.get(s.runtime.id)?.isOpen !== false)) await lowering;
    } else if ((isolatedChanged || browserChanged) && this.isConnected) {
      this.send(await this.capabilitiesFrame());
    }
    return {
      fullAccessOptIn: next.optIn,
      fullAccessSource: next.source,
      runtimeUpdatesLevel: updates.level,
      runtimeUpdatesSource: updates.source,
      ...(m ? { runtimeUpdatesEffectiveLevel: m.effectiveLevel } : {}),
      isolatedServer: this.isolated.on,
      isolatedServerSource: this.isolated.source,
      host: this.hostKind,
      browserOptIn: this.browserCfg.optIn,
      browserOptInSource: this.browserCfg.source,
    };
  }

  /**
   * 07.18 (D-02, PD-11): `ocw-runtime account add|remove` changed slots.json: the slots are re-read from it and sent to
   * the server now (`accounts.sync`, while connected; offline, the next handshake reports them). Answers the count.
   */
  async reloadAccounts(): Promise<{ codexSlots: number }> {
    const slots = await this.codexSlots.list();
    await this.sendAccountsSync();
    return { codexSlots: slots.length };
  }

  /** Lowers one session out of fullAccess after the opt-out (in session order, before any later prompt). */
  private leaveFullAccess(s: ActiveSession): Promise<void> {
    return this.inSessionOrder(s.sessionId, async () => {
      if (s.mode !== "fullAccess" || !this.sessions.has(s.sessionId)) return;
      try {
        const configure = s.runtime.configure?.bind(s.runtime);
        if (!configure) throw new Error(`settings changes are not supported by ${s.runtime.id}`);
        // Through the gate (ME-06): a configure may wake or relaunch the CLI, never mid-update.
        await this.admit(s.runtime.id, s.sessionId, () =>
          configure(s.sessionId, { permissionMode: "acceptEdits" }),
        );
        if (!this.sessions.has(s.sessionId)) return;
        s.mode = "acceptEdits";
      } catch (err) {
        // The adapters' own gate still refuses every fullAccess turn; the server's downgrade follows.
        this.log.warn("could not lower a full-access session", {
          sessionId: s.sessionId,
          error: sanitizeString(errorMessage(err), this.rootsBySession.get(s.sessionId) ?? []),
        });
      }
    });
  }

  private async execute(cmd: CommandFrame): Promise<void> {
    const roots = this.rootsBySession.get(cmd.sessionId) ?? [];
    try {
      switch (cmd.kind) {
        // 07.11 (PD-07): session.start, prompt (and steer), session.configure and session.title wait at their
        // runtime's gate while its CLI updates; interrupt, approval.resolve, session.stop and diff.request never do.
        case "session.start":
          await this.admit(
            SessionStartPayload.safeParse(cmd.payload ?? {}).data?.runtime,
            cmd.sessionId,
            () => this.startSession(cmd),
          );
          break;
        case "prompt":
          await this.admit(this.requireSession(cmd.sessionId).runtime.id, cmd.sessionId, () =>
            this.runPrompt(cmd),
          );
          break;
        case "interrupt":
          await this.requireSession(cmd.sessionId).runtime.interrupt(cmd.sessionId);
          break;
        case "approval.resolve": {
          const p = ApprovalResolvePayload.parse(cmd.payload);
          // 07.13 (PD-10, Pitfall 7): a browser approval is the manager's, never the adapter's.
          if (this.browser.resolveApproval(cmd.sessionId, p.approvalId, p.decision)) break;
          const ok = this.requireSession(cmd.sessionId).runtime.resolveApproval(
            cmd.sessionId,
            p.approvalId,
            p.decision,
            p.comment,
          );
          if (!ok) throw new Error("approval not pending (unknown, expired or already resolved)");
          break;
        }
        case "session.stop": {
          const s = this.sessions.get(cmd.sessionId);
          if (s) {
            await s.runtime.stop(cmd.sessionId);
            this.endSession(cmd.sessionId);
          }
          break;
        }
        case "diff.request":
          await this.sendDiff(cmd);
          break;
        // 07.17.1.1 (D-03, D-08): never in session order and never gated, like diff.request: a running turn does not
        // delay it (a file being written may be read half-done, PD-08).
        case "session.file.read":
          await this.readSessionFile(cmd);
          break;
        // 07.17.1.1 (D-02, D-13): in session order (handleCommand), only while no turn runs; not gated (no CLI call).
        case "session.file.write":
          await this.writeSessionFileFromServer(cmd);
          break;
        case "session.configure":
          await this.admit(this.sessions.get(cmd.sessionId)?.runtime.id, cmd.sessionId, () =>
            this.configureSession(cmd),
          );
          break;
        case "session.title":
          await this.admit(
            SessionTitlePayload.safeParse(cmd.payload ?? {}).data?.runtime,
            cmd.sessionId,
            () => this.sendTitle(cmd),
          );
          break;
        // 07.11 "Update now" (D-05, PD-08): never in session order, never gated; acked once accepted.
        case "runtime.update":
          await this.requestRuntimeUpdate(cmd);
          break;
        // 07.18 (D-02, D-10, PD-10): outside the session chains; Codex's gate holds them while its CLI updates. A
        // sign-in acks only after its outcome frame.
        case "account.login":
          await this.accountLogin(cmd);
          break;
        case "account.logout":
          await this.accountLogout(cmd);
          break;
      }
      if (cmd.kind === "session.file.read" || cmd.kind === "session.file.write") {
        this.rememberFileOutcome(cmd.id, undefined);
      }
      this.ack(cmd.id);
    } catch (err) {
      if (cmd.kind === "session.file.read" || cmd.kind === "session.file.write") {
        // 07.17.1.1 (P1): a code and at most a size; the log line carries the command id and the code only.
        const e = err instanceof SessionFileError ? err : new SessionFileError("transfer_failed");
        this.rememberFileOutcome(cmd.id, e.message);
        this.log.warn("session file command failed", { kind: cmd.kind, commandId: cmd.id, code: e.code });
        this.ack(cmd.id, e.message, this.rootsBySession.get(cmd.sessionId) ?? roots);
        return;
      }
      const message = errorMessage(err);
      this.log.warn("command failed", {
        kind: cmd.kind,
        commandId: cmd.id,
        error: sanitizeString(stripImageData(message), roots),
      });
      this.ack(cmd.id, message, this.rootsBySession.get(cmd.sessionId) ?? roots);
      if (cmd.kind === "session.start") {
        this.forwardEvent(cmd.sessionId, { type: "session.error", message });
        this.forwardEvent(cmd.sessionId, { type: "session.state", status: "failed" });
      }
    }
  }

  /**
   * "Update now" from the web (D-05, PD-08): the payload names the runtime and nothing else (strict); the device picks
   * the candidate and the command from its own table. Refusals are the ack's error text; the result arrives as
   * `runtime.update.run` frames carrying this command's id.
   */
  private async requestRuntimeUpdate(cmd: CommandFrame): Promise<void> {
    const payload = RuntimeUpdatePayload.safeParse(cmd.payload);
    if (!payload.success) throw new Error(INVALID_PAYLOAD_MESSAGE);
    const runtime = payload.data.runtime;
    // 07.17.1 (D-05, PD-11, E17): the device re-decides; a command it already ran (before the restart too) runs nothing.
    if (runtime === OCW_RUNTIME_TARGET) {
      const su = this.selfUpdate;
      if (!su) throw new Error(SELF_UPDATE_UNAVAILABLE_MESSAGE);
      if (su.isKnownCommand(cmd.id)) return;
      const answer = await su.request("manual", cmd.id);
      if (!answer.accepted) throw new Error(answer.reason);
      return;
    }
    if (!this.maintenance) throw new Error(RUNTIME_UPDATES_UNAVAILABLE_MESSAGE);
    const answer = await this.maintenance.requestUpdate(runtime, "manual", cmd.id);
    if (!answer.accepted) throw new Error(answer.reason);
  }

  // -------------------------------------------------------------------------------------------
  // Codex account slots (07.18, D-02, D-10, PD-10, PD-25)

  /** How account app-servers start: the test seam, else the configured CLI, else (not in fake mode) the detected one. */
  private codexAccountsSpawn(): SpawnAppServer {
    const seam = this.opts.codexAccounts?.spawn;
    if (seam) return seam;
    const fake = this.env.OCW_RUNTIME_FAKE === "1";
    const path = this.config.codex.path ?? (fake ? null : findExecutable("codex", this.env));
    return codexAccountSpawner(path, this.log);
  }

  /** Runs `fn` through Codex's gate (a sign-in never starts while its CLI updates, and holds the update meanwhile). */
  private admitCodex<T>(fn: () => Promise<T>): Promise<T> {
    const gate = this.gates.get("codex");
    return gate ? gate.admit(fn) : fn();
  }

  /**
   * `account.login` (D-02, D-10): the slot (created with `origin: "server"` unless it exists), Codex's device-code
   * login under its `CODEX_HOME`, frames `code` then `completed` (or `failed`) with this command's id, then
   * `accounts.sync`. A failure removes a slot this sign-in created and fails the ack with the same message, stripped of
   * the user code (T-07.18-08-06).
   */
  private async accountLogin(cmd: CommandFrame): Promise<void> {
    const payload = AccountLoginPayload.safeParse(cmd.payload);
    if (!payload.success) throw new Error(INVALID_PAYLOAD_MESSAGE);
    const { slotId, label } = payload.data;
    if (this.accountLogins.has(slotId)) throw new Error(SIGN_IN_RUNNING_MESSAGE);
    const controller = new AbortController();
    this.accountLogins.set(slotId, controller);
    let created = false;
    let userCode: string | null = null;
    try {
      if (!(await this.codexSlots.get(slotId))) {
        await this.codexSlots.create({ label, origin: "server", slotId });
        created = true;
      }
      const home = this.codexSlots.homeOf(slotId);
      const timeoutMs = this.opts.codexAccounts?.loginTimeoutMs;
      const result = await this.admitCodex(() =>
        runCodexDeviceLogin({
          spawn: this.codexAccountsSpawn(),
          home,
          env: this.env,
          signal: controller.signal,
          ...(timeoutMs ? { timeoutMs } : {}),
          onCode: (code) => {
            userCode = code.userCode;
            this.send({ type: "account.login", requestId: cmd.id, slotId, phase: "code", ...code });
          },
        }),
      );
      await this.codexSlots.setPlan(slotId, result.planType);
      this.send({
        type: "account.login",
        requestId: cmd.id,
        slotId,
        phase: "completed",
        ...(result.planType ? { planType: result.planType } : {}),
      });
      this.log.info("Codex account signed in", { slotId });
      await this.sendAccountsSync();
    } catch (err) {
      const code = err instanceof CodexLoginError ? err.code : "failed";
      const message = sanitizeString(withoutUserCode(errorMessage(err), userCode), [this.home]).slice(0, 300);
      this.send({
        type: "account.login",
        requestId: cmd.id,
        slotId,
        phase: "failed",
        error: { code, message },
      });
      if (created) {
        await this.codexSlots.remove(slotId).catch((e: unknown) =>
          this.log.warn("could not remove the slot of a failed sign-in", {
            slotId,
            error: sanitizeString(errorMessage(e), [this.home]),
          }),
        );
      }
      throw new Error(message);
    } finally {
      this.accountLogins.delete(slotId);
    }
  }

  /**
   * `account.logout` (PD-25): a running sign-in of the slot is cancelled, Codex signs it out, then the slot is removed
   * (the shared `sessions/` stays) and `accounts.sync` re-sent. Unknown slot: done already (idempotent). A sign-out
   * Codex refuses still removes the slot: its `auth.json` goes with the directory.
   */
  private async accountLogout(cmd: CommandFrame): Promise<void> {
    const payload = AccountLogoutPayload.safeParse(cmd.payload);
    if (!payload.success) throw new Error(INVALID_PAYLOAD_MESSAGE);
    const { slotId } = payload.data;
    this.accountLogins.get(slotId)?.abort();
    if (!(await this.codexSlots.get(slotId))) {
      if (await this.codexSlots.remove(slotId)) await this.sendAccountsSync();
      return;
    }
    try {
      await this.admitCodex(() =>
        logoutCodex({
          spawn: this.codexAccountsSpawn(),
          home: this.codexSlots.homeOf(slotId),
          env: this.env,
        }),
      );
    } catch (err) {
      this.log.warn("Codex could not sign the slot out; removing it anyway", {
        slotId,
        error: sanitizeString(errorMessage(err), [this.home]),
      });
    }
    await this.codexSlots.remove(slotId);
    this.log.info("Codex account slot removed", { slotId });
    await this.sendAccountsSync();
  }

  /** A prompt (or steer), checked after admission so a held prompt sees the device's current gates. */
  private async runPrompt(cmd: CommandFrame): Promise<void> {
    const s = this.requireSession(cmd.sessionId);
    const prompt = PromptPayload.parse(cmd.payload);
    // A turn may run in fullAccess only while the opt-in is on (an explicit fullAccess cap, or a session
    // still in fullAccess with no cap); checked before the adapter sees the prompt.
    this.refuseFullAccess(prompt.permissionMode ?? s.mode);
    if (prompt.permissionMode === "fullAccess") this.refuseFullAccess("fullAccess");
    // P-10: images go to the adapter in memory only, and only to a runtime that can take them.
    if (prompt.images?.length && !s.runtime.capabilities.supportsImages) {
      throw new Error(IMAGES_NOT_SUPPORTED_MESSAGE);
    }
    // 07.18 (PD-03): absent = keep the current account; null or an object = this turn's account, switched only when
    // the ref differs (the adapter applies it between turns). The daemon keeps the ref, never the token.
    if (prompt.account !== undefined) {
      const account = await runtimeAccountOf(prompt.account, this.codexSlots);
      const ref = account?.ref ?? null;
      if (ref !== s.accountRef) {
        if (account) refuseAccountKind(s.runtime, account);
        if (!s.runtime.useAccount)
          throw new Error(`${s.runtime.id} cannot change accounts in a live session`);
        await s.runtime.useAccount(cmd.sessionId, account);
        s.accountRef = ref;
      }
    }
    // ADR-0045: the prompt's files land in the working tree before the turn, and the runtime reads the note listing
    // them (written here, never by the person). Any file that does not land fails the prompt: nothing runs, and the
    // turn's browser grant is never applied.
    const { files, ...turn } = prompt;
    const paths = files?.length ? await this.landPromptFiles(cmd.sessionId, s, files) : null;
    // 07.13 (PD-09): this turn's browser grant (absent = not allowed) and whether it runs in Full access.
    const mode = prompt.permissionMode ? minMode(s.mode, prompt.permissionMode) : s.mode;
    // A prompt with files is always its own turn (ADR-0045), never a steer.
    const steer =
      paths === null &&
      prompt.delivery === "steer" &&
      s.runtime.capabilities.supportsSteer &&
      !!s.runtime.steer;
    // LO-04: a steer that joins the running turn keeps that turn's member data and unloads another member's sign-in.
    this.browser.onPrompt(cmd.sessionId, prompt.promptId, prompt.browser, {
      fullAccess: mode === "fullAccess" && this.gate.optIn,
      steer,
    });
    if (paths !== null) {
      turn.text = withPromptFilesNote(turn.text, paths);
      await s.runtime.prompt(cmd.sessionId, turn);
    } else if (steer && s.runtime.steer) {
      await s.runtime.steer(cmd.sessionId, prompt);
    } else {
      await s.runtime.prompt(cmd.sessionId, prompt);
    }
  }

  /**
   * ADR-0045: copies a prompt's files into the session's tree, in order, through ADR-0041's transfer (each fetched once
   * from `toRuntimeFileUrl` with the device JWT, size and sha256 checked, landed without overwriting by
   * `writeSessionFile`, which re-decides the deny list on the real path). A taken name moves to the next free one
   * (`promptFileCollisionPath`: `spec-1.pdf`, `spec-2.pdf` …). Only between turns (principle 4). On a failure the files
   * this prompt already landed are removed and the prompt fails with one sentence naming the file (repo-relative).
   * Returns the repo-relative paths they landed at.
   */
  private async landPromptFiles(sessionId: string, s: ActiveSession, files: PromptFile[]): Promise<string[]> {
    // Uploads never reach a commit the runtime makes: the repository's own `info/exclude`, never `.gitignore`.
    try {
      await excludePromptUploads(s.cwd, WORK_PROMPT_UPLOADS_DIR);
    } catch (err) {
      this.log.warn("could not exclude prompt uploads from git", {
        sessionId,
        error: sanitizeString(errorMessage(err), this.rootsBySession.get(sessionId) ?? []),
      });
    }
    const landed: string[] = [];
    for (const file of files) {
      try {
        if (this.turnsRunning.has(sessionId)) throw new SessionFileError("busy");
        landed.push(await this.landPromptFile(s.cwd, file));
      } catch (err) {
        const code = err instanceof SessionFileError ? err.code : "transfer_failed";
        this.log.warn("prompt file failed", { sessionId, transferId: file.transferId, code });
        for (const path of landed) await removeLandedSessionFile(s.cwd, path).catch(() => undefined);
        throw new Error(promptFileFailedMessage(file.path, code));
      }
    }
    return landed;
  }

  /** One prompt file at the first free name from its offered path (`PROMPT_FILE_MAX_NAMES` candidates at most). */
  private async landPromptFile(cwd: string, file: PromptFile): Promise<string> {
    for (let n = 0; n < PROMPT_FILE_MAX_NAMES; n++) {
      const path = n === 0 ? file.path : promptFileCollisionPath(file.path, n);
      const fetched = this.transferBody(file.transferId, file.sizeBytes);
      try {
        await writeSessionFile(cwd, path, {
          transferId: file.transferId,
          sizeBytes: file.sizeBytes,
          sha256: file.sha256,
          overwrite: false,
          body: fetched.body,
          landBy: fetched.landBy,
        });
        return path;
      } catch (err) {
        // A taken name is found before any byte is fetched (the transfer is still unused): try the next one.
        if (err instanceof SessionFileError && err.code === "exists" && !fetched.started()) continue;
        throw err;
      }
    }
    throw new SessionFileError("exists");
  }

  private requireSession(sessionId: string): ActiveSession {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error("session is not active on this device");
    return s;
  }

  /** ADR-0012 / P-12: fullAccess is refused while this device's own opt-in is off. */
  private refuseFullAccess(mode: PermissionMode | undefined): void {
    if (mode === "fullAccess" && !this.gate.optIn) throw new Error(FULL_ACCESS_OFF_MESSAGE);
  }

  /** A runtime bypass literal is refused by name, whatever the payload schema would say (D-03). */
  private refuseBypassLiteral(raw: unknown): void {
    if (typeof raw === "string" && RUNTIME_BYPASS_LITERALS.includes(raw)) {
      throw new Error(`permission mode '${raw}' is not allowed`);
    }
  }

  /** `session.configure` (D-07): only modes this device's adapter supports; the adapter applies between turns. */
  private async configureSession(cmd: CommandFrame): Promise<void> {
    const raw = cmd.payload as { settings?: { permissionMode?: unknown } } | undefined;
    this.refuseBypassLiteral(raw?.settings?.permissionMode);
    const payload = SessionConfigurePayload.parse(cmd.payload ?? {});
    const mode = payload.settings.permissionMode;
    this.refuseFullAccess(mode);
    const s = this.requireSession(cmd.sessionId);
    if (mode && !s.runtime.capabilities.supportsPermissionModes.includes(mode)) {
      throw new Error(`permission mode ${mode} is not available on this device`);
    }
    if (!s.runtime.configure) throw new Error(`settings changes are not supported by ${s.runtime.id}`);
    await s.runtime.configure(cmd.sessionId, payload.settings);
    if (mode) s.mode = mode;
  }

  private async startSession(cmd: CommandFrame): Promise<void> {
    if (this.sessions.has(cmd.sessionId)) return; // idempotent
    this.refuseBypassLiteral((cmd.payload as { permissionMode?: unknown } | undefined)?.permissionMode);
    const payload = SessionStartPayload.parse(cmd.payload ?? {});
    this.refuseFullAccess(payload.permissionMode);
    const project = this.registry.get(payload.projectLocalId);
    if (!project) throw new Error("project is not registered on this device");
    const runtime = this.runtimes.get(payload.runtime);
    if (!runtime) throw new Error(`runtime ${payload.runtime} is not available on this device`);
    // Only modes this device's adapter supports (replaces the old hard-coded rejection list, T-03.2-01-01).
    if (!runtime.capabilities.supportsPermissionModes.includes(payload.permissionMode)) {
      throw new Error(`permission mode '${payload.permissionMode}' is not allowed on this device`);
    }

    // 07.18 (PD-03, PD-04): the account is mapped and checked against the adapter before anything is created.
    const account = await runtimeAccountOf(payload.account, this.codexSlots);
    if (account) refuseAccountKind(runtime, account);

    let cwd = project.path;
    let worktreeBranch: string | null = null;
    if (payload.worktree) {
      const wt = await ensureSessionWorktree(project.path, cmd.sessionId);
      cwd = wt.path;
      worktreeBranch = wt.branch;
    }
    this.rootsBySession.set(cmd.sessionId, this.rootsFor(cwd, project));
    this.sessions.set(cmd.sessionId, {
      sessionId: cmd.sessionId,
      runtime,
      project,
      cwd,
      worktreeBranch,
      mode: payload.permissionMode,
      accountRef: account?.ref ?? null,
    });
    // 07.13 (D-10, PD-09): the start's grant decides whether the adapter offers the browser tools from the start.
    this.browser.onPrompt(cmd.sessionId, null, payload.browser);
    try {
      await runtime.start(
        {
          sessionId: cmd.sessionId,
          cwd,
          permissionMode: payload.permissionMode,
          ...(account ? { account } : {}),
          onAccountSignal: (signal) => this.sendAccountSignal(cmd.sessionId, signal),
          browser: this.browser.forSession(cmd.sessionId),
          ...(payload.model ? { model: payload.model } : {}),
          ...(payload.effort ? { effort: payload.effort } : {}),
          ...(payload.fastMode !== undefined ? { fastMode: payload.fastMode } : {}),
          ...(payload.contextWindow ? { contextWindow: payload.contextWindow } : {}),
          ...(payload.resumeRuntimeSessionId
            ? { resumeRuntimeSessionId: payload.resumeRuntimeSessionId }
            : {}),
        },
        (event) => {
          this.forwardEvent(cmd.sessionId, event);
          if (event.type === "session.state" && (event.status === "failed" || event.status === "completed")) {
            this.endSession(cmd.sessionId);
          }
        },
      );
    } catch (err) {
      this.endSession(cmd.sessionId);
      throw err;
    }
    if (account?.kind === "token") {
      void this.announcePoolCatalog(runtime).catch((err: unknown) =>
        this.log.warn("pool catalog not announced", {
          error: sanitizeString(errorMessage(err), [this.home]),
        }),
      );
    }
  }

  /**
   * 07.18 (D-07, D-09, PD-05): an adapter's limit or usage report, as a frame naming the account ref the session runs
   * on now. It goes through `send()`, so offline it waits in the same log as the events, in order (the limit before
   * the turn's `prompt.completed`). A usage report of the device's own login has no account to name: nothing is sent.
   */
  private sendAccountSignal(sessionId: string, signal: AccountSignal): void {
    const active = this.sessions.get(sessionId);
    if (!active) return; // the session already left this device
    const accountId = active.accountRef;
    if (signal.kind === "limited") {
      this.send({
        type: "session.account_limited",
        sessionId,
        promptId: signal.promptId,
        accountId,
        reason: signal.reason,
        resetsAt: signal.resetsAt,
        at: new Date().toISOString(),
      });
      return;
    }
    if (accountId) this.send({ type: "account.usage", accountId, usage: signal.usage });
  }

  /**
   * `session.title` (D-18, P-15, P-19): the session runtime's adapter names the first prompt with its small model,
   * outside the per-session chain (never delays a turn) and under the daemon's own timeout. A failure is only a
   * failed ack (`"<code>: <detail>"`): never a session event, never a failed session.
   */
  private async sendTitle(cmd: CommandFrame): Promise<void> {
    const payload = SessionTitlePayload.parse(cmd.payload ?? {});
    const active = this.sessions.get(cmd.sessionId);
    const roots = [
      ...(this.rootsBySession.get(cmd.sessionId) ?? []),
      this.home,
      ...this.registry.list().flatMap((p) => [p.path, realpathOr(p.path)]),
    ];
    const title = await runTitle({
      runtime: this.runtimes.get(payload.runtime),
      payload,
      roots,
      timeoutMs: this.opts.titleTimeoutMs ?? TITLE_TIMEOUT_MS,
      sessionId: cmd.sessionId,
      ...(active ? { sessionRuntime: active.runtime.id } : {}),
    });
    this.send({
      type: "title.result",
      requestId: cmd.id,
      sessionId: cmd.sessionId,
      title,
      model: payload.model,
    });
  }

  private async sendDiff(cmd: CommandFrame): Promise<void> {
    const payload = DiffRequestPayload.parse(cmd.payload ?? {});
    const active = this.sessions.get(cmd.sessionId);
    let cwd: string;
    let project: LocalProject | undefined;
    if (active) {
      cwd = active.cwd;
      project = active.project;
    } else {
      project = payload.projectLocalId ? this.registry.get(payload.projectLocalId) : undefined;
      if (!project) throw new Error("no active session or registered project for diff");
      cwd = project.path;
    }
    const roots = this.rootsFor(cwd, project);
    if (!(await isGitRepo(cwd))) {
      // A project without git: nothing to compare, said so instead of failing.
      this.send({
        type: "diff.result",
        requestId: cmd.id,
        files: [],
        patch: "",
        truncated: false,
        branch: null,
        headSha: null,
        git: false,
      });
      return;
    }
    const [files, { patch, truncated }, info] = await Promise.all([
      changedFiles(cwd),
      unifiedPatch(cwd),
      repoInfo(cwd),
    ]);
    const frame: DiffResultFrame = {
      type: "diff.result",
      requestId: cmd.id,
      files,
      patch,
      truncated,
      branch: info.branch,
      headSha: info.headSha,
    };
    // 07.17.1.1 (D-14, PD-19): bounded after sanitising, so the frame never exceeds the API's inbound limit.
    this.send(boundDiffFrame(sanitizeValue(frame, roots), DEVICE_LINK_MAX_DEVICE_FRAME_BYTES));
  }

  // -------------------------------------------------------------------------------------------
  // Session files (07.17.1.1, D-02 … D-04, D-08, D-13, PD-05, PD-10, PD-18)

  /**
   * `session.file.read`: one contained regular file of an active session, at most `maxBytes` (else `too_large: <size>`
   * before any request), `PUT` to the server's transfer route as exactly its bytes with `content-length`.
   */
  private async readSessionFile(cmd: CommandFrame): Promise<void> {
    const payload = SessionFileReadPayload.safeParse(cmd.payload);
    if (!payload.success) throw payloadRefusal(payload.error.issues);
    const active = this.sessions.get(cmd.sessionId);
    if (!active) throw new SessionFileError("not_running");
    const { handle, size } = await openSessionFileForRead(
      active.cwd,
      payload.data.path,
      payload.data.maxBytes,
    );
    const streams: Array<{ destroy(): void }> = [];
    try {
      const res = await this.transfer(cmd.id, size, () => {
        // A fresh stream per attempt, from byte 0 (positional reads), never past the size checked above.
        let body: Uint8Array | AsyncIterable<Uint8Array> = new Uint8Array(0);
        if (size > 0) {
          const stream = handle.createReadStream({ start: 0, end: size - 1, autoClose: false });
          streams.push(stream);
          body = stream;
        }
        return {
          method: "PUT",
          headers: { "content-type": "application/octet-stream", "content-length": String(size) },
          body,
        };
      });
      const answer = RuntimeFilePutAnswer.safeParse(await res.json().catch(() => null));
      if (!answer.success || answer.data.sizeBytes !== size) throw new SessionFileError("transfer_failed");
    } finally {
      for (const s of streams) s.destroy();
      await handle.close().catch(() => undefined);
    }
  }

  /**
   * `session.file.write`: one file into an active session whose turn is not running (`busy` otherwise, before any
   * request). Every path, target and free-space check runs first; only then the bytes are fetched (`GET`, the body
   * read lazily by `writeSessionFile`) and land after their size and sha256 matched the payload's.
   */
  private async writeSessionFileFromServer(cmd: CommandFrame): Promise<void> {
    const payload = SessionFileWritePayload.safeParse(cmd.payload);
    if (!payload.success) throw payloadRefusal(payload.error.issues);
    const active = this.sessions.get(cmd.sessionId);
    if (!active) throw new SessionFileError("not_running");
    if (this.turnsRunning.has(cmd.sessionId)) throw new SessionFileError("busy");
    const p = payload.data;
    const fetched = this.transferBody(cmd.id, p.sizeBytes);
    await writeSessionFile(active.cwd, p.path, {
      transferId: cmd.id,
      sizeBytes: p.sizeBytes,
      sha256: p.sha256,
      overwrite: p.overwrite,
      body: fetched.body,
      landBy: fetched.landBy,
    });
  }

  /**
   * The bytes of a `to_device` transfer, fetched lazily (`GET`, on the first read of `body`, so every path check runs
   * first). Review WR-01: `landBy` is the moment the server names (once the GET answered) after which nothing may land.
   * `started` tells whether the GET was made (the transfer is single use).
   */
  private transferBody(
    transferId: string,
    sizeBytes: number,
  ): { body: AsyncIterable<Uint8Array>; landBy: () => number | null; started: () => boolean } {
    let landBy: number | null = null;
    let started = false;
    const fetchBody = async function* (this: Daemon): AsyncGenerator<Uint8Array> {
      started = true;
      const res = await this.transfer(transferId, sizeBytes, () => ({
        method: "GET",
        headers: { accept: "application/octet-stream" },
      }));
      const within = res.headers.get(RUNTIME_FILE_LAND_WITHIN_HEADER);
      if (within !== null && /^\d{1,10}$/.test(within)) landBy = Date.now() + Number(within);
      if (!res.body) return;
      for await (const chunk of res.body) yield chunk;
    };
    return { body: fetchBody.call(this), landBy: () => landBy, started: () => started };
  }

  /**
   * One transfer request to `toRuntimeFileUrl(serverUrl, transferId)` under the device JWT, bounded by
   * `transferDeadlineMs(bytes)`, redirects refused (P3). A 401 is retried once with a fresh JWT; a 503 (the server's
   * stream counter was full, the transfer stays pending) after each `FILE_TRANSFER_RETRY_DELAYS_MS`; 410 → `expired`,
   * 413 → `too_large`, anything else → `transfer_failed`. Answers the 200 response (its body unread).
   */
  private async transfer(
    transferId: string,
    bytes: number,
    init: () => {
      method: "GET" | "PUT";
      headers: Record<string, string>;
      body?: Uint8Array | AsyncIterable<Uint8Array>;
    },
  ): Promise<Response> {
    let url: string;
    try {
      url = toRuntimeFileUrl(this.config.serverUrl, transferId);
    } catch {
      throw new SessionFileError("transfer_failed");
    }
    const signal = AbortSignal.timeout(transferDeadlineMs(bytes));
    const delays = this.opts.fileRetryDelaysMs ?? FILE_TRANSFER_RETRY_DELAYS_MS;
    let refreshed = false;
    let busy = 0;
    for (;;) {
      let token: string;
      try {
        token = await this.getAccessToken(refreshed);
      } catch {
        throw new SessionFileError("transfer_failed");
      }
      const req = init();
      let res: Response;
      try {
        res = await fetch(url, {
          method: req.method,
          headers: { ...req.headers, Authorization: `Bearer ${token}` },
          ...(req.body !== undefined ? { body: req.body, duplex: "half" } : {}),
          redirect: "error",
          signal,
        } as RequestInit);
      } catch {
        throw new SessionFileError("transfer_failed");
      }
      if (res.status === 200) return res;
      await res.body?.cancel().catch(() => undefined);
      if (res.status === 401 && !refreshed) {
        refreshed = true;
        continue;
      }
      const delay = delays[busy];
      if (res.status === 503 && delay !== undefined) {
        busy++;
        if (!(await sleepUnlessAborted(delay, signal))) throw new SessionFileError("transfer_failed");
        continue;
      }
      if (res.status === 410) throw new SessionFileError("expired");
      if (res.status === 413) throw new SessionFileError("too_large");
      throw new SessionFileError("transfer_failed");
    }
  }

  /**
   * 07.13 (PD-15, PD-17): the browser manager's PUT (a sign-in upload or re-seal) under the device JWT, to a path of
   * `WORK_BROWSER_SIGNIN_ROUTES` only (`toBrowserApiUrl`), redirects refused, a 401 retried once with a fresh JWT.
   * Answers the HTTP status; the body (a storage state) is never logged.
   */
  private async browserApiPut(path: string, body: unknown): Promise<number> {
    const url = toBrowserApiUrl(this.config.serverUrl, path);
    let refreshed = false;
    for (;;) {
      const token = await this.getAccessToken(refreshed);
      const res = await fetch(url, {
        method: "PUT",
        headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(BROWSER_PUT_TIMEOUT_MS),
      });
      await res.body?.cancel().catch(() => undefined);
      if (res.status === 401 && !refreshed) {
        refreshed = true;
        continue;
      }
      return res.status;
    }
  }

  // -------------------------------------------------------------------------------------------
  // Control socket (local desktop shell only; absolute paths may appear here, never on the wire)

  private async handleControl(req: ControlRequest): Promise<unknown> {
    switch (req.cmd) {
      case "status":
        return this.status();
      case "listProjects":
        return this.registry.list();
      case "addProject": {
        const project = await this.registry.add(req.path, req.name);
        await this.syncProjects();
        return project;
      }
      case "removeProject": {
        const removed = await this.registry.remove(req.localId);
        if (removed) await this.syncProjects();
        return { removed };
      }
      case "reloadConfig":
        return this.reloadConfig();
      // 07.18 (PD-11): `ocw-runtime account add|remove` changed the slots; local only, no value.
      case "reloadAccounts":
        return this.reloadAccounts();
      // 07.11 (D-09, PD-08): local only; the command still comes from the on-device table.
      case "runtimeCheck": {
        if (!this.maintenance) throw new Error(RUNTIME_UPDATES_UNAVAILABLE_MESSAGE);
        await this.maintenance.check({ fresh: true });
        return this.runtimeUpdatesStatus(this.maintenance);
      }
      case "runtimeUpdate": {
        if (!this.maintenance) throw new Error(RUNTIME_UPDATES_UNAVAILABLE_MESSAGE);
        const answer: UpdateRequestAnswer = await this.maintenance.requestUpdate(req.runtime, "local");
        return answer;
      }
      // 07.13 (PD-08): the Codex shim's tool call; the manager checks the session's token, then decides it.
      case "browserCall":
        return this.browser.shimCall(req);
      // 07.13.1 (D-07): the desktop app's restart hold; local only, never logged, no host data in or out.
      case "appUpdateHold":
        return this.appHold.hold({ drain: req.drain });
      case "appUpdateRelease":
        return this.appHold.release({ holdId: req.holdId });
    }
  }
}
