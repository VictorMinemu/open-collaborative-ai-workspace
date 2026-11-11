import {
  DeviceRuntimeMaintenance,
  EventTypes,
  IdParams,
  InstallMethod,
  OCW_RUNTIME_TARGET,
  RequestRuntimeUpdateResponse,
  RUNTIME_SELF_UPDATE_REFUSAL_SENTENCES,
  RUNTIME_UPDATE_TARGET_LABEL,
  RuntimeBuild,
  type RuntimeId,
  type RuntimeMaintenanceFrame,
  type RuntimeMaintenanceStatus,
  type RuntimeSelfUpdateRefusal,
  type RuntimeServedBuild,
  RuntimeUpdateHistoryQuery,
  RuntimeUpdateParams,
  type RuntimeUpdatePayload,
  type RuntimeUpdateRun,
  type RuntimeUpdateRunFrame,
  RuntimeUpdateRunList,
  type RuntimeUpdatesLevel,
  type RuntimeUpdateTarget,
  RuntimeVersion,
  scrubHostPaths,
} from "@ocw/contracts";
import { type deviceCommands, deviceRuntimeUpdates, devices, type Tx } from "@ocw/db";
import { and, desc, eq, isNull, lt, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import { type App, authOf, type Core, tenant } from "../../core";
import { conflict, notFound } from "../../lib/errors";
import type { AuditEventInput, AuditService } from "../audit";
import { memberDirectory, type PermissionService } from "../organization";
import type { RealtimeService } from "../realtime";
import { loadDeviceAccess } from "./access";
import type { DeviceHub, DeviceRef } from "./hub";
import { deviceFacts } from "./routes";

/**
 * Runtime CLI maintenance on the Control Plane (Phase 07.11, D-05, D-06, D-11, ADR-0032; PD-04, PD-05, PD-06, PD-08).
 *
 * The device reports a snapshot of its coding CLIs (`runtime.maintenance`, stored as `devices.runtime_maintenance`)
 * and every update run (`runtime.update.run`, kept in `device_runtime_updates`); the owner or an admin
 * (`device.maintain`) reads the history and presses "Update now", whose `runtime.update` command carries the runtime
 * id and nothing else. Everything here is written only from the authenticated device socket or by a `device.maintain`
 * holder, audited in the same transaction (never with output or a path), and never carries a host path: device text
 * is scrubbed again before it is stored (principle 7). The `org:` stream only ever gets the id-only `device.updated`
 * ping.
 */

/** What the frame handlers write with (the hub's own services; the device module never imports the core here). */
export interface MaintenanceDeps {
  audit: AuditService;
  realtime: RealtimeService;
  /** The organization's runtime updates level, read in `tx` (an automatic run against it is flagged, LO-04). */
  runtimePolicy?: (tx: Tx) => Promise<RuntimeUpdatesLevel>;
}

type RunRow = typeof deviceRuntimeUpdates.$inferSelect;
type CommandRow = typeof deviceCommands.$inferSelect;

/** "Update now" waits at most this long for the device's answer before a new request may replace it (PD-04). */
export const RUNTIME_UPDATE_REQUEST_TTL_MS = 60 * 60_000;
/**
 * A run `started` longer ago than this without its `finished` frame can no longer be running (a run is bounded at a
 * few minutes on the device): the device died or restarted mid-install. Its row is closed as failed (07.11 review
 * ME-04); a late `finished` frame from the device's offline log still records the real outcome.
 */
export const RUNTIME_UPDATE_RUN_ABANDON_MS = 30 * 60_000;
export const RUN_INTERRUPTED = "interrupted: the device never reported how this update ended";
const REQUESTED_UQ = "device_runtime_updates_requested_uq";

/**
 * The stored snapshot: the device's report (07.17.1: with its own runtime's `self` when it sent one) plus whether it
 * had the org level when it sent it (D-10). `served` is never stored: the API fills it on every read (PD-15).
 */
const StoredMaintenance = DeviceRuntimeMaintenance.omit({ orgLevel: true, served: true }).extend({
  orgLevelReceived: z.boolean(),
});
type StoredMaintenance = z.infer<typeof StoredMaintenance>;

/** The device's last snapshot, or null when it never reported one (or the stored value no longer parses). */
export function storedMaintenance(value: unknown): StoredMaintenance | null {
  const parsed = StoredMaintenance.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * `Device.runtimeMaintenance` for a `device.maintain` holder: the snapshot plus the org level the API applies and
 * (07.17.1, PD-15) the build the workspace serves now (null when it serves none).
 */
export function toDeviceRuntimeMaintenance(
  stored: StoredMaintenance,
  orgLevel: RuntimeUpdatesLevel,
  served: RuntimeServedBuild | null,
): DeviceRuntimeMaintenance {
  return {
    runtimes: stored.runtimes,
    localLevel: stored.localLevel,
    localLevelSource: stored.localLevelSource,
    effectiveLevel: stored.effectiveLevel,
    orgLevel,
    reportedAt: stored.reportedAt,
    ...(stored.self ? { self: stored.self } : {}),
    served,
  };
}

/** Every string inside `value` scrubbed of host paths once more (defence in depth: the schemas already refuse them). */
function scrubDeep<T>(value: T): T {
  if (typeof value === "string") return scrubHostPaths(value) as T;
  if (Array.isArray(value)) return value.map(scrubDeep) as T;
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrubDeep(v)])) as T;
  }
  return value;
}

