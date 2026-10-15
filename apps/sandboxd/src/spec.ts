import { createHash } from "node:crypto";
import { SANDBOXD_LABELS, type SandboxdKind } from "@ocw/contracts";

/**
 * Every Docker object sandboxd creates is built here, from constants plus validated numeric limits (07.8-04, D-01,
 * D-11, Pattern 1). No caller-supplied field reaches `HostConfig`, `Mounts`, `Image`, `User`, `Env` or `Labels`: the
 * builders read only the named parameters below, so an extra key a caller smuggles in is never copied. There is no
 * host bind mount, no published port, no privileged flag and no added capability anywhere in this file.
 */

/** The bot's uid and gid inside `sbx` (the image creates user `ocw` with them and chowns /workspace). */
export const SANDBOX_UID = 10001;
export const SANDBOX_USER = `${SANDBOX_UID}:${SANDBOX_UID}`;
export const WORKSPACE = "/workspace";
/** The helper every exec goes through (infra/sandbox/sbx/ocw-run). */
export const OCW_RUN = "/usr/local/bin/ocw-run";

export interface ContainerLimits {
  nanoCpus: number;
  memoryBytes: number;
  pids: number;
}

/** The research defaults for `sbx` (1 CPU, 1 GiB, 256 pids) until the API pushes the org limits. */
export const DEFAULT_SBX_LIMITS: ContainerLimits = {
  nanoCpus: 1_000_000_000,
  memoryBytes: 1024 * 1024 * 1024,
  pids: 256,
};

/** No container is ever wider than this, whatever limits arrive (4 CPUs, 8 GiB, 4096 pids). */
export const HARD_MAX: ContainerLimits = {
  nanoCpus: 4_000_000_000,
  memoryBytes: 8 * 1024 * 1024 * 1024,
  pids: 4096,
};

/** The floor a clamped limit never goes under: Docker reads 0 and -1 as "unlimited". */
const HARD_MIN: ContainerLimits = {
  nanoCpus: 100_000_000,
  memoryBytes: 64 * 1024 * 1024,
  pids: 16,
};

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

/** Limits clamped into [HARD_MIN, HARD_MAX]; only the three numbers are read. */
export function clampLimits(limits: ContainerLimits): ContainerLimits {
  return {
    nanoCpus: clamp(limits.nanoCpus, HARD_MIN.nanoCpus, HARD_MAX.nanoCpus),
    memoryBytes: clamp(limits.memoryBytes, HARD_MIN.memoryBytes, HARD_MAX.memoryBytes),
    pids: clamp(limits.pids, HARD_MIN.pids, HARD_MAX.pids),
  };
}

/** Docker's runtime names for the two boundaries (D-01): gVisor where the daemon has it, else hardened runc. */
export type DockerRuntime = "runsc" | "runc";

/** Object name kinds: containers (`sbx`, `brw`), volumes (`ws`, `pkg`) and the bot's network (`net`). */
export type NameKind = "sbx" | "brw" | "ws" | "pkg" | "net";

/** A namespace is part of every object name: lower-case letters, digits and dashes. */
export const NAMESPACE_RE = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;

/**
 * The bot's short key in object names: 12 hex characters of sha256(agentId). Not a prefix of the id: agent ids are
 * UUIDv7, whose first characters are a timestamp, so two bots created in the same minute would share a prefix.
 */
export function agentKey(agentId: string): string {
  return createHash("sha256").update(agentId).digest("hex").slice(0, 12);
}

/** `ocw-<kind>-<ns>-<agentKey>`, e.g. `ocw-sbx-ocw-1a2b3c4d5e6f`. */
export function nameFor(kind: NameKind, ns: string, agentId: string): string {
  return `ocw-${kind}-${ns}-${agentKey(agentId)}`;
}

export interface LabelInput {
  ns: string;
  orgId: string;
  agentId: string;
  kind: SandboxdKind;
}

/** The five labels of every sandboxd object; the four of `ownerLabels` are checked before any operation. */
export function labelsFor(p: LabelInput): Record<string, string> {
  return {
    [SANDBOXD_LABELS.sandbox]: "1",
    [SANDBOXD_LABELS.namespace]: p.ns,
    [SANDBOXD_LABELS.org]: p.orgId,
    [SANDBOXD_LABELS.agent]: p.agentId,
    [SANDBOXD_LABELS.kind]: p.kind,
  };
}

/** The labels that must match a request before sandboxd touches an object (D-02, Pattern 1). */
export function ownerLabels(p: Omit<LabelInput, "kind">): Record<string, string> {
  return {
    [SANDBOXD_LABELS.sandbox]: "1",
    [SANDBOXD_LABELS.namespace]: p.ns,
    [SANDBOXD_LABELS.org]: p.orgId,
    [SANDBOXD_LABELS.agent]: p.agentId,
  };
}

export interface ObjectSpecInput {
  ns: string;
  orgId: string;
  agentId: string;
}

/** The bot's own network: `internal: true`, so no route and no DNS outside it (Docker ≥ 26, CVE-2024-29018). */
export function networkSpec(p: ObjectSpecInput) {
  return {
    Name: nameFor("net", p.ns, p.agentId),
    Driver: "bridge",
    Internal: true,
    Attachable: false,
    EnableIPv6: false,
    Labels: labelsFor({ ns: p.ns, orgId: p.orgId, agentId: p.agentId, kind: "sbx" }),
  };
}

/** The bot's workspace volume (mounted at /workspace). */
export function volumeSpec(p: ObjectSpecInput) {
  return {
    Name: nameFor("ws", p.ns, p.agentId),
    Driver: "local",
    Labels: labelsFor({ ns: p.ns, orgId: p.orgId, agentId: p.agentId, kind: "sbx" }),
  };
}

export interface ShellSpecInput extends ObjectSpecInput {
  /** The configured `sbx` image (OCW_SANDBOX_SBX_IMAGE), never a caller's. */
  image: string;
  runtime: DockerRuntime;
  network: string;
  volume: string;
  limits: ContainerLimits;
}

/**
 * The `ContainerCreate` body of a bot's `sbx` (research Code Examples, hardened profile table). The command only keeps
 * the container alive; every bot command arrives later through exec as 10001 via `ocw-run`.
 */
export function shellSpec(p: ShellSpecInput) {
  const limits = clampLimits(p.limits);
  return {
    Image: p.image,
    User: SANDBOX_USER,
    Cmd: ["sleep", "infinity"],
    WorkingDir: WORKSPACE,
    Env: [`HOME=${WORKSPACE}`],
    Labels: labelsFor({ ns: p.ns, orgId: p.orgId, agentId: p.agentId, kind: "sbx" }),
    AttachStdin: false,
    AttachStdout: false,
    AttachStderr: false,
    OpenStdin: false,
    Tty: false,
    StopTimeout: 5,
    HostConfig: {
      Runtime: p.runtime,
      Privileged: false,
      ReadonlyRootfs: true,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges:true"],
      Init: true,
      PidsLimit: limits.pids,
      Memory: limits.memoryBytes,
      MemorySwap: limits.memoryBytes,
      NanoCpus: limits.nanoCpus,
      Tmpfs: { "/tmp": "rw,noexec,nosuid,nodev,size=256m" },
      Mounts: [{ Type: "volume", Source: p.volume, Target: WORKSPACE, ReadOnly: false }],
      NetworkMode: p.network,
      PublishAllPorts: false,
      RestartPolicy: { Name: "no" },
      IpcMode: "private",
      LogConfig: { Type: "none", Config: {} },
    },
  };
}
