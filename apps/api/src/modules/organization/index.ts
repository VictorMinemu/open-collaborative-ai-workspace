import {
  EventTypes,
  MemberUpdatedPayload,
  MyPermissions,
  PermissionRulesUpdatedPayload,
  UnitsUpdatedPayload,
} from "@ocw/contracts";
import { type ApiModule, type Core, tenant } from "../../core";
import { registerMemberRoutes } from "./members";
import { orgResource, userResource } from "./permissions/policy";
import { createPermissionService } from "./permissions/service";
import { registerRuleRoutes } from "./rules";
import { registerUnitRoutes } from "./units";

export { listMembers, memberDirectory } from "./members";

export { AuthzDeniedError } from "./permissions/errors";
export { loadPrincipalFacts, type PrincipalRef } from "./permissions/facts";
export {
  type AgentFacts,
  agentResource,
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

/** `member.updated` fields that change what a member may read (the rest are profile fields). */
const ACCESS_FIELDS = new Set(["role", "status"]);

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

  // Live re-authorisation (RT-01, D-05): every access change this module makes re-decides the affected live
  // subscriptions through the topic authorizers (the resolver). Topics are omitted: a role, rule or unit change can
  // change any topic the user reads. Profile-only member updates change nobody's access and trigger nothing.
  core.realtime.registerSubscriptionInvalidator(EventTypes.memberUpdated, (topic, payload) => {
    if (!topic.startsWith("org:")) return null;
    const parsed = MemberUpdatedPayload.safeParse(payload);
    if (!parsed.success) return null;
    const { userId, changed } = parsed.data;
    return changed.some((c) => ACCESS_FIELDS.has(c)) ? { userIds: [userId] } : null;
  });
  // Unit memberships, lead roles and moves change the facts of everyone below the unit, and a rule can name a role
  // or everyone: the whole organization is re-decided (coalesced and bounded by the gateway queue).
  core.realtime.registerSubscriptionInvalidator(EventTypes.unitsUpdated, (topic, payload) =>
    topic.startsWith("org:") && UnitsUpdatedPayload.safeParse(payload).success ? {} : null,
  );
  core.realtime.registerSubscriptionInvalidator(EventTypes.permissionRulesUpdated, (topic, payload) =>
    topic.startsWith("org:") && PermissionRulesUpdatedPayload.safeParse(payload).success ? {} : null,
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