const versionOrNull = (v: string | null) => (v !== null && RuntimeVersion.safeParse(v).success ? v : null);
const buildOrNull = (v: string | null) => (v !== null && RuntimeBuild.safeParse(v).success ? v : null);
const isSelfRun = (row: { runtime: RuntimeUpdateTarget }) => row.runtime === OCW_RUNTIME_TARGET;
/** 07.17.1 PD-14: the device's own runtime is not busy with an update (idle, or a daemon that reports no `self`). */
const selfIdle = (self: StoredMaintenance["self"]) => !self || self.state === "idle";
const isoOrNull = (v: string | null) => (v ? new Date(v).toISOString() : null);

/** One history row as owners and admins read it (`RuntimeUpdateRun`), the requester named from the directory. */
export function toRuntimeUpdateRun(
  row: RunRow,
  names: ReadonlyMap<string, { displayName: string | null }>,
): RuntimeUpdateRun {
  const method = InstallMethod.safeParse(row.method);
  return {
    id: row.id,
    runtime: row.runtime,
    trigger: row.trigger,
    state: row.state,
    requestedBy: row.requestedBy
      ? { id: row.requestedBy, name: names.get(row.requestedBy)?.displayName ?? null }
      : null,
    fromVersion: versionOrNull(row.fromVersion),
    toVersion: versionOrNull(row.toVersion),
    candidate: versionOrNull(row.candidate),
    method: method.success ? method.data : null,
    output: row.output,
    error: row.error,
    requestedAt: isoOrNull(row.requestedAt),
    startedAt: isoOrNull(row.startedAt),
    finishedAt: isoOrNull(row.finishedAt),
    // 07.17.1: the OCW runtime's builds; CLI rows keep their 07.11 shape.
    ...(isSelfRun(row) ? { fromBuild: buildOrNull(row.fromBuild), toBuild: buildOrNull(row.toBuild) } : {}),
  };
}

// ---------------------------------------------------------------- audit (PD-06)

type Actor = Pick<AuditEventInput, "actorKind" | "actorId" | "userId">;

const deviceActor = (device: DeviceRef): Actor => ({
  actorKind: "device",
  actorId: device.deviceId,
  userId: null,
});

/** Who a run step is attributed to: the requester for "Update now", the system for automatic, else the device. */
function runActor(row: RunRow, device: DeviceRef): Actor {
  if (row.trigger === "manual" && row.requestedBy) {
    return { actorKind: "user", actorId: row.requestedBy, userId: row.requestedBy };
  }
  if (row.trigger === "automatic") return { actorKind: "system", actorId: null, userId: null };
  return deviceActor(device);
}

