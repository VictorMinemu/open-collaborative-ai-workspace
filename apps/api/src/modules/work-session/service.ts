import {
  type Attachment,
  type DiffResultFrame,
  DiffStat,
  EffectiveSessionSettings,
  type EventFrame,
  EventTypes,
  type HelloFrame,
  isFullAccessReport,
  onlyRelativePaths,
  type SessionEvent,
  SessionTitle,
  type SessionVisibilityKind,
  type TeamProjectRef,
  TITLE_PROMPT_MAX_CHARS,
  TitleFailureCode,
  type TitleResultFrame,
  type WorkApproval,
  type WorkPrompt,
  type WorkSession,
  type WorkSessionChanges,
  type WorkSessionStatus,
  type WorkSessionVisibilitySummary,
  type WorkZonePolicy,
} from "@ocw/contracts";
import {
  agents,
  conversations,
  deviceCommands,
  devices,
  orgMembers,
  orgUnits,
  projects,
  type TenantDb,
  type Tx,
  tenantOf,
  workApprovals,
  workProjectRepos,
  workPrompts,
  workSessions,
} from "@ocw/db";
import { and, asc, count, desc, eq, inArray, isNull, min, type SQL, sql } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { attachmentRowsForWorkPrompt, attachmentsForWorkPrompts, type ObjectStorage } from "../artifact";
import type { AuditService } from "../audit";
import type { DeviceCommandRow, DeviceHub, DeviceRef, DeviceSessionHandler } from "../device";
import { memberDirectory, type PermissionService, type ResourceFacts, uuidArray } from "../organization";
import type { RealtimeService } from "../realtime";
import { loadControlsContext } from "./context";
import {
  buildRuntimeControls,
  clampToControls,
  highestAvailableMode,
  pickSettings,
  requestedSettings,
  storedSettings,
  turnMode,
} from "./controls";
import { type SessionFactsRow, sessionAccessSql, sessionFactsForUsers, sessionResourceOf } from "./facts";
import {
  currentSessionModel,
  hydratePromptImages,
  type PromptImagesPlan,
  preparePromptImages,
} from "./images";
import { OrgQueue, type OrgQueueOptions, type OrgTask } from "./org-queue";
import { loadWorkZonePolicy } from "./policy";
import { decideTitleRequest, heuristicTitle, loadTitleContext } from "./title";
import type { SessionProject, ShapeSource } from "./viewer-fields";

/** Frames published at once by the per-user delivery (one Redis round trip each, bounded concurrency). */
const PUBLISH_BATCH = 200;
/** Sessions decided per read of a delivery (one short system transaction each, never a snapshot of thousands). */
const DELIVER_BATCH = 50;
/** Sessions re-checked per transaction of a sweep: short row locks, so the device's own events interleave. */
const SWEEP_CHUNK = 50;
/** Shutdown: how long the background queue may drain before what still waits is dropped (07.9 fan-out). */
export const BACKGROUND_DRAIN_MS = 5_000;

/**
 * Whether facts name a seeing relation of the SQL rule (creator, device owner, viewer, or the `creator_left` state):
 * the same set `app.work_session_viewers` enumerates and the audience backstop admits (admins aside).
 */
function seesSession(f: ResourceFacts): boolean {
  return (
    f.relations.has("creator") ||
    f.relations.has("device_owner") ||
    f.relations.has("viewer") ||
    f.state.has("creator_left")
  );
}

/** Why live sessions are re-checked (ADR-0012): a policy change, a member's access change, a device opt-out. */
export type ReauthorizeReason = "policy" | "access_changed" | "device_opt_out";

/** What a sweep re-checks: every active session of the organization, or of one device (07.9 fan-out). */
interface SweepScope {
  reason: ReauthorizeReason;
  deviceId: string | null;
  /** The person whose change caused it (the admin who saved the policy): the actor of its audit rows. */
  actorUserId: string | null;
}

const UNAUTHORIZED_MODE_ERROR =
  "The device reported Full access without authorization; the session was stopped";

/** 06.1-02: why the hub failed a prompt before sending it, and the plain text the session shows. */
type UndeliveredReason = "image_unavailable" | "frame_too_large";
const UNDELIVERED_PROMPT = new Map<string, string>([
  ["image_unavailable", "An attached image is no longer available"],
  ["frame_too_large", "The images are too large to send to the device"],
]);

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

/** Sessions emitted in a transaction, by its tenant context (one per transaction or savepoint), awaiting delivery. */
const pendingDeliveries = new WeakMap<object, Set<string>>();
const iso = (v: string | null) => (v ? new Date(v).toISOString() : null);

export interface WorkSessionDeps {
  db: TenantDb;
  realtime: RealtimeService;
  audit: AuditService;
  hub: DeviceHub;
  log: FastifyBaseLogger;
  /** The resolver: the per-turn author cap includes the author's `device.full_access` grain (P-07). */
  perms: PermissionService;
  /** Attachment storage (06.1): a prompt's image bytes are read from it at dispatch; null = not configured. */
  storage?: ObjectStorage | null;
  /** The background queue's bounds (07.9 fan-out); tests shorten the retries. */
  background?: Omit<OrgQueueOptions, "log">;
}

/**
 * Work session domain: DTOs, the shared prompt queue ARBITER (one execution authority: a prompt is
 * dispatched only when the previous one completed) and ingestion of device events. Every state change locks
 * the session row (`SELECT … FOR UPDATE`) first, so the arbiter, REST mutations and device events serialize.
 */
export class WorkSessionService implements DeviceSessionHandler {
  /**
   * Phase 07.9 fan-out (WINDOWS #311): the work that follows a commit (per-user delivery, the `removed` notices, the
   * re-authorization sweeps) runs here, ordered per organization, so the request returns right after its commit.
   */
  readonly background: OrgQueue;

