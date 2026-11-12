import { createHash } from "node:crypto";
import { isIPv4 } from "node:net";
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
/** The helper every file operation goes through (infra/sandbox/sbx/ocw-files), workspace-confined with realpath. */
export const OCW_FILES = "/usr/local/bin/ocw-files";
/**
 * `ocw-extract`'s scratch folder in the workspace (infra/sandbox/sbx/tools/ocw_extract/runner.py SCRATCH_ROOT), as
 * `ocw-files` names it: a run SIGKILLed mid-extraction leaves it behind (07.17.1.1.1 review WR-06).
 */
export const EXTRACT_SCRATCH = ".ocw-extract-tmp";
/** The room left under the soft quota, told to every exec (07.17.1.1.1 review WR-06; ocw-extract caps archives). */
export const DISK_ROOM_ENV = "OCW_DISK_ROOM_BYTES";

export interface ContainerLimits {
  nanoCpus: number;
  memoryBytes: number;
  pids: number;
}

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

/**
 * Object name kinds: containers (`sbx`, `brw`, the `files` helper), volumes (`ws`, `pkg`), the bot's shell network
 * (`net`) and its browser network (`bnet`).
 */
export type NameKind = "sbx" | "brw" | "files" | "ws" | "pkg" | "net" | "bnet" | "pnet" | "prun";

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

/** The `files` helper's limits: enough for coreutils over one workspace, never the bot's own share. */
export const FILES_HELPER_LIMITS: ContainerLimits = {
  nanoCpus: 500_000_000,
  memoryBytes: 256 * 1024 * 1024,
  pids: 64,
};

/** How long a `files` helper lives on its own before it exits (the sweeper reaps idle ones sooner). */
export const FILES_HELPER_SECONDS = 300;

export interface ShellSpecInput extends ObjectSpecInput {
  /** The configured `sbx` image (OCW_SANDBOX_SBX_IMAGE), never a caller's. */
  image: string;
  runtime: DockerRuntime;
  network: string;
  volume: string;
  /** The bot's packages volume (`ocw-pkg-<ns>-<key>`), mounted read-only at /opt/ocw-packages (07.8-17). */
  packagesVolume: string;
  limits: ContainerLimits;
  /** The egress proxy's address on `network` (from Docker, at attach), or none: no proxy, no entry. */
  egressAddress?: string | null;
}

/** Where approved sandbox packages live (P-12): read-only in `sbx`, read-write only in the installer. */
export const PACKAGES_DIR = "/opt/ocw-packages";
/** The scratch volume of a review or installer run: downloads and builds happen here, never in the bot's volume. */
export const STAGING_DIR = "/staging";

/** The namespace's egress proxy as every bot network names it (07.8-12/13): the only way out. */
export const EGRESS_ALIAS = "sandbox-egress";
export const EGRESS_PORT = 3128;
export const EGRESS_PROXY_URL = `http://${EGRESS_ALIAS}:${EGRESS_PORT}`;
const NO_PROXY = "localhost,127.0.0.1,::1";

/** The proxy variables curl, pip, npm, apt and Python honour; no credential: identity is the arrival network. */
export const PROXY_ENV: readonly string[] = [
  `HTTP_PROXY=${EGRESS_PROXY_URL}`,
  `HTTPS_PROXY=${EGRESS_PROXY_URL}`,
  `http_proxy=${EGRESS_PROXY_URL}`,
  `https_proxy=${EGRESS_PROXY_URL}`,
  `NO_PROXY=${NO_PROXY}`,
  `no_proxy=${NO_PROXY}`,
];

/**
 * The `/etc/hosts` entry naming the proxy on one bot network (07.8 gVisor DNS fix). gVisor `runsc` does not answer
 * Docker's embedded DNS (127.0.0.11) on the internal bot networks, so the alias in `HTTP(S)_PROXY` and in Chromium's
 * proxy flag resolves only through this entry; under runc it gives the same answer as Docker's DNS. The address is the
 * proxy's on that network, read from Docker each time sandboxd attaches it, never a caller's: anything but a dotted
 * IPv4 address (the bot networks have no IPv6) is refused, so no host name or second entry reaches `ExtraHosts`.
 */
export function egressHosts(address: string | null | undefined): string[] {
  if (address === null || address === undefined) return [];
  if (!isIPv4(address)) throw new Error("the egress proxy's address is not an IPv4 address");
  return [`${EGRESS_ALIAS}:${address}`];
}

