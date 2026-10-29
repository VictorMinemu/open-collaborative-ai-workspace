import { z } from "zod";
import { Id, IsoDateTime } from "./common";
import { PINNED_RUNTIME_VERSIONS } from "./runtime-controls/index";
import { RuntimeId } from "./session-events";

/**
 * Phase 07.11 (runtime CLI auto-updates, RTU-01…RTU-07). The vocabulary every tier shares: versions and their order,
 * the update levels and their intersection (D-02, D-10), the compatibility manifest (D-04), the install-method, state
 * and run vocabularies (D-01, D-05, D-08), the maintenance status and history DTOs (D-06) and `scrubHostPaths`.
 *
 * Imports only `zod`, `./common`, `./session-events` and `./runtime-controls/index`; `device.ts` and `device-link.ts`
 * import this module, never the reverse. No field here can carry an absolute host path (AGENTS principle 7).
 */

// ---- versions ----

const RUNTIME_VERSION_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/;
/** The detect regex the daemon's `claude/detect.ts` and `codex/detect.ts` already use (Pitfall 8). */
const VERSION_IN_TEXT_RE = /(\d+\.\d+\.\d+(?:[-+][\w.]+)?)/;

/** A runtime CLI version: `MAJOR.MINOR.PATCH[-prerelease]`, no build metadata (07.11, Pitfall 8). */
export const RuntimeVersion = z.string().max(64).regex(RUNTIME_VERSION_RE);
export type RuntimeVersion = z.infer<typeof RuntimeVersion>;

/**
 * The version in a CLI's `--version` output (`2.1.307 (Claude Code)`, `codex-cli 0.164.0`), build metadata after `+`
 * dropped; null when there is none (an unknown version is never "behind", Pitfall 8).
 */
export function parseRuntimeVersion(text: string): string | null {
  const found = VERSION_IN_TEXT_RE.exec(text)?.[1];
  if (!found) return null;
  const version = found.split("+")[0] ?? "";
  return RuntimeVersion.safeParse(version).success ? version : null;
}

function splitVersion(v: string): { core: number[]; pre: string[] } {
  const dash = v.indexOf("-");
  const core = (dash === -1 ? v : v.slice(0, dash)).split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pre = dash === -1 ? [] : v.slice(dash + 1).split(".");
  return { core, pre };
}

const NUMERIC_ID = /^\d+$/;

/**
 * Orders two runtime versions (no `semver` dependency; RESEARCH "Alternatives Considered"): the numeric triplet first;
 * a prerelease sorts below its release; prerelease identifiers compare numerically when both are numeric, else
 * lexically, and a shorter prefix sorts first.
 */
