import {
  type BotWorkSessionReadModel,
  EventTypes,
  WorkProjectUpdatedEvent,
  type WorkSession,
} from "@ocw/contracts";
import { orgMembers, permissionRules, type Tx, workSessions } from "@ocw/db";
import { eq, sql } from "drizzle-orm";
import type { ApiModule, Core } from "../../core";
import type { ApprovalService } from "../approval";
import type { ObjectStorage } from "../artifact";
import type { DeviceHub } from "../device";
import { createPermissionService } from "../organization";
import { type BotFiles, createBotFiles } from "./bot-files";
import { registerBotProfileRoutes } from "./bot-profile";
import { type BotReadParams, readBotWorkSession } from "./bot-read";
import { type BotSessions, createBotSessions } from "./bot-sessions";
import { sessionFacts } from "./facts";
import { registerFileTransferRoutes } from "./file-transfer-routes";
import { loadWorkZonePolicy, serverFileMaxBytes } from "./policy";
import { registerProjectRoutes } from "./projects";
import {
  listProposableProjects,
  proposeWorkZone,
  type WorkZoneProposalService,
  workZoneStartKind,
} from "./proposals";
import { revokeCauseOf } from "./revoke-cause";
import { registerWorkSessionRoutes } from "./routes";
import { WorkSessionService } from "./service";
import {
  createWorkSession,
  type WorkSessionActor,
  type WorkSessionStartInput,
  type WorkSessionStartOptions,
  type WorkSessionStartResult,
} from "./start";
import { withoutViewerFields } from "./viewer-fields";

// 07.16-20 (PD-12, PD-16): the wake handler refreshes the live card with the start's own composer.
export { composeWorkSessionCard } from "./bot-card";
// 07.17.1.1-11 (PD-06, PD-16): the file routes' service types (the service itself is `WorkSessionModule.botFiles`).
export type {
  BotFileAuditFacts,
  BotFileFinished,
  BotFilePrepared,
  BotFiles,
  BotFileUploadParams,
} from "./bot-files";
// 07.16-11 (PD-17): delivery asks whether a bot's turn is offered the Work Zone tools, and with which context.
export { workZoneOfferFor } from "./bot-offer";
// 07.16-07 (PD-04 … PD-06): the start route, the arbiter, the offer and the web read a bot's profile status.
export {
  type BotProfileRow,
  type BotProfileStatus,
  botLayerForSession,
  loadBotProfile,
  profileScopeRefusal,
  profileStatus,
} from "./bot-profile";
// 07.16-17 (PD-14, D-10): what a bot reads about its own session; 07.16-20's wake names the same deciders.
export { type BotReadParams, sessionDeciders } from "./bot-read";
// 07.16-15 (PD-03, PD-10 … PD-13): a bot's own start, its audience, its card and the one ownership rule; 07.16-16 its
// prompt and stop, and the one audit builder of the bot's Work Zone routes.
export {
  auditBotWorkSession,
  type BotSessions,
  type BotWorkSessionRow,
  botSessionAudience,
  type ConversationReaders,
  ownBotSession,
  refusedAnswer,
} from "./bot-sessions";
export { sessionFacts, sessionFactsForUsers } from "./facts";
export { createWorkSessionAttachmentScope } from "./images";
export type { OrgQueueOptions, OrgTask } from "./org-queue";
export { loadWorkZonePolicy } from "./policy";
export { projectFacts } from "./projects";
export { WORK_ZONE_PROPOSAL_RESOURCE, type WorkZoneProposalService } from "./proposals";
export { revokeCauseOf } from "./revoke-cause";
export {
  ACTIVE_STATES,
  BACKGROUND_DRAIN_MS,
  type ReauthorizeReason,
  WorkSessionService,
  wsTopic,
} from "./service";
export type {
  WorkSessionActor,
  WorkSessionStartCode,
  WorkSessionStartFailure,
  WorkSessionStartInput,
  WorkSessionStartOptions,
  WorkSessionStartResult,
} from "./start";
// 07.6-13 (D-11): the digest names a session's team project with the same per-viewer decision (07.10, PD-04).
export { projectNamedFor, type SessionProject, type ViewerFilter } from "./viewer-fields";

