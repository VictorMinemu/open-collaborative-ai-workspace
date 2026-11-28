import {
  type AccountSwitchReason,
  ATTACHMENT_DEFAULT_MAX_BYTES,
  type Attachment,
  type DiffResultFrame,
  DiffStat,
  EffectiveSessionSettings,
  type EventFrame,
  EventTypes,
  type HelloFrame,
  isFullAccessReport,
  NO_GIT_WORKTREE_MESSAGE,
  onlyRelativePaths,
  POOL_LIMITS,
  POOL_PROVIDER_OF_RUNTIME,
  PROMPT_FILE_FAILURE_PREFIX,
  PROMPT_FILES_UPDATE_DEVICE,
  RuntimeInfo,
  SERVER_ONLY_SESSION_EVENTS,
  type SessionAccount,
  type SessionAccountLimitedFrame,
  type SessionBrowserGrant,
  type SessionEvent,
  SessionTitle,
  type SessionToolsGrant,
  type SessionVisibilityKind,
  type TeamProjectRef,
  TITLE_PROMPT_MAX_CHARS,
  TitleFailureCode,
  type TitleResultFrame,
  type WorkApproval,
  type WorkBrowserApprovalRequest,
  type WorkPrompt,
  type WorkSession,
  type WorkSessionAgentRef,
  type WorkSessionChanges,
  type WorkSessionStatus,
  type WorkSessionVisibilitySummary,
  type WorkZonePolicy,
} from "@ocw/contracts";
import {
  accountPoolAccounts,
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
  workBrowsers,
  workProjectRepos,
  workPrompts,
  workSessions,
} from "@ocw/db";
import { and, asc, count, desc, eq, inArray, isNotNull, isNull, min, type SQL, sql } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { z } from "zod";
import type { Jobs } from "../../lib/jobs";
import {
  type AccountPoolPort,
  cooldownUntil,
  earliestPoolReset,
  everyAccountLimitedSentence,
  markLimited,
  markNeedsSignIn,
  noAccountSentence,
  type PoolAccountRow,
  type StoredSessionAccount,
  storedSessionAccount,
  usableFor,
} from "../account-pool";
import { attachmentRowsForWorkPrompt, attachmentsForWorkPrompts, type ObjectStorage } from "../artifact";
import type { AuditService } from "../audit";
import {
  CommandUndeliverableError,
  type DeviceCommandRow,
  type DeviceHub,
  type DeviceRef,
  type DeviceSessionHandler,
} from "../device";
import { memberDirectory, type PermissionService, type ResourceFacts, uuidArray } from "../organization";
import type { RealtimeService } from "../realtime";
import { botLayerForSession } from "./bot-profile";
import { type BrowserAsker, browserGrantFor, browserRequestOf, browserStateOf } from "./browser-grant";
import { type AgentControlsLayer, loadControlsContext } from "./context";
import {
  buildRuntimeControls,
  type ControlsContext,
  clampToControls,
  highestAvailableMode,
  pickSettings,
  requestedSettings,
  storedSettings,
  turnMode,
} from "./controls";
import { type SessionFactsRow, sessionAccessSql, sessionFactsForSessions, sessionResourceOf } from "./facts";
import { hydratePromptImages, type PromptImagesPlan, preparePromptImages } from "./images";
import { namingRulesFor } from "./naming-rules";
import { eachBounded, OrgQueue, type OrgQueueOptions, type OrgTask } from "./org-queue";
import { loadWorkZonePolicy } from "./policy";
import {
  decidePromptFilesAtDispatch,
  finishPromptFiles,
  openPromptFileTransfers,
  type PromptFilesDispatchRefusal,
} from "./prompt-files";
import { decideTitleRequest, heuristicTitle, loadTitleContext } from "./title";
import {
  type DeliverySource,
  loadViewerFieldsForRecipients,
  type SessionProject,
  type ShapeSource,
  withoutViewerFields,
  withViewerFields,
} from "./viewer-fields";

/** Frames published at once by the per-user delivery (one Redis round trip each, bounded concurrency). */
const PUBLISH_BATCH = 200;
/** Sessions decided per read of a delivery (one short system transaction each, never a snapshot of thousands). */
const DELIVER_BATCH = 50;
/**
 * Reads of one delivery at once (WINDOWS #311): the SQL rule per (session, member) is CPU in PostgreSQL, so batches run
 * on separate connections. With the queue's two organizations at once, background deliveries hold at most six of the
 * pool's ten connections.
 */
export const DELIVER_CONCURRENCY = 3;
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

/**
 * 07.13.1.1 (D-05, D-13, PD-03): how one re-check runs. `interruptInFlight: false` lets a Full access turn in flight
 * finish (Assign to me never cuts a turn; the lower settings apply between turns). `cause` names what changed the
 * access in the audit rows only; the device keeps its closed `reason` (Pitfall 2).
 */
export interface ReauthorizeOptions {
  interruptInFlight?: boolean;
  cause?: "owner_changed";
}

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

/** ADR-0045: what the session says when a queued prompt's files cannot go at dispatch (images keep 06.1's silence). */
const PROMPT_FILES_REFUSED_SENTENCE: Partial<Record<PromptFilesDispatchRefusal, string>> = {
  runtime_too_old: `${PROMPT_FILES_UPDATE_DEVICE} (Settings › Devices). The prompt was not run.`,
  file_too_large: "An attached file is over the size limit now. The prompt was not run.",
  file_unavailable: "An attached file is no longer available. The prompt was not run.",
};

/** 07.18 (PD-02): the hub-origin reason of a command whose pool token could not be opened at send time. */
const ACCOUNT_UNAVAILABLE = "account_unavailable";

/** `ensureAccount`'s answer: the account a command names (undefined = no pool support, null = the device's login). */
type AccountCheck =
  | { ok: true; account: StoredSessionAccount | null | undefined }
  | { ok: false; message: string };

/** What `prepareCommand` hands to `hydrateCommand` (memory only, never stored). */
interface CommandPlan {
  images: PromptImagesPlan | undefined;
  account: { stored: Extract<StoredSessionAccount, { kind: "token" }>; token: string | null } | undefined;
  /** 07.13 (PD-09, PD-20): the turn's browser grant, decided at send time; undefined for a device without a browser. */
  browser?: SessionBrowserGrant;
  /** 07.13.1.1 (D-07, D-08, PD-10, PD-13): the turn's `ocw_session` grant, decided at send time (start and prompt). */
  sessionTools?: SessionToolsGrant;
}

/** The token account a stored `session.start` or `prompt` payload names (the API wrote it; checked anyway), or null. */
function tokenAccountOf(
  payload: Record<string, unknown>,
): Extract<StoredSessionAccount, { kind: "token" }> | null {
  const a = payload.account;
  if (typeof a !== "object" || a === null) return null;
  const { kind, accountId, label } = a as Record<string, unknown>;
  if (
    kind !== "token" ||
    typeof accountId !== "string" ||
    !UUID_RE.test(accountId) ||
    typeof label !== "string"
  ) {
    return null;
  }
  return { kind, accountId, label };
}

export type SessionRow = typeof workSessions.$inferSelect;
type PromptRow = typeof workPrompts.$inferSelect;
type ApprovalRow = typeof workApprovals.$inferSelect;
/** 07.13 (PD-10): `work_approvals.request` with the optional browser part (absent on every other approval). */
export type StoredApprovalRequest = ApprovalRow["request"] & { browser?: WorkBrowserApprovalRequest };

