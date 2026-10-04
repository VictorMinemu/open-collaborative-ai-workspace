import type { TenantDb } from "@ocw/db";
import type { ApiModule } from "../../core";
import type { AuditService } from "../audit";
import type { RealtimeService } from "../realtime";
import { createInvitationService, registerInvitationRoutes } from "./invitations";
import { registerIdentityRoutes } from "./routes";
import type { IdentityService } from "./service";

export { type Auth, createAuth } from "./auth";
export type { InvitationService } from "./invitations";
export { auditVia, type IdentityResult, IdentityService } from "./service";

/** Mounts /api/v1/{setup,me,invitations} and the better-auth allowlist under /api/auth. */
export function createIdentityModule(deps: {
  identity: IdentityService;
  db: TenantDb;
  audit: AuditService;
  realtime: RealtimeService;
  apiUrl: string;
}): ApiModule {
  const invitations = createInvitationService(deps.identity);
  return {
    name: "identity",
    prefix: "",
    register: (app) => {
      registerIdentityRoutes(app, deps);
      registerInvitationRoutes(app, { ...deps, invitations });
    },
  };
}