async function auditDevice(
  tx: Tx,
  deps: MaintenanceDeps,
  device: DeviceRef,
  action: string,
  actor: Actor,
  metadata: Record<string, unknown>,
  result: "success" | "error" = "success",
): Promise<void> {
  await deps.audit.record(tx, {
    action,
    resourceType: "device",
    resourceId: device.deviceId,
    deviceId: device.deviceId,
    result,
    ...actor,
    metadata,
  });
}

/**
 * Run metadata: versions, outcome, trigger and method (07.17.1: and both builds on `ocw-runtime` runs, so CLI rows
 * keep their 07.11 keys); never output, error text or a path.
 */
const runMetadata = (row: RunRow) => ({
  runtime: row.runtime,
  from: row.fromVersion,
  to: row.toVersion,
  candidate: row.candidate,
  outcome: row.state === "started" ? null : row.state,
  trigger: row.trigger,
  method: row.method,
  ...(isSelfRun(row) ? { fromBuild: row.fromBuild, toBuild: row.toBuild } : {}),
});

async function auditRun(
  tx: Tx,
  deps: MaintenanceDeps,
  device: DeviceRef,
  row: RunRow,
  action: "device.runtime_update_started" | "device.runtime_update_finished",
): Promise<void> {
  const failed = row.state === "failed" || row.state === "refused";
  await auditDevice(
    tx,
    deps,
    device,
    action,
    runActor(row, device),
    runMetadata(row),
    failed ? "error" : "success",
  );
}

async function pingOrg(tx: Tx, deps: MaintenanceDeps, device: DeviceRef, status: string): Promise<void> {
  await deps.realtime.appendEvent(tx, `org:${device.organizationId}`, EventTypes.deviceUpdated, {
    deviceId: device.deviceId,
    status,
    changed: true,
  });
}

async function lockDevice(tx: Tx, device: DeviceRef) {
  const [row] = await tx
    .select({ status: devices.status, maintenance: devices.runtimeMaintenance })
    .from(devices)
    .where(eq(devices.id, device.deviceId))
    .for("update");
  return row ?? null;
}

// ---------------------------------------------------------------- device → server frames

/**
 * `runtime.maintenance` (PD-03, PD-06): store the snapshot and the runtimes it reports, audit transitions only
 * (`available` once per runtime and latest version, `stale` when it turns true, the local level when it changes),
 * then the id-only `org:` ping.
 */
export async function onRuntimeMaintenance(
  tx: Tx,
  deps: MaintenanceDeps,
  device: DeviceRef,
  frame: RuntimeMaintenanceFrame,
): Promise<void> {
  const locked = await lockDevice(tx, device);
  if (!locked) return;
  const previous = storedMaintenance(locked.maintenance);
  const runtimes = scrubDeep(frame.runtimes);
  const next: StoredMaintenance = {
    runtimes,
    localLevel: frame.localLevel,
    localLevelSource: frame.localLevelSource,
    effectiveLevel: frame.effectiveLevel,
    orgLevelReceived: frame.orgLevelReceived,
    reportedAt: new Date().toISOString(),
    // 07.17.1 (PD-04): the device's own runtime, kept for the DTO and the update route's preconditions (PD-13).
    ...(frame.self ? { self: scrubDeep(frame.self) } : {}),
  };
  await tx
    .update(devices)
    .set({ runtimeMaintenance: next, runtimeInfo: scrubDeep(frame.runtimeInfo) })
    .where(eq(devices.id, device.deviceId));

  const actor = deviceActor(device);
  for (const s of runtimes) {
    const before: RuntimeMaintenanceStatus | undefined = previous?.runtimes.find(
      (p) => p.runtime === s.runtime,
    );
    const alreadyBehind = before?.advisory === "behind" && before.latestVersion === s.latestVersion;
    if (s.advisory === "behind" && s.latestVersion !== null && !alreadyBehind) {
      await auditDevice(tx, deps, device, "device.runtime_update_available", actor, {
        runtime: s.runtime,
        installed: s.installedVersion,
        candidate: s.latestVersion,
        candidateCompatibility: s.candidateCompatibility,
      });
    }
    if (s.stale && !before?.stale) {
      await auditDevice(tx, deps, device, "device.runtime_update_stale", actor, {
        runtime: s.runtime,
        installed: s.installedVersion,
        candidate: s.latestVersion,
        pendingSince: s.pendingSince,
      });
    }
  }
  if (previous && previous.localLevel !== frame.localLevel) {
    await auditDevice(tx, deps, device, "device.runtime_updates_level_changed", actor, {
      from: previous.localLevel,
      to: frame.localLevel,
      source: frame.localLevelSource,
    });
  }
  // 07.17.1 PD-14: an OCW runtime run stays open while the device reports it is still busy with it (`waiting` for
  // sessions to finish can outlast the abandon time); idle, or a daemon without `self`, can no longer be running it.
  await closeAbandonedRuns(tx, deps, device, { cli: true, self: selfIdle(next.self) });
  await pingOrg(tx, deps, device, locked.status);
}

