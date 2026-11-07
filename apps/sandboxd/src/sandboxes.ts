import { randomBytes } from "node:crypto";
import type { Duplex, Readable } from "node:stream";
import {
  Id,
  SANDBOX_LIMITS,
  SANDBOXD_LABELS,
  type SandboxdErrorCode,
  type SandboxdEvent,
  type SandboxdExec,
  type SandboxdExecResult,
  type SandboxdInfo,
  type SandboxdOrgPolicy,
  type SandboxdProcess,
  type SandboxdSandboxStatus,
  type SandboxdStop,
  type SandboxdTarget,
  type SandboxdUsage,
  type SandboxRuntime,
  type SandboxState,
  type SandboxStopReason,
} from "@ocw/contracts";
import { type Docker, DockerUnavailableError, demux } from "./docker";
import type { Egress } from "./egress-attach";
import {
  type ContainerLimits,
  type DockerRuntime,
  egressHostsCurrent,
  filesSpec,
  nameFor,
  networkSpec,
  OCW_RUN,
  ownerLabels,
  packagesVolumeSpec,
  SANDBOX_USER,
  shellSpec,
  volumeSpec,
  WORKSPACE,
} from "./spec";

/**
 * The label-scoped lifecycle of each bot's `sbx` (07.8-04, D-01, D-02, Pattern 1). Every operation inspects its target
 * first and refuses an object whose `ocw.sandbox`, `ocw.namespace`, `ocw.org` and `ocw.agent` labels do not match the
 * request; `kill`, `killOrg` and `purge` act by label. Containers are created only from `shellSpec`. Nothing here logs
 * or returns argv beyond the exec result itself.
 */

export const SANDBOXD_VERSION = "0.1.0";
/** Running processes per sandbox before `exec` answers `busy`. */
export const MAX_PROCESSES_PER_SANDBOX = 16;
/** A finished process nobody polled is forgotten after this long. */
const FINISHED_RETENTION_MS = 10 * 60_000;
/** Extra time over the exec timeout before sandboxd kills the process group itself (ocw-run normally has). */
const TIMEOUT_GRACE_MS = 5_000;
const EXEC_POLL_MS = 250;
const RUN_MAX_STDOUT = 1024 * 1024;
const RUN_TIMEOUT_MS = 60_000;
const STDIN_CHUNK = 64 * 1024;
/** A broker-caused stop is matched to its `die` event within this window. */
const EXPECTED_STOP_MS = 60_000;
/** `ocw-run --kill` exits 3 when it holds no record of the id: the command has not recorded its group yet. */
const KILL_NO_RECORD = 3;
/** How long a process kill keeps retrying a command that has not recorded its group yet, and how often. */
const PROCESS_KILL_BUDGET_MS = 5_000;
const KILL_RETRY_MS = 100;
/** The longest a kill waits for the container's last usage sample (best-effort; the kill never waits longer). */
const KILL_SAMPLE_BUDGET_MS = 250;
const WATCH_RETRY_MS = 2_000;
/** A Docker event line longer than this is dropped (they are a few hundred bytes). */
const MAX_EVENT_LINE = 64 * 1024;