/**
 * Whether a container's `HostConfig.ExtraHosts` (as Docker inspects it: null when empty) is exactly the entry for the
 * proxy's address now. A proxy that restarted has a new address, and a container created before this fix has none.
 */
export function egressHostsCurrent(extraHosts: unknown, address: string | null): boolean {
  const have = Array.isArray(extraHosts) ? extraHosts : [];
  const want = egressHosts(address);
  return have.length === want.length && have.every((h, i) => h === want[i]);
}

/**
 * The document toolkit baked into the `sbx` image (07.17.1.1.1, D-03, PD-05; ADR-0043): its `bin` comes after the system
 * paths and before approved package bins in PATH; in PYTHONPATH it comes after approved packages (07.17.1.1.1 review
 * WR-08), so a version an approval pinned is never replaced by the toolkit's. `bin` holds curated links only (e.g.
 * `pdfplumber`), never the venv's own `bin` (it has `python`, which would shadow bookworm's missing one).
 */
export const TOOLS_DIR = "/opt/ocw-tools";
/** The toolkit venv's site-packages (Python 3.11, the image's interpreter), after approved packages on PYTHONPATH. */
export const TOOLS_SITE = `${TOOLS_DIR}/venv/lib/python3.11/site-packages`;

/**
 * The whole environment of a bot's `sbx` (07.8-17, WINDOWS #253): the toolkit (07.17.1.1.1) and then package bins after
 * the system paths (neither ever shadows a system command), Node and Python find approved packages and then the toolkit
 * (an approved package and the dependencies its approval pinned win over a toolkit module of the same name; ocw-extract
 * runs isolated and never reads PYTHONPATH), and every tool uses the egress proxy by default.
 * Constants only: nothing here comes from a request, and no secret is ever set. Package runs (`runEnv`) never see the
 * toolkit.
 */
export const SHELL_ENV: readonly string[] = [
  `HOME=${WORKSPACE}`,
  `PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${TOOLS_DIR}/bin:${PACKAGES_DIR}/bin`,
  `NODE_PATH=${PACKAGES_DIR}/node_modules`,
  `PYTHONPATH=${PACKAGES_DIR}/python:${TOOLS_SITE}`,
  ...PROXY_ENV,
];

/**
 * Whether a container's inspected `Config.Env` holds every current `SHELL_ENV` line (07.17.1.1.1 D-10, PD-10): a shell
 * created before an environment change (e.g. without the toolkit on PATH) lacks one and is created again at its next
 * start. Presence, not equality: Docker merges the image's own `ENV` lines (e.g. `NODE_VERSION`) into the container's,
 * so an exact comparison would always fail. No environment at all is never current.
 */
export function shellEnvCurrent(env: unknown): boolean {
  if (!Array.isArray(env) || env.length === 0) return false;
  const have = new Set(env.filter((l): l is string => typeof l === "string"));
  return SHELL_ENV.every((line) => have.has(line));
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
    Env: [...SHELL_ENV],
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
      Mounts: [
        { Type: "volume", Source: p.volume, Target: WORKSPACE, ReadOnly: false },
        { Type: "volume", Source: p.packagesVolume, Target: PACKAGES_DIR, ReadOnly: true },
      ],
      NetworkMode: p.network,
      ExtraHosts: egressHosts(p.egressAddress),
      PublishAllPorts: false,
      RestartPolicy: { Name: "no" },
      IpcMode: "private",
      LogConfig: { Type: "none", Config: {} },
    },
  };
}

export interface FilesSpecInput extends ObjectSpecInput {
  image: string;
  runtime: DockerRuntime;
  volume: string;
}

/**
 * The `files` helper (D-01, D-04, D-09, Pitfall 5): people's file operations on a stopped or killed sandbox run here,
 * so the bot's `sbx` stays stopped. It is `shellSpec` with no network at all (`NetworkMode: "none"`), kind `files`,
 * small limits and a command that ends on its own; every file operation still arrives through exec as 10001 via
 * `ocw-files`.
 */