/** States in which the session is attached (or attaching) to a runtime on its device. */
export const ACTIVE_STATES: WorkSessionStatus[] = [
  "provisioning",
  "idle",
  "running",
  "waiting_approval",
  "host_offline",
];
const TERMINAL_RESTARTABLE: WorkSessionStatus[] = ["failed", "completed"];
/** A turn the device holds: sent, or running. Assign to me (07.13.1.1) reads it for the confirm dialog. */
export const IN_FLIGHT: PromptRow["status"][] = ["dispatched", "running"];
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
  /**
   * Phase 07.6 (AUTO-06, D-06): the job runtime. A session entering `completed` or `archived` enqueues its memory
   * summary job in the same transaction; the job decides (consent, linked team project, new work). Null = no jobs.
   */
  jobs?: Pick<Jobs, "sendInTx"> | null;
  /**
   * Phase 07.18 (D-02, D-05, PD-02, PD-06): the organization's account pool. A session on a pool-capable device starts
   * on an account the strategy chose, keeps it while it serves, and its device gets the token only in the frame sent.
   * Null = no pool (services built directly in unit tests): every session runs on its device's own login.
   */
  pool?: AccountPoolPort | null;
  /**
   * ADR-0045: the server's attachment ceiling (`OCW_ATTACHMENT_MAX_BYTES`); a prompt file's limit is the lower of it
   * and the organization's. Absent (services built directly in unit tests) = the chat default, 25 MiB.
   */
  serverFileMaxBytes?: number;
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

  /** 07.18: the account pool `createWorkSession` selects from (null = no pool: the device's own login). */
  get pool(): AccountPoolPort | null {
    return this.deps.pool ?? null;
  }

  /** ADR-0045: the server's ceiling for one prompt file (`OCW_ATTACHMENT_MAX_BYTES`, else the chat default). */
  promptFileCeiling(): number {
    return this.deps.serverFileMaxBytes ?? ATTACHMENT_DEFAULT_MAX_BYTES;
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

  /**
   * The viewer-neutral DTOs (Phase 07.10, PD-03): no team project, no per-viewer field. A route that does not shape
   * its answer for its viewer (`withViewerFields`) answers less, never more (fail closed).
   */
  async sessions(tx: Tx, filter?: SQL): Promise<WorkSession[]> {
    return (await this.load(tx, filter, null)).map((r) => withoutViewerFields(r.dto));
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
   * Every DTO carries its audience summary (UI-SPEC R1); its team project travels beside it (`project`, with the unit
   * path) until a viewer's shaping decides whether to name it (Phase 07.10, PD-04). One batched call of
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
        deviceBrowserVersion: devices.browserVersion,
        deviceBrowserOptIn: devices.browserOptIn,
        deviceHostKind: devices.hostKind,
        unitPath: orgUnits.path,
        access: userId === null ? sql<string[]>`'{}'::text[]` : sessionAccessSql(userId),
        poolId: accountPoolAccounts.id,
        poolLabel: accountPoolAccounts.label,
        poolProvider: accountPoolAccounts.provider,
      })
      .from(workSessions)
      .innerJoin(projects, eq(projects.id, workSessions.projectId))
      .innerJoin(devices, eq(devices.id, workSessions.deviceId))
      .leftJoin(accountPoolAccounts, eq(accountPoolAccounts.id, workSessions.poolAccountId))
      .leftJoin(workProjectRepos, eq(workProjectRepos.projectId, workSessions.projectId))
      .leftJoin(orgUnits, eq(orgUnits.id, workProjectRepos.unitId))
      .where(filter)
      .orderBy(desc(workSessions.updatedAt));
    // Pre-narrowing (cardinality of the facts > 0): the resolver then decides on the facts of the kept rows.
    const rows = userId === null ? all : all.filter((r) => (r.access ?? []).length > 0);
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.s.id);
    const [queued, pending, running, dir, summaries, starters, policy, openBrowsers] = await Promise.all([
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
      // 07.16 (D-06): the bots that started these sessions, by the same lookup as the prompts' bots.
      agentRefs(
        tx,
        rows.flatMap((r) => (r.s.startedByAgentId ? [r.s.startedByAgentId] : [])),
      ),
      // 07.13 (D-19): the browser state of every session from one policy read and one read of the open pages.
      loadWorkZonePolicy(tx),
      tx
        .select({ id: workBrowsers.workSessionId })
        .from(workBrowsers)
        .where(and(inArray(workBrowsers.workSessionId, ids), eq(workBrowsers.state, "open"))),
    ]);
    const live = new Set(openBrowsers.map((r) => r.id));
    const q = new Map(queued.map((r) => [r.id, Number(r.n)]));
    const p = new Map(pending.map((r) => [r.id, Number(r.n)]));
    const since = new Map(running.map((r) => [r.id, r.since]));
    return rows.map(
      ({
        s,
        projectName,
        deviceName,
        deviceStatus,
        deviceRevoked,
        deviceOwner,
        deviceBrowserVersion,
        deviceBrowserOptIn,
        deviceHostKind,
        unitPath,
        access,
        poolId,
        poolLabel,
        poolProvider,
      }) => {
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
          // 07.13.1.1 (PD-14): the device's self-reported host label, viewer-neutral (null = never reported).
          deviceHostKind,
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
          createdAt: new Date(s.createdAt).toISOString(),
          updatedAt: new Date(s.updatedAt).toISOString(),
          startedByAgent: agentRefOf(s.startedByAgentId, starters),
          // 07.18 (D-11, PD-19): the account's label only; null = the device's own login.
          poolAccount:
            poolId !== null && poolLabel !== null && poolProvider !== null
              ? { id: poolId, label: poolLabel, provider: poolProvider }
              : null,
          // 07.13 (D-19): viewer-neutral (no host, no member), so it rides the shared `ws:` stream as is.
          browser: browserStateOf({
            policy,
            device: { browserVersion: deviceBrowserVersion, browserOptIn: deviceBrowserOptIn },
            open: live.has(s.id),
          }),
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
    const bots = await promptAgents(tx, rows);
    return rows.map((r) =>
      toPrompt(
        r,
        dir.get(r.authorUserId)?.displayName ?? null,
        images.get(r.id) ?? [],
        proposedByOf(r, bots),
        agentRefOf(r.authorAgentId, bots),
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
    // The shared, durable stream carries the viewer-neutral DTO (Phase 07.10, PD-03).
    await this.deps.realtime.appendEvent(
      tx,
      wsTopic(sessionId),
      EventTypes.workSessionUpdated,
      withoutViewerFields(dto),
    );
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
                withoutViewerFields(dto),
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
   * decided exactly as the detail route decides one person (`work_session.read` on `sessionFactsForSessions`), each frame
   * shaped for its recipient (Phase 07.10, PD-03, PD-04: never one shared DTO naming a project to someone who may not
   * see it named). Candidates are the people the SQL rule names with a seeing relation (creator, creator who left,
   * device owner, viewer: the set `app.work_session_viewers` enumerates) and the active admins (never enumerated by the
   * rule); module and deny rules then remove anyone they reach. Unstored (no `user:` stream lock inside the domain
   * transaction, the 07.5-16 lock-order hazard): a missed frame is covered by the list's refetch. The DTO is read before
   * its readers, so a narrowing that commits in between can only remove recipients, never show the new DTO to someone
   * it removed. Throws: the queue retries (07.9 fan-out). Sessions are decided DELIVER_BATCH at a time, each batch in
   * its own read.
   *
   * 07.9-12 (WINDOWS #311, measured in list-perf.int.test.ts): the rule runs once per active member and session (the
   * reasons `work_session_viewers` adds for the panel cost four times more and are not needed here), and the frames are
   * published concurrently in bounded batches. Batching (pinned by delivery-batching.int.test.ts): a batch costs a fixed
   * number of round trips whatever its size (every member's facts on all its sessions in one query, the members' resolver
   * facts and the rules loaded once), and up to DELIVER_CONCURRENCY batches are read at once.
   */
  private async deliverNow(organizationId: string, sessionIds: readonly string[]): Promise<void> {
    const batches: Array<readonly string[]> = [];
    for (let i = 0; i < sessionIds.length; i += DELIVER_BATCH) {
      batches.push(sessionIds.slice(i, i + DELIVER_BATCH));
    }
    await eachBounded(batches, DELIVER_CONCURRENCY, (batch) => this.deliverBatch(organizationId, batch));
  }

  private async deliverBatch(organizationId: string, sessionIds: readonly string[]): Promise<void> {
    const deliveries = await this.deps.db.withTenant({ organizationId, userId: null }, async (tx) => {
      const sources = await this.load(tx, inArray(workSessions.id, [...sessionIds]), null);
      if (sources.length === 0) return [];
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
      // Every member's audience facts on every session of the batch (one query), then the members' resolver facts and
      // the rules (once): each session is decided in memory exactly as `usersAllowed` decides it.
      const factsBySession = await sessionFactsForSessions(
        tx,
        sources.map((s) => s.dto),
        members,
      );
      const decider = await this.deps.perms.usersDecider(tx, members);
      const out: DeliverySource[] = [];
      for (const { dto, project } of sources) {
        const facts = factsBySession.get(dto.id) ?? new Map<string, ResourceFacts>();
        const candidates = members.filter((id) => {
          const f = facts.get(id);
          return f !== undefined && (admins.has(id) || seesSession(f));
        });
        const recipients = decider.allowed(candidates, "work_session.read", (userId) => {
          const f = facts.get(userId);
          if (!f) throw new Error("session facts missing for a candidate");
          return f;
        });
        out.push({ dto, project, recipients, facts });
      }
      // Phase 07.10 (PD-03, PD-04, PD-05): each recipient gets the session as they read it (its project named or
      // hidden, what in it waits on them), decided for the whole batch.
      const fields = await loadViewerFieldsForRecipients(tx, decider, out);
      return out.map(({ dto, recipients }) => ({
        frames: recipients.map((userId) => ({
          userId,
          dto: withViewerFields(dto, fields.get(dto.id)!.get(userId)!),
        })),
      }));
    });
    const frames = deliveries.flatMap((d) => d.frames);
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
    const bots = await promptAgents(tx, [row]);
    await this.deps.realtime.appendEvent(
      tx,
      wsTopic(row.workSessionId),
      EventTypes.promptUpdated,
      toPrompt(
        row,
        dir.get(row.authorUserId)?.displayName ?? null,
        images.get(row.id) ?? [],
        proposedByOf(row, bots),
        agentRefOf(row.authorAgentId, bots),
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
    const entered = s.status !== status;
    await tx
      .update(workSessions)
      .set({ status, updatedAt: sql`now()`, ...extra })
      .where(eq(workSessions.id, s.id));
    s.status = status;
    // 07.6 (AUTO-06, D-06, D-07): a finished session may feed its team project's memory. Ids only; the job checks the
    // owner's consent (button or automatic preference), the 07.9 link and whether anything is new.
    if (entered && (status === "completed" || status === "archived") && this.deps.jobs) {
      await this.deps.jobs.sendInTx(
        tx,
        "work_session.summarize",
        { organizationId: s.organizationId, workSessionId: s.id, mode: "auto" },
        { singletonKey: `ws:${s.id}:${s.lastLocalSeq}` },
      );
    }
    // 07.16 (D-09, PD-16): a bot's session changed state; its card follows and the bot may be woken. The row flag is the
    // debounce of record (one pending wake per session): standard pg-boss queues do not dedupe by key (Pitfall 4). The
    // 3 s delay absorbs an `idle → running` flip of the same dispatch; the handler decides on the state it then reads.
    if (entered) await this.syncBotCard(tx, s);
    await this.emitSession(tx, s.id);
  }

  /**
   * 07.16 (D-12, PD-16): a bot's session changed what its live card shows (its state, or its mode or model without a
   * state change: code review WR-07): one pending `work_session.bot_sync` per session. The handler refreshes the card
   * only when its fields changed and wakes the bot only for a wake-worthy state not woken yet, so a settings change
   * alone never wakes it. A person's session does nothing.
   */
  async syncBotCard(
    tx: Tx,
    s: Pick<SessionRow, "id" | "organizationId" | "startedByAgentId">,
  ): Promise<void> {
    if (!s.startedByAgentId || !this.deps.jobs) return;
    const flipped = await tx.execute(sql`
      update app.bot_work_sessions set wake_pending = true
       where work_session_id = ${s.id} and not wake_pending
      returning 1`);
    if (flipped.rows.length > 0) {
      await this.deps.jobs.sendInTx(
        tx,
        "work_session.bot_sync",
        { organizationId: s.organizationId, workSessionId: s.id },
        { startAfter: new Date(Date.now() + 3_000) },
      );
    }
  }

  /** `session.start` payload for this session (resume when the runtime already has a session id). */
  async startPayload(tx: Tx, s: SessionRow): Promise<Record<string, unknown>> {
    const [p] = await tx
      .select({ localId: projects.localId })
      .from(projects)
      .where(eq(projects.id, s.projectId));
    const requested = requestedSettings(s);
    const account = await this.commandAccount(tx, s);
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
      // 07.18 (PD-02, PD-03): the stored form only (no token); absent for a device without pool support.
      ...(account !== undefined ? { account } : {}),
    };
  }

  /**
   * The account a command of this session names (PD-03): undefined for a device without pool support (the key is
   * left out, so an older daemon sees today's payload), null for the device's own login, else the stored form.
   */
  private async commandAccount(
    tx: Tx,
    s: Pick<SessionRow, "deviceId" | "poolAccountId">,
  ): Promise<StoredSessionAccount | null | undefined> {
    if (!this.deps.pool) return undefined;
    const [d] = await tx
      .select({ version: devices.accountPoolVersion })
      .from(devices)
      .where(eq(devices.id, s.deviceId));
    if (!d || d.version === null) return undefined;
    if (s.poolAccountId === null) return null;
    const row = await this.deps.pool.get(tx, s.poolAccountId);
    return row ? storedSessionAccount(row) : null;
  }

  /** (Re)attach the session to a runtime on its device (07.18: on an account that can serve, PD-06). */
  async restart(tx: Tx, s: SessionRow): Promise<void> {
    await this.ensureAccount(tx, s);
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
    let account: AccountCheck | undefined;
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
      // 07.16 (D-04, PD-07, Pitfall 10): a bot's prompt (written in its sponsor's name) is re-decided against the bot's
      // live profile on every turn: no active profile for this session → refused; else its caps join the sponsor's.
      // A prompt written after outside content counts as tainted even before the session is marked (D-08).
      let agent: AgentControlsLayer | undefined;
      if (next.authorAgentId) {
        const layer = await botLayerForSession(tx, this.deps.perms, s);
        if (!layer || layer.agentId !== next.authorAgentId) {
          await this.refusePrompt(tx, s, next, "bot_not_allowed");
          continue;
        }
        agent = next.tainted ? { ...layer, tainted: true } : layer;
      }
      const author = await loadControlsContext(tx, this.deps.perms, {
        deviceId: s.deviceId,
        runtime: s.runtime,
        userId: next.authorUserId,
        inSession: true,
        policy,
        ...(agent ? { agent } : {}),
      });
      const cap = author ? highestAvailableMode(author.ctx, s.model, s.permissionMode) : null;
      const mode = turnMode(s.permissionMode, cap);
      if (mode === null) {
        const revoked = author?.revoked === true && author.cap === null;
        await this.refusePrompt(tx, s, next, revoked ? "access_revoked" : "mode_not_allowed");
        continue;
      }
      // D-05, P-08, ADR-0045: the model can change while a prompt with attachments waits. Images it reads go inline;
      // every other file (an image it cannot read included) goes into the working tree. A device that cannot take
      // them, or a file over a limit lowered since, refuses the prompt (audited) and the arbiter moves on.
      const prepared = await decidePromptFilesAtDispatch(
        tx,
        s,
        next.id,
        await attachmentRowsForWorkPrompt(tx, next.id),
        this.promptFileCeiling(),
      );
      if (!prepared.ok) {
        await this.refusePrompt(tx, s, next, prepared.reason);
        const lastError = PROMPT_FILES_REFUSED_SENTENCE[prepared.reason];
        if (lastError) await this.setStatus(tx, s, s.status, { lastError });
        continue;
      }
      const images = prepared.inline;
      // 07.18 (PD-06, PD-16): the session's account, replaced first when it can no longer serve; none at all (fallback
      // off, or the device's own login is not signed in) refuses the turn with the no_account sentence.
      account ??= await this.ensureAccount(tx, s);
      if (!account.ok) {
        await this.refusePrompt(tx, s, next, "no_account");
        await this.setStatus(tx, s, s.status, { lastError: account.message });
        continue;
      }
      const [dispatched] = await tx
        .update(workPrompts)
        .set({ status: "dispatched", dispatchedAt: sql`now()`, permissionMode: mode })
        .where(eq(workPrompts.id, next.id))
        .returning();
      // ADR-0045: the transfers exist only for a prompt that is actually sent.
      const files = await openPromptFileTransfers(tx, s, next.id, prepared);
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
          // ADR-0045: transfer ids, repo-relative paths, sizes and digests; the device fetches the bytes itself.
          ...(files.length > 0 ? { files } : {}),
          // 07.18 (PD-02, PD-03): the stored form; the token is added at send time only.
          ...(account.account !== undefined ? { account: account.account } : {}),
        },
      });
      // D-04: every turn's effective mode is audited (actor = the prompt's author, device, session, org).
      await this.deps.audit.record(tx, {
        action: "work_prompt.dispatched",
        resourceType: "work_prompt",
        resourceId: next.id,
        userId: next.authorUserId,
        ...(next.authorAgentId ? { agentId: next.authorAgentId } : {}),
        deviceId: s.deviceId,
        sessionId: s.id,
        metadata: {
          promptId: next.id,
          authorUserId: next.authorUserId,
          ...(next.authorAgentId ? { authorAgentId: next.authorAgentId } : {}),
          requestedMode: s.permissionMode,
          effectiveMode: mode,
          capped: mode !== s.permissionMode,
          ...(mode === "fullAccess" ? { fullAccess: true } : {}),
          ...(images.length > 0 ? { imageCount: images.length } : {}),
          ...(files.length > 0 ? { fileCount: files.length } : {}),
        },
      });
      await this.emitPrompt(tx, dispatched!);
      await this.setStatus(tx, s, "running");
      return dispatched!;
    }
  }

  /**
   * 07.18 (D-05, PD-06, PD-16): call with the session row LOCKED, before a turn or a (re)start is enqueued. A session
   * keeps its account while it can serve; one removed, disabled, needing a new sign-in, cooling or of another kind is
   * replaced by the strategy's next usable account, else by the device's own login under fallback when that login is
   * signed in, else refused. A session on the device's own login stays there (a limit moves it: plan 10). `account`
   * is what the command names: undefined for a device without pool support (no key at all), null for the device's
   * own login.
   */
  private async ensureAccount(tx: Tx, s: SessionRow): Promise<AccountCheck> {
    const pool = this.deps.pool;
    if (!pool) return { ok: true, account: undefined };
    const device = await this.deviceAccountState(tx, s);
    if (!device.pool) return { ok: true, account: undefined };
    if (s.poolAccountId === null) return { ok: true, account: null };
    const provider = POOL_PROVIDER_OF_RUNTIME[s.runtime];
    const now = new Date();
    const current = await pool.get(tx, s.poolAccountId);
    const { scope } = await pool.policy(tx, provider);
    const stored = current ? storedSessionAccount(current) : null;
    if (
      current &&
      stored &&
      current.provider === provider &&
      usableFor(current, { deviceId: s.deviceId, consumer: "work_zone", scope, now })
    ) {
      return { ok: true, account: stored };
    }
    // Must change. A limit (cooling, otherwise fine) says until when; anything else is "no longer available".
    const until =
      current?.cooldownUntil && new Date(current.cooldownUntil).getTime() > now.getTime()
        ? new Date(current.cooldownUntil)
        : null;
    const limited =
      until !== null && current?.removedAt === null && current.enabled && current.credentialState === "ok";
    const change = { from: current, reason: (limited ? "limit" : "unavailable") as AccountSwitchReason };
    const picked = await pool.select(tx, {
      provider,
      deviceId: s.deviceId,
      consumer: "work_zone",
      now,
      exclude: [s.poolAccountId],
    });
    if ("row" in picked) {
      const next = storedSessionAccount(picked.row);
      if (next) {
        await this.switchAccount(tx, s, { ...change, to: picked.row, until: limited ? until : null });
        return { ok: true, account: next };
      }
    }
    if (picked.policy.fallbackToDeviceLogin && device.loggedIn) {
      await this.switchAccount(tx, s, { ...change, to: null, until: limited ? until : null });
      return { ok: true, account: null };
    }
    return { ok: false, message: noAccountSentence("none" in picked ? picked.earliestReset : null) };
  }

  /**
   * 07.18 (PD-04, PD-16): whether the session's device runs sessions on pool accounts (`hello.accountPool`), and whether
   * the session's runtime reports a login of its own there (the fallback).
   */
  private async deviceAccountState(
    tx: Tx,
    s: Pick<SessionRow, "deviceId" | "runtime">,
  ): Promise<{ pool: boolean; loggedIn: boolean }> {
    const [d] = await tx
      .select({ version: devices.accountPoolVersion, runtimeInfo: devices.runtimeInfo })
      .from(devices)
      .where(eq(devices.id, s.deviceId));
    if (!d || d.version === null) return { pool: false, loggedIn: false };
    const runtime = z
      .array(RuntimeInfo)
      .catch([])
      .parse(d.runtimeInfo)
      .find((r) => r.id === s.runtime);
    return { pool: true, loggedIn: runtime?.loggedIn === true };
  }

  /**
   * 07.18 (D-05, D-08, PD-14): moves a LOCKED session to another account (`to` null = the device's own login): the
   * row, one `account.switched` event on `ws:<id>` (labels only), one `account_pool.switched` audit row (ids, labels,
   * reason, until; never a token), `lastError` cleared, the session emitted. Plan 10 calls it for limits.
   */
  async switchAccount(
    tx: Tx,
    s: SessionRow,
    change: {
      from: PoolAccountRow | null;
      to: PoolAccountRow | null;
      reason: AccountSwitchReason;
      until: Date | null;
    },
  ): Promise<void> {
    const toId = change.to?.id ?? null;
    await tx
      .update(workSessions)
      .set({ poolAccountId: toId, lastError: null, updatedAt: sql`now()` })
      .where(eq(workSessions.id, s.id));
    const fromAccountId = s.poolAccountId;
    s.poolAccountId = toId;
    s.lastError = null;
    const labels = {
      fromLabel: change.from?.label.slice(0, 120) ?? null,
      toLabel: change.to?.label.slice(0, 120) ?? null,
    };
    const until = change.until?.toISOString() ?? null;
    const event: SessionEvent = { type: "account.switched", ...labels, reason: change.reason, until };
    await this.deps.realtime.appendEvent(tx, wsTopic(s.id), EventTypes.workSessionEvent, {
      at: new Date().toISOString(),
      event,
    });
    await this.deps.audit.record(tx, {
      action: "account_pool.switched",
      resourceType: "work_session",
      resourceId: s.id,
      sessionId: s.id,
      deviceId: s.deviceId,
      metadata: {
        provider: POOL_PROVIDER_OF_RUNTIME[s.runtime],
        fromAccountId,
        toAccountId: toId,
        ...labels,
        reason: change.reason,
        until,
      },
    });
    await this.emitSession(tx, s.id);
  }

  /**
   * 07.18 (PD-02): the hub could not open the pool token a command named. A live account whose seal does not open
   * needs its token entered again (`needs_sign_in`), so the next check moves the session on and never loops on it.
   */
  private async accountUnavailable(tx: Tx, cmd: DeviceCommandRow): Promise<void> {
    const stored = tokenAccountOf(cmd.payload);
    if (!stored) return;
    await tx
      .update(accountPoolAccounts)
      .set({ credentialState: "needs_sign_in", updatedAt: sql`now()` })
      .where(and(eq(accountPoolAccounts.id, stored.accountId), isNull(accountPoolAccounts.removedAt)));
  }

  /**
   * A turn that may not run (P-07: its author's access; 06.1 P-08: images for a model that cannot read them; 07.16
   * Pitfall 10, `bot_not_allowed`: the bot's profile is not active for this turn): failed, audited, never sent; the
   * arbiter moves to the next prompt.
   */
  private async refusePrompt(
    tx: Tx,
    s: SessionRow,
    p: PromptRow,
    reason:
      | "access_revoked"
      | "mode_not_allowed"
      | PromptFilesDispatchRefusal
      | "bot_not_allowed"
      | "no_account",
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
      ...(p.authorAgentId ? { agentId: p.authorAgentId } : {}),
      deviceId: s.deviceId,
      sessionId: s.id,
      result: "denied",
      metadata: {
        promptId: p.id,
        authorUserId: p.authorUserId,
        ...(p.authorAgentId ? { authorAgentId: p.authorAgentId } : {}),
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
   *
   * 07.16 (D-04, PD-08, E4): a bot's session (`started_by_agent_id`) is decided with the bot's live layer joined to its
   * sponsor's controls while the profile is active, and with the sponsor's own controls when it is not (people keep
   * their control of the session); a bot turn in flight that its layer no longer allows is interrupted, a person's turn
   * never is by the bot's layer. A person's session takes the branch it always took.
   *
   * 07.13.1.1 (PD-03): `opts` (Assign to me only) keeps a Full access turn in flight running and names the cause in the
   * audit; every other caller passes none and behaves exactly as before. Answers whether a `session.configure` went out.
   */
  async reauthorize(
    tx: Tx,
    s: SessionRow,
    reason: ReauthorizeReason,
    policy?: WorkZonePolicy,
    actorUserId: string | null = null,
    opts: ReauthorizeOptions = {},
  ): Promise<{ downgraded: boolean }> {
    const actor = actorUserId ? { userId: actorUserId } : {};
    const cause = opts.cause ? { cause: opts.cause } : {};
    const unchanged = { downgraded: false };
    if (!ACTIVE_STATES.includes(s.status)) return unchanged;
    const layer = s.startedByAgentId ? await botLayerForSession(tx, this.deps.perms, s) : null;
    const creator = await loadControlsContext(tx, this.deps.perms, {
      deviceId: s.deviceId,
      runtime: s.runtime,
      userId: s.createdBy,
      inSession: false,
      ...(policy ? { policy } : {}),
      ...(layer ? { agent: layer } : {}),
    });
    if (!creator) return unchanged;
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
      return unchanged;
    }
    const current = requestedSettings(s);
    const { next, changed } = clampToControls(current, buildRuntimeControls(s.runtime, creator.ctx, s.model));
    if (changed.length === 0) {
      if (s.startedByAgentId) await this.interruptBotTurn(tx, s, creator.ctx, layer, reason, actor);
      return unchanged;
    }
    const from = current.permissionMode;
    const to = next.permissionMode ?? from;
    let interruptSent = false;
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
      metadata: {
        reason,
        changed,
        from: pickSettings(current, changed),
        to: pickSettings(next, changed),
        ...cause,
      },
    });
    if (from === "fullAccess" && to !== "fullAccess") {
      await this.deps.audit.record(tx, {
        ...actor,
        action: "work_session.full_access_left",
        resourceType: "work_session",
        resourceId: s.id,
        deviceId: s.deviceId,
        sessionId: s.id,
        metadata: { from, to, source: reason, ...cause },
      });
      // 07.13.1.1 (D-05): an owner transfer lets the running turn finish; every other re-check cuts it as before.
      const fullTurn =
        opts.interruptInFlight === false
          ? []
          : await tx
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
        interruptSent = true;
      }
    }
    if (s.startedByAgentId && !interruptSent) {
      await this.interruptBotTurn(tx, s, creator.ctx, layer, reason, actor);
    }
    // WR-07: the live card shows the mode and model every reader of the channel sees; it follows the downgrade.
    await this.syncBotCard(tx, s);
    await this.emitSession(tx, s.id);
    return { downgraded: true };
  }

  /**
   * 07.16 (E4, PD-08): the bot's turn in flight in its session, interrupted when the bot may no longer run it at its
   * mode: the profile is not active (or names another bot), or the layer (with the turn's own taint) no longer allows
   * the mode. A person's turn is left alone. Audited like an interrupt, with the turn and the bot.
   */
  private async interruptBotTurn(
    tx: Tx,
    s: SessionRow,
    ctx: ControlsContext,
    layer: AgentControlsLayer | null,
    reason: ReauthorizeReason,
    actor: { userId?: string },
  ): Promise<void> {
    const [turn] = await tx
      .select({
        id: workPrompts.id,
        permissionMode: workPrompts.permissionMode,
        authorAgentId: workPrompts.authorAgentId,
        tainted: workPrompts.tainted,
      })
      .from(workPrompts)
      .where(
        and(
          eq(workPrompts.workSessionId, s.id),
          inArray(workPrompts.status, IN_FLIGHT),
          isNotNull(workPrompts.authorAgentId),
        ),
      )
      .limit(1);
    if (!turn) return;
    if (layer && layer.agentId === turn.authorAgentId && turn.permissionMode) {
      const agent = turn.tainted ? { ...layer, tainted: true } : layer;
      const allowed = highestAvailableMode({ ...ctx, agent }, s.model, turn.permissionMode);
      if (allowed === turn.permissionMode) return;
    }
    await this.deps.hub.enqueue(tx, {
      deviceId: s.deviceId,
      workSessionId: s.id,
      kind: "interrupt",
      payload: {},
    });
    await this.deps.audit.record(tx, {
      ...actor,
      action: "work_session.interrupted",
      resourceType: "work_session",
      resourceId: s.id,
      ...(turn.authorAgentId ? { agentId: turn.authorAgentId } : {}),
      deviceId: s.deviceId,
      sessionId: s.id,
      metadata: {
        reason,
        promptId: turn.id,
        authorAgentId: turn.authorAgentId,
        mode: turn.permissionMode,
        botActive: layer !== null,
      },
    });
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
      let policy: WorkZonePolicy | undefined;
      for (const { id } of rows) {
        const s = await this.lock(tx, id);
        if (!s) continue;
        // 07.16 (D-19, PD-08): the hello rewrote the device's opt-in and isolated mark without a sweep; a bot session
        // is re-decided now (lowered, its bot turn interrupted), before anything is re-attached or dispatched.
        if (s.startedByAgentId) {
          policy ??= await loadWorkZonePolicy(tx);
          await this.reauthorize(tx, s, "device_opt_out", policy);
          if (!ACTIVE_STATES.includes(s.status)) continue;
        }
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
        // 07.17.1 PD-27: a prompt the old daemon never started runs on the new one; only a running turn is lost.
        await this.requeueUnstarted(tx, s);
        await this.failInFlight(tx, s, "The device restarted");
        await this.restart(tx, s);
      }
    });
  }

  /**
   * 07.17.1 PD-27: after a daemon restart, a prompt still `dispatched` (sent, never reported running: e.g. held at the
   * OCW runtime self-update's gate) never started on the old daemon. It goes back to `queued` at its own place (the
   * head of the queue) and its stale `prompt` command is closed through the device hub, so the new daemon never gets
   * it; the arbiter dispatches the prompt once more after the `session.start` that re-attaches the session is acked.
   * Call with the session row LOCKED, before `failInFlight` (which then fails only `running` prompts).
   */
  private async requeueUnstarted(tx: Tx, s: SessionRow): Promise<void> {
    const requeued = await tx
      .update(workPrompts)
      .set({ status: "queued", dispatchedAt: null })
      .where(and(eq(workPrompts.workSessionId, s.id), eq(workPrompts.status, "dispatched")))
      .returning();
    if (requeued.length === 0) return;
    const stale = await tx
      .select({ id: deviceCommands.id })
      .from(deviceCommands)
      .where(
        and(
          eq(deviceCommands.workSessionId, s.id),
          eq(deviceCommands.kind, "prompt"),
          inArray(deviceCommands.status, ["pending", "sent"]),
          inArray(
            sql`${deviceCommands.payload}->>'promptId'`,
            requeued.map((p) => p.id),
          ),
        ),
      );
    await this.deps.hub.supersedeCommands(
      tx,
      s.deviceId,
      stale.map((c) => c.id),
    );
    for (const p of requeued) await this.emitPrompt(tx, p);
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

  /**
   * Inside the hub's flush transaction (database work only): 06.1-02 (P-03) a prompt's images, and 07.18 (PD-02) the
   * token of the pool account a `session.start` or `prompt` names, opened from the secret store. The plan lives in
   * memory only; undefined when the stored payload is sent as is.
   */
  async prepareCommand(tx: Tx, _device: DeviceRef, cmd: DeviceCommandRow): Promise<unknown> {
    const images = await preparePromptImages(tx, cmd);
    const account = await this.prepareAccount(tx, cmd);
    const browser = await this.prepareBrowser(tx, cmd);
    const sessionTools = await this.prepareSessionTools(tx, cmd);
    if (
      images === undefined &&
      account === undefined &&
      browser === undefined &&
      sessionTools === undefined
    ) {
      return undefined;
    }
    return {
      images,
      account,
      ...(browser ? { browser } : {}),
      ...(sessionTools ? { sessionTools } : {}),
    } satisfies CommandPlan;
  }

  /**
   * 07.13.1.1 (D-07, D-08, PD-10, PD-13): what the session's agent may do with `ocw_session` this turn, decided now for
   * a `session.start` or `prompt`: rename while no person typed the title, with the naming rules of the organization
   * and the session's team project. Undefined for every other command. Sent to every device: an older daemon strips
   * the key (non-strict payloads) and offers no tool.
   *
   * ADR-0047 § 7 (CR-01): the rules are text other people write, so they reach the live agent only beside the rename
   * tool, and never while the turn (or the session) runs in Full access, where nothing a step asks for needs an
   * approval. The title call keeps them.
   */
  private async prepareSessionTools(tx: Tx, cmd: DeviceCommandRow): Promise<SessionToolsGrant | undefined> {
    const sessionId = cmd.workSessionId;
    if (!sessionId || (cmd.kind !== "session.start" && cmd.kind !== "prompt")) return undefined;
    const [s] = await tx
      .select({
        titleSource: workSessions.titleSource,
        projectId: workSessions.projectId,
        permissionMode: workSessions.permissionMode,
      })
      .from(workSessions)
      .where(eq(workSessions.id, sessionId));
    if (!s) return undefined;
    const rename = s.titleSource !== "user";
    const fullAccess = cmd.payload.permissionMode === "fullAccess" || s.permissionMode === "fullAccess";
    return { rename, namingRules: rename && !fullAccess ? await namingRulesFor(tx, s) : null };
  }

  /**
   * 07.13 (D-10, PD-09, PD-20): the browser grant of a `session.start` (asker = the session's creator, or the bot that
   * started it) or a `prompt` (asker = the prompt's author, or the bot that wrote it), decided now from the live policy,
   * the device's opt-in and capability. Undefined for any other command and for a device without a browser version.
   */
  private async prepareBrowser(tx: Tx, cmd: DeviceCommandRow): Promise<SessionBrowserGrant | undefined> {
    const sessionId = cmd.workSessionId;
    if (!sessionId || (cmd.kind !== "session.start" && cmd.kind !== "prompt")) return undefined;
    let asker: Omit<BrowserAsker, "sessionId"> = { askerId: null, askerIsBot: false };
    const of = (userId: string, agentId: string | null): Omit<BrowserAsker, "sessionId"> =>
      agentId === null
        ? { askerId: userId, askerIsBot: false }
        : { askerId: agentId, askerIsBot: true, onBehalfOf: userId };
    if (cmd.kind === "session.start") {
      const [s] = await tx
        .select({ createdBy: workSessions.createdBy, agentId: workSessions.startedByAgentId })
        .from(workSessions)
        .where(eq(workSessions.id, sessionId));
      if (s) asker = of(s.createdBy, s.agentId);
    } else {
      const promptId = cmd.payload.promptId;
      const [p] =
        typeof promptId === "string" && UUID_RE.test(promptId)
          ? await tx
              .select({ userId: workPrompts.authorUserId, agentId: workPrompts.authorAgentId })
              .from(workPrompts)
              .where(and(eq(workPrompts.id, promptId), eq(workPrompts.workSessionId, sessionId)))
          : [];
      if (p) asker = of(p.userId, p.agentId);
    }
    return (await browserGrantFor(tx, this.deps.perms, { sessionId, ...asker })) ?? undefined;
  }

  /**
   * 07.18 (PD-02): a command naming a token account gets its token, or `{ token: null }` when it cannot be opened
   * (removed, no secret, a seal that does not open). Only commands of this device are flushed here, and the account is
   * the one the API itself wrote into the stored payload.
   */
  private async prepareAccount(tx: Tx, cmd: DeviceCommandRow): Promise<CommandPlan["account"]> {
    if (!this.deps.pool || (cmd.kind !== "session.start" && cmd.kind !== "prompt")) return undefined;
    const stored = tokenAccountOf(cmd.payload);
    if (!stored) return undefined;
    const row = await this.deps.pool.get(tx, stored.accountId);
    const token = row && row.kind === "token" ? await this.deps.pool.open(tx, row) : null;
    return { stored, token };
  }

  /**
   * After the flush transaction committed: 06.1-02 the image bytes, then 07.18 (PD-02) the token added to the copy that
   * is sent. Never written back. A token that could not be opened fails the command `account_unavailable`.
   */
  async hydrateCommand(
    _device: DeviceRef,
    cmd: DeviceCommandRow,
    plan: unknown,
  ): Promise<Record<string, unknown>> {
    const { images, account, browser, sessionTools } = plan as CommandPlan;
    if (account && account.token === null) {
      throw new CommandUndeliverableError(ACCOUNT_UNAVAILABLE, "The session's pool account is not available");
    }
    const payload = images ? await hydratePromptImages(this.deps.storage ?? null, cmd, images) : cmd.payload;
    // The sent copy only: `SessionAccount` with the token, on its way to this session's own device.
    const sent: SessionAccount | undefined = account?.token
      ? { ...account.stored, oauthToken: account.token }
      : undefined;
    // 07.13 (PD-09): then the turn's browser grant, and 07.13.1.1 (PD-10) its session tools grant, on the sent copy
    // only too (never written back).
    if (!sent && !browser && !sessionTools) return payload;
    return {
      ...payload,
      ...(sent ? { account: sent } : {}),
      ...(browser ? { browser } : {}),
      ...(sessionTools ? { sessionTools } : {}),
    };
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
        if (!ok && origin === "hub" && error === ACCOUNT_UNAVAILABLE && s.status !== "archived") {
          // 07.18 (PD-02): never sent; start again on an account whose token opens.
          await this.accountUnavailable(tx, cmd);
          await this.restart(tx, s);
          return;
        }
        if (!ok) {
          // Quick 261119-ngw: a worktree the device refused because the project has no git teaches the API that it
          // has none (an older daemon may never have said so), so the next bot start there runs in place.
          const noGit = cmd.payload.worktree === true && (error ?? "").includes(NO_GIT_WORKTREE_MESSAGE);
          if (noGit) {
            await tx
              .update(projects)
              .set({ git: false })
              .where(and(eq(projects.id, s.projectId), eq(projects.deviceId, device.deviceId)));
          }
          await this.failInFlight(tx, s, "The session could not start");
          await this.setStatus(tx, s, "failed", {
            lastError: noGit
              ? `${NO_GIT_WORKTREE_MESSAGE}. The project is now known to have no git: a new session there runs in the project folder, without a worktree.`
              : (error ?? "The session could not start"),
          });
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
      if (cmd.kind === "prompt") {
        // ADR-0045: the device answers a prompt only after its files landed (or failed to): close their transfers.
        const promptId = String((cmd.payload as { promptId?: unknown }).promptId ?? "");
        if (UUID_RE.test(promptId)) {
          const [author] = await tx
            .select({ userId: workPrompts.authorUserId })
            .from(workPrompts)
            .where(eq(workPrompts.id, promptId))
            .limit(1);
          await finishPromptFiles(tx, this.deps.audit, s, cmd, ok, author?.userId ?? null);
        }
      }
      if (cmd.kind === "prompt" && !ok) {
        const promptId = String((cmd.payload as { promptId?: unknown }).promptId ?? "");
        if (!UUID_RE.test(promptId)) return;
        if (origin === "hub" && error === ACCOUNT_UNAVAILABLE) {
          // 07.18 (PD-02): the prompt was never sent. Back at its place in the queue, never failed; the arbiter's
          // account check moves the session to the next account before it is dispatched again.
          await this.accountUnavailable(tx, cmd);
          const [p] = await tx
            .update(workPrompts)
            .set({ status: "queued", dispatchedAt: null })
            .where(and(eq(workPrompts.id, promptId), inArray(workPrompts.status, IN_FLIGHT)))
            .returning();
          if (p) await this.emitPrompt(tx, p);
          if (s.status === "running") await this.setStatus(tx, s, "idle");
          await this.tryDispatch(tx, s);
          return;
        }
        const undelivered = origin === "hub" ? UNDELIVERED_PROMPT.get(error ?? "") : undefined;
        if (undelivered) {
          await this.promptUndelivered(tx, s, promptId, error as UndeliveredReason, undelivered);
          return;
        }
        // ADR-0045: a prompt file's failure names the file ("Could not copy …"); its name never reads as a lost runtime.
        const fileFailure = (error ?? "").startsWith(PROMPT_FILE_FAILURE_PREFIX);
        if (/not active/i.test(error ?? "") && !fileFailure && s.status !== "archived") {
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
    // 07.13.1.1 (D-08, PD-06): the organization's and the project's naming rules; organization data, so the stored
    // title command may hold them (never logged, never audited). Absent when there are none.
    const namingRules = await namingRulesFor(tx, s);
    await this.deps.hub.enqueue(tx, {
      deviceId: s.deviceId,
      workSessionId: s.id,
      kind: "session.title",
      payload: {
        runtime: s.runtime,
        model: decision.model,
        prompt: text,
        ...(namingRules ? { namingRules } : {}),
      },
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
        ...(frame.git === false ? { git: false } : {}),
      };
      await this.deps.realtime.appendEvent(tx, wsTopic(s.id), EventTypes.workSessionChanges, changes);
    });
  }

  /**
   * 07.18 (D-06, D-07, D-08, PD-05, PD-08, PD-15, PD-16; E4, E11, E17): the device says the account of one of its
   * sessions reached its limit, before the turn's `prompt.completed`. The frame acts only when the session is this
   * device's, active, and uses exactly that account (null = the device's own login); anything else changes nothing.
   * The account cools until its reset (`auth_failed`: needs a new sign-in instead). When the frame names the turn still
   * in flight and it has switched fewer than `POOL_LIMITS.switchesPerTurn` times, the turn goes back to its place in the
   * queue (`account_switches + 1`) and the session moves to the strategy's next usable account (or, under fallback, to
   * the device's own signed-in login): the device's following `prompt.completed` finds nothing in flight and the arbiter
   * dispatches the same prompt again with the new account. Otherwise the turn fails as the device reports it and
   * `lastError` says why, with the earliest reset. A replayed frame changes nothing more: the session no longer uses
   * the account it names, or the account already cools until that reset.
   */
  async onAccountLimited(device: DeviceRef, frame: SessionAccountLimitedFrame): Promise<void> {
    const pool = this.deps.pool;
    if (!pool || !UUID_RE.test(frame.sessionId)) return;
    await this.deps.db.withTenant(this.sys(device), async (tx) => {
      const s = await this.lock(tx, frame.sessionId);
      if (!s || s.deviceId !== device.deviceId || !ACTIVE_STATES.includes(s.status)) return;
      // E11 (T-07.18-10-01): only the account this very session uses; another account, slot or organization is inert.
      if (frame.accountId !== s.poolAccountId) return;
      const state = await this.deviceAccountState(tx, s);
      if (!state.pool) return;
      const provider = POOL_PROVIDER_OF_RUNTIME[s.runtime];
      const now = new Date();
      const resetsAt = frame.resetsAt ? new Date(frame.resetsAt) : null;
      const authFailed = frame.reason === "auth_failed";
      let from: PoolAccountRow | null = null;
      let until: Date | null = null;
      if (s.poolAccountId !== null) {
        from = await pool.get(tx, s.poolAccountId);
        if (!from || from.provider !== provider) return;
        const report = { account: from, now, deviceId: device.deviceId, sessionId: s.id };
        until = authFailed
          ? (await markNeedsSignIn(tx, this.deps.audit, report)).until
          : (await markLimited(tx, this.deps.audit, { ...report, reason: frame.reason, resetsAt })).until;
      } else if (!authFailed && resetsAt) {
        // The device's own login has no row to cool; the switch line still says until when it is limited.
        until = cooldownUntil(resetsAt, now);
      }
      // Only the turn still in flight is re-run; a frame for a finished or unknown prompt only cools the account.
      if (frame.promptId === null || !UUID_RE.test(frame.promptId)) return;
      const [p] = await tx
        .select()
        .from(workPrompts)
        .where(
          and(
            eq(workPrompts.id, frame.promptId),
            eq(workPrompts.workSessionId, s.id),
            inArray(workPrompts.status, IN_FLIGHT),
          ),
        );
      if (!p) return;
      if (p.accountSwitches >= POOL_LIMITS.switchesPerTurn) {
        // PD-15, E4: the turn already moved three times; it fails as the device reports it.
        const earliest = await earliestPoolReset(tx, {
          provider,
          deviceId: s.deviceId,
          consumer: "work_zone",
          now,
        });
        await this.setStatus(tx, s, s.status, { lastError: everyAccountLimitedSentence(earliest) });
        return;
      }
      const picked = await pool.select(tx, {
        provider,
        deviceId: s.deviceId,
        consumer: "work_zone",
        now,
        exclude: from ? [from.id] : [],
      });
      // undefined = nowhere to go; null = the device's own login (PD-16), never when that login is what was limited.
      let to: PoolAccountRow | null | undefined;
      if ("row" in picked && storedSessionAccount(picked.row)) to = picked.row;
      else if (from !== null && picked.policy.fallbackToDeviceLogin && state.loggedIn) to = null;
      if (to === undefined) {
        // PD-16: no account for this turn; it fails as the device reports it. A session on the device's own login in an
        // organization without a pool keeps the runtime's own error.
        if ("none" in picked && (from !== null || !picked.poolEmpty)) {
          await this.setStatus(tx, s, s.status, { lastError: noAccountSentence(picked.earliestReset) });
        }
        return;
      }
      const [requeued] = await tx
        .update(workPrompts)
        .set({ status: "queued", dispatchedAt: null, accountSwitches: p.accountSwitches + 1 })
        .where(and(eq(workPrompts.id, p.id), inArray(workPrompts.status, IN_FLIGHT)))
        .returning();
      if (requeued) await this.emitPrompt(tx, requeued);
      await this.switchAccount(tx, s, {
        from,
        to,
        reason: authFailed ? "unavailable" : "limit",
        until: authFailed ? null : until,
      });
    });
  }

  async onEvent(device: DeviceRef, frame: EventFrame): Promise<void> {
    const ev = frame.event;
    // 07.18 (PD-14, E12, T-07.18-10-04): only the API writes these (e.g. `account.switched`); a device's is dropped
    // before it reaches the session's stream. Logged with the session id and the type, never the event body.
    if (SERVER_ONLY_SESSION_EVENTS.has(ev.type)) {
      this.deps.log.warn(
        { workSessionId: frame.sessionId, type: ev.type },
        "dropped a server-only session event sent by a device",
      );
      return;
    }
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
        // 07.13 (PD-10, T-07.13-07-05): the browser part only when it parses (else dropped, never stored as text). It is
        // shown, never trusted: who may answer comes from the API's own state (`browserApproverRule`).
        const browser = browserRequestOf(ev.browser);
        const request: StoredApprovalRequest = {
          tool: ev.tool,
          summary: ev.summary,
          paths: ev.paths,
          ...(browser ? { browser } : {}),
        };
        const [row] = await tx
          .insert(workApprovals)
          .values({
            id: ev.approvalId,
            organizationId: device.organizationId,
            workSessionId: s.id,
            request,
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
          // 07.13: the origin (`scheme://host:port`) only, never a path or page content.
          metadata: { tool: ev.tool, paths: ev.paths, ...(browser ? { origin: browser.origin } : {}) },
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
  if (ev.type === "approval.requested") {
    // 07.13 (T-07.13-07-05): a browser part that does not parse never reaches the stream or the table.
    const { browser: hint, ...rest } = ev;
    const browser = browserRequestOf(hint);
    return { ...rest, paths: onlyRelativePaths(ev.paths), ...(browser ? { browser } : {}) };
  }
  return ev;
}

/** A bot as a session or a prompt names it (name and handle), live bots only. */
type AgentNames = ReadonlyMap<string, { name: string; handle: string }>;

/**
 * The live bots among `ids`. A deleted bot (soft delete; a hard delete already cleared the column) is gone, so what
 * it proposed, wrote or started names no bot. One query, and none when no id is given.
 */
async function agentRefs(tx: Tx, ids: readonly string[]): Promise<AgentNames> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const found = await tx
    .select({ id: agents.id, name: agents.name, handle: agents.username })
    .from(agents)
    .where(and(inArray(agents.id, unique), isNull(agents.deletedAt)));
  return new Map(found.map((a) => [a.id, { name: a.name, handle: a.handle }]));
}

/**
 * Phase 07.5 (D-04, UI-SPEC Surface 3) and 07.16 (D-06): the bots that proposed or wrote these prompts, in one
 * lookup for both columns.
 */
function promptAgents(tx: Tx, rows: readonly PromptRow[]): Promise<AgentNames> {
  return agentRefs(
    tx,
    rows.flatMap((r) => [r.proposedByAgentId, r.authorAgentId].filter((id): id is string => id !== null)),
  );
}

function proposedByOf(r: PromptRow, names: AgentNames): WorkPrompt["proposedBy"] {
  const bot = r.proposedByAgentId ? names.get(r.proposedByAgentId) : undefined;
  return r.proposedByAgentId && bot !== undefined
    ? { agentId: r.proposedByAgentId, displayName: bot.name.slice(0, 200) }
    : null;
}

/** 07.16 (D-06): `agentId` as a stable reference with its name and handle; null when unset or deleted. */
function agentRefOf(agentId: string | null, names: AgentNames): WorkSessionAgentRef | null {
  const bot = agentId ? names.get(agentId) : undefined;
  return agentId && bot
    ? { agentId, displayName: bot.name.slice(0, 200), handle: bot.handle.slice(0, 64) }
    : null;
}

export function toPrompt(
  r: PromptRow,
  authorName: string | null,
  attachments: Attachment[] = [],
  /** Phase 07.5: the bot whose Work Zone proposal created this prompt (`proposedByOf`); null for a person's prompt. */
  proposedBy: WorkPrompt["proposedBy"] = null,
  /** 07.16 (D-06): the bot that wrote this prompt (`agentRefOf`); the author stays its sponsor. */
  authorAgent: WorkSessionAgentRef | null = null,
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
    authorAgent,
    // D-08: sent from a bot turn after outside content (or the first prompt of a proposal made after it).
    tainted: r.tainted,
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
  const browser = browserRequestOf((r.request as StoredApprovalRequest).browser);
  return {
    id: r.id,
    workSessionId: r.workSessionId,
    request: {
      tool: r.request.tool,
      summary: r.request.summary,
      paths: onlyRelativePaths(r.request.paths ?? []),
      ...(browser ? { browser } : {}),
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