/**
 * 07.11 review ME-04: this device's runs `started` more than `RUNTIME_UPDATE_RUN_ABANDON_MS` ago and never finished
 * are closed as failed (`interrupted`), audited as finished with `result: "error"` by the system. CLI runs are checked
 * at every snapshot (the handshake carries one on every connect); `ocw-runtime` runs (07.17.1 PD-14) at a snapshot
 * whose `self` is idle and on reading the history while the device is offline or its stored `self` is idle. Returns
 * how many it closed.
 */
async function closeAbandonedRuns(
  tx: Tx,
  deps: MaintenanceDeps,
  device: DeviceRef,
  targets: { cli: boolean; self: boolean },
): Promise<number> {
  if (!targets.cli && !targets.self) return 0;
  const target =
    targets.cli && targets.self
      ? []
      : [
          targets.self
            ? eq(deviceRuntimeUpdates.runtime, OCW_RUNTIME_TARGET)
            : ne(deviceRuntimeUpdates.runtime, OCW_RUNTIME_TARGET),
        ];
  const closed = await tx
    .update(deviceRuntimeUpdates)
    .set({ state: "failed", error: RUN_INTERRUPTED, finishedAt: sql`now()` })
    .where(
      and(
        eq(deviceRuntimeUpdates.deviceId, device.deviceId),
        ...target,
        eq(deviceRuntimeUpdates.state, "started"),
        lt(
          deviceRuntimeUpdates.startedAt,
          new Date(Date.now() - RUNTIME_UPDATE_RUN_ABANDON_MS).toISOString(),
        ),
      ),
    )
    .returning();
  for (const row of closed) {
    await auditDevice(
      tx,
      deps,
      device,
      "device.runtime_update_finished",
      { actorKind: "system", actorId: null, userId: null },
      runMetadata(row),
      "error",
    );
  }
  return closed.length;
}

/** PD-04: this device's "Update now" requests the device never answered within the hour become `expired`. */
async function expireRequests(tx: Tx, deviceId: string, runtime?: RuntimeUpdateTarget): Promise<void> {
  await tx
    .update(deviceRuntimeUpdates)
    .set({ state: "expired", finishedAt: sql`now()` })
    .where(
      and(
        eq(deviceRuntimeUpdates.deviceId, deviceId),
        ...(runtime ? [eq(deviceRuntimeUpdates.runtime, runtime)] : []),
        eq(deviceRuntimeUpdates.state, "requested"),
        lt(
          deviceRuntimeUpdates.requestedAt,
          new Date(Date.now() - RUNTIME_UPDATE_REQUEST_TTL_MS).toISOString(),
        ),
      ),
    );
}

/**
 * 07.17.1 (PD-14): the builds an `ocw-runtime` run frame reports, only those it carries (a frame without them never
 * erases the builds the request recorded); a CLI frame has none.
 */
function frameBuilds(frame: RuntimeUpdateRunFrame): { fromBuild?: string | null; toBuild?: string | null } {
  if (!isSelfRun(frame)) return {};
  return {
    ...(frame.fromBuild !== undefined ? { fromBuild: frame.fromBuild } : {}),
    ...(frame.toBuild !== undefined ? { toBuild: frame.toBuild } : {}),
  };
}

const byRunId = (device: DeviceRef, runId: string) =>
  and(eq(deviceRuntimeUpdates.deviceId, device.deviceId), eq(deviceRuntimeUpdates.runId, runId));