export function filesSpec(p: FilesSpecInput) {
  const spec = shellSpec({
    ...p,
    network: "none",
    packagesVolume: "",
    limits: FILES_HELPER_LIMITS,
    egressAddress: null,
  });
  return {
    ...spec,
    Cmd: ["sleep", String(FILES_HELPER_SECONDS)],
    Labels: labelsFor({ ns: p.ns, orgId: p.orgId, agentId: p.agentId, kind: "files" }),
    // The workspace only: people's file operations never see the packages volume.
    HostConfig: {
      ...spec.HostConfig,
      NetworkMode: "none",
      ExtraHosts: [],
      Mounts: [{ Type: "volume", Source: p.volume, Target: WORKSPACE, ReadOnly: false }],
    },
  };
}

// ---------------------------------------------------------------- the browser (07.8-13, D-01, D-05, D-11, D-14)

/** What `brw`'s Chromium is told to use: the only way out of a bot network. */
export const BROWSER_PROXY = EGRESS_PROXY_URL;
/** Chromium's shared memory (spike i): Playwright's `--disable-dev-shm-usage` aside, the renderer needs room. */
export const BRW_SHM_BYTES = 512 * 1024 * 1024;

/**
 * The bot's browser network: `internal: true` like the shell's, holding only its `brw` and `sandbox-egress`. The proxy
 * tells bots apart by the address a connection arrived on, so the browser gets its own network and its own egress
 * mode (`browserEgress`), and member cookies in `brw` never share a network with the bot's exec container.
 */
export function browserNetworkSpec(p: ObjectSpecInput) {
  return {
    Name: nameFor("bnet", p.ns, p.agentId),
    Driver: "bridge",
    Internal: true,
    Attachable: false,
    EnableIPv6: false,
    Labels: labelsFor({ ns: p.ns, orgId: p.orgId, agentId: p.agentId, kind: "brw" }),
  };
}

export interface BrowserSpecInput extends ObjectSpecInput {
  /** The configured `brw` image (OCW_SANDBOX_BRW_IMAGE), never a caller's. */
  image: string;
  runtime: DockerRuntime;
  network: string;
  limits: ContainerLimits;
  /** Chromium's own sandbox (D-14): always on under runsc; on runc the agent may fall back and says so. */
  chromiumSandbox: boolean;
  /** The seccomp profile JSON (Docker default + userns, infra/sandbox/browser/seccomp.json), or null for Docker's. */
  seccompProfile?: string | null;
  /** The egress proxy's address on `network` (from Docker, at attach), or none. */
  egressAddress?: string | null;
}

/**
 * The `ContainerCreate` body of a bot's `brw` (07.8-07's agent): `shellSpec`'s hardened profile without a workspace
 * volume, `ShmSize` 512 MiB, a tmpfs `/tmp` (downloads live there), and stdin kept open so sandboxd speaks to the agent
 * over the attached stdio only. No port, no CDP endpoint, no host IPC: Chromium is driven over a pipe inside.
 */
export function brwSpec(p: BrowserSpecInput) {
  if (p.runtime === "runsc" && !p.chromiumSandbox) {
    // D-14: never a silent fallback under gVisor.
    throw new Error("Chromium's sandbox stays on under runsc");
  }
  const limits = clampLimits(p.limits);
  const securityOpt = ["no-new-privileges:true"];
  if (p.seccompProfile) securityOpt.push(`seccomp=${p.seccompProfile}`);
  return {
    Image: p.image,
    User: SANDBOX_USER,
    WorkingDir: "/tmp",
    Env: [
      "HOME=/tmp",
      `OCW_BROWSER_PROXY=${BROWSER_PROXY}`,
      `OCW_BROWSER_CHROMIUM_SANDBOX=${p.chromiumSandbox ? "on" : "off"}`,
      `OCW_BROWSER_RUNTIME=${p.runtime}`,
    ],
    Labels: labelsFor({ ns: p.ns, orgId: p.orgId, agentId: p.agentId, kind: "brw" }),
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    OpenStdin: true,
    StdinOnce: false,
    Tty: false,
    StopTimeout: 5,
    HostConfig: {
      Runtime: p.runtime,
      Privileged: false,
      ReadonlyRootfs: true,
      CapDrop: ["ALL"],
      SecurityOpt: securityOpt,
      Init: true,
      PidsLimit: limits.pids,
      Memory: limits.memoryBytes,
      MemorySwap: limits.memoryBytes,
      NanoCpus: limits.nanoCpus,
      ShmSize: BRW_SHM_BYTES,
      Tmpfs: { "/tmp": "rw,noexec,nosuid,nodev,size=256m" },
      Mounts: [],
      NetworkMode: p.network,
      ExtraHosts: egressHosts(p.egressAddress),
      PublishAllPorts: false,
      RestartPolicy: { Name: "no" },
      IpcMode: "private",
      LogConfig: { Type: "none", Config: {} },
    },
  };
}