/** The work-session module object: its routes, and session creation for other modules (07.5-08 proposals). */
export interface WorkSessionModule extends ApiModule {
  /**
   * Start a session for `actor` in their own tenant transaction, with the checks of `POST /work-sessions`. A Work
   * Zone proposal passes only projectId, deviceId, runtime and prompt (never a mode: it starts at `default` or lower).
   */
  start(
    tx: Tx,
    actor: WorkSessionActor,
    input: WorkSessionStartInput,
    opts?: WorkSessionStartOptions,
  ): Promise<WorkSessionStartResult>;
  /**
   * Work Zone proposals (07.5-08): the Agent Channel routes call these inside the turn's human's tenant transaction.
   * Null when the module was built without the approval service (no `work_zone.start` kind to request).
   */
  proposals: WorkZoneProposalService | null;
  /**
   * 07.16-15 (PD-03): a bot's own Work Zone sessions. The Agent Channel routes call these inside the bot's sponsor's
   * tenant transaction; every start goes through `start` above (`createWorkSession` with the agent layer).
   */
  bots: BotSessions;
  /**
   * 07.16-17 (PD-14): the bounded, redacted, repo-relative read of a bot's own session (`ocw_work_session_read`), in
   * the sponsor's tenant transaction, after the Agent Channel route found the session and claimed the call.
   */
  botRead(tx: Tx, p: BotReadParams): Promise<BotWorkSessionReadModel>;
  /**
   * 07.17.1.1-11 (D-02 … D-07, D-13): one file move between a bot's conversation and its own session. The Agent
   * Channel's file routes call `limitFor`, `prepare*` and `finish` inside their transactions and `deadlineFor` and
   * `waitForAck` between them (PD-06, PD-18).
   */
  botFiles: BotFiles;
}

/**
 * work-session module: Work Zone sessions on a paired device, the shared prompt queue with its server-side
 * arbiter (one execution authority), approvals, interrupt, diff relay, and ingestion of Unified Session
 * Event Protocol events from the Device Link (it is the device hub's session handler).
 */