/** The `requested` row of this device's "Update now" command `commandId` for `runtime`, not adopted yet. */
const requestedBy = (device: DeviceRef, runtime: RuntimeUpdateTarget, commandId: string) =>
  and(
    eq(deviceRuntimeUpdates.deviceId, device.deviceId),
    eq(deviceRuntimeUpdates.commandId, commandId),
    eq(deviceRuntimeUpdates.runtime, runtime),
    eq(deviceRuntimeUpdates.state, "requested"),
    isNull(deviceRuntimeUpdates.runId),
  );

async function runStarted(
  tx: Tx,
  deps: MaintenanceDeps,
  device: DeviceRef,
  frame: RuntimeUpdateRunFrame,
): Promise<boolean> {
  const [known] = await tx
    .select({ id: deviceRuntimeUpdates.id })
    .from(deviceRuntimeUpdates)
    .where(byRunId(device, frame.runId));
  if (known) return false;
  const values = {
    runId: frame.runId,
    state: "started" as const,
    fromVersion: frame.fromVersion,
    toVersion: frame.toVersion,
    candidate: frame.candidate,
    method: frame.method,
    ...frameBuilds(frame),
    startedAt: frame.at,
  };
  let row: RunRow | undefined;
  // "Update now": the device's run adopts the requested row (its requester stays the actor).
  if (frame.commandId) {
    [row] = await tx
      .update(deviceRuntimeUpdates)
      .set(values)
      .where(requestedBy(device, frame.runtime, frame.commandId))
      .returning();
  }
  if (!row) {
    [row] = await tx
      .insert(deviceRuntimeUpdates)
      .values({
        organizationId: device.organizationId,
        deviceId: device.deviceId,
        runtime: frame.runtime,
        commandId: frame.commandId ?? null,
        trigger: frame.trigger,
        ...values,
      })
      .onConflictDoNothing({
        target: [
          deviceRuntimeUpdates.organizationId,
          deviceRuntimeUpdates.deviceId,
          deviceRuntimeUpdates.runId,
        ],
      })
      .returning();
  }
  if (!row) return false;
  // 07.11 review LO-04: the device declares the trigger. An automatic run while the org is not at `automatic` is a
  // daemon installing against policy (buggy or old): never audited as a legitimate system action.
  const level = row.trigger === "automatic" && deps.runtimePolicy ? await deps.runtimePolicy(tx) : null;
  if (level !== null && level !== "automatic") {
    await auditDevice(
      tx,
      deps,
      device,
      "device.runtime_update_started",
      runActor(row, device),
      { ...runMetadata(row), policyViolation: true, orgLevel: level },
      "error",
    );
    return true;
  }
  await auditRun(tx, deps, device, row, "device.runtime_update_started");
  return true;
}

