import {
  type DiffResultFrame,
  DiffStat,
  EffectiveSessionSettings,
  type EventFrame,
  EventTypes,
  type HelloFrame,
  isFullAccessReport,
  onlyRelativePaths,
  type SessionEvent,
  type WorkApproval,
  type WorkPrompt,
  type WorkSession,
  type WorkSessionChanges,
  type WorkSessionStatus,
} from "@ocw/contracts";
import {
  deviceCommands,
  devices,
  projects,
  type TenantDb,
  type Tx,
  tenantOf,
  workApprovals,
  workPrompts,
  workSessions,
} from "@ocw/db";
import { and, asc, count, desc, eq, inArray, min, type SQL, sql } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { AuditService } from "../audit";
import type { DeviceCommandRow, DeviceHub, DeviceRef, DeviceSessionHandler } from "../device";
import { memberDirectory } from "../organization";
import type { RealtimeService } from "../realtime";
import { requestedSettings } from "./controls";

export type SessionRow = typeof workSessions.$inferSelect;
type PromptRow = typeof workPrompts.$inferSelect;
type ApprovalRow = typeof workApprovals.$inferSelect;

/** States in which the session is attached (or attaching) to a runtime on its device. */
export const ACTIVE_STATES: WorkSessionStatus[] = [
  "provisioning",
  "idle",
  "running",
  "waiting_approval",
  "host_offline",
];
const TERMINAL_RESTARTABLE: WorkSessionStatus[] = ["failed", "completed"];
const IN_FLIGHT: PromptRow["status"][] = ["dispatched", "running"];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const wsTopic = (sessionId: string) => `ws:${sessionId}`;
const iso = (v: string | null) => (v ? new Date(v).toISOString() : null);

export interface WorkSessionDeps {
  db: TenantDb;
  realtime: RealtimeService;
  audit: AuditService;
  hub: DeviceHub;
  log: FastifyBaseLogger;
}

/**
 * Work session domain: DTOs, the shared prompt queue ARBITER (one execution authority: a prompt is
 * dispatched only when the previous one completed) and ingestion of device events. Every state change locks
 * the session row (`SELECT … FOR UPDATE`) first, so the arbiter, REST mutations and device events serialize.
 */
export class WorkSessionService implements DeviceSessionHandler {
  constructor(private readonly deps: WorkSessionDeps) {}

  // ------------------------------------------------------------------ DTOs