/** A refusal with its sandboxd error code and HTTP status. The message is fixed text, never request content. */
export class SandboxdFailure extends Error {
  override readonly name = "SandboxdFailure";
  constructor(
    readonly code: SandboxdErrorCode,
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export type RuntimeSetting = "auto" | "runsc" | "runc";

/** Fixed refusal texts (the contract has no dedicated codes; both are `docker_unavailable`, 503). */
export const RUNSC_UNAVAILABLE = "the required runsc runtime is unavailable";
export const DOCKER_TOO_OLD = "docker_too_old: Docker Engine 26 or later is required";

/**
 * Why sandboxd must not start, or null. `OCW_SANDBOX_RUNTIME=runsc` on a daemon without runsc is refused at startup
 * (D-14: never a silent fallback to runc); `auto` and `runc` start and report the level they really run.
 */
export function startupRefusal(setting: RuntimeSetting, info: SandboxdInfo): string | null {
  if (setting === "runsc" && !info.runtimes.includes("runsc")) {
    return "OCW_SANDBOX_RUNTIME=runsc but the Docker daemon has no runsc runtime";
  }
  return null;
}

/**
 * D-14: sandboxd must never carry the label it kills by (spike iii: a label-scoped kill once killed its own runner). The
 * id of the container this process runs in, from `/proc/self/mountinfo` (Docker mounts `/etc/hostname` and friends
 * from `.../containers/<id>/`) or `/proc/self/cgroup`; null for a host process.
 */
export function ownContainerId(mountinfo: string, cgroup: string): string | null {
  const fromMounts = /\/containers\/([0-9a-f]{64})\//.exec(mountinfo);
  if (fromMounts?.[1]) return fromMounts[1];
  const fromCgroup = /(?:docker[-/])([0-9a-f]{64})(?:\.scope)?/.exec(cgroup);
  return fromCgroup?.[1] ?? null;
}

/** Why sandboxd must not start in a container with these labels, or null: the kill and purge label is never its own. */
export function ownLabelRefusal(labels: Record<string, string> | null | undefined): string | null {
  if (labels?.[SANDBOXD_LABELS.sandbox] !== undefined) {
    return `sandboxd's own container carries ${SANDBOXD_LABELS.sandbox}, the label it kills by`;
  }
  return null;
}

export interface Clock {
  now(): number;
}

/** One event as the broker emits it; the feed (events.ts) adds `seq` and `at`. Ids, kinds, states and sizes only. */
export type SandboxdEventInput = SandboxdEvent extends infer E
  ? E extends SandboxdEvent
    ? Omit<E, "seq" | "at">
    : never
  : never;

/**
 * What sandboxd enforces for one organization's `sbx`, from the policy the API pushed in this boot. There is no
 * default (07.8 policy fix): an organization without a pushed policy has no limits here, so nothing may start or run
 * for it (`policy_missing`) until the API pushes its current policy, kill state included.
 */
export interface EffectiveLimits {
  container: ContainerLimits;
  diskQuotaBytes: number;
  idleStopMs: number;
  killed: boolean;
}

export interface SandboxesOptions {
  docker: Docker;
  ns: string;
  runtime: RuntimeSetting;
  image: string;
  clock?: Clock;
  /** Every lifecycle change and usage sample (the event feed, 07.8-09 Task 3). */
  onEvent?: (event: SandboxdEventInput) => void;
  /**
   * The namespace's egress proxy (07.8-13): attached to each bot's shell network on `ensure`, detached before `purge`
   * removes the bot's networks. Without it a shell has no way out at all (every mode behaves as `off`).
   */
  egress?: Egress | null;
}

/** Where a file operation runs: the bot's running `sbx`, or its network-none `files` helper on the same volume. */
export interface WorkspaceHandle {
  containerId: string;
  kind: "sbx" | "files";
}

export interface RunOptions {
  /** Bytes for the helper's stdin (file content); the stream is half-closed after the last byte. */
  stdin?: Buffer;
  /** stdout beyond this is dropped and `overflow` is set (default 1 MiB). */
  maxStdout?: number;
  /** Backstop for a helper that never ends (default 60 s). */
  timeoutMs?: number;
}

export interface RunResult {
  /** The helper's exit code; -1 when it could not be read. */
  exitCode: number;
  stdout: Buffer;
  overflow: boolean;
}

export interface Sandboxes {
  info(): Promise<SandboxdInfo>;
  ensure(target: SandboxdTarget): Promise<SandboxdSandboxStatus>;
  exec(input: SandboxdExec): Promise<SandboxdExecResult>;
  process(input: SandboxdProcess): Promise<SandboxdExecResult>;
  stop(input: SandboxdStop): Promise<SandboxdSandboxStatus>;
  restart(target: SandboxdTarget): Promise<SandboxdSandboxStatus>;
  kill(target: SandboxdTarget): Promise<{ removed: number }>;
  killOrg(orgId: string): Promise<{ removed: number }>;
  purge(target: SandboxdTarget): Promise<{ removed: number }>;
  reconcile(): Promise<{ containers: number; networks: number; volumes: number }>;
  /**
   * The container a file operation runs in: the running `sbx`, else the bot's `files` helper (created or started on
   * the same volume, no network). A stopped or killed `sbx` stays stopped. 404 when the bot has no workspace.
   */
  workspace(target: SandboxdTarget, options?: { touch?: boolean }): Promise<WorkspaceHandle>;
  /** Runs one helper argv as 10001 in /workspace of that container; stderr is discarded, never logged. */
  run(handle: WorkspaceHandle, cmd: string[], options?: RunOptions): Promise<RunResult>;
  /** The bot's sandbox as sandboxd sees it now (inspect plus the broker's disk and stop state). */
  status(target: SandboxdTarget): Promise<SandboxdSandboxStatus>;
  /** The bot's packages volume (created with the bot's labels when absent; refused when its labels name another). */
  packagesVolume(target: SandboxdTarget): Promise<string>;

  // ------------------------------------------------------------ policy, quota, idle and usage (07.8-09 Task 2)

  /**
   * The organization's limits and kill state as pushed by the API (`policy`); egress fields are the proxy's (13). A
   * push older than the stored one (lower `version`) is ignored, so a late re-push never undoes a kill.
   */
  setPolicy(policy: SandboxdOrgPolicy): void;
  /** The organization's pushed limits, or null when this boot has none (no default). */
  limitsFor(orgId: string): EffectiveLimits | null;
  /** The organization's whole pushed policy (browser limits, egress), or null. */
  policyOf(orgId: string): SandboxdOrgPolicy | null;
  /**
   * The Docker runtime new containers get: runsc when the daemon has it (or it is required), else runc; 503 when the
   * daemon is too old or a required runsc is missing (D-14: never a silent fallback).
   */
  dockerRuntime(): Promise<DockerRuntime>;
  /** Marks a container the broker is about to stop or kill, so its death is not reported as a crash. */
  expectStop(containerId: string): void;
  /** Whether the broker stopped or killed this container within the last minute. */
  wasStoppedByBroker(containerId: string): boolean;
  /**
   * The pushed limits, else 409 `policy_missing`; with `runnable`, a killed organization is also refused (409
   * `killed`). Called before anything that would create, start or run a container, and before a write (the quota).
   */
  requirePolicy(orgId: string, opts?: { runnable?: boolean }): EffectiveLimits;
  /** Per bot: state, cumulative CPU since the container started, and the last measured disk. */
  usage(orgId: string): Promise<SandboxdUsage>;
  recordDisk(target: SandboxdTarget, bytes: number): void;
  isDiskFull(target: SandboxdTarget): boolean;
  /** Over quota: `ensure` refuses `disk_full`; a running `sbx` stops with that reason (one usage, one state event). */
  markDiskFull(target: SandboxdTarget): Promise<void>;
  /** Back under quota: `ensure` works again (one state event, reason null). */
  clearDiskFull(target: SandboxdTarget): Promise<void>;
  /** The namespace's running `sbx` containers. */
  listRunning(): Promise<Array<{ target: SandboxdTarget; containerId: string }>>;
  /** Milliseconds since the bot's last op (first sight counts as an op). */
  idleMs(target: SandboxdTarget, now: number): number;
  hasRunningProcess(target: SandboxdTarget): boolean;
  /** Stops the `sbx` with a reason: one usage sample, then one state event (idle, disk_full, kill_switch, …). */
  stopWith(target: SandboxdTarget, reason: SandboxStopReason): Promise<SandboxdSandboxStatus>;
  /** One usage event for a running `sbx`: the CPU since the previous sample and the last measured disk. */
  sampleUsage(target: SandboxdTarget): Promise<void>;
  /** Removes `files` helpers unused for `idleMs` (never their volume); returns how many. */
  reapFilesHelpers(now: number, idleMs: number): Promise<number>;
  /**
   * Follows Docker's `die` events for this namespace's `sbx` containers: one the broker did not stop, kill, restart
   * or remove is a crash, reported as state `stopped` with reason null. Reconnects after an error; returns `stop`.
   */
  watch(): () => void;
}

// ---------------------------------------------------------------- output tails

/** Keeps the last `max` bytes of one stream and whether anything was dropped. */
export class OutputTail {
  private buf: Buffer = Buffer.alloc(0);
  private total = 0;
  constructor(private readonly max: number = SANDBOX_LIMITS.outputTailBytes) {}

  push(chunk: Buffer): void {
    this.total += chunk.length;
    this.buf = Buffer.concat([this.buf, chunk]);
    if (this.buf.length > this.max * 2) this.buf = Buffer.from(this.buf.subarray(this.buf.length - this.max));
  }

  get truncated(): boolean {
    return this.total > this.max;
  }

  /** UTF-8 text of at most `max` bytes, cut on a character boundary. */
  text(): string {
    return tailText(this.buf, this.max);
  }
}

/** The last `max` UTF-8 bytes of `buf` as text; invalid bytes decode to U+FFFD and the result is re-bounded. */
export function tailText(buf: Buffer, max: number): string {
  let bytes = buf.length > max ? buf.subarray(buf.length - max) : buf;
  let text = bytes.toString("utf8");
  if (Buffer.byteLength(text) <= max) return stripLeadingPartial(text, bytes);
  // Replacement characters can grow binary input; re-encode and cut again on a character boundary.
  bytes = Buffer.from(text, "utf8");
  bytes = bytes.subarray(bytes.length - max);
  let start = 0;
  while (start < bytes.length && ((bytes[start] as number) & 0xc0) === 0x80) start++;
  text = bytes.subarray(start).toString("utf8");
  return text;
}

function stripLeadingPartial(text: string, bytes: Buffer): string {
  // A tail that starts inside a multi-byte character decodes to U+FFFD at the start; drop those bytes instead.
  let start = 0;
  while (start < bytes.length && start < 3 && ((bytes[start] as number) & 0xc0) === 0x80) start++;
  return start === 0 ? text : bytes.subarray(start).toString("utf8");
}

// ---------------------------------------------------------------- docker shapes (only the fields read here)

interface ContainerInspect {
  Id: string;
  Config?: { Labels?: Record<string, string> | null; Image?: string };
  State?: { Running?: boolean; Restarting?: boolean; Status?: string; StartedAt?: string };
  HostConfig?: { Runtime?: string; ExtraHosts?: string[] | null };
}

interface ProcessRecord {
  id: string;
  orgId: string;
  agentId: string;
  execId: string;
  startedAt: number;
  stdout: OutputTail;
  stderr: OutputTail;
  stream: Duplex;
  ended: boolean;
  endedAt: number | null;
  exitCode: number | null;
  timer: NodeJS.Timeout | null;
  /** Resolves when the output stream ends, so a wait wakes at once instead of on the next poll tick. */
  streamDone: Promise<void>;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Waits until the stream can take more, or is gone. */
function drained(stream: Duplex): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      stream.off("drain", done);
      stream.off("close", done);
      stream.off("error", done);
      resolve();
    };
    stream.on("drain", done);
    stream.on("close", done);
    stream.on("error", done);
  });
}