async function runFinished(
  tx: Tx,
  deps: MaintenanceDeps,
  device: DeviceRef,
  frame: RuntimeUpdateRunFrame,
): Promise<boolean> {
  const outcome = frame.outcome!;
  const finished = {
    state: outcome,
    fromVersion: frame.fromVersion,
    toVersion: frame.toVersion,
    candidate: frame.candidate,
    method: frame.method,
    ...frameBuilds(frame),
    output: frame.output === undefined ? null : scrubHostPaths(frame.output).slice(0, 4096),
    error: null,
    finishedAt: frame.at,
  };
  // A run closed as interrupted (ME-04) still takes the device's real outcome when its frame arrives late.
  const [closed] = await tx
    .update(deviceRuntimeUpdates)
    .set(finished)
    .where(
      and(
        byRunId(device, frame.runId),
        or(
          eq(deviceRuntimeUpdates.state, "started"),
          and(eq(deviceRuntimeUpdates.state, "failed"), eq(deviceRuntimeUpdates.error, RUN_INTERRUPTED)),
        ),
      ),
    )
    .returning();
  if (closed) {
    await auditRun(tx, deps, device, closed, "device.runtime_update_finished");
    return true;
  }
  // Already finished: a replay from the device's offline log.
  const [known] = await tx
    .select({ id: deviceRuntimeUpdates.id })
    .from(deviceRuntimeUpdates)
    .where(byRunId(device, frame.runId));
  if (known) return false;

  // Finished without a started row: a broken candidate skipped before anything ran, or a lost `started`.
  let row: RunRow | undefined;
  if (frame.commandId) {
    [row] = await tx
      .update(deviceRuntimeUpdates)
      .set({ runId: frame.runId, ...finished })
      .where(requestedBy(device, frame.runtime, frame.commandId))
      .returning();
  }
  if (!row && outcome === "skipped_broken") {
    // Once per candidate: the device reports the same skip at every check.
    const [latest] = await tx
      .select({ state: deviceRuntimeUpdates.state, candidate: deviceRuntimeUpdates.candidate })
      .from(deviceRuntimeUpdates)
      .where(
        and(
          eq(deviceRuntimeUpdates.deviceId, device.deviceId),
          eq(deviceRuntimeUpdates.runtime, frame.runtime),
        ),
      )
      .orderBy(desc(deviceRuntimeUpdates.createdAt), desc(deviceRuntimeUpdates.id))
      .limit(1);
    if (latest?.state === "skipped_broken" && latest.candidate === frame.candidate) return false;
  }
  if (!row) {
    [row] = await tx
      .insert(deviceRuntimeUpdates)
      .values({
        organizationId: device.organizationId,
        deviceId: device.deviceId,
        runtime: frame.runtime,
        runId: frame.runId,
        commandId: frame.commandId ?? null,
        trigger: frame.trigger,
        ...finished,
      })
      .onConflictDoNothing({
        target: [
          deviceRuntimeUpdates.organizationId,
          deviceRuntimeUpdates.deviceId,
          deviceRuntimeUpdates.runId,
        ],
      })
      .returning();
  }
  if (!row) return false;
  if (outcome === "skipped_broken") {
    await auditDevice(
      tx,
      deps,
      device,
      "device.runtime_update_skipped",
      { actorKind: "system", actorId: null, userId: null },
      runMetadata(row),
    );
  } else {
    await auditRun(tx, deps, device, row, "device.runtime_update_finished");
  }
  return true;
}

/**
 * `runtime.update.run` (PD-04, PD-06): `started` adopts the "Update now" row it answers or inserts its own; `finished`
 * closes it with the outcome and the (scrubbed, bounded) output. Idempotent by the device's run id: a replay inserts
 * nothing and audits nothing.
 */
export async function onRuntimeUpdateRun(
  tx: Tx,
  deps: MaintenanceDeps,
  device: DeviceRef,
  frame: RuntimeUpdateRunFrame,
): Promise<void> {
  const locked = await lockDevice(tx, device);
  if (!locked) return;
  const changed =
    frame.phase === "started"
      ? await runStarted(tx, deps, device, frame)
      : await runFinished(tx, deps, device, frame);
  if (changed) await pingOrg(tx, deps, device, locked.status);
}

/**
 * The device's ack of a `runtime.update` command (PD-08): accepted → the run frames follow; refused (updates off on
 * the device, already up to date, …) → the requested row becomes `refused` with the scrubbed reason, audited as a
 * finished run with `result: "error"`.
 */
export async function onRuntimeUpdateAck(
  tx: Tx,
  deps: MaintenanceDeps,
  device: DeviceRef,
  command: CommandRow,
  ok: boolean,
  error: string | null,
): Promise<void> {
  if (ok) return;
  // The device row first, as every other maintenance write does (one lock order, no deadlock with the run frames).
  const locked = await lockDevice(tx, device);
  if (!locked) return;
  const [row] = await tx
    .update(deviceRuntimeUpdates)
    .set({
      state: "refused",
      error: scrubHostPaths(error ?? "refused by the device").slice(0, 500),
      finishedAt: sql`now()`,
    })
    .where(
      and(
        eq(deviceRuntimeUpdates.deviceId, device.deviceId),
        eq(deviceRuntimeUpdates.commandId, command.id),
        eq(deviceRuntimeUpdates.state, "requested"),
      ),
    )
    .returning();
  if (!row) return;
  await auditRun(tx, deps, device, row, "device.runtime_update_finished");
  await pingOrg(tx, deps, device, locked.status);
}