  async sessions(tx: Tx, filter?: SQL): Promise<WorkSession[]> {
    const rows = await tx
      .select({
        s: workSessions,
        projectName: projects.name,
        deviceName: devices.name,
        deviceStatus: devices.status,
        deviceRevoked: devices.revokedAt,
      })
      .from(workSessions)
      .innerJoin(projects, eq(projects.id, workSessions.projectId))
      .innerJoin(devices, eq(devices.id, workSessions.deviceId))
      .where(filter)
      .orderBy(desc(workSessions.updatedAt));
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.s.id);
    const [queued, pending, running, dir] = await Promise.all([
      tx
        .select({ id: workPrompts.workSessionId, n: count() })
        .from(workPrompts)
        .where(and(inArray(workPrompts.workSessionId, ids), eq(workPrompts.status, "queued")))
        .groupBy(workPrompts.workSessionId),
      tx
        .select({ id: workApprovals.workSessionId, n: count() })
        .from(workApprovals)
        .where(and(inArray(workApprovals.workSessionId, ids), eq(workApprovals.status, "pending")))
        .groupBy(workApprovals.workSessionId),
      tx
        .select({ id: workPrompts.workSessionId, since: min(workPrompts.dispatchedAt) })
        .from(workPrompts)
        .where(and(inArray(workPrompts.workSessionId, ids), inArray(workPrompts.status, IN_FLIGHT)))
        .groupBy(workPrompts.workSessionId),
      memberDirectory(tx),
    ]);
    const q = new Map(queued.map((r) => [r.id, Number(r.n)]));
    const p = new Map(pending.map((r) => [r.id, Number(r.n)]));
    const since = new Map(running.map((r) => [r.id, r.since]));
    return rows.map(({ s, projectName, deviceName, deviceStatus, deviceRevoked }) => {
      const effective = EffectiveSessionSettings.safeParse(s.effectiveSettings);
      const diffStat = DiffStat.safeParse(s.diffStat);
      return {
        id: s.id,
        conversationId: s.conversationId,
        projectId: s.projectId,
        projectName,
        deviceId: s.deviceId,
        deviceName,
        deviceOnline: deviceStatus === "online" && !deviceRevoked,
        runtime: s.runtime,
        model: s.model,
        permissionMode: s.permissionMode,
        worktree: s.worktree,
        branch: s.branch,
        status: s.status,
        title: s.title,
        createdBy: s.createdBy,
        createdByName: dir.get(s.createdBy)?.displayName ?? null,
        queuedCount: q.get(s.id) ?? 0,
        pendingApprovals: p.get(s.id) ?? 0,
        lastError: s.lastError,
        settings: {
          requested: requestedSettings(s),
          effective: effective.success ? effective.data : null,
          pending: s.settingsPending,
        },
        fullAccess:
          s.permissionMode === "fullAccess" ||
          (effective.success && isFullAccessReport(effective.data.permissionMode)),
        runningSince: iso(since.get(s.id) ?? null),
        diffStat: diffStat.success ? diffStat.data : null,
        createdAt: new Date(s.createdAt).toISOString(),
        updatedAt: new Date(s.updatedAt).toISOString(),
      };
    });
  }

  async session(tx: Tx, id: string): Promise<WorkSession | null> {
    return (await this.sessions(tx, eq(workSessions.id, id)))[0] ?? null;
  }

  async prompts(tx: Tx, sessionId: string): Promise<WorkPrompt[]> {
    const [rows, dir] = await Promise.all([
      tx
        .select()
        .from(workPrompts)
        .where(eq(workPrompts.workSessionId, sessionId))
        .orderBy(asc(workPrompts.position), asc(workPrompts.createdAt)),
      memberDirectory(tx),
    ]);
    return rows.map((r) => toPrompt(r, dir.get(r.authorUserId)?.displayName ?? null));
  }

  async approvals(tx: Tx, sessionId: string): Promise<WorkApproval[]> {
    const [rows, dir] = await Promise.all([
      tx
        .select()
        .from(workApprovals)
        .where(eq(workApprovals.workSessionId, sessionId))
        .orderBy(asc(workApprovals.createdAt)),
      memberDirectory(tx),
    ]);
    return rows.map((r) => toApproval(r, r.decidedBy ? (dir.get(r.decidedBy)?.displayName ?? null) : null));
  }

  // ------------------------------------------------------------------ realtime emitters

  /** Broadcast the session snapshot on its own stream and on the org stream (session lists). */
  async emitSession(tx: Tx, sessionId: string): Promise<WorkSession | null> {
    const dto = await this.session(tx, sessionId);
    if (!dto) return null;
    await this.deps.realtime.appendEvent(tx, wsTopic(sessionId), EventTypes.workSessionUpdated, dto);
    await this.deps.realtime.appendEvent(
      tx,
      `org:${tenantOf(tx).organizationId}`,
      EventTypes.workSessionUpdated,
      dto,
    );
    return dto;
  }

  async emitPrompt(tx: Tx, row: PromptRow): Promise<void> {
    const dir = await memberDirectory(tx);
    await this.deps.realtime.appendEvent(
      tx,
      wsTopic(row.workSessionId),
      EventTypes.promptUpdated,
      toPrompt(row, dir.get(row.authorUserId)?.displayName ?? null),
    );
  }

  async emitApproval(tx: Tx, row: ApprovalRow): Promise<void> {
    const dir = row.decidedBy ? await memberDirectory(tx) : null;
    await this.deps.realtime.appendEvent(
      tx,
      wsTopic(row.workSessionId),
      EventTypes.approvalUpdated,
      toApproval(row, row.decidedBy ? (dir?.get(row.decidedBy)?.displayName ?? null) : null),
    );
  }

  // ------------------------------------------------------------------ state machine helpers

  async lock(tx: Tx, sessionId: string): Promise<SessionRow | null> {
    const [row] = await tx.select().from(workSessions).where(eq(workSessions.id, sessionId)).for("update");
    return row ?? null;
  }

  async setStatus(
    tx: Tx,
    s: SessionRow,
    status: WorkSessionStatus,
    extra: Partial<Pick<SessionRow, "lastError">> = {},
  ): Promise<void> {
    await tx
      .update(workSessions)
      .set({ status, updatedAt: sql`now()`, ...extra })
      .where(eq(workSessions.id, s.id));
    s.status = status;
    await this.emitSession(tx, s.id);
  }

  /** `session.start` payload for this session (resume when the runtime already has a session id). */
  async startPayload(tx: Tx, s: SessionRow): Promise<Record<string, unknown>> {
    const [p] = await tx
      .select({ localId: projects.localId })
      .from(projects)
      .where(eq(projects.id, s.projectId));
    const requested = requestedSettings(s);
    return {
      projectLocalId: p?.localId ?? "",
      runtime: s.runtime,
      permissionMode: s.permissionMode,
      ...(s.model ? { model: s.model } : {}),
      ...(requested.effort ? { effort: requested.effort } : {}),
      ...(requested.fastMode ? { fastMode: true } : {}),
      ...(requested.contextWindow ? { contextWindow: requested.contextWindow } : {}),
      ...(s.worktree ? { worktree: true } : {}),
      ...(s.runtimeSessionId ? { resumeRuntimeSessionId: s.runtimeSessionId } : {}),
    };
  }

  /** (Re)attach the session to a runtime on its device. */
  async restart(tx: Tx, s: SessionRow): Promise<void> {
    await this.deps.hub.enqueue(tx, {
      deviceId: s.deviceId,
      workSessionId: s.id,
      kind: "session.start",
      payload: await this.startPayload(tx, s),
    });
    await this.setStatus(tx, s, "provisioning", { lastError: null });
  }

  /**
   * The arbiter. Call with the session row LOCKED. Dispatches the next queued prompt only when the session is
   * idle and nothing is in flight, so prompts from many users execute strictly one at a time, in queue order.
   */
  async tryDispatch(tx: Tx, s: SessionRow): Promise<PromptRow | null> {
    if (s.status !== "idle") return null;
    const inflight = await tx
      .select({ id: workPrompts.id })
      .from(workPrompts)
      .where(and(eq(workPrompts.workSessionId, s.id), inArray(workPrompts.status, IN_FLIGHT)))
      .limit(1);
    if (inflight.length > 0) return null;
    const [next] = await tx
      .select()
      .from(workPrompts)
      .where(and(eq(workPrompts.workSessionId, s.id), eq(workPrompts.status, "queued")))
      .orderBy(asc(workPrompts.position), asc(workPrompts.createdAt))
      .limit(1);
    if (!next) return null;
    // P-07: the turn's authorized mode (Plan 04 caps it by the prompt author's grain on the device).
    const mode = s.permissionMode;
    const [dispatched] = await tx
      .update(workPrompts)
      .set({ status: "dispatched", dispatchedAt: sql`now()`, permissionMode: mode })
      .where(eq(workPrompts.id, next.id))
      .returning();
    await this.deps.hub.enqueue(tx, {
      deviceId: s.deviceId,
      workSessionId: s.id,
      kind: "prompt",
      payload: { promptId: next.id, text: next.body, permissionMode: mode },
    });
    await this.emitPrompt(tx, dispatched!);
    await this.setStatus(tx, s, "running");
    return dispatched!;
  }

  private async failInFlight(tx: Tx, s: SessionRow, reason: string): Promise<void> {
    const failed = await tx
      .update(workPrompts)
      .set({ status: "failed", completedAt: sql`now()` })
      .where(and(eq(workPrompts.workSessionId, s.id), inArray(workPrompts.status, IN_FLIGHT)))
      .returning();
    for (const p of failed) await this.emitPrompt(tx, p);
    const expired = await tx
      .update(workApprovals)
      .set({ status: "expired", decision: "expired", decidedAt: sql`now()`, comment: reason })
      .where(and(eq(workApprovals.workSessionId, s.id), eq(workApprovals.status, "pending")))
      .returning();
    for (const a of expired) await this.emitApproval(tx, a);
  }

  private async hasPendingApprovals(tx: Tx, sessionId: string): Promise<boolean> {
    const rows = await tx
      .select({ id: workApprovals.id })
      .from(workApprovals)
      .where(and(eq(workApprovals.workSessionId, sessionId), eq(workApprovals.status, "pending")))
      .limit(1);
    return rows.length > 0;
  }

  private async hasInFlight(tx: Tx, sessionId: string): Promise<boolean> {
    const rows = await tx
      .select({ id: workPrompts.id })
      .from(workPrompts)
      .where(and(eq(workPrompts.workSessionId, sessionId), inArray(workPrompts.status, IN_FLIGHT)))
      .limit(1);
    return rows.length > 0;
  }

  private sys(device: DeviceRef) {
    return { organizationId: device.organizationId, userId: null };
  }

  // ------------------------------------------------------------------ DeviceSessionHandler

  async onHello(device: DeviceRef, hello: HelloFrame): Promise<void> {
    const alive = hello.sessions ? new Set(hello.sessions) : null;
    await this.deps.db.withTenant(this.sys(device), async (tx) => {
      const rows = await tx
        .select({ id: workSessions.id })
        .from(workSessions)
        .where(and(eq(workSessions.deviceId, device.deviceId), inArray(workSessions.status, ACTIVE_STATES)));
      for (const { id } of rows) {
        const s = await this.lock(tx, id);
        if (!s) continue;
        if (alive === null || alive.has(s.id)) {
          if (s.status !== "host_offline") continue;
          if (await this.hasPendingApprovals(tx, s.id)) await this.setStatus(tx, s, "waiting_approval");
          else if (await this.hasInFlight(tx, s.id)) await this.setStatus(tx, s, "running");
          else {
            await this.setStatus(tx, s, "idle");
            await this.tryDispatch(tx, s);
          }
          continue;
        }
        // The device does not have this session (daemon restarted). A start already queued will attach it.
        const startQueued = await tx
          .select({ id: deviceCommands.id })
          .from(deviceCommands)
          .where(
            and(
              eq(deviceCommands.workSessionId, s.id),
              eq(deviceCommands.kind, "session.start"),
              inArray(deviceCommands.status, ["pending", "sent"]),
            ),
          )
          .limit(1);
        if (startQueued.length > 0) {
          if (s.status === "host_offline") await this.setStatus(tx, s, "provisioning");
          continue;
        }
        await this.failInFlight(tx, s, "The device restarted");
        await this.restart(tx, s);
      }
    });
  }

  async onOffline(device: DeviceRef): Promise<void> {
    await this.deps.db.withTenant(this.sys(device), async (tx) => {
      const [d] = await tx
        .select({ revokedAt: devices.revokedAt })
        .from(devices)
        .where(eq(devices.id, device.deviceId));
      const revoked = !d || d.revokedAt !== null;
      const rows = await tx
        .select({ id: workSessions.id })
        .from(workSessions)
        .where(and(eq(workSessions.deviceId, device.deviceId), inArray(workSessions.status, ACTIVE_STATES)));
      for (const { id } of rows) {
        const s = await this.lock(tx, id);
        if (!s) continue;
        if (revoked) {
          await this.failInFlight(tx, s, "The device was revoked");
          await this.setStatus(tx, s, "failed", { lastError: "The device was revoked" });
        } else if (s.status !== "host_offline") {
          await this.setStatus(tx, s, "host_offline");
        }
      }
    });
  }

  async onCommandResult(
    device: DeviceRef,
    cmd: DeviceCommandRow,
    ok: boolean,
    error: string | null,
  ): Promise<void> {
    if (!cmd.workSessionId) return;
    const sessionId = cmd.workSessionId;
    await this.deps.db.withTenant(this.sys(device), async (tx) => {
      const s = await this.lock(tx, sessionId);
      if (!s || s.deviceId !== device.deviceId) return;
      if (cmd.kind === "session.start") {
        if (!ok) {
          await this.failInFlight(tx, s, "The session could not start");
          await this.setStatus(tx, s, "failed", { lastError: error ?? "The session could not start" });
        } else if (s.status === "provisioning" || s.status === "host_offline") {
          await this.setStatus(tx, s, "idle");
          await this.tryDispatch(tx, s);
        }
        return;
      }
      if (cmd.kind === "session.configure" && !ok) {
        // A session the daemon no longer runs gets its settings from the next session.start instead.
        const lost = /not active/i.test(error ?? "");
        await tx
          .update(workSessions)
          .set({
            settingsPending: false,
            updatedAt: sql`now()`,
            ...(lost
              ? {}
              : { lastError: (error ?? "The device could not apply the settings").slice(0, 2000) }),
          })
          .where(eq(workSessions.id, s.id));
        if (!lost) {
          await this.deps.audit.record(tx, {
            action: "work_session.settings_failed",
            resourceType: "work_session",
            resourceId: s.id,
            actorKind: "device",
            actorId: device.deviceId,
            deviceId: device.deviceId,
            sessionId: s.id,
            userId: null,
            result: "error",
            metadata: { settings: cmd.payload.settings ?? null, error: error ?? null },
          });
        }
        await this.emitSession(tx, s.id);
        return;
      }
      if (cmd.kind === "prompt" && !ok) {
        const promptId = String((cmd.payload as { promptId?: unknown }).promptId ?? "");
        if (!UUID_RE.test(promptId)) return;
        if (/not active/i.test(error ?? "") && s.status !== "archived") {
          // Daemon restarted and lost the runtime: put the prompt back at the head and re-attach.
          const [p] = await tx
            .update(workPrompts)
            .set({ status: "queued", dispatchedAt: null })
            .where(and(eq(workPrompts.id, promptId), inArray(workPrompts.status, IN_FLIGHT)))
            .returning();
          if (p) await this.emitPrompt(tx, p);
          await this.restart(tx, s);
          return;
        }
        const [p] = await tx
          .update(workPrompts)
          .set({ status: "failed", completedAt: sql`now()` })
          .where(and(eq(workPrompts.id, promptId), inArray(workPrompts.status, IN_FLIGHT)))
          .returning();
        if (p) await this.emitPrompt(tx, p);
        if (s.status === "running") {
          await this.setStatus(tx, s, "idle", { lastError: error });
          await this.tryDispatch(tx, s);
        }
      }
    });
  }

  async onDiffResult(device: DeviceRef, workSessionId: string, frame: DiffResultFrame): Promise<void> {
    await this.deps.db.withTenant(this.sys(device), async (tx) => {
      const [s] = await tx.select().from(workSessions).where(eq(workSessions.id, workSessionId));
      if (!s || s.deviceId !== device.deviceId) return;
      const branch = frame.branch ?? null;
      if (branch !== s.branch) {
        await tx.update(workSessions).set({ branch }).where(eq(workSessions.id, s.id));
        await this.emitSession(tx, s.id);
      }
      const changes: WorkSessionChanges = {
        files: frame.files.filter((f) => onlyRelativePaths([f.path]).length === 1),
        branch,
        headSha: frame.headSha ?? null,
        truncated: frame.truncated ?? false,
        at: new Date().toISOString(),
      };
      await this.deps.realtime.appendEvent(tx, wsTopic(s.id), EventTypes.workSessionChanges, changes);
    });
  }

  async onEvent(device: DeviceRef, frame: EventFrame): Promise<void> {
    const ev = frame.event;
    if (ev.type === "assistant.delta") {
      // Ephemeral: never persisted. The device link is per-device, so only this device's sessions reach here,
      // but check ownership cheaply before fan-out.
      const owned = await this.deps.db.withTenant(this.sys(device), (tx) =>
        tx
          .select({ id: workSessions.id })
          .from(workSessions)
          .where(and(eq(workSessions.id, frame.sessionId), eq(workSessions.deviceId, device.deviceId))),
      );
      if (owned.length > 0) {
        await this.deps.realtime.publishEphemeral(wsTopic(frame.sessionId), "assistant.delta", {
          messageId: ev.messageId,
          text: ev.text,
        });
      }
      return;
    }
    await this.deps.db.withTenant(this.sys(device), async (tx) => {
      const s = await this.lock(tx, frame.sessionId);
      if (!s || s.deviceId !== device.deviceId) return;
      if (frame.localSeq !== undefined) {
        // Offline-log replay de-duplication.
        if (frame.localSeq <= s.lastLocalSeq) return;
        await tx.update(workSessions).set({ lastLocalSeq: frame.localSeq }).where(eq(workSessions.id, s.id));
        s.lastLocalSeq = frame.localSeq;
      }
      const event = normalizeEvent(ev);
      await this.deps.realtime.appendEvent(tx, wsTopic(s.id), EventTypes.workSessionEvent, {
        at: new Date().toISOString(),
        event,
      });
      await this.apply(tx, device, s, event);
    });
  }

  private async apply(tx: Tx, device: DeviceRef, s: SessionRow, ev: SessionEvent): Promise<void> {
    switch (ev.type) {
      case "session.started": {
        if (ev.runtimeSessionId && ev.runtimeSessionId !== s.runtimeSessionId) {
          await tx
            .update(workSessions)
            .set({ runtimeSessionId: ev.runtimeSessionId })
            .where(eq(workSessions.id, s.id));
          s.runtimeSessionId = ev.runtimeSessionId;
        }
        // A (re)start reports the model and mode it really runs: seed or refresh the effective settings.
        if (ev.model !== undefined || ev.permissionMode !== undefined || s.effectiveSettings === null) {
          await this.storeEffective(tx, s, {
            ...(ev.model !== undefined ? { model: ev.model } : {}),
            ...(ev.permissionMode !== undefined ? { permissionMode: ev.permissionMode } : {}),
          });
        }
        return;
      }
      case "session.settings": {
        const { type: _type, ...reported } = ev;
        await this.storeEffective(tx, s, reported, true);
        return;
      }
      case "session.state":
        return this.applyDeviceState(tx, s, ev.status);
      case "prompt.started": {
        if (!UUID_RE.test(ev.promptId)) return;
        const [p] = await tx
          .update(workPrompts)
          .set({ status: "running" })
          .where(
            and(
              eq(workPrompts.id, ev.promptId),
              eq(workPrompts.workSessionId, s.id),
              inArray(workPrompts.status, ["dispatched", "queued"]),
            ),
          )
          .returning();
        if (p) await this.emitPrompt(tx, p);
        if (s.status === "idle" || s.status === "provisioning") await this.setStatus(tx, s, "running");
        return;
      }
      case "prompt.completed": {
        if (!UUID_RE.test(ev.promptId)) return;
        const status = ev.interrupted ? "cancelled" : ev.isError ? "failed" : "completed";
        const [p] = await tx
          .update(workPrompts)
          .set({ status, completedAt: sql`now()` })
          .where(
            and(
              eq(workPrompts.id, ev.promptId),
              eq(workPrompts.workSessionId, s.id),
              inArray(workPrompts.status, IN_FLIGHT),
            ),
          )
          .returning();
        if (p) await this.emitPrompt(tx, p);
        if (s.status === "running" || s.status === "waiting_approval") {
          await this.setStatus(tx, s, "idle");
          await this.tryDispatch(tx, s);
        }
        // Refresh the Changes panel after every turn.
        await this.deps.hub.enqueue(tx, {
          deviceId: s.deviceId,
          workSessionId: s.id,
          kind: "diff.request",
          payload: {},
        });
        return;
      }
      case "approval.requested": {
        const [row] = await tx
          .insert(workApprovals)
          .values({
            id: ev.approvalId,
            organizationId: device.organizationId,
            workSessionId: s.id,
            request: { tool: ev.tool, summary: ev.summary, paths: ev.paths },
          })
          .onConflictDoNothing()
          .returning();
        if (!row) return;
        await this.deps.audit.record(tx, {
          action: "work_approval.requested",
          resourceType: "work_approval",
          resourceId: row.id,
          actorKind: "device",
          actorId: device.deviceId,
          deviceId: device.deviceId,
          sessionId: s.id,
          metadata: { tool: ev.tool, paths: ev.paths },
        });
        await this.emitApproval(tx, row);
        if (s.status !== "waiting_approval") await this.setStatus(tx, s, "waiting_approval");
        else await this.emitSession(tx, s.id);
        return;
      }
      case "approval.resolved": {
        // Decided on the device (timeout → expired, interrupt → deny): close it if still pending.
        const status = ev.decision === "expired" ? "expired" : ev.decision === "deny" ? "denied" : "approved";
        const [row] = await tx
          .update(workApprovals)
          .set({ status, decision: ev.decision, decidedAt: sql`now()` })
          .where(
            and(
              eq(workApprovals.id, ev.approvalId),
              eq(workApprovals.workSessionId, s.id),
              eq(workApprovals.status, "pending"),
            ),
          )
          .returning();
        if (row) await this.emitApproval(tx, row);
        if (s.status === "waiting_approval" && !(await this.hasPendingApprovals(tx, s.id))) {
          await this.setStatus(tx, s, (await this.hasInFlight(tx, s.id)) ? "running" : "idle");
        } else if (row) {
          await this.emitSession(tx, s.id);
        }
        return;
      }
      case "session.error":
        await this.setStatus(tx, s, s.status, { lastError: ev.message.slice(0, 2000) });
        return;
      default:
        return;
    }
  }

  /** Merge reported values into `effective_settings` (D-07); `settled` clears the pending flag. */
  private async storeEffective(
    tx: Tx,
    s: SessionRow,
    reported: Partial<Omit<EffectiveSessionSettings, "at">>,
    settled = false,
  ): Promise<void> {
    const prev = EffectiveSessionSettings.safeParse(s.effectiveSettings);
    const base: Omit<EffectiveSessionSettings, "at"> = prev.success
      ? prev.data
      : {
          model: null,
          effort: null,
          contextWindow: null,
          fastMode: null,
          fastModeState: null,
          fastModeReason: null,
          permissionMode: null,
          serviceTier: null,
        };
    const merged: EffectiveSessionSettings = { ...base, at: new Date().toISOString() };
    for (const [k, v] of Object.entries(reported)) {
      if (v !== undefined) (merged as Record<string, unknown>)[k] = v;
    }
    const parsed = EffectiveSessionSettings.safeParse(merged);
    if (!parsed.success) return;
    await tx
      .update(workSessions)
      .set({
        effectiveSettings: parsed.data,
        updatedAt: sql`now()`,
        ...(settled ? { settingsPending: false } : {}),
      })
      .where(eq(workSessions.id, s.id));
    s.effectiveSettings = parsed.data;
    if (settled) s.settingsPending = false;
    await this.emitSession(tx, s.id);
  }

  private async applyDeviceState(tx: Tx, s: SessionRow, status: WorkSessionStatus): Promise<void> {
    if (s.status === "archived") return;
    switch (status) {
      case "idle":
        if (s.status === "provisioning" || s.status === "host_offline") {
          await this.setStatus(tx, s, "idle");
          await this.tryDispatch(tx, s);
        } else if (
          (s.status === "running" || s.status === "waiting_approval") &&
          !(await this.hasInFlight(tx, s.id)) &&
          !(await this.hasPendingApprovals(tx, s.id))
        ) {
          await this.setStatus(tx, s, "idle");
          await this.tryDispatch(tx, s);
        }
        return;
      case "running":
        if (s.status === "waiting_approval" && (await this.hasPendingApprovals(tx, s.id))) return;
        if (s.status !== "running" && !TERMINAL_RESTARTABLE.includes(s.status))
          await this.setStatus(tx, s, "running");
        return;
      case "waiting_approval":
        if (s.status !== "waiting_approval") await this.setStatus(tx, s, "waiting_approval");
        return;
      case "failed":
      case "completed":
        await this.failInFlight(tx, s, status === "failed" ? "The session failed" : "The session ended");
        await this.setStatus(tx, s, status);
        return;
      default:
        return;
    }
  }
}

