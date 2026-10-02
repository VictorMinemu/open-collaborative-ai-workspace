import type { TenantDb } from "@ocw/db";
import type { ApiModule } from "../../core";
import type { AuditService } from "../audit";
import { registerIdentityRoutes } from "./routes";
import type { IdentityService } from "./service";

export { type Auth, createAuth } from "./auth";
export { type IdentityResult, IdentityService } from "./service";

/** Mounts /api/v1/{setup,me,invitations} and the better-auth allowlist under /api/auth. */
export function createIdentityModule(deps: {
  identity: IdentityService;
  db: TenantDb;
  audit: AuditService;
  apiUrl: string;
}): ApiModule {
  return { name: "identity", prefix: "", register: (app) => registerIdentityRoutes(app, deps) };
}