/** Calls `onLine` for each newline-terminated line of the stream; resolves when it ends or closes. */
function readLines(stream: Readable, onLine: (line: string) => void): Promise<void> {
  return new Promise((resolve) => {
    let buf = "";
    stream.on("data", (chunk: Buffer | string) => {
      buf += chunk.toString();
      for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.trim()) onLine(line);
      }
      if (buf.length > MAX_EVENT_LINE) buf = "";
    });
    const done = () => resolve();
    stream.on("end", done);
    stream.on("close", done);
    stream.on("error", done);
  });
}

/** Writes `data` in chunks with backpressure, then half-closes so the helper sees EOF on stdin. */
async function writeStdin(stream: Duplex, data: Buffer): Promise<void> {
  for (let offset = 0; offset < data.length; offset += STDIN_CHUNK) {
    if (stream.destroyed || stream.writableEnded) return;
    if (!stream.write(data.subarray(offset, offset + STDIN_CHUNK))) await drained(stream);
  }
  if (!stream.destroyed && !stream.writableEnded) stream.end();
}

function failure(code: SandboxdErrorCode, status: number, message: string): SandboxdFailure {
  return new SandboxdFailure(code, status, message);
}

const dockerDown = () => failure("docker_unavailable", 503, "the Docker daemon is unavailable");

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function isoOrNull(value: string | undefined): string | null {
  if (!value || value.startsWith("0001-")) return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

function stateOf(c: ContainerInspect | null): SandboxState {
  if (!c) return "absent";
  if (c.State?.Running) return "running";
  if (c.State?.Restarting) return "starting";
  switch (c.State?.Status) {
    case "removing":
      return "stopping";
    case "dead":
      return "unavailable";
    default:
      return "stopped";
  }
}

/** The state a stop leaves, by its reason. */
function stoppedState(reason: SandboxStopReason | undefined): SandboxState {
  if (reason === "disk_full") return "disk_full";
  if (reason === "kill_switch") return "killed";
  return "stopped";
}

/** The target named by an object's labels, or null when they are not two ids. */
function targetOfLabels(labels: Record<string, string> | null | undefined): SandboxdTarget | null {
  const orgId = labels?.[SANDBOXD_LABELS.org];
  const agentId = labels?.[SANDBOXD_LABELS.agent];
  if (!Id.safeParse(orgId).success || !Id.safeParse(agentId).success) return null;
  return { orgId: orgId as string, agentId: agentId as string };
}

function runtimeOf(c: ContainerInspect | null): SandboxRuntime | null {
  if (!c) return null;
  return c.HostConfig?.Runtime === "runsc" ? "gvisor" : "hardened-runc";
}

export function createSandboxes(options: SandboxesOptions): Sandboxes {
  const { docker, ns, image } = options;
  const clock: Clock = options.clock ?? { now: () => Date.now() };
  const emit = options.onEvent ?? (() => {});
  const processes = new Map<string, ProcessRecord>();
  /**
   * Per organization: the pushed policy, in memory only. A restart (new boot id) forgets every one; the API pushes
   * them again (its events consumer on the new boot id, its client on `policy_missing`).
   */
  const policies = new Map<string, SandboxdOrgPolicy>();
  /** Per bot (`org:agent`): last measured disk, disk_full flag, why it last stopped, last CPU sample. */
  const diskBytes = new Map<string, number>();
  const diskFull = new Set<string>();
  const stopReasons = new Map<string, SandboxStopReason>();
  const cpuLast = new Map<string, number>();
  /** Containers the broker itself is stopping, killing or restarting: their `die` is not a crash. */
  const expectedStops = new Map<string, number>();
  const lastActive = new Map<string, number>();
  const locks = new Map<string, Promise<unknown>>();
  /** `files` helper container id → last use, and file operations still running in it (the sweeper reaps idle ones). */
  const filesUsed = new Map<string, number>();
  const filesBusy = new Map<string, number>();

  const targetKey = (t: SandboxdTarget) => `${t.orgId}:${t.agentId}`;

  /** One operation at a time per bot for the lifecycle calls that create or remove objects. */
  async function locked<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = locks.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    locks.set(key, settled);
    try {
      return await run;
    } finally {
      if (locks.get(key) === settled) locks.delete(key);
    }
  }

  async function call(method: "GET" | "POST" | "DELETE", path: string, body?: unknown) {
    try {
      return await docker.request(method, path, body);
    } catch (err) {
      if (err instanceof DockerUnavailableError) throw dockerDown();
      throw err;
    }
  }

  // ------------------------------------------------------------ daemon probe and runtime choice

  async function probe() {
    let version: Awaited<ReturnType<Docker["request"]>>;
    let info: Awaited<ReturnType<Docker["request"]>>;
    try {
      version = await docker.request("GET", "/version", undefined, { unversioned: true });
      info = await docker.request("GET", "/info", undefined, { unversioned: true });
    } catch {
      throw dockerDown();
    }
    if (version.status !== 200 || info.status !== 200) throw dockerDown();
    const dockerVersion = String(asRecord(version.body).Version ?? "").slice(0, 64);
    const major = Number.parseInt(dockerVersion.split(".")[0] ?? "", 10);
    const runtimes = Object.keys(asRecord(asRecord(info.body).Runtimes)).slice(0, 16);
    const hasRunsc = runtimes.includes("runsc");
    let dockerRuntime: DockerRuntime | null;
    let runtime: SandboxRuntime;
    if (options.runtime === "runc") {
      // Explicitly requested: the weaker boundary, reported as such.
      dockerRuntime = "runc";
      runtime = "hardened-runc";
    } else if (hasRunsc) {
      dockerRuntime = "runsc";
      runtime = "gvisor";
    } else if (options.runtime === "runsc") {
      // Required and absent: fail closed. Never fall back to runc (D-14); nothing can be created.
      dockerRuntime = null;
      runtime = "gvisor";
    } else {
      // auto without runsc: hardened runc, and the real level is what info and status report.
      dockerRuntime = "runc";
      runtime = "hardened-runc";
    }
    return {
      dockerVersion,
      versionOk: Number.isFinite(major) && major >= 26,
      runtimes,
      runtime,
      dockerRuntime,
    };
  }

  async function chooseRuntime(): Promise<DockerRuntime> {
    const p = await probe();
    if (!p.versionOk) throw failure("docker_unavailable", 503, DOCKER_TOO_OLD);
    if (p.dockerRuntime === null) throw failure("docker_unavailable", 503, RUNSC_UNAVAILABLE);
    return p.dockerRuntime;
  }

  // ------------------------------------------------------------ inspect and the label check

  async function inspectContainer(name: string): Promise<ContainerInspect | null> {
    const res = await call("GET", `/containers/${encodeURIComponent(name)}/json`);
    if (res.status === 404) return null;
    if (res.status !== 200) throw dockerDown();
    return res.body as ContainerInspect;
  }

  function labelsMatch(
    labels: Record<string, string> | null | undefined,
    target: SandboxdTarget,
    kind: string,
  ) {
    const have = labels ?? {};
    const want = { ...ownerLabels({ ns, orgId: target.orgId, agentId: target.agentId }) };
    for (const [k, v] of Object.entries(want)) if (have[k] !== v) return false;
    return have[SANDBOXD_LABELS.kind] === kind;
  }

  const mismatch = () => failure("label_mismatch", 409, "the object exists but is not this bot's sandbox");

  /** The bot's `sbx`, or null when absent; refuses one whose labels name anything else. */
  async function ownedShell(target: SandboxdTarget): Promise<ContainerInspect | null> {
    const c = await inspectContainer(nameFor("sbx", ns, target.agentId));
    if (c && !labelsMatch(c.Config?.Labels, target, "sbx")) throw mismatch();
    return c;
  }

  async function ownedRunningShell(target: SandboxdTarget): Promise<ContainerInspect> {
    const c = await ownedShell(target);
    if (!c) throw failure("not_found", 404, "this bot has no sandbox");
    if (!c.State?.Running) throw failure("not_found", 404, "this bot's sandbox is not running");
    return c;
  }

  async function ensureNetwork(target: SandboxdTarget): Promise<string> {
    const spec = networkSpec({ ns, orgId: target.orgId, agentId: target.agentId });
    const res = await call("GET", `/networks/${encodeURIComponent(spec.Name)}`);
    if (res.status === 200) {
      const net = asRecord(res.body);
      if (!labelsMatch(net.Labels as Record<string, string>, target, "sbx") || net.Internal !== true) {
        throw mismatch();
      }
      return spec.Name;
    }
    if (res.status !== 404) throw dockerDown();
    const created = await call("POST", "/networks/create", spec);
    if (created.status !== 201) throw dockerDown();
    return spec.Name;
  }

  async function ensureVolume(target: SandboxdTarget): Promise<string> {
    return ensureNamedVolume(target, volumeSpec({ ns, orgId: target.orgId, agentId: target.agentId }));
  }

  async function ensurePackagesVolume(target: SandboxdTarget): Promise<string> {
    return ensureNamedVolume(
      target,
      packagesVolumeSpec({ ns, orgId: target.orgId, agentId: target.agentId }),
    );
  }

  async function ensureNamedVolume(
    target: SandboxdTarget,
    spec: { Name: string; Driver: string; Labels: Record<string, string> },
  ): Promise<string> {
    const res = await call("GET", `/volumes/${encodeURIComponent(spec.Name)}`);
    if (res.status === 200) {
      if (!labelsMatch(asRecord(res.body).Labels as Record<string, string>, target, "sbx")) throw mismatch();
      return spec.Name;
    }
    if (res.status !== 404) throw dockerDown();
    const created = await call("POST", "/volumes/create", spec);
    if (created.status !== 201) throw dockerDown();
    return spec.Name;
  }

  function limitsFor(orgId: string): EffectiveLimits | null {
    const p = policies.get(orgId);
    if (!p) return null;
    return {
      container: { nanoCpus: p.limits.nanoCpus, memoryBytes: p.limits.memoryBytes, pids: p.limits.pids },
      diskQuotaBytes: p.limits.diskQuotaBytes,
      idleStopMs: p.limits.idleStopMs,
      killed: p.killed,
    };
  }

  function requirePolicy(orgId: string, opts: { runnable?: boolean } = {}): EffectiveLimits {
    const lim = limitsFor(orgId);
    if (!lim) throw failure("policy_missing", 409, "sandboxd holds no policy for this organization");
    if (opts.runnable && lim.killed)
      throw failure("killed", 409, "this organization's sandboxes are stopped");
    return lim;
  }

  /** The broker's view of a stopped sandbox: disk_full and killed outlive the container's own "exited". */
  function stateFor(target: SandboxdTarget, c: ContainerInspect | null): SandboxState {
    const state = stateOf(c);
    if (state !== "stopped") return state;
    const key = targetKey(target);
    if (diskFull.has(key)) return "disk_full";
    return stoppedState(stopReasons.get(key));
  }

  function statusOf(target: SandboxdTarget, c: ContainerInspect | null): SandboxdSandboxStatus {
    const active = lastActive.get(targetKey(target));
    return {
      target,
      state: stateFor(target, c),
      runtime: runtimeOf(c),
      diskBytes: diskBytes.get(targetKey(target)) ?? 0,
      startedAt: c?.State?.Running ? isoOrNull(c.State.StartedAt) : null,
      lastActiveAt: active === undefined ? null : new Date(active).toISOString(),
    };
  }

  // ------------------------------------------------------------ label-scoped listing

  function labelFilter(labels: Record<string, string>) {
    const filters = { label: Object.entries(labels).map(([k, v]) => `${k}=${v}`) };
    return encodeURIComponent(JSON.stringify(filters));
  }

  async function listContainers(labels: Record<string, string>, all: boolean) {
    const res = await call("GET", `/containers/json?all=${all ? 1 : 0}&filters=${labelFilter(labels)}`);
    if (res.status !== 200 || !Array.isArray(res.body)) throw dockerDown();
    return res.body as Array<{ Id: string; State?: string; Labels?: Record<string, string> }>;
  }

  async function listNetworks(labels: Record<string, string>) {
    const res = await call("GET", `/networks?filters=${labelFilter(labels)}`);
    if (res.status !== 200 || !Array.isArray(res.body)) throw dockerDown();
    return res.body as Array<{ Id: string; Name: string }>;
  }

  async function listVolumes(labels: Record<string, string>) {
    const res = await call("GET", `/volumes?filters=${labelFilter(labels)}`);
    if (res.status !== 200) throw dockerDown();
    const vols = asRecord(res.body).Volumes;
    return (Array.isArray(vols) ? vols : []) as Array<{ Name: string }>;
  }

  // ------------------------------------------------------------ usage and stops

  /** Cumulative CPU of a running container in ms (cgroup `cpu.stat` via one-shot stats), or null. */
  async function cpuOf(containerId: string): Promise<number | null> {
    const res = await call(
      "GET",
      `/containers/${encodeURIComponent(containerId)}/stats?stream=false&one-shot=true`,
    );
    if (res.status !== 200) return null;
    const ns = (asRecord(asRecord(asRecord(res.body).cpu_stats).cpu_usage).total_usage ?? null) as unknown;
    return typeof ns === "number" && Number.isFinite(ns) && ns >= 0 ? Math.floor(ns / 1_000_000) : null;
  }

  /** One `usage` event: the CPU since this bot's previous sample (a restarted container starts again from 0). */
  async function sampleUsageOf(target: SandboxdTarget, containerId: string): Promise<void> {
    const key = targetKey(target);
    const cumulative = await cpuOf(containerId);
    let delta = 0;
    if (cumulative !== null) {
      const last = cpuLast.get(key) ?? 0;
      delta = cumulative >= last ? cumulative - last : cumulative;
      cpuLast.set(key, cumulative);
    }
    emit({ type: "usage", target, cpuMs: delta, diskBytes: diskBytes.get(key) ?? 0 });
  }

  function expectStop(containerId: string) {
    const now = clock.now();
    for (const [id, at] of expectedStops) if (now - at > EXPECTED_STOP_MS) expectedStops.delete(id);
    expectedStops.set(containerId, now);
  }

  /** One Docker event line: a `die` of this namespace's `sbx` the broker did not cause is a crash. */
  function onDockerEvent(line: string) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    const ev = asRecord(parsed);
    if ((ev.Action ?? ev.status) !== "die") return;
    const actor = asRecord(ev.Actor);
    const id = String(actor.ID ?? ev.id ?? "");
    const attrs = asRecord(actor.Attributes) as Record<string, string>;
    if (
      attrs[SANDBOXD_LABELS.sandbox] !== "1" ||
      attrs[SANDBOXD_LABELS.namespace] !== ns ||
      attrs[SANDBOXD_LABELS.kind] !== "sbx"
    ) {
      return;
    }
    const t = targetOfLabels(attrs);
    if (!t) return;
    const at = expectedStops.get(id);
    if (at !== undefined) {
      expectedStops.delete(id);
      if (clock.now() - at <= EXPECTED_STOP_MS) return;
    }
    const key = targetKey(t);
    cpuLast.delete(key);
    stopReasons.delete(key);
    emit({ type: "state", target: t, kind: "sbx", state: "stopped", reason: null });
  }

  /** Stops the bot's `sbx` (the caller holds the bot's lock): usage sample, stop, state event with the reason. */
  async function stopLocked(
    target: SandboxdTarget,
    reason: SandboxStopReason,
  ): Promise<SandboxdSandboxStatus> {
    const key = targetKey(target);
    const c = await ownedShell(target);
    if (!c) return statusOf(target, null);
    if (c.State?.Running) {
      await sampleUsageOf(target, c.Id).catch(() => undefined);
      expectStop(c.Id);
      const res = await call("POST", `/containers/${encodeURIComponent(c.Id)}/stop?t=5`);
      if (res.status !== 204 && res.status !== 304) throw dockerDown();
      cpuLast.delete(key);
      stopReasons.set(key, reason);
      emit({
        type: "state",
        target,
        kind: "sbx",
        state: diskFull.has(key) ? "disk_full" : stoppedState(reason),
        reason,
      });
    }
    return statusOf(target, await ownedShell(target));
  }

  /** Kills running containers listed by label (kill switch): usage for each `sbx`, then `killed` state events. */
  async function killListed(
    listed: Array<{ Id: string; Labels?: Record<string, string> }>,
  ): Promise<{ removed: number }> {
    // The kill switch is an emergency stop: every container is killed at once, and the last usage sample before a
    // kill is best-effort, bounded so a slow `stats` on a loaded daemon never holds the kill up (sandbox-proof step 3
    // measured 11.9 s on CI with sequential sampling).
    const results = await Promise.all(
      listed.map(async (c) => {
        const t = targetOfLabels(c.Labels);
        const kind = c.Labels?.[SANDBOXD_LABELS.kind];
        if (t && kind === "sbx") {
          await Promise.race([
            sampleUsageOf(t, c.Id).catch(() => undefined),
            new Promise<void>((resolve) => setTimeout(resolve, KILL_SAMPLE_BUDGET_MS)),
          ]);
        }
        expectStop(c.Id);
        const res = await call("POST", `/containers/${encodeURIComponent(c.Id)}/kill`);
        if (res.status !== 204) return 0;
        if (t && (kind === "sbx" || kind === "brw")) {
          if (kind === "sbx") {
            stopReasons.set(targetKey(t), "kill_switch");
            cpuLast.delete(targetKey(t));
          }
          emit({ type: "state", target: t, kind, state: "killed", reason: "kill_switch" });
        }
        return 1;
      }),
    );
    return { removed: results.reduce<number>((sum, n) => sum + n, 0) };
  }

  // ------------------------------------------------------------ exec

  function sweep() {
    const now = clock.now();
    for (const [id, rec] of processes) {
      if (rec.ended && rec.endedAt !== null && now - rec.endedAt > FINISHED_RETENTION_MS)
        processes.delete(id);
    }
  }

  async function execInspect(execId: string): Promise<{ running: boolean; exitCode: number | null }> {
    const res = await call("GET", `/exec/${encodeURIComponent(execId)}/json`);
    if (res.status !== 200) return { running: false, exitCode: null };
    const body = asRecord(res.body);
    return {
      running: body.Running === true,
      exitCode: typeof body.ExitCode === "number" ? body.ExitCode : null,
    };
  }

  /**
   * Runs one helper argv as the bot's user in /workspace and waits for it: `ocw-run --kill` and every `ocw-files`
   * operation. Content travels on stdin and stdout only (never argv); stderr is read and dropped.
   */
  async function runIn(containerId: string, cmd: string[], opts: RunOptions = {}): Promise<RunResult> {
    const withStdin = opts.stdin !== undefined;
    const created = await call("POST", `/containers/${encodeURIComponent(containerId)}/exec`, {
      User: SANDBOX_USER,
      Cmd: cmd,
      WorkingDir: WORKSPACE,
      AttachStdin: withStdin,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
    });
    const execId = String(asRecord(created.body).Id ?? "");
    if (created.status === 404) throw failure("not_found", 404, "this bot's sandbox is gone");
    if (created.status === 409) throw failure("not_found", 404, "this bot's sandbox is not running");
    if (created.status !== 201 || !execId) throw dockerDown();
    let stream: Duplex;
    try {
      stream = await docker.hijack(`/exec/${encodeURIComponent(execId)}/start`, {
        Detach: false,
        Tty: false,
      });
    } catch {
      throw dockerDown();
    }
    const max = opts.maxStdout ?? RUN_MAX_STDOUT;
    const chunks: Buffer[] = [];
    let size = 0;
    let overflow = false;
    const ended = demux(stream, (frame) => {
      if (frame.stream !== 1 || overflow) return;
      if (size + frame.data.length > max) {
        chunks.push(frame.data.subarray(0, max - size));
        size = max;
        overflow = true;
        stream.destroy();
        return;
      }
      chunks.push(frame.data);
      size += frame.data.length;
    });
    // A helper that never ends (a FIFO, a hung filesystem) is cut off; the process dies with its container.
    const timer = setTimeout(() => stream.destroy(), opts.timeoutMs ?? RUN_TIMEOUT_MS);
    timer.unref();
    try {
      if (withStdin) await writeStdin(stream, opts.stdin as Buffer);
      await ended;
    } finally {
      clearTimeout(timer);
    }
    let exitCode = -1;
    for (let i = 0; i < 40; i++) {
      const state = await execInspect(execId);
      if (!state.running) {
        exitCode = state.exitCode ?? -1;
        break;
      }
      await sleep(EXEC_POLL_MS);
    }
    return { exitCode, stdout: Buffer.concat(chunks, size), overflow };
  }

  async function finish(rec: ProcessRecord): Promise<void> {
    if (rec.exitCode !== null && rec.ended) return;
    for (let i = 0; i < 20; i++) {
      const state = await execInspect(rec.execId);
      if (!state.running) {
        rec.exitCode = state.exitCode ?? -1;
        break;
      }
      await sleep(EXEC_POLL_MS);
    }
    if (rec.exitCode === null) rec.exitCode = -1;
    rec.ended = true;
    rec.endedAt = clock.now();
    if (rec.timer) clearTimeout(rec.timer);
    rec.stream.destroy();
  }

  /** Waits up to `ms` for the process to end (stream end, or the exec reported finished). */
  async function waitFor(rec: ProcessRecord, ms: number): Promise<void> {
    const deadline = clock.now() + ms;
    let nextInspect = clock.now() + 500;
    while (!rec.ended) {
      const now = clock.now();
      if (now >= deadline) break;
      if (now >= nextInspect) {
        nextInspect = now + 500;
        const state = await execInspect(rec.execId);
        if (!state.running) {
          // The main process exited; give the stream a moment to flush, then stop waiting for it (a background
          // child may still hold the pipe open).
          await sleep(200);
          rec.ended = true;
          break;
        }
      }
      await Promise.race([sleep(Math.min(EXEC_POLL_MS, Math.max(0, deadline - now))), rec.streamDone]);
    }
    if (rec.ended) await finish(rec);
  }

  function resultOf(rec: ProcessRecord): SandboxdExecResult {
    const common = {
      stdout: rec.stdout.text(),
      stderr: rec.stderr.text(),
      truncated: rec.stdout.truncated || rec.stderr.truncated,
      durationMs: Math.max(0, Math.round((rec.endedAt ?? clock.now()) - rec.startedAt)),
    };
    if (rec.ended) {
      processes.delete(rec.id);
      return { status: "exited", exitCode: rec.exitCode ?? -1, ...common };
    }
    return { status: "running", processId: rec.id, ...common };
  }

  /**
   * The bot's `sbx` from `shellSpec`, with the proxy's current address in its /etc/hosts (`egressAddress`, from the
   * attach just made): under gVisor that entry is the only way the shell resolves `sandbox-egress`.
   */
  async function createShell(
    target: SandboxdTarget,
    limits: ContainerLimits,
    dockerRuntime: DockerRuntime,
    network: string,
    egressAddress: string | null,
  ): Promise<ContainerInspect> {
    const volume = await ensureVolume(target);
    const packagesVolume = await ensurePackagesVolume(target);
    const spec = shellSpec({
      ns,
      orgId: target.orgId,
      agentId: target.agentId,
      image,
      runtime: dockerRuntime,
      network,
      volume,
      packagesVolume,
      limits,
      egressAddress,
    });
    const name = nameFor("sbx", ns, target.agentId);
    const created = await call("POST", `/containers/create?name=${encodeURIComponent(name)}`, spec);
    if (created.status !== 201 && created.status !== 409) throw dockerDown();
    const c = await ownedShell(target);
    if (!c) throw dockerDown();
    return c;
  }

  /**
   * Removes the bot's own `sbx` (already label-checked by `ownedShell`) so it can be created again with a current
   * /etc/hosts entry. The container only: no `v=1`, so the workspace and packages volumes stay (its root is read-only,
   * so nothing else is lost).
   */
  async function removeShell(c: ContainerInspect): Promise<void> {
    if (c.State?.Running) expectStop(c.Id);
    const res = await call("DELETE", `/containers/${encodeURIComponent(c.Id)}?force=1`);
    if (res.status !== 204 && res.status !== 404) throw dockerDown();
  }

  /**
   * SIGKILLs the process group `ocw-run` recorded for this process. Docker answers the exec start before runc has
   * spawned the command, so on a loaded daemon the helper can run before the command recorded its group; it then exits
   * `KILL_NO_RECORD` and the kill is tried again until it lands, the command ends, or `PROCESS_KILL_BUDGET_MS` runs
   * out (CI p144: a single attempt left `sleep 300` running and the kill answered `running`).
   */
  async function killRecord(rec: ProcessRecord): Promise<void> {
    const deadline = clock.now() + PROCESS_KILL_BUDGET_MS;
    for (;;) {
      if (rec.ended) return;
      const c = await inspectContainer(nameFor("sbx", ns, rec.agentId));
      if (!c?.State?.Running) return;
      const res = await runIn(c.Id, [OCW_RUN, "--kill", rec.id], { timeoutMs: 10_000 });
      if (res.exitCode !== KILL_NO_RECORD || rec.ended || clock.now() >= deadline) return;
      await sleep(KILL_RETRY_MS);
    }
  }

  return {
    async info() {
      const p = await probe();
      return {
        version: SANDBOXD_VERSION,
        namespace: ns,
        dockerVersion: p.dockerVersion,
        dockerOk: p.versionOk && p.dockerRuntime !== null,
        runtimes: p.runtimes,
        runtime: p.runtime,
        browserSandbox: null,
      };
    },

    async ensure(target) {
      const lim = requirePolicy(target.orgId, { runnable: true });
      if (diskFull.has(targetKey(target))) {
        throw failure("disk_full", 409, "the workspace is over its quota");
      }
      const dockerRuntime = await chooseRuntime();
      return locked(targetKey(target), async () => {
        let c = await ownedShell(target);
        const network = await ensureNetwork(target);
        // The proxy on the shell network before the shell runs (idempotent; a restarted proxy is re-attached here),
        // and its address there now, for the shell's /etc/hosts.
        const egressAddress = options.egress ? await options.egress.attach(target, "sbx", network) : null;
        if (
          c &&
          !c.State?.Running &&
          options.egress &&
          !egressHostsCurrent(c.HostConfig?.ExtraHosts, egressAddress)
        ) {
          // Stopped with a stale entry (the proxy restarted, or the shell predates the entry): created again below.
          await removeShell(c);
          c = null;
        }
        if (!c) c = await createShell(target, lim.container, dockerRuntime, network, egressAddress);
        if (!c.State?.Running) {
          const started = await call("POST", `/containers/${encodeURIComponent(c.Id)}/start`);
          if (started.status !== 204 && started.status !== 304) throw dockerDown();
          c = await ownedShell(target);
          stopReasons.delete(targetKey(target));
          cpuLast.delete(targetKey(target));
          emit({ type: "state", target, kind: "sbx", state: "running", reason: null });
        }
        lastActive.set(targetKey(target), clock.now());
        return statusOf(target, c);
      });
    },

    async exec(input) {
      requirePolicy(input.target.orgId, { runnable: true });
      sweep();
      const c = await ownedRunningShell(input.target);
      let running = 0;
      for (const rec of processes.values()) {
        if (!rec.ended && rec.orgId === input.target.orgId && rec.agentId === input.target.agentId) running++;
      }
      if (running >= MAX_PROCESSES_PER_SANDBOX) throw failure("busy", 409, "too many running processes");

      const id = randomBytes(12).toString("base64url");
      const seconds = Math.ceil(input.timeoutMs / 1000);
      const created = await call("POST", `/containers/${encodeURIComponent(c.Id)}/exec`, {
        User: SANDBOX_USER,
        Cmd: [OCW_RUN, id, String(seconds), "--", ...input.argv],
        WorkingDir: input.cwd ? `${WORKSPACE}/${input.cwd}` : WORKSPACE,
        AttachStdin: false,
        AttachStdout: true,
        AttachStderr: true,
        Tty: false,
      });
      const execId = String(asRecord(created.body).Id ?? "");
      if (created.status !== 201 || !execId) throw dockerDown();
      let stream: Duplex;
      try {
        stream = await docker.hijack(`/exec/${encodeURIComponent(execId)}/start`, {
          Detach: false,
          Tty: false,
        });
      } catch {
        throw dockerDown();
      }
      const rec: ProcessRecord = {
        id,
        orgId: input.target.orgId,
        agentId: input.target.agentId,
        execId,
        startedAt: clock.now(),
        stdout: new OutputTail(),
        stderr: new OutputTail(),
        stream,
        ended: false,
        endedAt: null,
        exitCode: null,
        timer: null,
        streamDone: Promise.resolve(),
      };
      rec.streamDone = demux(stream, (frame) =>
        (frame.stream === 2 ? rec.stderr : rec.stdout).push(frame.data),
      ).then(() => {
        rec.ended = true;
      });
      processes.set(id, rec);
      lastActive.set(targetKey(input.target), clock.now());
      // ocw-run's timeout kills the group; this is the backstop if the helper itself was killed or hung.
      rec.timer = setTimeout(() => {
        void killRecord(rec).catch(() => undefined);
      }, input.timeoutMs + TIMEOUT_GRACE_MS);
      rec.timer.unref();

      await waitFor(rec, input.yieldMs);
      return resultOf(rec);
    },

    async process(input) {
      sweep();
      const rec = processes.get(input.processId);
      if (!rec || rec.orgId !== input.target.orgId || rec.agentId !== input.target.agentId) {
        throw failure("not_found", 404, "no such process");
      }
      await ownedShell(input.target);
      lastActive.set(targetKey(input.target), clock.now());
      if (input.action === "kill") {
        await killRecord(rec);
        await waitFor(rec, 5_000);
      } else {
        await waitFor(rec, 0);
      }
      return resultOf(rec);
    },

    async stop(input) {
      return locked(targetKey(input.target), () => stopLocked(input.target, input.reason));
    },

    async restart(target) {
      return locked(targetKey(target), async () => {
        const lim = requirePolicy(target.orgId, { runnable: true });
        const c = await ownedShell(target);
        if (!c) throw failure("not_found", 404, "this bot has no sandbox");
        if (diskFull.has(targetKey(target)))
          throw failure("disk_full", 409, "the workspace is over its quota");
        if (options.egress) {
          const network = await ensureNetwork(target);
          const egressAddress = await options.egress.attach(target, "sbx", network);
          if (!egressHostsCurrent(c.HostConfig?.ExtraHosts, egressAddress)) {
            // A Docker restart keeps a stale /etc/hosts entry: the shell is created again with the current address.
            const dockerRuntime = await chooseRuntime();
            await removeShell(c);
            const fresh = await createShell(target, lim.container, dockerRuntime, network, egressAddress);
            const started = await call("POST", `/containers/${encodeURIComponent(fresh.Id)}/start`);
            if (started.status !== 204 && started.status !== 304) throw dockerDown();
            lastActive.set(targetKey(target), clock.now());
            stopReasons.delete(targetKey(target));
            cpuLast.delete(targetKey(target));
            emit({ type: "state", target, kind: "sbx", state: "running", reason: null });
            return statusOf(target, await ownedShell(target));
          }
        }
        expectStop(c.Id);
        const res = await call("POST", `/containers/${encodeURIComponent(c.Id)}/restart?t=5`);
        if (res.status !== 204) throw dockerDown();
        lastActive.set(targetKey(target), clock.now());
        stopReasons.delete(targetKey(target));
        cpuLast.delete(targetKey(target));
        emit({ type: "state", target, kind: "sbx", state: "running", reason: null });
        return statusOf(target, await ownedShell(target));
      });
    },

    async kill(target) {
      await ownedShell(target);
      const running = await listContainers(
        ownerLabels({ ns, orgId: target.orgId, agentId: target.agentId }),
        false,
      );
      return killListed(running);
    },

    async killOrg(orgId) {
      const running = await listContainers(
        { [SANDBOXD_LABELS.sandbox]: "1", [SANDBOXD_LABELS.namespace]: ns, [SANDBOXD_LABELS.org]: orgId },
        false,
      );
      return killListed(running);
    },

    async purge(target) {
      return locked(targetKey(target), async () => {
        await ownedShell(target);
        const labels = ownerLabels({ ns, orgId: target.orgId, agentId: target.agentId });
        let removed = 0;
        let hadShell = false;
        for (const c of await listContainers(labels, true)) {
          expectStop(c.Id);
          const res = await call("DELETE", `/containers/${encodeURIComponent(c.Id)}?force=1`);
          if (res.status === 204) removed++;
          if (c.Labels?.[SANDBOXD_LABELS.kind] === "sbx") hadShell = true;
          filesUsed.delete(c.Id);
        }
        for (const v of await listVolumes(labels)) {
          const res = await call("DELETE", `/volumes/${encodeURIComponent(v.Name)}`);
          if (res.status === 204) removed++;
        }
        // A network with the proxy still on it cannot be removed.
        if (options.egress) await options.egress.detachTarget(target);
        for (const n of await listNetworks(labels)) {
          const res = await call("DELETE", `/networks/${encodeURIComponent(n.Id)}`);
          if (res.status === 204) removed++;
        }
        for (const [id, rec] of processes) {
          if (rec.orgId === target.orgId && rec.agentId === target.agentId) {
            if (rec.timer) clearTimeout(rec.timer);
            rec.stream.destroy();
            processes.delete(id);
          }
        }
        const key = targetKey(target);
        lastActive.delete(key);
        diskBytes.delete(key);
        diskFull.delete(key);
        stopReasons.delete(key);
        cpuLast.delete(key);
        if (hadShell) emit({ type: "state", target, kind: "sbx", state: "absent", reason: null });
        return { removed };
      });
    },

    async workspace(target, opts = {}) {
      const c = await ownedShell(target);
      if (c?.State?.Running) {
        // A person's or the bot's file op is activity; the broker's own measurement is not.
        if (opts.touch !== false) lastActive.set(targetKey(target), clock.now());
        return { containerId: c.Id, kind: "sbx" };
      }
      return locked(`files:${targetKey(target)}`, async () => {
        const volume = nameFor("ws", ns, target.agentId);
        const vol = await call("GET", `/volumes/${encodeURIComponent(volume)}`);
        if (vol.status === 404) throw failure("not_found", 404, "this bot has no workspace");
        if (vol.status !== 200) throw dockerDown();
        if (!labelsMatch(asRecord(vol.body).Labels as Record<string, string>, target, "sbx"))
          throw mismatch();

        const name = nameFor("files", ns, target.agentId);
        let h = await inspectContainer(name);
        if (h && !labelsMatch(h.Config?.Labels, target, "files")) throw mismatch();
        if (!h) {
          const p = await probe();
          if (!p.versionOk) throw failure("docker_unavailable", 503, DOCKER_TOO_OLD);
          if (p.dockerRuntime === null) throw failure("docker_unavailable", 503, RUNSC_UNAVAILABLE);
          const spec = filesSpec({
            ns,
            orgId: target.orgId,
            agentId: target.agentId,
            image,
            runtime: p.dockerRuntime,
            volume,
          });
          const created = await call("POST", `/containers/create?name=${encodeURIComponent(name)}`, spec);
          if (created.status !== 201 && created.status !== 409) throw dockerDown();
          h = await inspectContainer(name);
          if (!h) throw dockerDown();
          if (!labelsMatch(h.Config?.Labels, target, "files")) throw mismatch();
        }
        if (!h.State?.Running) {
          const started = await call("POST", `/containers/${encodeURIComponent(h.Id)}/start`);
          if (started.status !== 204 && started.status !== 304) throw dockerDown();
        }
        filesUsed.set(h.Id, clock.now());
        return { containerId: h.Id, kind: "files" };
      });
    },

    async run(handle, cmd, opts) {
      if (handle.kind === "files") {
        filesUsed.set(handle.containerId, clock.now());
        filesBusy.set(handle.containerId, (filesBusy.get(handle.containerId) ?? 0) + 1);
      }
      try {
        return await runIn(handle.containerId, cmd, opts);
      } finally {
        if (handle.kind === "files") {
          filesUsed.set(handle.containerId, clock.now());
          const n = (filesBusy.get(handle.containerId) ?? 1) - 1;
          if (n <= 0) filesBusy.delete(handle.containerId);
          else filesBusy.set(handle.containerId, n);
        }
      }
    },

    async status(target) {
      return statusOf(target, await ownedShell(target));
    },

    packagesVolume: (target) => ensurePackagesVolume(target),

    setPolicy(policy) {
      const held = policies.get(policy.orgId);
      if (held && held.version > policy.version) return;
      policies.set(policy.orgId, policy);
    },

    limitsFor,
    policyOf: (orgId) => policies.get(orgId) ?? null,
    dockerRuntime: chooseRuntime,
    expectStop,
    wasStoppedByBroker(containerId) {
      const at = expectedStops.get(containerId);
      return at !== undefined && clock.now() - at <= EXPECTED_STOP_MS;
    },
    requirePolicy,

    async usage(orgId) {
      const listed = await listContainers(
        { [SANDBOXD_LABELS.sandbox]: "1", [SANDBOXD_LABELS.namespace]: ns, [SANDBOXD_LABELS.org]: orgId },
        true,
      );
      const items: SandboxdUsage["items"] = [];
      const running = { sandboxes: 0, browsers: 0 };
      for (const c of listed) {
        const kind = c.Labels?.[SANDBOXD_LABELS.kind];
        const t = targetOfLabels(c.Labels);
        if (!t || t.orgId !== orgId || (kind !== "sbx" && kind !== "brw")) continue;
        const isRunning = c.State === "running";
        if (isRunning) running[kind === "sbx" ? "sandboxes" : "browsers"] += 1;
        const key = targetKey(t);
        let state: SandboxState = isRunning ? "running" : "stopped";
        if (!isRunning && kind === "sbx") {
          state = diskFull.has(key) ? "disk_full" : stoppedState(stopReasons.get(key));
        }
        items.push({
          agentId: t.agentId,
          kind,
          state,
          diskBytes: kind === "sbx" ? (diskBytes.get(key) ?? 0) : 0,
          cpuMs: isRunning ? ((await cpuOf(c.Id)) ?? 0) : 0,
        });
        if (items.length >= 1000) break;
      }
      return { orgId, running, items };
    },

    recordDisk(target, bytes) {
      diskBytes.set(targetKey(target), bytes);
    },

    isDiskFull(target) {
      return diskFull.has(targetKey(target));
    },

    async markDiskFull(target) {
      const key = targetKey(target);
      diskFull.add(key);
      await locked(key, async () => {
        const c = await ownedShell(target);
        if (c?.State?.Running) await stopLocked(target, "disk_full");
        else emit({ type: "state", target, kind: "sbx", state: "disk_full", reason: "disk_full" });
      });
    },

    async clearDiskFull(target) {
      const key = targetKey(target);
      if (!diskFull.delete(key)) return;
      if (stopReasons.get(key) === "disk_full") stopReasons.delete(key);
      const c = await ownedShell(target);
      emit({ type: "state", target, kind: "sbx", state: stateFor(target, c), reason: null });
    },

    async listRunning() {
      const listed = await listContainers(
        { [SANDBOXD_LABELS.sandbox]: "1", [SANDBOXD_LABELS.namespace]: ns, [SANDBOXD_LABELS.kind]: "sbx" },
        false,
      );
      const out: Array<{ target: SandboxdTarget; containerId: string }> = [];
      for (const c of listed) {
        const t = targetOfLabels(c.Labels);
        if (t) out.push({ target: t, containerId: c.Id });
      }
      return out;
    },

    idleMs(target, now) {
      const key = targetKey(target);
      const last = lastActive.get(key);
      if (last === undefined) {
        // First sight (a sandbox this process did not start): its idle time counts from now.
        lastActive.set(key, now);
        return 0;
      }
      return Math.max(0, now - last);
    },

    hasRunningProcess(target) {
      for (const rec of processes.values()) {
        if (!rec.ended && rec.orgId === target.orgId && rec.agentId === target.agentId) return true;
      }
      return false;
    },

    async stopWith(target, reason) {
      return locked(targetKey(target), () => stopLocked(target, reason));
    },

    async sampleUsage(target) {
      const c = await ownedShell(target);
      if (c?.State?.Running) await sampleUsageOf(target, c.Id);
    },

    async reapFilesHelpers(now, idleMs) {
      const listed = await listContainers(
        { [SANDBOXD_LABELS.sandbox]: "1", [SANDBOXD_LABELS.namespace]: ns, [SANDBOXD_LABELS.kind]: "files" },
        true,
      );
      let reaped = 0;
      for (const c of listed) {
        if ((filesBusy.get(c.Id) ?? 0) > 0) continue;
        const last = filesUsed.get(c.Id);
        if (last === undefined) {
          filesUsed.set(c.Id, now);
          continue;
        }
        if (now - last < idleMs) continue;
        // force=1 without v=1: the helper goes, the bot's named volume stays.
        const res = await call("DELETE", `/containers/${encodeURIComponent(c.Id)}?force=1`);
        if (res.status === 204 || res.status === 404) {
          filesUsed.delete(c.Id);
          reaped++;
        }
      }
      return reaped;
    },

    watch() {
      let stopped = false;
      let current: Readable | null = null;
      const filters = encodeURIComponent(
        JSON.stringify({
          type: ["container"],
          event: ["die"],
          label: [
            `${SANDBOXD_LABELS.sandbox}=1`,
            `${SANDBOXD_LABELS.namespace}=${ns}`,
            `${SANDBOXD_LABELS.kind}=sbx`,
          ],
        }),
      );
      const loop = async () => {
        while (!stopped) {
          try {
            current = await docker.stream(`/events?filters=${filters}`);
            if (stopped) current.destroy();
            else await readLines(current, onDockerEvent);
          } catch {
            // Docker unavailable: try again shortly (a die in the gap is not reported).
          }
          current = null;
          if (!stopped) {
            await new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, WATCH_RETRY_MS);
              timer.unref();
            });
          }
        }
      };
      void loop();
      return () => {
        stopped = true;
        current?.destroy();
      };
    },

    async reconcile() {
      const labels = { [SANDBOXD_LABELS.sandbox]: "1", [SANDBOXD_LABELS.namespace]: ns };
      const [containers, networks, volumes] = await Promise.all([
        listContainers(labels, true),
        listNetworks(labels),
        listVolumes(labels),
      ]);
      return { containers: containers.length, networks: networks.length, volumes: volumes.length };
    },
  };
}