/** Server-side defence in depth: only repo-relative paths are stored and fanned out. */
export function normalizeEvent(ev: SessionEvent): SessionEvent {
  if (ev.type === "approval.requested") return { ...ev, paths: onlyRelativePaths(ev.paths) };
  return ev;
}

export function toPrompt(r: PromptRow, authorName: string | null): WorkPrompt {
  return {
    id: r.id,
    workSessionId: r.workSessionId,
    authorUserId: r.authorUserId,
    authorName,
    originDeviceId: r.originDeviceId,
    body: r.body,
    status: r.status,
    position: r.position,
    createdAt: new Date(r.createdAt).toISOString(),
    dispatchedAt: iso(r.dispatchedAt),
    completedAt: iso(r.completedAt),
  };
}

export function toApproval(r: ApprovalRow, decidedByName: string | null): WorkApproval {
  return {
    id: r.id,
    workSessionId: r.workSessionId,
    request: {
      tool: r.request.tool,
      summary: r.request.summary,
      paths: onlyRelativePaths(r.request.paths ?? []),
    },
    status: r.status,
    decidedBy: r.decidedBy,
    decidedByName,
    decision: r.decision,
    comment: r.comment,
    createdAt: new Date(r.createdAt).toISOString(),
    decidedAt: iso(r.decidedAt),
  };
}