// ---------------------------------------------------------------- routes (owner and admins: device.maintain)

function pgError(err: unknown): { code?: string; constraint?: string } {
  const e = err as { code?: string; constraint?: string; cause?: { code?: string; constraint?: string } };
  return e?.cause?.code ? e.cause : (e ?? {});
}

const updatePending = (runtime: RuntimeUpdateTarget) =>
  conflict(
    runtime === OCW_RUNTIME_TARGET
      ? "An update of the OCW runtime is already waiting for the device"
      : "An update of this CLI is already waiting for the device",
    "update_pending",
  );

/** 07.17.1 (PD-13): an OCW runtime update the API refuses, with the contracts' sentence. */
const selfRefusal = (code: RuntimeSelfUpdateRefusal) =>
  conflict(RUNTIME_SELF_UPDATE_REFUSAL_SENTENCES[code], code);

function manualUpdateMessage(runtime: RuntimeId, status: RuntimeMaintenanceStatus): string {
  const how = status.updateCommand
    ? ` Run \`${status.updateCommand}\` on the device.`
    : " Update it on the device.";
  return status.reason === "needs_admin"
    ? `${RUNTIME_UPDATE_TARGET_LABEL[runtime]} on this device needs administrator rights to update.${how}`
    : `${RUNTIME_UPDATE_TARGET_LABEL[runtime]} on this device was installed in a way OCW can't update.${how}`;
}

/**
 * `GET /devices/:id/runtime-updates` (the last 50, newest first, optionally one runtime) and `POST
 * /devices/:id/runtimes/:runtime/update` ("Update now"). Both are decided by the resolver on `device.maintain` (the
 * device owner or an admin, D-11); a device the caller cannot see, or a revoked one, is 404.
 */
