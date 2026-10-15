import { randomBytes } from "node:crypto";
import type { Duplex } from "node:stream";
import {
  SANDBOX_LIMITS,
  SANDBOXD_LABELS,
  type SandboxdErrorCode,
  type SandboxdExec,
  type SandboxdExecResult,
  type SandboxdInfo,
  type SandboxdProcess,
  type SandboxdSandboxStatus,
  type SandboxdStop,
  type SandboxdTarget,
  type SandboxRuntime,
  type SandboxState,
} from "@ocw/contracts";
import { type Docker, DockerUnavailableError, demux } from "./docker";
import {
  type ContainerLimits,
  DEFAULT_SBX_LIMITS,
  type DockerRuntime,
  nameFor,
  networkSpec,
  OCW_RUN,
  ownerLabels,
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

export interface Clock {
  now(): number;
}

export interface SandboxesOptions {
  docker: Docker;
  ns: string;
  runtime: RuntimeSetting;
  image: string;
  clock?: Clock;
  limits?: ContainerLimits;
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
  HostConfig?: { Runtime?: string };
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

function runtimeOf(c: ContainerInspect | null): SandboxRuntime | null {
  if (!c) return null;
  return c.HostConfig?.Runtime === "runsc" ? "gvisor" : "hardened-runc";
}

export function createSandboxes(options: SandboxesOptions): Sandboxes {
  const { docker, ns, image } = options;
  const clock: Clock = options.clock ?? { now: () => Date.now() };
  const limits = options.limits ?? DEFAULT_SBX_LIMITS;
  const processes = new Map<string, ProcessRecord>();
  const lastActive = new Map<string, number>();
  const locks = new Map<string, Promise<unknown>>();

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
    const spec = volumeSpec({ ns, orgId: target.orgId, agentId: target.agentId });
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

  function statusOf(target: SandboxdTarget, c: ContainerInspect | null): SandboxdSandboxStatus {
    const active = lastActive.get(targetKey(target));
    return {
      target,
      state: stateOf(c),
      runtime: runtimeOf(c),
      diskBytes: 0,
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

  /** Runs a short helper command as the bot's user and waits for it (used for `ocw-run --kill`). */
  async function runHelper(containerId: string, cmd: string[]): Promise<number | null> {
    const created = await call("POST", `/containers/${encodeURIComponent(containerId)}/exec`, {
      User: SANDBOX_USER,
      Cmd: cmd,
      WorkingDir: WORKSPACE,
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
    await demux(stream, () => {});
    for (let i = 0; i < 20; i++) {
      const state = await execInspect(execId);
      if (!state.running) return state.exitCode;
      await sleep(EXEC_POLL_MS);
    }
    return null;
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

  async function killRecord(rec: ProcessRecord): Promise<void> {
    if (rec.ended) return;
    const c = await inspectContainer(nameFor("sbx", ns, rec.agentId));
    if (c?.State?.Running) await runHelper(c.Id, [OCW_RUN, "--kill", rec.id]);
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
      const p = await probe();
      if (!p.versionOk) throw failure("docker_unavailable", 503, DOCKER_TOO_OLD);
      const dockerRuntime = p.dockerRuntime;
      if (dockerRuntime === null) throw failure("docker_unavailable", 503, RUNSC_UNAVAILABLE);
      return locked(targetKey(target), async () => {
        let c = await ownedShell(target);
        if (!c) {
          const network = await ensureNetwork(target);
          const volume = await ensureVolume(target);
          const spec = shellSpec({
            ns,
            orgId: target.orgId,
            agentId: target.agentId,
            image,
            runtime: dockerRuntime,
            network,
            volume,
            limits,
          });
          const name = nameFor("sbx", ns, target.agentId);
          const created = await call("POST", `/containers/create?name=${encodeURIComponent(name)}`, spec);
          if (created.status !== 201 && created.status !== 409) throw dockerDown();
          c = await ownedShell(target);
          if (!c) throw dockerDown();
        }
        if (!c.State?.Running) {
          const started = await call("POST", `/containers/${encodeURIComponent(c.Id)}/start`);
          if (started.status !== 204 && started.status !== 304) throw dockerDown();
          c = await ownedShell(target);
        }
        lastActive.set(targetKey(target), clock.now());
        return statusOf(target, c);
      });
    },

    async exec(input) {
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
      return locked(targetKey(input.target), async () => {
        const c = await ownedShell(input.target);
        if (!c) return statusOf(input.target, null);
        const res = await call("POST", `/containers/${encodeURIComponent(c.Id)}/stop?t=5`);
        if (res.status !== 204 && res.status !== 304) throw dockerDown();
        return statusOf(input.target, await ownedShell(input.target));
      });
    },

    async restart(target) {
      return locked(targetKey(target), async () => {
        const c = await ownedShell(target);
        if (!c) throw failure("not_found", 404, "this bot has no sandbox");
        const res = await call("POST", `/containers/${encodeURIComponent(c.Id)}/restart?t=5`);
        if (res.status !== 204) throw dockerDown();
        lastActive.set(targetKey(target), clock.now());
        return statusOf(target, await ownedShell(target));
      });
    },

    async kill(target) {
      await ownedShell(target);
      const running = await listContainers(
        ownerLabels({ ns, orgId: target.orgId, agentId: target.agentId }),
        false,
      );
      let removed = 0;
      for (const c of running) {
        const res = await call("POST", `/containers/${encodeURIComponent(c.Id)}/kill`);
        if (res.status === 204) removed++;
      }
      return { removed };
    },

    async killOrg(orgId) {
      const running = await listContainers(
        { [SANDBOXD_LABELS.sandbox]: "1", [SANDBOXD_LABELS.namespace]: ns, [SANDBOXD_LABELS.org]: orgId },
        false,
      );
      let removed = 0;
      for (const c of running) {
        const res = await call("POST", `/containers/${encodeURIComponent(c.Id)}/kill`);
        if (res.status === 204) removed++;
      }
      return { removed };
    },

    async purge(target) {
      return locked(targetKey(target), async () => {
        await ownedShell(target);
        const labels = ownerLabels({ ns, orgId: target.orgId, agentId: target.agentId });
        let removed = 0;
        for (const c of await listContainers(labels, true)) {
          const res = await call("DELETE", `/containers/${encodeURIComponent(c.Id)}?force=1`);
          if (res.status === 204) removed++;
        }
        for (const v of await listVolumes(labels)) {
          const res = await call("DELETE", `/volumes/${encodeURIComponent(v.Name)}`);
          if (res.status === 204) removed++;
        }
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
        lastActive.delete(targetKey(target));
        return { removed };
      });
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
