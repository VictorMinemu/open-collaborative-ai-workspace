import { MyPermissions } from "@ocw/contracts";
import { type ApiModule, type Core, tenant } from "../../core";
import { registerMemberRoutes } from "./members";
import { createPermissionService } from "./permissions/service";
import { registerUnitRoutes } from "./units";

export { listMembers, memberDirectory } from "./members";

export { AuthzDeniedError } from "./permissions/errors";
export type { PrincipalRef } from "./permissions/facts";
export {
  type ChannelFacts,
  channelMemberResource,
  channelResource,
  deviceResource,
  invitationResource,
  memberResource,
  orgResource,
  unitResource,
  userResource,
  workSessionResource,
} from "./permissions/policy";
export type {
  OnBehalfOf,
  PrincipalFacts,
  Relation,
  Resolution,
  ResourceFacts,
  ResourceState,
  ResourceType,
  RuleFact,
} from "./permissions/resolve";
export {
  createPermissionService,
  type DecideOptions,
  type PermissionService,
  principalOf,
  principalTenant,
  recordAuthzDenial,
} from "./permissions/service";

export function createOrganizationModule(core: Core): ApiModule {
  const perms = createPermissionService(core);
  return {
    name: "organization",
    register(app) {
      registerMemberRoutes(app, core, perms);
      registerUnitRoutes(app, core, perms);

      app.get(
        "/me/permissions",
        {
          config: { authz: "user" },
          preHandler: core.identity.requireUser,
          schema: { tags: ["organization"], response: { 200: MyPermissions } },
        },
        async (req) => core.db.withTenant(tenant(req), (tx) => perms.myPermissions(req, tx)),
      );
    },
  };
}