export function registerDeviceMaintenanceRoutes(
  app: App,
  core: Core,
  hub: DeviceHub,
  perms: PermissionService,
): void {
  const user = { config: { authz: "user" as const }, preHandler: core.identity.requireUser };
  const tags = ["device"];

  /** The device, when the caller holds `device.maintain` on it; `lock` serializes "Update now" per device. */
  async function maintainable(req: Parameters<typeof authOf>[0], tx: Tx, deviceId: string, lock: boolean) {
    const userId = authOf(req).userId;
    const query = tx.select().from(devices).where(eq(devices.id, deviceId));
    const [row] = lock ? await query.for("update") : await query;
    if (!row || row.revokedAt) throw notFound("Device not found");
    await perms.assertCan(
      req,
      tx,
      "device.maintain",
      deviceFacts(row, userId, await loadDeviceAccess(tx, userId)),
    );
    return row;
  }

  app.get(
    "/devices/:id/runtime-updates",
    {
      ...user,
      schema: {
        tags,
        params: IdParams,
        querystring: RuntimeUpdateHistoryQuery,
        response: { 200: RuntimeUpdateRunList },
      },
    },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        const row = await maintainable(req, tx, req.params.id, false);
        // ME-04: a request the device never answered reads as expired, not as "Updating…" for ever.
        await expireRequests(tx, row.id);
        // 07.17.1 PD-14: an OCW runtime update that never reported back (the device is gone, or back and idle) reads
        // as failed, not as "Updating…" for ever; one still waiting for its sessions keeps its row open.
        const self = storedMaintenance(row.runtimeMaintenance)?.self;
        if (row.status !== "online" || selfIdle(self)) {
          const device = {
            deviceId: row.id,
            organizationId: row.organizationId,
            ownerUserId: row.ownerUserId,
          };
          const deps = { audit: core.audit, realtime: core.realtime };
          if (await closeAbandonedRuns(tx, deps, device, { cli: false, self: true })) {
            await pingOrg(tx, deps, device, row.status);
          }
        }
        const runtime = req.query.runtime;
        const rows = await tx
          .select()
          .from(deviceRuntimeUpdates)
          .where(
            and(
              eq(deviceRuntimeUpdates.deviceId, row.id),
              ...(runtime ? [eq(deviceRuntimeUpdates.runtime, runtime)] : []),
            ),
          )
          .orderBy(desc(deviceRuntimeUpdates.createdAt), desc(deviceRuntimeUpdates.id))
          .limit(50);
        const names = await memberDirectory(tx);
        return { runs: rows.map((r) => toRuntimeUpdateRun(r, names)) };
      }),
  );

  app.post(
    "/devices/:id/runtimes/:runtime/update",
    {
      ...user,
      schema: { tags, params: RuntimeUpdateParams, response: { 200: RequestRuntimeUpdateResponse } },
    },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        const auth = authOf(req);
        const runtime = req.params.runtime;
        const row = await maintainable(req, tx, req.params.id, true);
        if (row.status !== "online") {
          throw conflict("This device is offline. Update it once it is connected", "device_offline");
        }
        const stored = storedMaintenance(row.runtimeMaintenance);
        /** The `requested` row's own columns and the request's audit metadata, per target. */
        let request: { values: Partial<RunRow>; metadata: Record<string, unknown> };
        if (runtime === OCW_RUNTIME_TARGET) {
          // 07.17.1 PD-13, in order. The org level is not checked: `off` stops automatic checks only (D-09).
          if (row.hostKind !== "service") throw selfRefusal("not_a_service");
          const self = stored?.self;
          if (!self) throw selfRefusal("self_update_unsupported");
          if (self.reason) throw selfRefusal(self.reason);
          const served = await hub.servedRuntime();
          if (!served) throw selfRefusal("runtime_not_served");
          if (served.build === self.build) throw selfRefusal("already_current");
          request = {
            values: {
              fromVersion: self.version,
              toVersion: served.version,
              candidate: served.version,
              fromBuild: self.build,
              toBuild: served.build,
            },
            metadata: {
              runtime,
              from: self.version,
              to: served.version,
              fromBuild: self.build,
              toBuild: served.build,
            },
          };
        } else {
          if ((await hub.runtimePolicy(tx)) === "off") {
            throw conflict("Runtime updates are off for this organization", "runtime_updates_off");
          }
          const status = stored?.runtimes.find((s) => s.runtime === runtime);
          if (
            status &&
            !status.canUpdate &&
            (status.reason === "manual" || status.reason === "needs_admin")
          ) {
            throw conflict(manualUpdateMessage(runtime, status), "manual_update");
          }
          request = { values: {}, metadata: { runtime } };
        }
        const mine = and(
          eq(deviceRuntimeUpdates.deviceId, row.id),
          eq(deviceRuntimeUpdates.runtime, runtime),
          eq(deviceRuntimeUpdates.state, "requested"),
        );
        // PD-04: a request the device never answered within the hour no longer blocks a new one.
        await expireRequests(tx, row.id, runtime);
        const [waiting] = await tx
          .select({ id: deviceRuntimeUpdates.id })
          .from(deviceRuntimeUpdates)
          .where(mine)
          .limit(1);
        if (waiting) throw updatePending(runtime);

        // D-05, P1: the command names the target and nothing else; the device picks the method and the version (the
        // OCW runtime: from its own paired server).
        const payload: RuntimeUpdatePayload = { runtime };
        const commandId = await hub.enqueue(tx, {
          deviceId: row.id,
          workSessionId: null,
          kind: "runtime.update",
          payload,
        });
        let run: RunRow | undefined;
        try {
          [run] = await tx
            .insert(deviceRuntimeUpdates)
            .values({
              organizationId: auth.organizationId,
              deviceId: row.id,
              runtime,
              commandId,
              trigger: "manual",
              requestedBy: auth.userId,
              state: "requested",
              requestedAt: sql`now()`,
              ...request.values,
            })
            .returning();
        } catch (err) {
          // The device row lock serializes requests; the partial unique index is the backstop (T-07.11-06-06).
          if (pgError(err).constraint === REQUESTED_UQ) throw updatePending(runtime);
          throw err;
        }
        await core.audit.record(tx, {
          action: "device.runtime_update_requested",
          resourceType: "device",
          resourceId: row.id,
          deviceId: row.id,
          metadata: request.metadata,
        });
        return { run: toRuntimeUpdateRun(run!, await memberDirectory(tx)) };
      }),
  );
}