export function createWorkSessionModule(
  core: Core,
  hub: DeviceHub,
  deps: {
    storage?: ObjectStorage | null;
    /** 07.5-08: the approve-and-apply primitive, where the `work_zone.start` kind is registered. */
    approvals?: ApprovalService | null;
    /**
     * 07.17.1.1 (PD-18), test hook: the bot file transfer deadline for a size. Absent in production
     * (`transferDeadlineMs`); a test stack sets it through `botFileDeadlineMs`, never through the environment.
     */
    botFileDeadlineMs?: (bytes: number) => number;
    /** 07.17.1.1 review WR-01, test hook: a shorter idle cut for a transfer stream (`BOT_FILE_LIMITS.transferIdleMs`). */
    botFileTransferIdleMs?: number;
  } = {},
): WorkSessionModule {
  const perms = createPermissionService(core);
  const service = new WorkSessionService({
    db: core.db,
    realtime: core.realtime,
    audit: core.audit,
    hub,
    log: core.log,
    perms,
    storage: deps.storage ?? null,
    // 07.6 (AUTO-06): a finished session enqueues its memory summary job.
    jobs: core.jobs,
  });
  hub.setSessionHandler(service);
  // 07.11 (D-02, PD-03): the org's runtime updates level reaches the device module only through this source.
  hub.setRuntimePolicySource(async (tx) => (await loadWorkZonePolicy(tx)).runtimeUpdates);

  // Following a session's stream is `work_session.read` on that session, with the facts of `sessionFacts` (the session's
  // audience, D-04/D-09; RLS scopes the lookup to the org). Nobody outside the audience subscribes `ws:<id>`. A refusal
  // carries why, as a code (D-13), for the `revoked` frame of a live re-decision.
  core.realtime.registerTopicAuthorizer("ws", async (auth, workSessionId) =>
    core.db.withTenant({ organizationId: auth.organizationId, userId: auth.userId }, async (tx) => {
      const [row] = await tx
        .select({ id: workSessions.id, createdBy: workSessions.createdBy, deviceId: workSessions.deviceId })
        .from(workSessions)
        .where(eq(workSessions.id, workSessionId));
      if (!row) {
        // 07.9-12: the audience backstop hides a session outside the person's relations, which is exactly the
        // resolver's `not_in_audience`. A live subscription the audience just removed is told so (`visibility`); a
        // first subscribe never shows the cause (`authorizeTopic` is a boolean), so no id is confirmed to anyone.
        const exists = await tx.execute(sql`select app.work_session_exists(${workSessionId}::uuid) as e`);
        if ((exists.rows[0] as { e: boolean } | undefined)?.e !== true) return false;
        // The backstop also hides every session from a member who is no longer active; the resolver would refuse them
        // as a principal before any audience check, so the cause is theirs (`role`), not the session's (07.9 ledger).
        const [member] = await tx
          .select({ deactivatedAt: orgMembers.deactivatedAt })
          .from(orgMembers)
          .where(eq(orgMembers.userId, auth.userId));
        return {
          allowed: false as const,
          cause:
            !member || member.deactivatedAt !== null
              ? revokeCauseOf({ layer: "user", reason: "deactivated" })
              : revokeCauseOf({ layer: "resource", reason: "not_in_audience" }),
        };
      }
      const { allowed, denial } = await perms.decide(
        tx,
        { kind: "user", userId: auth.userId },
        "work_session.read",
        await sessionFacts(tx, auth.userId, row),
      );
      if (allowed) return true;
      let rulePermission: string | null = null;
      if (denial?.ruleId) {
        const [rule] = await tx
          .select({ permission: permissionRules.permission })
          .from(permissionRules)
          .where(eq(permissionRules.id, denial.ruleId));
        rulePermission = rule?.permission ?? null;
      }
      return { allowed: false as const, cause: revokeCauseOf(denial, rulePermission) };
    }),
  );
  // 07.10-07 (LO-02): `ws:` snapshots stored before 07.10 still name the session's team project; a replay strips the
  // per-viewer fields on read, so the shared stream is viewer-neutral from seq 0, as it is live (PD-03).
  core.realtime.registerReplayMapper("ws", (type, payload) =>
    type === EventTypes.workSessionUpdated && payload !== null && typeof payload === "object"
      ? withoutViewerFields(payload as WorkSession)
      : payload,
  );
  // A team project's teams or repositories changed (P-09): who may see its sessions changed for anyone in the
  // organization, so every live subscription is re-decided (coalesced by the gateway queue), as for `units.updated`.
  core.realtime.registerSubscriptionInvalidator(EventTypes.workProjectUpdated, (topic, payload) =>
    topic.startsWith("org:") && WorkProjectUpdatedEvent.safeParse(payload).success ? {} : null,
  );

  const start: WorkSessionModule["start"] = (tx, actor, input, opts) =>
    createWorkSession(tx, { core, perms, svc: service, hub }, actor, input, opts);

  // 07.5-08 (D-03, P-08): Start on a bot's proposal is `createWorkSession` for the person who pressed it.
  let proposals: WorkZoneProposalService | null = null;
  if (deps.approvals) {
    const approvals = deps.approvals;
    approvals.register(workZoneStartKind({ perms, start }));
    const proposalDeps = { core, perms, start, approvals };
    proposals = {
      propose: (tx, p) => proposeWorkZone(tx, proposalDeps, p),
      listProjects: (tx, p) => listProposableProjects(tx, proposalDeps, p),
    };
  }

  // 07.16-15 (PD-03): a bot's start is `createWorkSession` for its sponsor, with the bot's caps as the agent layer.
  // 07.16-16 (PD-13): its follow-up prompts and its stop are the bodies people's routes use (`controller.ts`).
  const bots = createBotSessions({
    core,
    start,
    controller: { core, svc: service, startDeps: { core, perms, svc: service, hub } },
  });
  // 07.17.1.1-11 (PD-06 … PD-18): a bot's file moves, decided for its sponsor and bounded by the server's ceiling.
  const botFiles = createBotFiles({
    core,
    hub,
    svc: service,
    perms,
    storage: deps.storage ?? null,
    serverMaxBytes: serverFileMaxBytes(core.env),
    ...(deps.botFileDeadlineMs ? { deadlineMs: deps.botFileDeadlineMs } : {}),
  });

  return {
    name: "work-session",
    register(app) {
      registerWorkSessionRoutes(app, core, hub, service);
      registerProjectRoutes(app, core, perms);
      // 07.16 (D-01 … D-03): a bot's Work Zone profile and the per-bot device consent; changes sweep the device.
      registerBotProfileRoutes(app, core, perms, service);
      // 07.17.1.1 (D-08, PD-05): the device side of a bot's file move, `GET /api/v1/runtime/files/:transferId`.
      registerFileTransferRoutes(app, core, {
        storage: deps.storage ?? null,
        ...(deps.botFileTransferIdleMs ? { idleMs: deps.botFileTransferIdleMs } : {}),
      });
    },
    start,
    proposals,
    bots,
    botRead: (tx, p) => readBotWorkSession(tx, { core, perms }, p),
    botFiles,
    // Shutdown (07.9 fan-out): the background queue drains for a bounded time, then what still waits is dropped.
    close: () => service.close(),
  };
}