export function compareRuntimeVersions(a: string, b: string): -1 | 0 | 1 {
  const x = splitVersion(a);
  const y = splitVersion(b);
  for (let i = 0; i < 3; i++) {
    const d = (x.core[i] ?? 0) - (y.core[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  if (x.pre.length === 0 || y.pre.length === 0) {
    if (x.pre.length === y.pre.length) return 0;
    return x.pre.length === 0 ? 1 : -1;
  }
  const n = Math.max(x.pre.length, y.pre.length);
  for (let i = 0; i < n; i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    if (NUMERIC_ID.test(p) && NUMERIC_ID.test(q)) return Number(p) < Number(q) ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

// ---- levels (D-02, D-10) ----

/**
 * How far a level lets updates go: `automatic` installs when behind, `notify` checks and reports (installs only on
 * "Update now"), `off` makes no registry request at all (PD-08). Set by the org policy and by each device.
 */
export const RuntimeUpdatesLevel = z.enum(["automatic", "notify", "off"]);
export type RuntimeUpdatesLevel = z.infer<typeof RuntimeUpdatesLevel>;

/** Where the device-local level came from: `OCW_RUNTIME_UPDATES` (wins) or `runtime.json`. */
export const RuntimeUpdatesLevelSource = z.enum(["env", "config"]);
export type RuntimeUpdatesLevelSource = z.infer<typeof RuntimeUpdatesLevelSource>;

/** The level ladder: the effective level is the lower rank (D-02). */
export const RUNTIME_UPDATES_RANK: Readonly<Record<RuntimeUpdatesLevel, number>> = {
  off: 0,
  notify: 1,
  automatic: 2,
};

/**
 * Org level ∩ device level = the lower of the two (D-02). `org === null` (no `runtime.config` received yet: an older
 * API, or offline since start) counts as `notify`: never install unattended without a server that audits (D-10).
 */
export function effectiveRuntimeUpdatesLevel(
  org: RuntimeUpdatesLevel | null,
  local: RuntimeUpdatesLevel,
): RuntimeUpdatesLevel {
  const orgLevel = org ?? "notify";
  return RUNTIME_UPDATES_RANK[orgLevel] <= RUNTIME_UPDATES_RANK[local] ? orgLevel : local;
}

// ---- compatibility manifest (D-04, PD-12) ----

/** What the Control Plane says about a version; `unknown` = no version, or one that does not parse. */
export const RuntimeCompatibility = z.enum(["supported", "graceful", "unsupported", "broken", "unknown"]);
export type RuntimeCompatibility = z.infer<typeof RuntimeCompatibility>;

/** The statuses a manifest range may declare (`unknown` is only ever computed). */
export const RuntimeCompatibilityStatus = RuntimeCompatibility.exclude(["unknown"]);
export type RuntimeCompatibilityStatus = z.infer<typeof RuntimeCompatibilityStatus>;

/** `min ≤ version < maxExclusive`; a missing bound is open. */
export const VersionBounds = z
  .object({ min: RuntimeVersion.optional(), maxExclusive: RuntimeVersion.optional() })
  .strict();
export type VersionBounds = z.infer<typeof VersionBounds>;

export const RuntimeCompatibilityRange = z.object({
  bounds: VersionBounds,
  status: RuntimeCompatibilityStatus,
  note: z.string().max(200).optional(),
});
export type RuntimeCompatibilityRange = z.infer<typeof RuntimeCompatibilityRange>;

/** One runtime's entry: the recommended bounds and the ranges, first match wins (list narrow ranges first). */
export const RuntimeCompatibilityEntry = z.object({
  recommended: VersionBounds,
  ranges: z.array(RuntimeCompatibilityRange).max(50),
});
export type RuntimeCompatibilityEntry = z.infer<typeof RuntimeCompatibilityEntry>;

/**
 * The compatibility manifest (D-04): bundled here, served by the Control Plane in `runtime.config`; the device keeps
 * the newer of its bundled copy and the server's (`newerManifest`). It only marks ranges; it never names a version to
 * install, so the server cannot steer what a device runs (D-05).
 */
export const RuntimeCompatibilityManifest = z.object({
  updatedAt: IsoDateTime,
  runtimes: z.object({ "claude-code": RuntimeCompatibilityEntry, codex: RuntimeCompatibilityEntry }),
});
export type RuntimeCompatibilityManifest = z.infer<typeof RuntimeCompatibilityManifest>;

/**
 * The bundled manifest (PD-12). Floors = the oldest committed adapter fixture (Claude Code 2.1.287,
 * `claude-code-2.1.287.plan-read.sdk.jsonl`; Codex 0.160.0); recommended = `PINNED_RUNTIME_VERSIONS`; no upper bound
 * (the point is to reach latest); no broken range. A known-bad release becomes a `broken` range, listed first, in a
 * server release.
 */
export const RUNTIME_COMPATIBILITY_MANIFEST: RuntimeCompatibilityManifest = {
  updatedAt: "2026-10-28T00:00:00.000Z",
  runtimes: {
    "claude-code": {
      recommended: { min: PINNED_RUNTIME_VERSIONS["claude-code"].cli },
      ranges: [
        { bounds: { min: "2.1.287" }, status: "supported" },
        {
          bounds: { maxExclusive: "2.1.287" },
          status: "unsupported",
          note: "Older than the oldest version the Work Zone adapter is tested against",
        },
      ],
    },
    codex: {
      recommended: { min: PINNED_RUNTIME_VERSIONS.codex.cli },
      ranges: [
        { bounds: { min: "0.160.0" }, status: "supported" },
        {
          bounds: { maxExclusive: "0.160.0" },
          status: "unsupported",
          note: "Older than the oldest version the Work Zone adapter is tested against",
        },
      ],
    },
  },
};

function inBounds(version: string, bounds: VersionBounds): boolean {
  if (bounds.min !== undefined && compareRuntimeVersions(version, bounds.min) < 0) return false;
  if (bounds.maxExclusive !== undefined && compareRuntimeVersions(version, bounds.maxExclusive) >= 0)
    return false;
  return true;
}

/**
 * What `manifest` says about `version` of `runtime` (D-04): null or unparsable → `unknown`; the first range whose
 * bounds contain it wins; no match → `supported` at or above the highest `min` among the ranges, else `unsupported`.
 */
export function compatibilityOf(
  manifest: RuntimeCompatibilityManifest,
  runtime: RuntimeId,
  version: string | null,
): RuntimeCompatibility {
  if (version === null || !RuntimeVersion.safeParse(version).success) return "unknown";
  const entry = manifest.runtimes[runtime];
  const match = entry.ranges.find((r) => inBounds(version, r.bounds));
  if (match) return match.status;
  const mins = entry.ranges.flatMap((r) => (r.bounds.min === undefined ? [] : [r.bounds.min]));
  if (mins.length === 0) return "supported";
  const highest = mins.reduce((hi, m) => (compareRuntimeVersions(m, hi) > 0 ? m : hi));
  return compareRuntimeVersions(version, highest) >= 0 ? "supported" : "unsupported";
}

/**
 * The manifest with the later `updatedAt` (a tie keeps `a`; the device passes its bundled copy as `a`), keeping every
 * `broken` range of the other copy in front of its ranges (07.11 review LO-01): a manifest can only block, so a later
 * copy that lacks a broken range never re-enables that version.
 */
export function newerManifest(
  a: RuntimeCompatibilityManifest,
  b: RuntimeCompatibilityManifest,
): RuntimeCompatibilityManifest {
  const bNewer = Date.parse(b.updatedAt) > Date.parse(a.updatedAt);
  const newer = bNewer ? b : a;
  const older = bNewer ? a : b;
  let changed = false;
  const runtimes = { ...newer.runtimes };
  for (const id of Object.keys(runtimes) as RuntimeId[]) {
    const own = new Set(newer.runtimes[id].ranges.map((r) => JSON.stringify(r)));
    const keep = older.runtimes[id].ranges.filter(
      (r) => r.status === "broken" && !own.has(JSON.stringify(r)),
    );
    if (keep.length === 0) continue;
    changed = true;
    runtimes[id] = { ...newer.runtimes[id], ranges: [...keep, ...newer.runtimes[id].ranges] };
  }
  return changed ? { ...newer, runtimes } : newer;
}

// ---- install methods, states, runs (D-01, D-05, D-08, PD-09) ----

/**
 * How a runtime CLI was installed on the device, resolved by the daemon from one fixed table (PD-09). Only some
 * methods can update themselves unattended; the rest are reported with a manual command.
 */
export const InstallMethod = z.enum([
  "native",
  "codex_standalone",
  "npm",
  "pnpm",
  "bun",
  "yarn",
  "volta",
  "homebrew_cask",
  "homebrew_formula",
  "system_package",
  "mise",
  "asdf",
  "project_local",
  "sdk_bundled",
  "windows",
  "unknown",
  "not_installed",
]);
export type InstallMethod = z.infer<typeof InstallMethod>;

/** Why the device will not run the update itself (D-08: never escalates; `needs_admin` shows a `sudo` command). */
export const UpdateBlockReason = z.enum(["manual", "needs_admin", "updates_disabled", "not_installed"]);
export type UpdateBlockReason = z.infer<typeof UpdateBlockReason>;

/** The npm dist-tag the install follows (PD-10). */
export const UpdateChannel = z.enum(["latest", "stable"]);
export type UpdateChannel = z.infer<typeof UpdateChannel>;

/** Installed vs the channel's latest; `unknown` when either side is missing (never "behind" on a guess). */
export const UpdateAdvisory = z.enum(["unknown", "current", "behind"]);
export type UpdateAdvisory = z.infer<typeof UpdateAdvisory>;

/**
 * Where an update stands on the device (PD-07): `pending` waits for an idle moment, `draining` holds new turns while
 * in-flight ones finish, `queued` waits for another daemon's update of the same install, `running` runs the command.
 */
export const RuntimeMaintenanceState = z.enum(["idle", "pending", "draining", "queued", "running"]);
export type RuntimeMaintenanceState = z.infer<typeof RuntimeMaintenanceState>;

/** Who started a run: the device on its own, "Update now" from the web, or the device's local CLI. */
export const RuntimeUpdateTrigger = z.enum(["automatic", "manual", "local"]);
export type RuntimeUpdateTrigger = z.infer<typeof RuntimeUpdateTrigger>;

/** How a run ended on the device (PD-11). */
export const RuntimeUpdateOutcome = z.enum(["succeeded", "unchanged", "failed", "skipped_broken"]);
export type RuntimeUpdateOutcome = z.infer<typeof RuntimeUpdateOutcome>;

/** A history row's state (PD-04): a request, a run in progress, an outcome, or a request refused or expired. */
export const RuntimeUpdateRunState = z.enum([
  "requested",
  "started",
  "succeeded",
  "unchanged",
  "failed",
  "skipped_broken",
  "refused",
  "expired",
]);
export type RuntimeUpdateRunState = z.infer<typeof RuntimeUpdateRunState>;

// ---- no host path (principle 7, Pitfall 9) ----

/**
 * Characters after which an absolute path may start inside a token (`--prefix=/usr`, `(/usr/x.js:1:2)`, `error:/x`,
 * `a->/opt/x`, `x|/usr/lib`, `a;/x`, `user@/srv`, `!/x`, `(a)/x`). A `//` never starts one, so `scheme://` inside a
 * token is left alone.
 */
const PATH_LEAD = "(?<=^|[\\s\"'`(=\\[{<,:>|;@!)])";
const PATH_BODY = "[^\\s\"'`]";
const HOST_PATH_RE = new RegExp(
  [
    `${PATH_LEAD}file:${PATH_BODY}+`,
    `${PATH_LEAD}[A-Za-z]:[\\\\/]${PATH_BODY}*`,
    `${PATH_LEAD}\\\\\\\\${PATH_BODY}+`,
    `${PATH_LEAD}\\/(?![\\/\\s"'\`])${PATH_BODY}+`,
  ].join("|"),
  "gi",
);
const TRAILING_PUNCTUATION_RE = /[.,;:!?)\]}>]+$/;
const URL_TOKEN_RE = /^[^A-Za-z]*[A-Za-z][A-Za-z0-9+.-]+:\/\//;

/**
 * Replaces every absolute host path in `text` with `<path>` (Pitfall 9: `contain()` maps only the home and the given
 * roots, so `/usr/lib/node_modules/…`, `npm error path /opt/…` and Cellar paths would survive it). Absolute POSIX,
 * Windows-drive, UNC and `file:` tokens go; trailing punctuation stays; `~` and `~/…`, URLs with a scheme and relative
 * paths are kept. Idempotent.
 */
export function scrubHostPaths(text: string): string {
  return text.replace(/[^\s"'`]+/g, (token) => {
    if (URL_TOKEN_RE.test(token) && !/^[^A-Za-z]*file:/i.test(token)) return token;
    return token.replace(HOST_PATH_RE, (path) => {
      const tail = TRAILING_PUNCTUATION_RE.exec(path)?.[0] ?? "";
      return `<path>${tail}`;
    });
  });
}

/** Free text from a device (run output, errors): scrubbed of host paths when parsed, then bounded. */
const PathFreeText = (max: number) => z.string().overwrite(scrubHostPaths).max(max);

/** Where a CLI lives, only when under the daemon user's home: `~` or `~/…`; anything else is reported as null. */
export const HomeRelativeLocation = z
  .string()
  .max(200)
  .regex(/^~(\/\S*)?$/);
export type HomeRelativeLocation = z.infer<typeof HomeRelativeLocation>;

/** A command shown to people (`claude update`, `brew upgrade --cask claude-code`); never contains a host path. */
export const DisplayCommand = z
  .string()
  .max(300)
  .refine((s) => scrubHostPaths(s) === s, { message: "a display command never contains an absolute path" });
export type DisplayCommand = z.infer<typeof DisplayCommand>;

// ---- status and DTOs (D-06, PD-05) ----

/** The last finished run the device remembers for a runtime. */
export const RuntimeLastRun = z.object({
  runId: z.uuid(),
  outcome: RuntimeUpdateOutcome,
  at: IsoDateTime,
  fromVersion: RuntimeVersion.nullable(),
  toVersion: RuntimeVersion.nullable(),
});
export type RuntimeLastRun = z.infer<typeof RuntimeLastRun>;

/**
 * One runtime's maintenance status as the device reports it (RTU-01): installed version, how it was installed,
 * whether the device can update it and the exact command, the channel's latest, both compatibilities and where an
 * update stands. Strict, so no extra field can carry a path.
 */
export const RuntimeMaintenanceStatus = z
  .object({
    runtime: RuntimeId,
    installedVersion: RuntimeVersion.nullable(),
    method: InstallMethod,
    location: HomeRelativeLocation.nullable(),
    canUpdate: z.boolean(),
    reason: UpdateBlockReason.nullable(),
    updateCommand: DisplayCommand.nullable(),
    channel: UpdateChannel,
    latestVersion: RuntimeVersion.nullable(),
    advisory: UpdateAdvisory,
    installedCompatibility: RuntimeCompatibility,
    candidateCompatibility: RuntimeCompatibility,
    state: RuntimeMaintenanceState,
    /** When the current update first became due (drives `stale` after 24 h, PD-07). */
    pendingSince: IsoDateTime.nullable(),
    stale: z.boolean(),
    lastRun: RuntimeLastRun.nullable(),
    /** The last registry check; null = never checked (level `off`, or not yet). */
    checkedAt: IsoDateTime.nullable(),
  })
  .strict();
export type RuntimeMaintenanceStatus = z.infer<typeof RuntimeMaintenanceStatus>;

/**
 * `Device.runtimeMaintenance` (owner and admins only, `device.maintain`, D-06, D-11): the device's last snapshot plus
 * the org level the API applies.
 */
export const DeviceRuntimeMaintenance = z.object({
  runtimes: z.array(RuntimeMaintenanceStatus).max(4),
  localLevel: RuntimeUpdatesLevel,
  localLevelSource: RuntimeUpdatesLevelSource,
  effectiveLevel: RuntimeUpdatesLevel,
  orgLevel: RuntimeUpdatesLevel,
  reportedAt: IsoDateTime,
});
export type DeviceRuntimeMaintenance = z.infer<typeof DeviceRuntimeMaintenance>;

/** `Device.runtimeCompatibility` (everyone who sees the device, D-04): the manifest's verdict per installed runtime. */
export const DeviceRuntimeCompatibility = z.object({
  "claude-code": RuntimeCompatibility.optional(),
  codex: RuntimeCompatibility.optional(),
});
export type DeviceRuntimeCompatibility = z.infer<typeof DeviceRuntimeCompatibility>;

/**
 * Payload of the `runtime.update` command: the runtime id and nothing else (D-05). The server can never express a
 * command, a prefix or a version; the device picks all of them from its fixed table.
 */
export const RuntimeUpdatePayload = z.object({ runtime: RuntimeId }).strict();
export type RuntimeUpdatePayload = z.infer<typeof RuntimeUpdatePayload>;

/** One row of a device's update history (PD-04), as owners and admins see it. Output and error carry no path. */
export const RuntimeUpdateRun = z.object({
  id: Id,
  runtime: RuntimeId,
  trigger: RuntimeUpdateTrigger,
  state: RuntimeUpdateRunState,
  /** The member who pressed "Update now"; null for automatic and local runs. */
  requestedBy: z.object({ id: Id, name: z.string().nullable() }).nullable(),
  fromVersion: RuntimeVersion.nullable(),
  toVersion: RuntimeVersion.nullable(),
  candidate: RuntimeVersion.nullable(),
  method: InstallMethod.nullable(),
  output: PathFreeText(4096).nullable(),
  error: PathFreeText(500).nullable(),
  /** Null for runs the device started on its own. */
  requestedAt: IsoDateTime.nullable(),
  startedAt: IsoDateTime.nullable(),
  finishedAt: IsoDateTime.nullable(),
});
export type RuntimeUpdateRun = z.infer<typeof RuntimeUpdateRun>;

/** `GET /api/v1/devices/:id/runtime-updates`: newest first, at most 50. */
export const RuntimeUpdateRunList = z.object({ runs: z.array(RuntimeUpdateRun).max(50) });
export type RuntimeUpdateRunList = z.infer<typeof RuntimeUpdateRunList>;

/** `POST /api/v1/devices/:id/runtimes/:runtime/update` params. */
export const RuntimeUpdateParams = z.object({ id: Id, runtime: RuntimeId });
export type RuntimeUpdateParams = z.infer<typeof RuntimeUpdateParams>;

/** `GET /api/v1/devices/:id/runtime-updates?runtime=` query. */
export const RuntimeUpdateHistoryQuery = z.object({ runtime: RuntimeId.optional() });
export type RuntimeUpdateHistoryQuery = z.infer<typeof RuntimeUpdateHistoryQuery>;

/** "Update now" response: the `requested` history row. */
export const RequestRuntimeUpdateResponse = z.object({ run: RuntimeUpdateRun });
export type RequestRuntimeUpdateResponse = z.infer<typeof RequestRuntimeUpdateResponse>;

/** Device → server run output: bounded and path-free (shared with `device-link.ts`). */
export const RuntimeUpdateOutputText = PathFreeText(4096);