  constructor(private readonly deps: WorkSessionDeps) {
    this.background = new OrgQueue({ log: deps.log, ...deps.background });
  }

  /** Resolves once the background work of the organization (or of every organization) is done (tests, perf). */
  settled(organizationId?: string): Promise<void> {
    return this.background.whenIdle(organizationId);
  }

  /** Shutdown: drains the background queue for at most BACKGROUND_DRAIN_MS (see `OrgQueue.close`). */
  async close(): Promise<void> {
    const { drained, abandoned } = await this.background.close(BACKGROUND_DRAIN_MS);
    if (!drained) this.deps.log.warn({ abandoned }, "work session background queue abandoned at shutdown");
  }

  // ------------------------------------------------------------------ DTOs

  async sessions(tx: Tx, filter?: SQL): Promise<WorkSession[]> {
    return (await this.load(tx, filter, null)).map((r) => r.dto);
  }

  async session(tx: Tx, id: string): Promise<WorkSession | null> {
    return (await this.sessions(tx, eq(workSessions.id, id)))[0] ?? null;
  }

  /**
   * One session with its team project (id, name, unit path) for the per-viewer shaping of the detail (Phase 07.10,
   * PD-04): the project travels beside the DTO, never inside it, until `withViewerFields` decides it for a viewer.
   */
  async sessionSource(tx: Tx, id: string): Promise<ShapeSource | null> {
    const [r] = await this.load(tx, eq(workSessions.id, id), null);
    return r ? { dto: r.dto, project: r.project } : null;
  }

  /**
   * The sessions `userId` has any audience fact on (Phase 07.9, D-09, Pitfall 8), each with its resolver facts built
   * from the same row by the one builder (`sessionResourceOf`): the list route then decides `work_session.read` on
   * those facts with `perms.filter`, exactly as the detail route decides one session. Rows outside every fact (no
   * creator, device owner, viewer, admin or lead fact) are dropped before any count or directory work. Each row also
   * carries its team project beside the DTO, for the route's per-viewer shaping (Phase 07.10, PD-04).
   */
  async readableSessions(
    tx: Tx,
    userId: string,
    filter?: SQL,
  ): Promise<Array<ShapeSource & { facts: ResourceFacts }>> {
    return (await this.load(tx, filter, userId)).map((r) => ({
      dto: r.dto,
      project: r.project,
      facts: sessionResourceOf(r.facts, userId),
    }));
  }

  /**
   * The DTO rows (+ the facts row when `userId` is given, narrowed to the sessions where the SQL rule names them).
   * Every DTO carries its audience summary and team project (UI-SPEC R1), from one batched call of
   * `app.work_session_visibility_summary`.
   */
  private async load(
    tx: Tx,
    filter: SQL | undefined,
    userId: string | null,
  ): Promise<Array<{ dto: WorkSession; facts: SessionFactsRow; project: SessionProject | null }>> {
    const all = await tx
      .select({
        s: workSessions,
        projectName: projects.name,
        deviceName: devices.name,
        deviceStatus: devices.status,
        deviceRevoked: devices.revokedAt,
        deviceOwner: devices.ownerUserId,
        unitPath: orgUnits.path,
        access: userId === null ? sql<string[]>`'{}'::text[]` : sessionAccessSql(userId),
      })
      .from(workSessions)
      .innerJoin(projects, eq(projects.id, workSessions.projectId))
      .innerJoin(devices, eq(devices.id, workSessions.deviceId))
      .leftJoin(workProjectRepos, eq(workProjectRepos.projectId, workSessions.projectId))
      .leftJoin(orgUnits, eq(orgUnits.id, workProjectRepos.unitId))
      .where(filter)
      .orderBy(desc(workSessions.updatedAt));
    // Pre-narrowing (cardinality of the facts > 0): the resolver then decides on the facts of the kept rows.
    const rows = userId === null ? all : all.filter((r) => (r.access ?? []).length > 0);
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.s.id);
    const [queued, pending, running, dir, summaries] = await Promise.all([
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
      visibilitySummaries(tx, ids),
    ]);
    const q = new Map(queued.map((r) => [r.id, Number(r.n)]));
    const p = new Map(pending.map((r) => [r.id, Number(r.n)]));
    const since = new Map(running.map((r) => [r.id, r.since]));
    return rows.map(
      ({ s, projectName, deviceName, deviceStatus, deviceRevoked, deviceOwner, unitPath, access }) => {
        const effective = EffectiveSessionSettings.safeParse(s.effectiveSettings);
        const diffStat = DiffStat.safeParse(s.diffStat);
        const summary = summaries.get(s.id);
        const dto: WorkSession = {
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
          titleSource: s.titleSource,
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
          visibility: summary?.visibility ?? {
            kind: s.visibility,
            activeCount: 0,
            differsFromDefault: false,
            firstTeamName: null,
          },
          teamProject: summary?.teamProject ?? null,
          createdAt: new Date(s.createdAt).toISOString(),
          updatedAt: new Date(s.updatedAt).toISOString(),
        };
        return {
          dto,
          project: summary?.teamProject ? { ...summary.teamProject, path: unitPath ?? [] } : null,
          facts: {
            createdBy: s.createdBy,
            deviceOwnerUserId: deviceOwner,
            deviceRevoked: deviceRevoked !== null,
            unitPath: unitPath ?? [],
            access: access ?? [],
          },
        };
      },
    );
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
    const images = await attachmentsForWorkPrompts(
      tx,
      rows.map((r) => r.id),
    );
    const bots = await proposerNames(tx, rows);
    return rows.map((r) =>
      toPrompt(
        r,
        dir.get(r.authorUserId)?.displayName ?? null,
        images.get(r.id) ?? [],
        proposedByOf(r, bots),
      ),
    );
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

