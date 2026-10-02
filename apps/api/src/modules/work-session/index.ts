import { workSessions } from "@ocw/db";
import { eq } from "drizzle-orm";
import type { ApiModule, Core } from "../../core";
import type { DeviceHub } from "../device";
import { registerWorkSessionRoutes } from "./routes";
import { WorkSessionService } from "./service";

export { ACTIVE_STATES, WorkSessionService, wsTopic } from "./service";

/**
 * work-session module: Work Zone sessions on a paired device, the shared prompt queue with its server-side
 * arbiter (one execution authority), approvals, interrupt, diff relay, and ingestion of Unified Session
 * Event Protocol events from the Device Link (it is the device hub's session handler).
 */
export function createWorkSessionModule(core: Core, hub: DeviceHub): ApiModule {
  const service = new WorkSessionService({
    db: core.db,
    realtime: core.realtime,
    audit: core.audit,
    hub,
    log: core.log,
  });
  hub.setSessionHandler(service);

  // Any member of the organization may follow a work session (RLS scopes the lookup to the org).
  core.realtime.registerTopicAuthorizer("ws", async (auth, workSessionId) =>
    core.db.withTenant({ organizationId: auth.organizationId, userId: auth.userId }, async (tx) => {
      const rows = await tx
        .select({ id: workSessions.id })
        .from(workSessions)
        .where(eq(workSessions.id, workSessionId));
      return rows.length > 0;
    }),
  );

  return {
    name: "work-session",
    register(app) {
      registerWorkSessionRoutes(app, core, hub, service);
    },
  };
}
