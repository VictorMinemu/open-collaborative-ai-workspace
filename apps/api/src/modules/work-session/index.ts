import { type Tx, workSessions } from "@ocw/db";
import { eq } from "drizzle-orm";
import type { ApiModule, Core } from "../../core";
import type { ApprovalService } from "../approval";
import type { ObjectStorage } from "../artifact";
import type { DeviceHub } from "../device";
import { createPermissionService } from "../organization";
import { sessionFacts } from "./facts";
import { registerProjectRoutes } from "./projects";
import {
  listProposableProjects,
  proposeWorkZone,
  type WorkZoneProposalService,
  workZoneStartKind,
} from "./proposals";
import { registerWorkSessionRoutes } from "./routes";
import { WorkSessionService } from "./service";
import {
  createWorkSession,
  type WorkSessionActor,
  type WorkSessionStartInput,
  type WorkSessionStartOptions,
  type WorkSessionStartResult,
} from "./start";

export { sessionFacts, sessionFactsForUsers } from "./facts";
export { createWorkSessionAttachmentScope } from "./images";
export { loadWorkZonePolicy } from "./policy";
export { projectFacts } from "./projects";
export { WORK_ZONE_PROPOSAL_RESOURCE, type WorkZoneProposalService } from "./proposals";
export { ACTIVE_STATES, type ReauthorizeReason, WorkSessionService, wsTopic } from "./service";
export type {
  WorkSessionActor,
  WorkSessionStartCode,
  WorkSessionStartFailure,
  WorkSessionStartInput,
  WorkSessionStartOptions,
  WorkSessionStartResult,
} from "./start";

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
  });
  hub.setSessionHandler(service);

  // Following a session's stream is `work_session.read` on that session, with the facts of `sessionFacts` (the session's
  // audience, D-04/D-09; RLS scopes the lookup to the org). Nobody outside the audience subscribes `ws:<id>`.
  core.realtime.registerTopicAuthorizer("ws", async (auth, workSessionId) =>
    core.db.withTenant({ organizationId: auth.organizationId, userId: auth.userId }, async (tx) => {
      const [row] = await tx
        .select({ id: workSessions.id, createdBy: workSessions.createdBy, deviceId: workSessions.deviceId })
        .from(workSessions)
        .where(eq(workSessions.id, workSessionId));
      if (!row) return false;
      const { allowed } = await perms.decide(
        tx,
        { kind: "user", userId: auth.userId },
        "work_session.read",
        await sessionFacts(tx, auth.userId, row),
      );
      return allowed;
    }),
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

  return {
    name: "work-session",
    register(app) {
      registerWorkSessionRoutes(app, core, hub, service);
      registerProjectRoutes(app, core, perms);
    },
    start,
    proposals,
  };
}