  /**
   * The session snapshot, durable on its own stream (`ws:<id>`, gated by the audience rule) and, for the session
   * lists, unstored on the `user:` topic of each person who may read it, after commit (Phase 07.9, D-08, P-08). Nothing
   * about a session is written on `org:`, which every member reads.
   */
  async emitSession(tx: Tx, sessionId: string): Promise<WorkSession | null> {
    const dto = await this.session(tx, sessionId);
    if (!dto) {
      // 07.9-12: the request's own, authorized change took the session out of the caller's audience (a project lead who
      // narrowed it past themself), so the audience backstop hides it from the rest of the caller's transaction. The
      // people who still read it get the snapshot from a system transaction once this one commits; the caller never
      // reads it. A session that is not there (or not in this tenant) emits nothing either way.
      if (tenantOf(tx).userId) this.emitAfterCommitAsSystem(tx, sessionId);
      return null;
    }
    await this.deps.realtime.appendEvent(tx, wsTopic(sessionId), EventTypes.workSessionUpdated, dto);
    this.deliverAfterCommit(tx, sessionId);
    return dto;
  }

  /**
   * The `ws:` snapshot of a session the caller just lost, appended by the system after commit, then delivered; queued
   * in order with the organization's other background work.
   */
  private emitAfterCommitAsSystem(tx: Tx, sessionId: string): void {
    const { organizationId } = tenantOf(tx);
    tenantOf(tx).afterCommit(() =>
      this.background.push(organizationId, {
        kind: "snapshot",
        ids: () => [sessionId],
        run: async () => {
          await this.deps.db.withTenant({ organizationId, userId: null }, async (sys) => {
            const dto = await this.session(sys, sessionId);
            if (dto)
              await this.deps.realtime.appendEvent(
                sys,
                wsTopic(sessionId),
                EventTypes.workSessionUpdated,
                dto,
              );
          });
          await this.deliverNow(organizationId, [sessionId]);
        },
      }),
    );
  }

  /**
   * Coalesced per transaction (device paths and sweeps emit one session several times): the first emit of a transaction
   * registers one after-commit hook that queues the delivery of every session the transaction emitted. A rolled-back
   * transaction (or savepoint) drops it with its other after-commit hooks. The queue coalesces it further with a
   * delivery still waiting at its tail (07.9 fan-out); the delivery reads the session and its readers when it runs.
   */
  private deliverAfterCommit(tx: Tx, sessionId: string): void {
    const ctx = tenantOf(tx);
    const pending = pendingDeliveries.get(ctx);
    if (pending) {
      pending.add(sessionId);
      return;
    }
    const ids = new Set([sessionId]);
    pendingDeliveries.set(ctx, ids);
    ctx.afterCommit(() =>
      this.background.push(ctx.organizationId, this.deliveryTask(ctx.organizationId, ids)),
    );
  }

  /** A queued delivery of these sessions; absorbs a later delivery queued right behind it (tail coalescing). */
  private deliveryTask(organizationId: string, sessionIds: ReadonlySet<string>): OrgTask {
    const ids = new Set(sessionIds);
    return {
      kind: "deliver",
      ids: () => [...ids],
      run: () => this.deliverNow(organizationId, [...ids]),
      absorb: (next) => {
        if (next.kind !== "deliver") return false;
        for (const id of next.ids()) ids.add(id);
        return true;
      },
    };
  }

  /**
   * Tells the people an audience change removed (`work_session.removed` on their `user:` topic), after commit and in
   * order with the organization's deliveries: an update delivered before it is never followed by one for them, because
   * every later delivery reads the narrowed audience (07.9 fan-out).
   */
  notifyRemovedAfterCommit(tx: Tx, sessionId: string, userIds: readonly string[]): void {
    if (userIds.length === 0) return;
    const { organizationId } = tenantOf(tx);
    const gone = [...userIds];
    tenantOf(tx).afterCommit(() =>
      this.background.push(organizationId, {
        kind: "removed",
        ids: () => [sessionId],
        run: async () => {
          for (const uid of gone) {
            await this.deps.realtime.publishEphemeral(`user:${uid}`, EventTypes.workSessionRemoved, {
              id: sessionId,
            });
          }
        },
      }),
    );
  }

  /**
   * In the background queue, in a fresh read: each session's current DTO goes to the people the resolver lets read it,
   * decided exactly as the detail route decides one person (`work_session.read` on `sessionFactsForUsers`). Candidates
   * are the people the SQL rule names with a seeing relation (creator, creator who left, device owner, viewer: the set
   * `app.work_session_viewers` enumerates) and the active admins (never enumerated by the rule); module and deny rules
   * then remove anyone they reach. Unstored (no `user:` stream lock inside the domain transaction, the 07.5-16
   * lock-order hazard): a missed frame is covered by the list's refetch. The DTO is read before its readers, so a
   * narrowing that commits in between can only remove recipients, never show the new DTO to someone it removed. Throws:
   * the queue retries (07.9 fan-out). Sessions are decided DELIVER_BATCH at a time, each batch in its own read.
   *
   * 07.9-12 (WINDOWS #311, measured in list-perf.int.test.ts): the rule runs once per active member and session, through
   * `sessionFactsForUsers` (the reasons `work_session_viewers` adds for the panel cost four times more and are not needed
   * here), and the frames are published concurrently in bounded batches.
   */
  private async deliverNow(organizationId: string, sessionIds: readonly string[]): Promise<void> {
    for (let i = 0; i < sessionIds.length; i += DELIVER_BATCH) {
      await this.deliverBatch(organizationId, sessionIds.slice(i, i + DELIVER_BATCH));
    }
  }