// ---------------------------------------------------------------- the namespace's egress proxy (07.8-12/13, D-11)

/** The tmpfs the broker writes the proxy's policy into (root-owned 0755: the proxy reads it, never rewrites it). */
export const EGRESS_POLICY_DIR = "/run/ocw-egress";
export const EGRESS_POLICY_FILE = `${EGRESS_POLICY_DIR}/policy.json`;
/** The proxy's own user (not the bot's 10001). */
export const EGRESS_USER = "10002:10002";

/** One proxy per namespace: modest, fixed limits (it only relays bytes). */
export const EGRESS_LIMITS: ContainerLimits = {
  nanoCpus: 1_000_000_000,
  memoryBytes: 256 * 1024 * 1024,
  pids: 256,
};

/** `ocw-egress-<ns>` (the container) and `ocw-egress-out-<ns>` (its outbound network). */
export function egressNames(ns: string) {
  return { container: `ocw-egress-${ns}`, network: `ocw-egress-out-${ns}` };
}

/** The proxy belongs to the namespace, not to an organization or a bot: no org or agent label, so no kill reaches it. */
export function egressLabels(ns: string): Record<string, string> {
  return {
    [SANDBOXD_LABELS.sandbox]: "1",
    [SANDBOXD_LABELS.namespace]: ns,
    [SANDBOXD_LABELS.kind]: "egress",
  };
}

/**
 * The proxy's outbound network: an ordinary bridge (the only non-internal network sandboxd creates), with no other
 * member and inter-container traffic off. Never the network the API and sandboxd share.
 */
export function egressNetworkSpec(ns: string) {
  return {
    Name: egressNames(ns).network,
    Driver: "bridge",
    Internal: false,
    Attachable: false,
    EnableIPv6: false,
    Options: { "com.docker.network.bridge.enable_icc": "false" },
    Labels: egressLabels(ns),
  };
}

/** The `sandbox-egress` container (07.8-12's image): non-root, read-only, the policy tmpfs, the outbound network. */
export function egressSpec(p: { ns: string; image: string }) {
  const limits = EGRESS_LIMITS;
  return {
    Image: p.image,
    User: EGRESS_USER,
    Labels: egressLabels(p.ns),
    AttachStdin: false,
    AttachStdout: true,
    AttachStderr: true,
    OpenStdin: false,
    Tty: false,
    StopTimeout: 5,
    HostConfig: {
      Privileged: false,
      ReadonlyRootfs: true,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges:true"],
      Init: true,
      PidsLimit: limits.pids,
      Memory: limits.memoryBytes,
      MemorySwap: limits.memoryBytes,
      NanoCpus: limits.nanoCpus,
      Tmpfs: { [EGRESS_POLICY_DIR]: "rw,noexec,nosuid,nodev,size=1m,mode=0755" },
      Mounts: [],
      NetworkMode: egressNames(p.ns).network,
      PublishAllPorts: false,
      RestartPolicy: { Name: "no" },
      IpcMode: "private",
      LogConfig: { Type: "none", Config: {} },
    },
  };
}

// ---------------------------------------------------------------- sandbox packages (07.8-17, D-03, D-11, P-12)

/** The bot's packages volume: approved packages, written only by an installer run, read-only in `sbx`. */
export function packagesVolumeSpec(p: ObjectSpecInput) {
  return {
    Name: nameFor("pkg", p.ns, p.agentId),
    Driver: "local",
    Labels: labelsFor({ ns: p.ns, orgId: p.orgId, agentId: p.agentId, kind: "sbx" }),
  };
}

/** A review or installer run: fixed limits, whatever the organization's (it only downloads, builds and copies). */
export const INSTALLER_LIMITS: ContainerLimits = {
  nanoCpus: 2_000_000_000,
  memoryBytes: 2 * 1024 * 1024 * 1024,
  pids: 1024,
};

