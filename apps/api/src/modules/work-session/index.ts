import { devices, type Tx, workSessions } from "@ocw/db";
import { eq } from "drizzle-orm";
import type { ApiModule, Core } from "../../core";
import type { ObjectStorage } from "../artifact";
import type { DeviceHub } from "../device";
import { createPermissionService, workSessionResource } from "../organization";
import { registerWorkSessionRoutes } from "./routes";
import { WorkSessionService } from "./service";
import {
  createWorkSession,
  type WorkSessionActor,
  type WorkSessionStartInput,
  type WorkSessionStartOptions,
  type WorkSessionStartResult,
} from "./start";

export { createWorkSessionAttachmentScope } from "./images";
export { loadWorkZonePolicy } from "./policy";
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
}

/**
 * work-session module: Work Zone sessions on a paired device, the shared prompt queue with its server-side
 * arbiter (one execution authority), approvals, interrupt, diff relay, and ingestion of Unified Session
 * Event Protocol events from the Device Link (it is the device hub's session handler).
 */
export function createWorkSessionModule(
  core: Core,
  hub: DeviceHub,
  deps: { storage?: ObjectStorage | null } = {},
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

  // Following a session's stream is `work_session.read` on that session (RLS scopes the lookup to the org).
  core.realtime.registerTopicAuthorizer("ws", async (auth, workSessionId) =>
    core.db.withTenant({ organizationId: auth.organizationId, userId: auth.userId }, async (tx) => {
      const [row] = await tx
        .select({
          createdBy: workSessions.createdBy,
          owner: devices.ownerUserId,
          revokedAt: devices.revokedAt,
        })
        .from(workSessions)
        .innerJoin(devices, eq(devices.id, workSessions.deviceId))
        .where(eq(workSessions.id, workSessionId));
      if (!row) return false;
      const facts = workSessionResource(
        { createdBy: row.createdBy, deviceOwnerUserId: row.owner, deviceRevoked: row.revokedAt !== null },
        auth.userId,
      );
      const { allowed } = await perms.decide(
        tx,
        { kind: "user", userId: auth.userId },
        "work_session.read",
        facts,
      );
      return allowed;
    }),
  );

  return {
    name: "work-session",
    register(app) {
      registerWorkSessionRoutes(app, core, hub, service);
    },
    start(tx, actor, input, opts) {
      return createWorkSession(tx, { core, perms, svc: service, hub }, actor, input, opts);
    },
  };
}