  private async deliverBatch(organizationId: string, sessionIds: readonly string[]): Promise<void> {
    const deliveries = await this.deps.db.withTenant({ organizationId, userId: null }, async (tx) => {
      const dtos = await this.sessions(tx, inArray(workSessions.id, [...sessionIds]));
      if (dtos.length === 0) return [];
      const members = (
        await tx
          .select({ userId: orgMembers.userId })
          .from(orgMembers)
          .where(isNull(orgMembers.deactivatedAt))
      ).map((m) => m.userId);
      const admins = new Set(
        (
          await tx
            .select({ userId: orgMembers.userId })
            .from(orgMembers)
            .where(and(eq(orgMembers.role, "admin"), isNull(orgMembers.deactivatedAt)))
        ).map((a) => a.userId),
      );
      const out: Array<{ dto: WorkSession; recipients: string[] }> = [];
      for (const dto of dtos) {
        const facts = await sessionFactsForUsers(tx, dto, members);
        const candidates = members.filter((id) => {
          const f = facts.get(id);
          return f !== undefined && (admins.has(id) || seesSession(f));
        });
        const recipients = await this.deps.perms.usersAllowed(tx, {
          candidates,
          permission: "work_session.read",
          resourceFor: (userId) => {
            const f = facts.get(userId);
            if (!f) throw new Error("session facts missing for a candidate");
            return f;
          },
        });
        out.push({ dto, recipients });
      }
      return out;
    });
    const frames = deliveries.flatMap(({ dto, recipients }) => recipients.map((userId) => ({ dto, userId })));
    for (let i = 0; i < frames.length; i += PUBLISH_BATCH) {
      await Promise.all(
        frames
          .slice(i, i + PUBLISH_BATCH)
          .map(({ dto, userId }) =>
            this.deps.realtime.publishEphemeral(`user:${userId}`, EventTypes.workSessionUpdated, dto),
          ),
      );
    }
  }