/** `ocw-pnet-<ns>-<key>` (the run's own network) and `ocw-prun-<ns>-<key>` (its container), from the run's id. */
export function packageRunNames(ns: string, runId: string) {
  return { network: nameFor("pnet", ns, runId), container: nameFor("prun", ns, runId) };
}

export interface PackageRunInput extends ObjectSpecInput {
  /** A fresh id per run: two runs never share a network or a container. */
  runId: string;
}

/**
 * Each review or install run gets its own internal network holding only its container and the egress proxy, which
 * applies the registries-only policy to it (`kind` installer or review), so two organizations' installers never meet.
 */
export function packageRunNetworkSpec(p: PackageRunInput & { kind: "installer" | "review" }) {
  return {
    Name: packageRunNames(p.ns, p.runId).network,
    Driver: "bridge",
    Internal: true,
    Attachable: false,
    EnableIPv6: false,
    Labels: labelsFor({ ns: p.ns, orgId: p.orgId, agentId: p.agentId, kind: p.kind }),
  };
}

export interface RunSpecInput extends PackageRunInput {
  /** The configured `sbx` image (it carries node, npm, python3, pip, apt and dpkg-deb), never a caller's. */
  image: string;
  runtime: DockerRuntime;
  /** The run's own network, or "none" (a removal reaches nothing). */
  network: string;
  /** The run's environment, built by sandboxd from its configuration (proxy and registry URLs; no secret). */
  env: readonly string[];
  /** The container ends on its own after this long, and Docker removes it (AutoRemove) with its scratch volume. */
  lifetimeSeconds: number;
  /** The egress proxy's address on the run's network (from Docker, at attach), or none (a removal has no network). */
  egressAddress?: string | null;
}

function runSpec(p: RunSpecInput, kind: "installer" | "review", packagesVolume: string | null) {
  const limits = clampLimits(INSTALLER_LIMITS);
  const labels = labelsFor({ ns: p.ns, orgId: p.orgId, agentId: p.agentId, kind });
  const mounts: Array<Record<string, unknown>> = [];
  if (packagesVolume !== null) {
    mounts.push({ Type: "volume", Source: packagesVolume, Target: PACKAGES_DIR, ReadOnly: false });
  }
  // An anonymous volume (removed with the container): staging never touches the bot's volume until it is verified.
  mounts.push({ Type: "volume", Target: STAGING_DIR, ReadOnly: false, VolumeOptions: { Labels: labels } });
  return {
    Image: p.image,
    User: SANDBOX_USER,
    Cmd: ["sleep", String(Math.max(60, Math.floor(p.lifetimeSeconds)))],
    WorkingDir: STAGING_DIR,
    Env: [`HOME=${STAGING_DIR}/home`, ...p.env],
    Labels: labels,
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
      Mounts: mounts,
      NetworkMode: p.network,
      ExtraHosts: p.network === "none" ? [] : egressHosts(p.egressAddress),
      PublishAllPorts: false,
      RestartPolicy: { Name: "no" },
      AutoRemove: true,
      IpcMode: "private",
      LogConfig: { Type: "none", Config: {} },
    },
  };
}

/**
 * The installer (P-12): `shellSpec`'s hardened profile with the bot's packages volume read-write and a scratch volume.
 * Install scripts run here and only here, never in sandboxd or the cell.
 */
export function installerSpec(p: RunSpecInput & { packagesVolume: string }) {
  return runSpec(
    {
      ns: p.ns,
      orgId: p.orgId,
      agentId: p.agentId,
      runId: p.runId,
      image: p.image,
      runtime: p.runtime,
      network: p.network,
      env: p.env,
      lifetimeSeconds: p.lifetimeSeconds,
      egressAddress: p.egressAddress ?? null,
    },
    "installer",
    p.packagesVolume,
  );
}

/** The review run (P-12): the same profile with nothing persistent mounted (no bot data, workspace or session). */
export function reviewSpec(p: RunSpecInput) {
  return runSpec(
    {
      ns: p.ns,
      orgId: p.orgId,
      agentId: p.agentId,
      runId: p.runId,
      image: p.image,
      runtime: p.runtime,
      network: p.network,
      env: p.env,
      lifetimeSeconds: p.lifetimeSeconds,
      egressAddress: p.egressAddress ?? null,
    },
    "review",
    null,
  );
}
