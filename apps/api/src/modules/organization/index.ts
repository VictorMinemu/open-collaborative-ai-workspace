import { MyPermissions } from "@ocw/contracts";
import { type ApiModule, type Core, tenant } from "../../core";
import { registerMemberRoutes } from "./members";
import { orgResource, userResource } from "./permissions/policy";
import { createPermissionService } from "./permissions/service";
import { registerRuleRoutes } from "./rules";
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

  // Realtime topics owned by this module, decided by the resolver (T-02-06-06). The tenant boundary is
  // checked first: a session only ever subscribes inside its own organization.
  core.realtime.registerTopicAuthorizer("org", async (auth, id) => {
    if (id !== auth.organizationId) return false;
    return core.db.withTenant(
      { organizationId: auth.organizationId, userId: auth.userId },
      async (tx) =>
        (await perms.decide(tx, { kind: "user", userId: auth.userId }, "org.read", orgResource())).allowed,
    );
  });
  core.realtime.registerTopicAuthorizer("user", async (auth, id) =>
    core.db.withTenant(
      { organizationId: auth.organizationId, userId: auth.userId },
      async (tx) =>
        (
          await perms.decide(
            tx,
            { kind: "user", userId: auth.userId },
            "account.manage",
            userResource(id, auth.userId),
          )
        ).allowed,
    ),
  );

  return {
    name: "organization",
    register(app) {
      registerMemberRoutes(app, core, perms);
      registerUnitRoutes(app, core, perms);
      registerRuleRoutes(app, core, perms);

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