  async emitPrompt(tx: Tx, row: PromptRow): Promise<void> {
    const [dir, images] = await Promise.all([memberDirectory(tx), attachmentsForWorkPrompts(tx, [row.id])]);
    const bots = await proposerNames(tx, [row]);
    await this.deps.realtime.appendEvent(
      tx,
      wsTopic(row.workSessionId),
      EventTypes.promptUpdated,
      toPrompt(
        row,
        dir.get(row.authorUserId)?.displayName ?? null,
        images.get(row.id) ?? [],
        proposedByOf(row, bots),
      ),
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
    let policy: WorkZonePolicy | undefined;
    for (;;) {
      const [next] = await tx
        .select()
        .from(workPrompts)
        .where(and(eq(workPrompts.workSessionId, s.id), eq(workPrompts.status, "queued")))
        .orderBy(asc(workPrompts.position), asc(workPrompts.createdAt))
        .limit(1);
      if (!next) return null;
      // P-07: re-checked on every turn: min(session mode, the author's cap = org policy ∩ device opt-in ∩ the
      // author's device cap (floor for unlisted controllers, nothing for revoked ones) ∩ grain ∩ catalog).
      policy ??= await loadWorkZonePolicy(tx);
      const author = await loadControlsContext(tx, this.deps.perms, {
        deviceId: s.deviceId,
        runtime: s.runtime,
        userId: next.authorUserId,
        inSession: true,
        policy,
      });
      const cap = author ? highestAvailableMode(author.ctx, s.model, s.permissionMode) : null;
      const mode = turnMode(s.permissionMode, cap);
      if (mode === null) {
        const revoked = author?.revoked === true && author.cap === null;
        await this.refusePrompt(tx, s, next, revoked ? "access_revoked" : "mode_not_allowed");
        continue;
      }
      // D-05, P-08: the model can change while an image prompt waits. A model that says it cannot read images never
      // gets the prompt without them: refused, audited, and the arbiter moves on.
      const images = await attachmentRowsForWorkPrompt(tx, next.id);
      const current = currentSessionModel(author?.ctx.catalog ?? null, s);
      if (current?.imageInput === false && images.length > 0) {
        await this.refusePrompt(tx, s, next, "images_not_supported");
        continue;
      }
      const [dispatched] = await tx
        .update(workPrompts)
        .set({ status: "dispatched", dispatchedAt: sql`now()`, permissionMode: mode })
        .where(eq(workPrompts.id, next.id))
        .returning();
      await this.deps.hub.enqueue(tx, {
        deviceId: s.deviceId,
        workSessionId: s.id,
        kind: "prompt",
        // D-04, P-03: ids only. The hub reads the bytes after its flush transaction; nothing hydrated is stored.
        payload: {
          promptId: next.id,
          text: next.body,
          permissionMode: mode,
          ...(images.length > 0 ? { imageAttachmentIds: images.map((a) => a.id) } : {}),
        },
      });
      // D-04: every turn's effective mode is audited (actor = the prompt's author, device, session, org).
      await this.deps.audit.record(tx, {
        action: "work_prompt.dispatched",
        resourceType: "work_prompt",
        resourceId: next.id,
        userId: next.authorUserId,
        deviceId: s.deviceId,
        sessionId: s.id,
        metadata: {
          promptId: next.id,
          authorUserId: next.authorUserId,
          requestedMode: s.permissionMode,
          effectiveMode: mode,
          capped: mode !== s.permissionMode,
          ...(mode === "fullAccess" ? { fullAccess: true } : {}),
          ...(images.length > 0 ? { imageCount: images.length } : {}),
        },
      });
      await this.emitPrompt(tx, dispatched!);
      await this.setStatus(tx, s, "running");
      return dispatched!;
    }
  }

  /**
   * A turn that may not run (P-07: its author's access; 06.1 P-08: images for a model that cannot read them): failed,
   * audited, never sent; the arbiter moves to the next prompt.
   */
  private async refusePrompt(
    tx: Tx,
    s: SessionRow,
    p: PromptRow,
    reason: "access_revoked" | "mode_not_allowed" | "images_not_supported",
  ): Promise<void> {
    const [row] = await tx
      .update(workPrompts)
      .set({ status: "failed", completedAt: sql`now()` })
      .where(eq(workPrompts.id, p.id))
      .returning();
    await this.deps.audit.record(tx, {
      action: "work_prompt.refused",
      resourceType: "work_prompt",
      resourceId: p.id,
      userId: p.authorUserId,
      deviceId: s.deviceId,
      sessionId: s.id,
      result: "denied",
      metadata: {
        promptId: p.id,
        authorUserId: p.authorUserId,
        requestedMode: s.permissionMode,
        reason,
      },
    });
    if (row) await this.emitPrompt(tx, row);
  }

  // ------------------------------------------------------------------ reauthorization (ADR-0012)

  /**
   * Re-check one LOCKED active session against its creator's current access (ADR-0012): a creator with no access
   * of their own to the device any more has the session stopped; otherwise the requested settings are lowered to
   * what the creator may pick now (policy ∩ opt-in ∩ cap ∩ grain ∩ catalog ∩ inventory) and the device is told
   * (`session.configure`); a Full access turn in flight is interrupted when Full access is left. `actorUserId` is the
   * person whose change caused the re-check (the audit actor; the transaction's own user otherwise).
   */
  async reauthorize(
    tx: Tx,
    s: SessionRow,
    reason: ReauthorizeReason,
    policy?: WorkZonePolicy,
    actorUserId: string | null = null,
  ): Promise<void> {
    const actor = actorUserId ? { userId: actorUserId } : {};
    if (!ACTIVE_STATES.includes(s.status)) return;
    const creator = await loadControlsContext(tx, this.deps.perms, {
      deviceId: s.deviceId,
      runtime: s.runtime,
      userId: s.createdBy,
      inSession: false,
      ...(policy ? { policy } : {}),
    });
    if (!creator) return;
    if (creator.cap === null) {
      const [d] = await tx.select({ name: devices.name }).from(devices).where(eq(devices.id, s.deviceId));
      const message = `Access to ${d?.name ?? "the device"} was revoked`;
      await this.deps.hub.enqueue(tx, {
        deviceId: s.deviceId,
        workSessionId: s.id,
        kind: "session.stop",
        payload: {},
      });
      await this.failInFlight(tx, s, message);
      await this.deps.audit.record(tx, {
        ...actor,
        action: "work_session.access_revoked",
        resourceType: "work_session",
        resourceId: s.id,
        deviceId: s.deviceId,
        sessionId: s.id,
        result: "denied",
        metadata: { reason, createdBy: s.createdBy, revoked: creator.revoked },
      });
      await this.setStatus(tx, s, "failed", { lastError: message });
      return;
    }
    const current = requestedSettings(s);
    const { next, changed } = clampToControls(current, buildRuntimeControls(s.runtime, creator.ctx, s.model));
    if (changed.length === 0) return;
    const from = current.permissionMode;
    const to = next.permissionMode ?? from;
    await tx
      .update(workSessions)
      .set({
        model: next.model ?? null,
        permissionMode: to,
        settings: storedSettings(next),
        settingsPending: true,
        updatedAt: sql`now()`,
      })
      .where(eq(workSessions.id, s.id));
    s.model = next.model ?? null;
    s.permissionMode = to;
    await this.deps.hub.enqueue(tx, {
      deviceId: s.deviceId,
      workSessionId: s.id,
      kind: "session.configure",
      payload: { settings: pickSettings(next, changed), reason },
    });
    await this.deps.audit.record(tx, {
      ...actor,
      action: "work_session.settings_downgraded",
      resourceType: "work_session",
      resourceId: s.id,
      deviceId: s.deviceId,
      sessionId: s.id,
      metadata: { reason, changed, from: pickSettings(current, changed), to: pickSettings(next, changed) },
    });
    if (from === "fullAccess" && to !== "fullAccess") {
      await this.deps.audit.record(tx, {
        ...actor,
        action: "work_session.full_access_left",
        resourceType: "work_session",
        resourceId: s.id,
        deviceId: s.deviceId,
        sessionId: s.id,
        metadata: { from, to, source: reason },
      });
      const fullTurn = await tx
        .select({ id: workPrompts.id })
        .from(workPrompts)
        .where(
          and(
            eq(workPrompts.workSessionId, s.id),
            inArray(workPrompts.status, IN_FLIGHT),
            eq(workPrompts.permissionMode, "fullAccess"),
          ),
        )
        .limit(1);
      if (fullTurn.length > 0) {
        await this.deps.hub.enqueue(tx, {
          deviceId: s.deviceId,
          workSessionId: s.id,
          kind: "interrupt",
          payload: {},
        });
      }
    }
    await this.emitSession(tx, s.id);
  }

  /**
   * Every active session of the transaction's organization, e.g. after a Work Zone policy change: queued once the
   * transaction commits (07.9 fan-out), so the admin's request returns at once. The transaction's user is the audit actor
   * of every downgrade. Until the sweep reaches a session, its next turn is still capped by the new policy (P-07).
   */
  async reauthorizeOrg(tx: Tx, reason: ReauthorizeReason): Promise<void> {
    const ctx = tenantOf(tx);
    const scope: SweepScope = { reason, deviceId: null, actorUserId: ctx.userId ?? null };
    ctx.afterCommit(() =>
      this.background.push(ctx.organizationId, this.sweepTask(ctx.organizationId, scope)),
    );
  }

  /**
   * `DeviceSessionHandler`: a member's access to the device or its opt-in changed (the change is committed). Privacy
   * first: every live subscription of the organization is re-decided now, before the sweep emits anything; the sweep of
   * the device's live sessions (stop or downgrade, ADR-0012 §2) is queued (07.9 fan-out).
   */
  async onAccessChanged(
    device: { deviceId: string; organizationId: string },
    reason: ReauthorizeReason,
  ): Promise<void> {
    // A device grant changed who may see the device's sessions (P-09): every live subscription of the organization is
    // re-decided (`device.updated` also fires on online/offline, so it is not an invalidator).
    try {
      await this.deps.realtime.invalidateSubscriptions({ organizationId: device.organizationId });
    } catch (err) {
      // The gateway's periodic re-check is the backstop for a lost invalidation.
      this.deps.log.warn({ err }, "subscription invalidation after a device access change failed");
    }
    this.background.push(
      device.organizationId,
      this.sweepTask(device.organizationId, { reason, deviceId: device.deviceId, actorUserId: null }),
    );
  }

  /**
   * A re-authorization sweep (ADR-0012) as a background task: the active sessions are listed when it runs, then
   * re-checked SWEEP_CHUNK at a time, each chunk in its own system transaction (short row locks; the policy is read
   * fresh per chunk). Idempotent, so a retry re-runs it whole. Coalesced: the same sweep already waiting covers this one.
   */
  private sweepTask(organizationId: string, scope: SweepScope): OrgTask {
    const sys = { organizationId, userId: null };
    let listed: string[] = [];
    return {
      kind: "sweep",
      key: `sweep:${scope.deviceId ?? "org"}:${scope.reason}:${scope.actorUserId ?? ""}`,
      ids: () => (scope.deviceId ? [scope.deviceId, ...listed] : listed),
      run: async () => {
        listed = await this.deps.db.withTenant(sys, async (tx) =>
          (
            await tx
              .select({ id: workSessions.id })
              .from(workSessions)
              .where(
                and(
                  inArray(workSessions.status, ACTIVE_STATES),
                  scope.deviceId ? eq(workSessions.deviceId, scope.deviceId) : undefined,
                ),
              )
              .orderBy(asc(workSessions.id))
          ).map((r) => r.id),
        );
        for (let i = 0; i < listed.length; i += SWEEP_CHUNK) {
          const chunk = listed.slice(i, i + SWEEP_CHUNK);
          await this.deps.db.withTenant(sys, async (tx) => {
            const policy = await loadWorkZonePolicy(tx);
            for (const id of chunk) {
              const s = await this.lock(tx, id);
              if (s && (scope.deviceId === null || s.deviceId === scope.deviceId)) {
                await this.reauthorize(tx, s, scope.reason, policy, scope.actorUserId);
              }
            }
          });
        }
      },
    };
  }

  /**
   * D-03 (server side): Full access — or a runtime bypass literal — reported while neither the session nor the turn
   * in flight is authorized for it. True when the report is authorized (or not a Full access report).
   */
  private async fullAccessReportAllowed(
    tx: Tx,
    s: SessionRow,
    reported: string | undefined,
  ): Promise<boolean> {
    if (!isFullAccessReport(reported)) return true;
    if (s.permissionMode === "fullAccess") return true;
    const turn = await tx
      .select({ id: workPrompts.id })
      .from(workPrompts)
      .where(
        and(
          eq(workPrompts.workSessionId, s.id),
          inArray(workPrompts.status, IN_FLIGHT),
          eq(workPrompts.permissionMode, "fullAccess"),
        ),
      )
      .limit(1);
    return turn.length > 0;
  }

  /** D-03: interrupt, stop, fail and audit; the reported value is never stored as effective. */
  private async failUnauthorizedMode(
    tx: Tx,
    device: DeviceRef,
    s: SessionRow,
    reported: string,
    via: "session.settings" | "session.started",
  ): Promise<void> {
    await this.deps.hub.enqueue(tx, {
      deviceId: s.deviceId,
      workSessionId: s.id,
      kind: "interrupt",
      payload: {},
    });
    await this.deps.hub.enqueue(tx, {
      deviceId: s.deviceId,
      workSessionId: s.id,
      kind: "session.stop",
      payload: {},
    });
    await this.failInFlight(tx, s, UNAUTHORIZED_MODE_ERROR);
    await this.deps.audit.record(tx, {
      action: "work_session.unauthorized_mode",
      resourceType: "work_session",
      resourceId: s.id,
      actorKind: "device",
      actorId: device.deviceId,
      deviceId: device.deviceId,
      sessionId: s.id,
      userId: null,
      result: "denied",
      metadata: { reported, authorizedMode: s.permissionMode, via },
    });
    await this.setStatus(tx, s, "failed", { lastError: UNAUTHORIZED_MODE_ERROR });
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

  /** 06.1-02 (P-03): a prompt's images, chosen inside the hub's flush transaction (database work only). */
  async prepareCommand(tx: Tx, _device: DeviceRef, cmd: DeviceCommandRow): Promise<unknown> {
    return preparePromptImages(tx, cmd);
  }

  /** 06.1-02 (P-03): the image bytes, read after the flush transaction committed; never stored. */
  async hydrateCommand(
    _device: DeviceRef,
    cmd: DeviceCommandRow,
    plan: unknown,
  ): Promise<Record<string, unknown>> {
    return hydratePromptImages(this.deps.storage ?? null, cmd, plan as PromptImagesPlan);
  }

  async onCommandResult(
    device: DeviceRef,
    cmd: DeviceCommandRow,
    ok: boolean,
    error: string | null,
    origin: "device" | "hub" = "device",
  ): Promise<void> {
    if (!cmd.workSessionId) return;
    const sessionId = cmd.workSessionId;
    await this.deps.db.withTenant(this.sys(device), async (tx) => {
      const s = await this.lock(tx, sessionId);
      if (!s || s.deviceId !== device.deviceId) return;
      if (cmd.kind === "session.title") {
        // D-19: a title that never came is only audited; the session keeps its first line and is never failed,
        // marked with an error or delayed.
        if (!ok) {
          const code = TitleFailureCode.safeParse((error ?? "").split(":")[0]?.trim());
          const model = typeof cmd.payload.model === "string" ? cmd.payload.model : null;
          await this.titleFailed(tx, device, s, code.success ? code.data : "title_failed", model, "error");
        }
        return;
      }
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
        const undelivered = origin === "hub" ? UNDELIVERED_PROMPT.get(error ?? "") : undefined;
        if (undelivered) {
          await this.promptUndelivered(tx, s, promptId, error as UndeliveredReason, undelivered);
          return;
        }
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

  /**
   * 06.1-02 (P-03, Pitfall 8): the hub could not send a prompt (an image is gone, or the frame is too large). Called
   * after the hub's marking transaction committed, with the session LOCKED: the prompt fails, the refusal is audited
   * with its reason, the session goes idle with a plain `lastError`, and the arbiter moves on.
   */
  private async promptUndelivered(
    tx: Tx,
    s: SessionRow,
    promptId: string,
    reason: UndeliveredReason,
    message: string,
  ): Promise<void> {
    const [p] = await tx
      .update(workPrompts)
      .set({ status: "failed", completedAt: sql`now()` })
      .where(and(eq(workPrompts.id, promptId), inArray(workPrompts.status, IN_FLIGHT)))
      .returning();
    if (!p) return;
    await this.deps.audit.record(tx, {
      action: "work_prompt.refused",
      resourceType: "work_prompt",
      resourceId: p.id,
      userId: p.authorUserId,
      deviceId: s.deviceId,
      sessionId: s.id,
      result: "error",
      metadata: { promptId: p.id, authorUserId: p.authorUserId, requestedMode: s.permissionMode, reason },
    });
    await this.emitPrompt(tx, p);
    if (s.status === "running") {
      await this.setStatus(tx, s, "idle", { lastError: message });
      await this.tryDispatch(tx, s);
    }
  }

  // ------------------------------------------------------------------ automatic titles (D-18 … D-20, ADR-0014)

  /**
   * Ask the session's device for a short title of its first prompt (P-18): only with the session runtime's own
   * small model, when the device catalog lists it and the org policy allows it. A skip changes nothing: the
   * session keeps its first-line title. The audit carries the prompt length, never its text.
   */
  async requestTitle(tx: Tx, s: SessionRow, prompt: string, clientKind: string | null): Promise<boolean> {
    // A session created without a prompt still carries its placeholder: its first prompt's first line replaces
    // it now (still `heuristic`, so the automatic title may follow). The caller emits the session.
    const first = heuristicTitle(prompt);
    if (first && first !== s.title) {
      await tx
        .update(workSessions)
        .set({ title: first, updatedAt: sql`now()` })
        .where(and(eq(workSessions.id, s.id), eq(workSessions.titleSource, "heuristic")));
      await tx.update(conversations).set({ name: first }).where(eq(conversations.id, s.conversationId));
      s.title = first;
    }
    const { catalog, policy } = await loadTitleContext(tx, s.deviceId, s.runtime);
    const decision = decideTitleRequest({ runtime: s.runtime, catalog, policy });
    if (!decision.ok) return false;
    const text = prompt.slice(0, TITLE_PROMPT_MAX_CHARS);
    await this.deps.hub.enqueue(tx, {
      deviceId: s.deviceId,
      workSessionId: s.id,
      kind: "session.title",
      payload: { runtime: s.runtime, model: decision.model, prompt: text },
    });
    await this.deps.audit.record(tx, {
      action: "work_session.title_requested",
      resourceType: "work_session",
      resourceId: s.id,
      sessionId: s.id,
      deviceId: s.deviceId,
      clientKind,
      metadata: { runtime: s.runtime, model: decision.model, promptLength: text.length },
    });
    return true;
  }

  /**
   * The device's answer to its own `session.title` command (the hub checked id, device and kind). Accepted only
   * for this device's session, with the requested model and a valid `SessionTitle`; stored only while the title
   * is still the heuristic one, so a typed title or an earlier automatic one is never replaced (D-19, D-20).
   */
  async onTitleResult(device: DeviceRef, cmd: DeviceCommandRow, frame: TitleResultFrame): Promise<void> {
    const sessionId = cmd.workSessionId;
    if (!sessionId || frame.sessionId !== sessionId) return;
    await this.deps.db.withTenant(this.sys(device), async (tx) => {
      const s = await this.lock(tx, sessionId);
      if (!s || s.deviceId !== device.deviceId) return;
      const requested = typeof cmd.payload.model === "string" ? cmd.payload.model : null;
      const refuse = (reason: "model_mismatch" | "invalid_title") =>
        this.titleFailed(tx, device, s, reason, requested, "denied");
      if (frame.model !== requested) return refuse("model_mismatch");
      if (!SessionTitle.safeParse(frame.title).success) return refuse("invalid_title");
      const [row] = await tx
        .update(workSessions)
        .set({ title: frame.title, titleSource: "auto", updatedAt: sql`now()` })
        .where(and(eq(workSessions.id, s.id), eq(workSessions.titleSource, "heuristic")))
        .returning({ conversationId: workSessions.conversationId });
      if (!row) return;
      await tx
        .update(conversations)
        .set({ name: frame.title })
        .where(eq(conversations.id, row.conversationId));
      await this.deps.audit.record(tx, {
        action: "work_session.title_generated",
        resourceType: "work_session",
        resourceId: s.id,
        actorKind: "device",
        actorId: device.deviceId,
        deviceId: device.deviceId,
        sessionId: s.id,
        userId: null,
        metadata: { model: requested, length: frame.title.length },
      });
      await this.emitSession(tx, s.id);
    });
  }

  /** A title that was refused or never came: audited only; the session, its status and lastError are untouched. */
  private async titleFailed(
    tx: Tx,
    device: DeviceRef,
    s: SessionRow,
    reason: string,
    model: string | null,
    result: "denied" | "error",
  ): Promise<void> {
    await this.deps.audit.record(tx, {
      action: "work_session.title_failed",
      resourceType: "work_session",
      resourceId: s.id,
      actorKind: "device",
      actorId: device.deviceId,
      deviceId: device.deviceId,
      sessionId: s.id,
      userId: null,
      result,
      metadata: { reason, model },
    });
  }

  async onDiffResult(device: DeviceRef, workSessionId: string, frame: DiffResultFrame): Promise<void> {
    await this.deps.db.withTenant(this.sys(device), async (tx) => {
      const [s] = await tx.select().from(workSessions).where(eq(workSessions.id, workSessionId));
      if (!s || s.deviceId !== device.deviceId) return;
      const branch = frame.branch ?? null;
      const files = frame.files.filter((f) => onlyRelativePaths([f.path]).length === 1);
      // The sidebar / footer diff stat (D-17): totals of the relative-only files.
      const diffStat: DiffStat = {
        files: files.length,
        additions: files.reduce((n, f) => n + f.additions, 0),
        deletions: files.reduce((n, f) => n + f.deletions, 0),
      };
      const prev = DiffStat.safeParse(s.diffStat);
      const statChanged =
        !prev.success ||
        prev.data.files !== diffStat.files ||
        prev.data.additions !== diffStat.additions ||
        prev.data.deletions !== diffStat.deletions;
      if (branch !== s.branch || statChanged) {
        await tx.update(workSessions).set({ branch, diffStat }).where(eq(workSessions.id, s.id));
        await this.emitSession(tx, s.id);
      }
      const changes: WorkSessionChanges = {
        files,
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
        if (!(await this.fullAccessReportAllowed(tx, s, ev.permissionMode))) {
          await this.failUnauthorizedMode(tx, device, s, ev.permissionMode!, "session.started");
          return;
        }
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
        if (!(await this.fullAccessReportAllowed(tx, s, reported.permissionMode))) {
          await this.failUnauthorizedMode(tx, device, s, reported.permissionMode!, "session.settings");
          return;
        }
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
        // A session the server already failed (access revoked, unauthorized mode) stays failed with its reason
        // when the device then reports the stopped session as ended.
        if (s.status === "failed" && status === "completed") return;
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

/**
 * Phase 07.5 (D-04, UI-SPEC Surface 3): the names of the bots that proposed these prompts. A deleted bot (soft
 * delete; a hard delete already cleared the column) is gone, so its prompts show no proposer. One query, and only
 * when a prompt has a proposer.
 */
async function proposerNames(tx: Tx, rows: readonly PromptRow[]): Promise<Map<string, string>> {
  const ids = [...new Set(rows.flatMap((r) => (r.proposedByAgentId ? [r.proposedByAgentId] : [])))];
  if (ids.length === 0) return new Map();
  const found = await tx
    .select({ id: agents.id, name: agents.name })
    .from(agents)
    .where(and(inArray(agents.id, ids), isNull(agents.deletedAt)));
  return new Map(found.map((a) => [a.id, a.name]));
}

function proposedByOf(r: PromptRow, names: ReadonlyMap<string, string>): WorkPrompt["proposedBy"] {
  const name = r.proposedByAgentId ? names.get(r.proposedByAgentId) : undefined;
  return r.proposedByAgentId && name !== undefined
    ? { agentId: r.proposedByAgentId, displayName: name.slice(0, 200) }
    : null;
}

export function toPrompt(
  r: PromptRow,
  authorName: string | null,
  attachments: Attachment[] = [],
  /** Phase 07.5: the bot whose Work Zone proposal created this prompt (`proposedByOf`); null for a person's prompt. */
  proposedBy: WorkPrompt["proposedBy"] = null,
): WorkPrompt {
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
    attachments,
    proposedBy,
  };
}

/**
 * The audience summary and team project of each session (UI-SPEC R1), one batched call of the SQL summary function
 * (Phase 07.9): never a person's name, only team names, counts and the project reference.
 */
async function visibilitySummaries(
  tx: Tx,
  ids: readonly string[],
): Promise<Map<string, { visibility: WorkSessionVisibilitySummary; teamProject: TeamProjectRef | null }>> {
  const res = await tx.execute(sql`
    select s.id::text as id, v.kind, v.active_count, v.differs_from_default, v.first_team_name,
           v.team_project_id::text as team_project_id, v.team_project_name
      from unnest(${uuidArray(ids)}) as s(id)
      cross join lateral app.work_session_visibility_summary(s.id) v`);
  const out = new Map<
    string,
    { visibility: WorkSessionVisibilitySummary; teamProject: TeamProjectRef | null }
  >();
  for (const r of res.rows as Array<{
    id: string;
    kind: SessionVisibilityKind;
    active_count: number;
    differs_from_default: boolean;
    first_team_name: string | null;
    team_project_id: string | null;
    team_project_name: string | null;
  }>) {
    out.set(r.id, {
      visibility: {
        kind: r.kind,
        activeCount: r.active_count,
        differsFromDefault: r.differs_from_default,
        firstTeamName: r.first_team_name,
      },
      teamProject:
        r.team_project_id && r.team_project_name
          ? { id: r.team_project_id, name: r.team_project_name }
          : null,
    });
  }
  return out;
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
