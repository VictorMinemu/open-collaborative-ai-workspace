import {
  MODULE_CATALOG,
  ModuleId,
  NON_DELEGABLE_PERMISSIONS,
  OrgRole,
  PERMISSION_SURFACE,
  Permission,
  permissionMatches,
  RuleSubjectKind,
} from "@ocw/contracts";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  agentResource,
  channelMemberResource,
  channelResource,
  deviceResource,
  invitationResource,
  moduleTargetResource,
  orgResource,
  unitResource,
  userResource,
  workSessionResource,
} from "./policy";
import {
  decide,
  type PrincipalFacts,
  type Relation,
  type ResourceFacts,
  type ResourceState,
  type ResourceType,
  type RuleFact,
  resolveEffectivePermissions,
} from "./resolve";

// ---------------------------------------------------------------- helpers

function user(orgRole: OrgRole | null, extra: Partial<PrincipalFacts> = {}): PrincipalFacts {
  return {
    kind: "user",
    id: "u-1",
    orgRole,
    deactivated: false,
    memberUnitPaths: [],
    leadOfUnitIds: new Set(),
    ...extra,
  };
}

function rule(extra: Partial<RuleFact> & Pick<RuleFact, "permission" | "effect">): RuleFact {
  return { id: "rule-1", scopeUnitId: null, subjectKind: "everyone", subjectId: null, tool: null, ...extra };
}

const allowed = (p: PrincipalFacts, r: ResourceFacts, perm: Permission, rules: RuleFact[] = []) =>
  decide(p, r, rules, perm).allowed;

// ---------------------------------------------------------------- the policy, written out by hand

/**
 * Organization-scope permissions per role, with no relation, no unit and no rule. Reviewed as the
 * human-readable policy ("What can each role do?"); deliberately NOT derived from ROLE_PERMISSIONS.
 */
const EXPECTED: Record<OrgRole, Record<Permission, boolean>> = {
  standard: {
    "org.read": true,
    "member.read": true,
    "member.manage": false,
    "invitation.read": false,
    "invitation.create": false,
    "invitation.revoke": false,
    "unit.read": true,
    "unit.manage": false,
    "unit.members.manage": false,
    "rule.read": false,
    "rule.manage": false,
    "account.manage": false,
    "channel.create": true,
    "channel.read": true,
    "channel.post": true,
    "channel.members.add": true,
    "channel.members.remove": false,
    "channel.archive": false,
    "bot.read": true,
    "bot.manage": false,
    "provider.manage": false,
    "cell.manage": false,
    "cell.sync": false,
    "device.read": false,
    "device.pair": false,
    "device.use": false,
    "device.update": false,
    "device.revoke": false,
    "device.link": false,
    "work_session.read": false,
    "work_session.create": false,
    "work_session.prompt": false,
    "work_session.interrupt": false,
    "work_session.approve": false,
    "work_session.archive": false,
    "bot.create_personal": true,
    "bot.configure": false,
    "bot.internet": true,
    "bot.tool.use": true,
    "plugin.manage": false,
    "mcp.manage": false,
    "work_session.configure": false,
    "device.full_access": false,
    "work_zone.manage": false,
    "message.delete_any": false,
    "channel.mention_all": true,
    "attachment.upload": true,
    "channel.update": false,
    "ai_chat.use": true,
    "ai_chat.web": true,
    "ai_chat.share": true,
    "ai_chat.share.read": true,
    "ai_chat.manage": true,
    "bot.manage_unit": false,
    "agent_card.approve": true,
    "ai_chat.read": true,
    "unit.modules.manage": false,
  },
  developer: {
    "org.read": true,
    "member.read": true,
    "member.manage": false,
    "invitation.read": false,
    "invitation.create": false,
    "invitation.revoke": false,
    "unit.read": true,
    "unit.manage": false,
    "unit.members.manage": false,
    "rule.read": false,
    "rule.manage": false,
    "account.manage": false,
    "channel.create": true,
    "channel.read": true,
    "channel.post": true,
    "channel.members.add": true,
    "channel.members.remove": false,
    "channel.archive": false,
    "bot.read": true,
    "bot.manage": false,
    "provider.manage": false,
    "cell.manage": false,
    "cell.sync": false,
    "device.read": true,
    "device.pair": true,
    "device.use": false,
    "device.update": false,
    "device.revoke": false,
    "device.link": false,
    "work_session.read": true,
    "work_session.create": true,
    "work_session.prompt": true,
    "work_session.interrupt": true,
    "work_session.approve": false,
    "work_session.archive": false,
    "bot.create_personal": true,
    "bot.configure": false,
    "bot.internet": true,
    "bot.tool.use": true,
    "plugin.manage": false,
    "mcp.manage": false,
    "work_session.configure": true,
    "device.full_access": false,
    "work_zone.manage": false,
    "message.delete_any": false,
    "channel.mention_all": true,
    "attachment.upload": true,
    "channel.update": false,
    "ai_chat.use": true,
    "ai_chat.web": true,
    "ai_chat.share": true,
    "ai_chat.share.read": true,
    "ai_chat.manage": true,
    "bot.manage_unit": false,
    "agent_card.approve": true,
    "ai_chat.read": true,
    "unit.modules.manage": false,
  },
  lead: {
    "org.read": true,
    "member.read": true,
    "member.manage": false,
    "invitation.read": true,
    "invitation.create": true,
    "invitation.revoke": false,
    "unit.read": true,
    "unit.manage": false,
    "unit.members.manage": false,
    "rule.read": false,
    "rule.manage": false,
    "account.manage": false,
    "channel.create": true,
    "channel.read": true,
    "channel.post": true,
    "channel.members.add": true,
    "channel.members.remove": false,
    "channel.archive": false,
    "bot.read": true,
    "bot.manage": false,
    "provider.manage": false,
    "cell.manage": false,
    "cell.sync": false,
    "device.read": true,
    "device.pair": true,
    "device.use": false,
    "device.update": false,
    "device.revoke": false,
    "device.link": false,
    "work_session.read": true,
    "work_session.create": true,
    "work_session.prompt": true,
    "work_session.interrupt": true,
    "work_session.approve": false,
    "work_session.archive": false,
    "bot.create_personal": true,
    "bot.configure": false,
    "bot.internet": true,
    "bot.tool.use": true,
    "plugin.manage": false,
    "mcp.manage": false,
    "work_session.configure": true,
    "device.full_access": false,
    "work_zone.manage": false,
    "message.delete_any": false,
    "channel.mention_all": true,
    "attachment.upload": true,
    "channel.update": false,
    "ai_chat.use": true,
    "ai_chat.web": true,
    "ai_chat.share": true,
    "ai_chat.share.read": true,
    "ai_chat.manage": true,
    "bot.manage_unit": false,
    "agent_card.approve": true,
    "ai_chat.read": true,
    "unit.modules.manage": false,
  },
  admin: {
    "org.read": true,
    "member.read": true,
    "member.manage": true,
    "invitation.read": true,
    "invitation.create": true,
    "invitation.revoke": true,
    "unit.read": true,
    "unit.manage": true,
    "unit.members.manage": true,
    "rule.read": true,
    "rule.manage": true,
    "account.manage": false,
    "channel.create": true,
    "channel.read": true,
    "channel.post": true,
    "channel.members.add": true,
    "channel.members.remove": true,
    "channel.archive": true,
    "bot.read": true,
    "bot.manage": true,
    "provider.manage": true,
    "cell.manage": true,
    "cell.sync": false,
    "device.read": true,
    "device.pair": true,
    "device.use": false,
    "device.update": false,
    "device.revoke": true,
    "device.link": false,
    "work_session.read": true,
    "work_session.create": true,
    "work_session.prompt": true,
    "work_session.interrupt": true,
    "work_session.approve": true,
    "work_session.archive": true,
    "bot.create_personal": true,
    "bot.configure": true,
    "bot.internet": true,
    "bot.tool.use": true,
    "plugin.manage": true,
    "mcp.manage": true,
    "work_session.configure": true,
    "device.full_access": false,
    "work_zone.manage": true,
    "message.delete_any": true,
    "channel.mention_all": true,
    "attachment.upload": true,
    "channel.update": true,
    "ai_chat.use": true,
    "ai_chat.web": true,
    "ai_chat.share": true,
    "ai_chat.share.read": true,
    "ai_chat.manage": true,
    "bot.manage_unit": true,
    "agent_card.approve": true,
    "ai_chat.read": true,
    "unit.modules.manage": true,
  },
};

describe("role matrix (organization scope)", () => {
  for (const role of OrgRole.options) {
    it(`${role}: every permission matches the written policy`, () => {
      const res = resolveEffectivePermissions(user(role), orgResource(), []);
      const actual = Object.fromEntries(Permission.options.map((p) => [p, res.permissions.has(p)]));
      expect(actual).toEqual(EXPECTED[role]);
    });
  }

  it("covers all four roles and every permission", () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...OrgRole.options].sort());
    for (const role of OrgRole.options) {
      expect(Object.keys(EXPECTED[role]).sort()).toEqual([...Permission.options].sort());
    }
  });

  it("a missing permission is explained by the role layer", () => {
    expect(decide(user("developer"), orgResource(), [], "provider.manage")).toEqual({
      allowed: false,
      denial: { permission: "provider.manage", layer: "role", reason: "missing_permission" },
    });
    expect(
      decide(
        user("developer"),
        deviceResource({ ownerUserId: "x", shared: false, revoked: false }, "u-1"),
        [],
        "device.use",
      ),
    ).toEqual({
      allowed: false,
      denial: { permission: "device.use", layer: "role", reason: "device_not_shared" },
    });
  });
});

// ---------------------------------------------------------------- relations

describe("relation grants", () => {
  const ownDevice = deviceResource({ ownerUserId: "u-1", shared: false, revoked: false }, "u-1");

  it("a developer who owns a device can use, update and revoke it", () => {
    for (const perm of ["device.use", "device.update", "device.revoke"] as const) {
      expect(allowed(user("developer"), ownDevice, perm), perm).toBe(true);
    }
  });

  it("a standard user owning a device gets nothing from it (no Work Zone surface)", () => {
    for (const perm of ["device.use", "device.update", "device.revoke"] as const) {
      expect(allowed(user("standard"), ownDevice, perm), perm).toBe(false);
    }
  });

  it("a shared device is usable by other developers, not updatable", () => {
    const shared = deviceResource({ ownerUserId: "other", shared: true, revoked: false }, "u-1");
    expect(allowed(user("developer"), shared, "device.use")).toBe(true);
    expect(allowed(user("developer"), shared, "device.update")).toBe(false);
  });

  it("a revoked device denies at the device layer, even for its owner", () => {
    const revoked = deviceResource({ ownerUserId: "u-1", shared: false, revoked: true }, "u-1");
    expect(decide(user("admin"), revoked, [], "device.use").denial).toMatchObject({
      layer: "device",
      reason: "device_revoked",
    });
  });

  describe("device caps and the Full access grain (Phase 03.2, P-06)", () => {
    const dev = (cap: Parameters<typeof deviceResource>[0]["cap"], owner = "other", revoked = false) =>
      deviceResource({ ownerUserId: owner, shared: false, revoked, cap }, "u-1");

    it("the owner holds device.full_access", () => {
      expect(allowed(user("developer"), dev("fullAccess", "u-1"), "device.full_access")).toBe(true);
      expect(allowed(user("developer"), ownDevice, "device.full_access")).toBe(true);
    });

    it("a grantee capped at acceptEdits uses the device but has no Full access", () => {
      const r = dev("acceptEdits");
      expect(r.relations.has("grantee")).toBe(true);
      expect(r.relations.has("full_access_grantee")).toBe(false);
      expect(allowed(user("developer"), r, "device.use")).toBe(true);
      expect(allowed(user("developer"), r, "device.full_access")).toBe(false);
    });

    it("a grantee capped at fullAccess holds both", () => {
      const r = dev("fullAccess");
      expect(r.relations.has("full_access_grantee")).toBe(true);
      expect(allowed(user("developer"), r, "device.use")).toBe(true);
      expect(allowed(user("developer"), r, "device.full_access")).toBe(true);
    });

    it("an allow rule never confers device.full_access (non-delegable, ADR-0012): only the cap does", () => {
      const allow = rule({ permission: "device.full_access", effect: "allow" });
      const allowUser = rule({
        permission: "device.full_access",
        effect: "allow",
        subjectKind: "user",
        subjectId: "u-1",
      });
      for (const role of ["developer", "lead", "admin"] as const) {
        expect(allowed(user(role), dev("acceptEdits"), "device.full_access", [allow, allowUser]), role).toBe(
          false,
        );
        expect(allowed(user(role), dev(null), "device.full_access", [allow, allowUser]), role).toBe(false);
      }
    });

    it("a deny rule on device.full_access removes it at the user layer; device.use stays", () => {
      const deny = rule({
        permission: "device.full_access",
        effect: "deny",
        subjectKind: "user",
        subjectId: "u-1",
      });
      const r = dev("fullAccess");
      expect(decide(user("developer"), r, [deny], "device.full_access").denial).toMatchObject({
        layer: "user",
        reason: "denied_by_rule",
      });
      expect(allowed(user("developer"), r, "device.use", [deny])).toBe(true);
      expect(decide(user("developer"), dev("fullAccess", "u-1"), [deny], "device.full_access").allowed).toBe(
        false,
      );
    });

    it("a standard member never gets device.use or device.full_access (no Work Zone surface)", () => {
      for (const r of [dev("fullAccess"), dev("fullAccess", "u-1")]) {
        expect(allowed(user("standard"), r, "device.use")).toBe(false);
        expect(allowed(user("standard"), r, "device.full_access")).toBe(false);
      }
    });

    it("no cap: neither relation; work_session.configure is denied on a revoked device", () => {
      const none = dev(null);
      expect(none.relations.size).toBe(0);
      expect(decide(user("developer"), none, [], "device.use").denial).toMatchObject({
        reason: "device_not_shared",
      });
      const session = workSessionResource(
        { createdBy: "u-1", deviceOwnerUserId: "u-1", deviceRevoked: true },
        "u-1",
      );
      expect(decide(user("admin"), session, [], "work_session.configure").denial).toMatchObject({
        layer: "device",
        reason: "device_revoked",
      });
    });

    it("without a cap the legacy behaviour is unchanged (shared → grantee)", () => {
      const legacy = deviceResource({ ownerUserId: "other", shared: true, revoked: false }, "u-1");
      expect([...legacy.relations]).toEqual(["grantee"]);
      expect(allowed(user("developer"), legacy, "device.full_access")).toBe(false);
    });
  });

  it("a lead revokes their own invitation; a developer inviter cannot", () => {
    const own = invitationResource({ inviterId: "u-1", role: "developer" }, "u-1");
    expect(allowed(user("lead"), own, "invitation.revoke")).toBe(true);
    expect(allowed(user("developer"), own, "invitation.revoke")).toBe(false);
    const theirs = invitationResource({ inviterId: "other", role: "developer" }, "u-1");
    expect(allowed(user("lead"), theirs, "invitation.revoke")).toBe(false);
  });

  it("the invitation role ceiling: leads invite standard and developer only", () => {
    expect(
      allowed(
        user("lead"),
        invitationResource({ inviterId: null, role: "developer" }, "u-1"),
        "invitation.create",
      ),
    ).toBe(true);
    expect(
      decide(
        user("lead"),
        invitationResource({ inviterId: null, role: "admin" }, "u-1"),
        [],
        "invitation.create",
      ).denial,
    ).toMatchObject({ layer: "resource", reason: "role_ceiling" });
    expect(
      allowed(
        user("admin"),
        invitationResource({ inviterId: null, role: "admin" }, "u-1"),
        "invitation.create",
      ),
    ).toBe(true);
  });

  it("every active user manages their own account, nobody else's", () => {
    for (const role of OrgRole.options) {
      expect(allowed(user(role), userResource("u-1", "u-1"), "account.manage"), role).toBe(true);
      expect(allowed(user(role), userResource("u-2", "u-1"), "account.manage"), role).toBe(false);
    }
  });

  it("a channel owner archives; a member removes themselves", () => {
    const owned = channelResource({ visibility: "public", archived: false, viewerRole: "owner" });
    expect(allowed(user("standard"), owned, "channel.archive")).toBe(true);
    const member = channelResource({ visibility: "public", archived: false, viewerRole: "member" });
    expect(allowed(user("standard"), member, "channel.archive")).toBe(false);
    const self = channelMemberResource({ visibility: "public", archived: false, viewerRole: "member" }, true);
    expect(allowed(user("standard"), self, "channel.members.remove")).toBe(true);
    const other = channelMemberResource(
      { visibility: "public", archived: false, viewerRole: "member" },
      false,
    );
    expect(allowed(user("standard"), other, "channel.members.remove")).toBe(false);
  });

  it("channel preconditions: private hides, archived blocks posting, non-members cannot post", () => {
    const priv = channelResource({ visibility: "private", archived: false, viewerRole: null });
    expect(decide(user("admin"), priv, [], "channel.read").denial).toMatchObject({
      layer: "resource",
      reason: "private_channel",
    });
    const archived = channelResource({ visibility: "public", archived: true, viewerRole: "member" });
    expect(decide(user("admin"), archived, [], "channel.post").denial).toMatchObject({ reason: "archived" });
    const outsider = channelResource({ visibility: "public", archived: false, viewerRole: null });
    expect(allowed(user("developer"), outsider, "channel.read")).toBe(true);
    expect(decide(user("developer"), outsider, [], "channel.post").denial).toMatchObject({
      reason: "not_a_member",
    });
  });

  it("a work session creator or device owner approves; others do not", () => {
    const s = { createdBy: "u-1", deviceOwnerUserId: "u-9", deviceRevoked: false };
    expect(allowed(user("developer"), workSessionResource(s, "u-1"), "work_session.approve")).toBe(true);
    expect(allowed(user("developer"), workSessionResource(s, "u-9"), "work_session.approve")).toBe(true);
    expect(allowed(user("developer"), workSessionResource(s, "u-5"), "work_session.approve")).toBe(false);
    expect(allowed(user("admin"), workSessionResource(s, "u-5"), "work_session.approve")).toBe(true);
  });
});

// ---------------------------------------------------------------- hierarchy and rules

describe("unit leads and explicit rules", () => {
  const D = "dept-D";
  const T = "team-T";
  const P = "proj-P";
  const OTHER = "dept-X";

  it("a lead of T manages members of T and its descendants, not of D", () => {
    const lead = user("developer", { memberUnitPaths: [[D, T]], leadOfUnitIds: new Set([T]) });
    expect(allowed(lead, unitResource({ id: T, path: [D, T] }), "unit.members.manage")).toBe(true);
    expect(allowed(lead, unitResource({ id: P, path: [D, T, P] }), "unit.members.manage")).toBe(true);
    expect(allowed(lead, unitResource({ id: D, path: [D] }), "unit.members.manage")).toBe(false);
  });

  it("a deny scoped to department D removes channel.create from a member of team T under D", () => {
    const deny = rule({ id: "deny-D", scopeUnitId: D, permission: "channel.create", effect: "deny" });
    const inT = user("developer", { memberUnitPaths: [[D, T]] });
    expect(decide(inT, orgResource(), [deny], "channel.create")).toEqual({
      allowed: false,
      denial: {
        permission: "channel.create",
        layer: "unit",
        reason: "denied_by_rule",
        ruleId: "deny-D",
        unitId: D,
      },
    });
    const outside = user("developer", { memberUnitPaths: [[OTHER]] });
    expect(allowed(outside, orgResource(), "channel.create", [deny])).toBe(true);
  });

  it("an upper unit's deny is reported before a deeper one", () => {
    const rules = [
      rule({ id: "a-deep", scopeUnitId: T, permission: "channel.*", effect: "deny" }),
      rule({ id: "z-top", scopeUnitId: D, permission: "channel.create", effect: "deny" }),
    ];
    const inT = user("developer", { memberUnitPaths: [[D, T]] });
    expect(decide(inT, orgResource(), rules, "channel.create").denial).toMatchObject({
      unitId: D,
      ruleId: "z-top",
    });
    const orgDeny = rule({ id: "org", permission: "channel.create", effect: "deny" });
    expect(decide(inT, orgResource(), [...rules, orgDeny], "channel.create").denial).toMatchObject({
      layer: "org",
    });
  });

  it("an allow scoped to T grants work_session.create to a standard member of T only", () => {
    const allow = rule({
      scopeUnitId: T,
      subjectKind: "role",
      subjectId: "standard",
      permission: "work_session.create",
      effect: "allow",
    });
    expect(
      allowed(user("standard", { memberUnitPaths: [[D, T]] }), orgResource(), "work_session.create", [allow]),
    ).toBe(true);
    expect(
      allowed(user("standard", { memberUnitPaths: [[OTHER]] }), orgResource(), "work_session.create", [
        allow,
      ]),
    ).toBe(false);
    expect(allowed(user("standard"), orgResource(), "work_session.create")).toBe(false);
  });

  it("an allow never grants a non-delegable permission", () => {
    const allowAll = [
      rule({ id: "a1", permission: "member.manage", effect: "allow" }),
      rule({ id: "a2", permission: "provider.manage", effect: "allow" }),
      rule({ id: "a3", permission: "cell.*", effect: "allow" }),
      rule({ id: "a4", permission: "device.full_access", effect: "allow" }),
    ];
    const res = resolveEffectivePermissions(user("standard"), orgResource(), allowAll);
    for (const perm of NON_DELEGABLE_PERMISSIONS) expect(res.permissions.has(perm), perm).toBe(false);
  });

  it("a deny beats an allow and the role", () => {
    const rules = [
      rule({ id: "allow", permission: "channel.create", effect: "allow" }),
      rule({
        id: "deny",
        subjectKind: "user",
        subjectId: "u-1",
        permission: "channel.create",
        effect: "deny",
      }),
    ];
    expect(decide(user("admin"), orgResource(), rules, "channel.create").denial).toMatchObject({
      layer: "user",
      ruleId: "deny",
    });
  });

  it("a tool-scoped deny removes approve only for that tool", () => {
    const deny = rule({ id: "no-bash", permission: "work_session.approve", tool: "Bash", effect: "deny" });
    const session = (tool: string) =>
      workSessionResource({ createdBy: "u-1", deviceOwnerUserId: null, deviceRevoked: false, tool }, "u-1");
    expect(decide(user("developer"), session("Bash"), [deny], "work_session.approve").denial).toMatchObject({
      layer: "tool",
      ruleId: "no-bash",
    });
    expect(allowed(user("developer"), session("Edit"), "work_session.approve", [deny])).toBe(true);
  });

  it("an agent-subject deny is reported by the agent layer", () => {
    const agent: PrincipalFacts = { ...user(null), kind: "agent", id: "agent-1" };
    const conv = channelResource({ visibility: "public", archived: false, viewerRole: "member" });
    const deny = rule({
      id: "mute",
      subjectKind: "agent",
      subjectId: "agent-1",
      permission: "channel.post",
      effect: "deny",
    });
    expect(decide(agent, conv, [deny], "channel.post").denial).toMatchObject({
      layer: "agent",
      ruleId: "mute",
    });
    expect(
      decide(
        agent,
        channelResource({ visibility: "public", archived: false, viewerRole: null }),
        [],
        "channel.read",
      ).denial,
    ).toMatchObject({ reason: "agent_not_member" });
  });

  it("an agent acting for a human never exceeds the human (confused deputy)", () => {
    const agent: PrincipalFacts = { ...user(null), kind: "agent", id: "agent-1" };
    const conv = channelResource({ visibility: "private", archived: false, viewerRole: "member" });
    const humanView = channelResource({ visibility: "private", archived: false, viewerRole: null });
    const res = decide(agent, conv, [], "channel.read", { principal: user("admin"), resource: humanView });
    expect(res).toEqual({
      allowed: false,
      denial: { permission: "channel.read", layer: "resource", reason: "private_channel" },
    });
    const deactivated = decide(agent, conv, [], "channel.post", {
      principal: user("admin", { deactivated: true }),
      resource: conv,
    });
    expect(deactivated.denial).toMatchObject({ layer: "user", reason: "deactivated" });
  });

  it("deactivated principals are denied at their own layer", () => {
    expect(decide(user("admin", { deactivated: true }), orgResource(), [], "org.read").denial).toEqual({
      permission: "org.read",
      layer: "user",
      reason: "deactivated",
    });
    const device: PrincipalFacts = { ...user(null), kind: "device", id: "dev-1", deactivated: true };
    expect(decide(device, orgResource(), [], "device.link").denial).toMatchObject({
      layer: "device",
      reason: "device_revoked",
    });
  });
});

// ---------------------------------------------------------------- personal bots and direct conversations (03.1-01)

describe("channels in units (CHAT-02, 04-08)", () => {
  const FIN = "dept-finance";
  const PROD = "dept-product";
  const MOB = "team-mobile";
  const financeDeny = rule({
    id: "deny-finance",
    scopeUnitId: FIN,
    subjectKind: "role",
    subjectId: "standard",
    permission: "channel.read",
    effect: "deny",
  });
  const inFinance = (c: Partial<Parameters<typeof channelResource>[0]> = {}) =>
    channelResource({ visibility: "public", archived: false, viewerRole: null, unitPath: [FIN], ...c });
  const inProduct = channelResource({
    visibility: "public",
    archived: false,
    viewerRole: null,
    unitPath: [PROD, MOB],
  });

  it("a channel resource carries its unit path (root → self); none = the organization", () => {
    expect(inProduct.unitPath).toEqual([PROD, MOB]);
    expect(channelResource({ visibility: "public", archived: false, viewerRole: null }).unitPath).toEqual([]);
    expect(
      channelMemberResource(
        { visibility: "public", archived: false, viewerRole: "member", unitPath: [FIN] },
        true,
      ).unitPath,
    ).toEqual([FIN]);
  });

  it("a deny scoped to Finance hides Finance channels from a non-Finance member and leaves Product ones", () => {
    const outsider = user("standard", { memberUnitPaths: [[PROD]] });
    expect(decide(outsider, inFinance(), [financeDeny], "channel.read")).toEqual({
      allowed: false,
      denial: {
        permission: "channel.read",
        layer: "unit",
        reason: "denied_by_rule",
        ruleId: "deny-finance",
        unitId: FIN,
      },
    });
    // Membership of the channel does not outrank the rule (explicit deny precedence).
    expect(allowed(outsider, inFinance({ viewerRole: "owner" }), "channel.read", [financeDeny])).toBe(false);
    expect(allowed(outsider, inProduct, "channel.read", [financeDeny])).toBe(true);
    // Without a unit path (the organization) the Finance rule does not reach the channel.
    expect(allowed(outsider, inFinance({ unitPath: [] }), "channel.read", [financeDeny])).toBe(true);
    // A role the rule does not name keeps reading it.
    expect(
      allowed(user("developer", { memberUnitPaths: [[FIN]] }), inFinance(), "channel.read", [financeDeny]),
    ).toBe(true);
  });

  it("a deny scoped to a department reaches its team channels (the team is below it on the path)", () => {
    const productDeny = rule({
      id: "deny-product",
      scopeUnitId: PROD,
      permission: "channel.post",
      effect: "deny",
    });
    const outsider = user("developer", { memberUnitPaths: [[FIN]] });
    const joined = channelResource({
      visibility: "public",
      archived: false,
      viewerRole: "member",
      unitPath: [PROD, MOB],
    });
    expect(allowed(outsider, joined, "channel.post")).toBe(true);
    expect(allowed(outsider, joined, "channel.post", [productDeny])).toBe(false);
  });

  it("channel.update: the channel owner relation and the admin role, nobody else", () => {
    const owned = (role: "owner" | "member" | null) =>
      channelResource({ visibility: "public", archived: false, viewerRole: role, unitPath: [PROD] });
    for (const r of ["standard", "developer", "lead"] as const) {
      expect(allowed(user(r), owned("owner"), "channel.update"), `${r} owner`).toBe(true);
      expect(allowed(user(r), owned("member"), "channel.update"), `${r} member`).toBe(false);
      expect(allowed(user(r), owned(null), "channel.update"), `${r} outsider`).toBe(false);
    }
    expect(allowed(user("admin"), owned(null), "channel.update")).toBe(true);
    expect(allowed(user("admin"), orgResource(), "channel.update")).toBe(true);
    expect(allowed(user("lead"), orgResource(), "channel.update")).toBe(false);
    // Direct conversations never move into a unit, whoever owns them.
    const dm = channelResource({ visibility: "private", archived: false, viewerRole: "owner", kind: "dm" });
    expect(decide(user("admin"), dm, [], "channel.update").denial).toMatchObject({
      layer: "resource",
      reason: "direct_conversation",
    });
    // Agents never move channels.
    const agent: PrincipalFacts = { ...user(null), kind: "agent", id: "a-1" };
    expect(allowed(agent, owned("owner"), "channel.update")).toBe(false);
  });
});

describe("unit personas (Phase 6, AGENT-01, P-04)", () => {
  const ENG = "unit-eng";
  const BACKEND = "unit-backend";
  const PAYMENTS = "unit-payments";
  const FRONTEND = "unit-frontend";
  const RILEY = "u-riley";
  const ALEX = "u-alex";
  const JO = "u-jo";
  const OWNER = "u-owner";
  // Riley has the standard role: every bot right below comes from leading Backend.
  const riley = user("standard", {
    id: RILEY,
    memberUnitPaths: [[ENG, BACKEND]],
    leadOfUnitIds: new Set([BACKEND]),
  });
  const alex = user("standard", { id: ALEX, memberUnitPaths: [[ENG, BACKEND]] });
  const payments = user("standard", { id: "u-pay", memberUnitPaths: [[ENG, BACKEND, PAYMENTS]] });
  const jo = user("standard", { id: JO, memberUnitPaths: [[ENG, FRONTEND]] });
  const admin = user("admin", { id: "u-admin" });
  const persona = {
    scope: "team" as const,
    ownerUserId: null,
    disabled: false,
    unitPath: [ENG, BACKEND],
  };

  it("a lead of Backend gets bot.manage_unit on Backend and its child Payments, not on Frontend", () => {
    expect(allowed(riley, unitResource({ id: BACKEND, path: [ENG, BACKEND] }), "bot.manage_unit")).toBe(true);
    expect(
      allowed(riley, unitResource({ id: PAYMENTS, path: [ENG, BACKEND, PAYMENTS] }), "bot.manage_unit"),
    ).toBe(true);
    expect(allowed(riley, unitResource({ id: FRONTEND, path: [ENG, FRONTEND] }), "bot.manage_unit")).toBe(
      false,
    );
    expect(allowed(riley, unitResource({ id: ENG, path: [ENG] }), "bot.manage_unit")).toBe(false);
    expect(allowed(riley, orgResource(), "bot.manage_unit")).toBe(false);
    expect(allowed(riley, orgResource(), "bot.manage")).toBe(false);
  });

  it("the unit path rides on the agent resource with state unit_scoped (organization personas carry none)", () => {
    const r = agentResource(persona, RILEY);
    expect(r.unitPath).toEqual([ENG, BACKEND]);
    expect(r.state.has("unit_scoped")).toBe(true);
    const org = agentResource({ ...persona, unitPath: [] }, RILEY);
    expect(org.unitPath).toEqual([]);
    expect(org.state.has("unit_scoped")).toBe(false);
    expect(agentResource({ scope: "team", ownerUserId: null, disabled: false }, RILEY).unitPath).toEqual([]);
  });

  it("the lead configures and governs the persona of the unit they lead", () => {
    const r = agentResource(persona, RILEY);
    expect(allowed(riley, r, "bot.read")).toBe(true);
    expect(allowed(riley, r, "bot.configure")).toBe(true);
    expect(allowed(riley, r, "bot.manage_unit")).toBe(true);
    expect(allowed(riley, r, "bot.manage")).toBe(false);
  });

  it("a standard member of Backend (or a sub-unit) reads it but does not configure it", () => {
    for (const m of [alex, payments]) {
      const r = agentResource(persona, m.id);
      expect(allowed(m, r, "bot.read")).toBe(true);
      expect(allowed(m, r, "bot.configure")).toBe(false);
    }
  });

  it("a member of Frontend is denied bot.read with unit_agent, even with an allow rule", () => {
    const r = agentResource(persona, JO);
    expect(decide(jo, r, [], "bot.read")).toEqual({
      allowed: false,
      denial: { permission: "bot.read", layer: "resource", reason: "unit_agent" },
    });
    const allowAll = rule({ subjectKind: "user", subjectId: JO, permission: "bot.*", effect: "allow" });
    expect(decide(jo, r, [allowAll], "bot.read").denial).toMatchObject({ reason: "unit_agent" });
    expect(allowed(jo, r, "bot.configure")).toBe(false);
    // A member of no unit at all is denied the same way.
    expect(
      decide(user("developer", { id: "u-x" }), agentResource(persona, "u-x"), [], "bot.read").denial,
    ).toMatchObject({ reason: "unit_agent" });
  });

  it("a lead of an ancestor unit sees and configures the personas of its subtree", () => {
    const engLead = user("lead", { id: "u-eng", leadOfUnitIds: new Set([ENG]), memberUnitPaths: [[ENG]] });
    const r = agentResource(persona, "u-eng");
    expect(allowed(engLead, r, "bot.read")).toBe(true);
    expect(allowed(engLead, r, "bot.configure")).toBe(true);
  });

  it("an admin keeps bot.read, bot.configure and bot.manage on any unit persona", () => {
    const r = agentResource(persona, "u-admin");
    expect(allowed(admin, r, "bot.read")).toBe(true);
    expect(allowed(admin, r, "bot.configure")).toBe(true);
    expect(allowed(admin, r, "bot.manage")).toBe(true);
    expect(allowed(admin, r, "bot.manage_unit")).toBe(true);
  });

  it("the owner of a shared persona reads and configures it through the relation, wherever they sit", () => {
    const owned = { ...persona, ownerUserId: OWNER };
    const owner = user("standard", { id: OWNER, memberUnitPaths: [[ENG, FRONTEND]] });
    const r = agentResource(owned, OWNER);
    expect(r.relations.has("owner")).toBe(true);
    expect(allowed(owner, r, "bot.read")).toBe(true);
    expect(allowed(owner, r, "bot.configure")).toBe(true);
    expect(allowed(owner, r, "bot.manage_unit")).toBe(false);
    // An organization persona with an owner: the owner configures it too.
    const orgOwned = agentResource({ scope: "team", ownerUserId: OWNER, disabled: false }, OWNER);
    expect(allowed(owner, orgOwned, "bot.configure")).toBe(true);
    expect(allowed(owner, orgOwned, "bot.manage")).toBe(false);
  });

  it("a deny scoped to Backend reaches the persona of Backend for every member", () => {
    const deny = rule({ id: "deny-b", scopeUnitId: BACKEND, permission: "bot.configure", effect: "deny" });
    expect(decide(riley, agentResource(persona, RILEY), [deny], "bot.configure").denial).toMatchObject({
      layer: "unit",
      reason: "denied_by_rule",
      unitId: BACKEND,
    });
  });
});

describe("personal bots (D-01) and direct conversations (D-03)", () => {
  const SAM = "u-sam";
  const ALEX = "u-alex";
  const ADMIN_ID = "u-admin";
  const sam = user("developer", { id: SAM });
  const alex = user("developer", { id: ALEX });
  const admin = user("admin", { id: ADMIN_ID });
  const personal = { scope: "personal" as const, ownerUserId: SAM, disabled: false };
  const team = { scope: "team" as const, ownerUserId: null, disabled: false };
  const bot: PrincipalFacts = { ...user(null), kind: "agent", id: "bot-1" };

  it("the owner sees and configures their personal bot", () => {
    const r = agentResource(personal, SAM);
    expect(r.relations.has("owner")).toBe(true);
    expect(r.state.has("personal")).toBe(true);
    expect(allowed(sam, r, "bot.read")).toBe(true);
    expect(allowed(sam, r, "bot.configure")).toBe(true);
    expect(allowed(sam, r, "bot.internet")).toBe(true);
  });

  it("another member and an admin are denied with personal_bot; the admin keeps governance (bot.manage)", () => {
    for (const [who, id] of [
      [alex, ALEX],
      [admin, ADMIN_ID],
    ] as const) {
      const r = agentResource(personal, id);
      for (const perm of ["bot.read", "bot.internet", "bot.tool.use"] as const) {
        expect(decide(who, r, [], perm)).toEqual({
          allowed: false,
          denial: { permission: perm, layer: "resource", reason: "personal_bot" },
        });
      }
    }
    // The admin's role grants bot.configure; the precondition removes it. A developer never had it.
    expect(decide(admin, agentResource(personal, ADMIN_ID), [], "bot.configure").denial).toEqual({
      permission: "bot.configure",
      layer: "resource",
      reason: "personal_bot",
    });
    expect(allowed(alex, agentResource(personal, ALEX), "bot.configure")).toBe(false);
    // Even an explicit allow rule for Alex cannot open someone else's personal bot.
    const allowAll = rule({ subjectKind: "user", subjectId: ALEX, permission: "bot.*", effect: "allow" });
    expect(decide(alex, agentResource(personal, ALEX), [allowAll], "bot.configure").denial).toMatchObject({
      reason: "personal_bot",
    });
    expect(allowed(admin, agentResource(personal, ADMIN_ID), "bot.manage")).toBe(true);
    expect(allowed(alex, agentResource(personal, ALEX), "bot.manage")).toBe(false);
  });

  it("on a team bot the admin configures and a developer does not", () => {
    expect(allowed(admin, agentResource(team, ADMIN_ID), "bot.configure")).toBe(true);
    expect(decide(sam, agentResource(team, SAM), [], "bot.configure").denial).toMatchObject({
      layer: "role",
      reason: "missing_permission",
    });
    expect(allowed(sam, agentResource(team, SAM), "bot.read")).toBe(true);
  });

  it("an owner relation never outlives the role surface (a standard owner still holds bot.configure)", () => {
    expect(allowed(user("standard", { id: SAM }), agentResource(personal, SAM), "bot.configure")).toBe(true);
  });

  it("a deny rule removes bot.create_personal at the org layer", () => {
    const deny = rule({
      subjectKind: "role",
      subjectId: "developer",
      permission: "bot.create_personal",
      effect: "deny",
    });
    expect(decide(sam, orgResource(), [deny], "bot.create_personal").denial).toMatchObject({
      layer: "org",
      reason: "denied_by_rule",
    });
    expect(allowed(user("standard"), orgResource(), "bot.create_personal", [deny])).toBe(true);
  });

  it("a bot acting for its owner keeps bot.internet; for anyone else it loses it with personal_bot", () => {
    const asBot = agentResource(personal, null);
    expect(
      decide(bot, asBot, [], "bot.internet", { principal: sam, resource: agentResource(personal, SAM) }),
    ).toEqual({ allowed: true });
    expect(
      decide(bot, asBot, [], "bot.internet", { principal: alex, resource: agentResource(personal, ALEX) }),
    ).toEqual({
      allowed: false,
      denial: { permission: "bot.internet", layer: "resource", reason: "personal_bot" },
    });
    expect(
      decide(bot, asBot, [], "bot.tool.use", {
        principal: admin,
        resource: agentResource(personal, ADMIN_ID),
      }).denial,
    ).toMatchObject({ reason: "personal_bot" });
  });

  it("a DM has fixed membership: the owner reads and posts but never adds, removes or archives", () => {
    const own = channelResource({ visibility: "private", archived: false, viewerRole: "owner", kind: "dm" });
    expect(own.state.has("dm")).toBe(true);
    expect(allowed(sam, own, "channel.read")).toBe(true);
    expect(allowed(sam, own, "channel.post")).toBe(true);
    for (const perm of ["channel.members.add", "channel.members.remove", "channel.archive"] as const) {
      expect(decide(sam, own, [], perm)).toEqual({
        allowed: false,
        denial: { permission: perm, layer: "resource", reason: "direct_conversation" },
      });
      expect(decide(admin, own, [], perm).denial).toMatchObject({ reason: "direct_conversation" });
    }
  });

  it("message.delete_any (D-01): admins moderate channels, never a direct conversation", () => {
    const publicNotJoined = channelResource({ visibility: "public", archived: false, viewerRole: null });
    expect(allowed(admin, publicNotJoined, "message.delete_any")).toBe(true);
    expect(decide(sam, publicNotJoined, [], "message.delete_any").denial).toMatchObject({
      permission: "message.delete_any",
      reason: "missing_permission",
    });
    const dm = channelResource({ visibility: "private", archived: false, viewerRole: "owner", kind: "dm" });
    expect(decide(admin, dm, [], "message.delete_any")).toEqual({
      allowed: false,
      denial: { permission: "message.delete_any", layer: "resource", reason: "direct_conversation" },
    });
    // An allow rule never hands moderation to anyone else (admin surface, non-delegable).
    const allowAll = [rule({ subjectKind: "everyone", permission: "message.delete_any", effect: "allow" })];
    expect(allowed(sam, publicNotJoined, "message.delete_any", allowAll)).toBe(false);
  });

  it("a group DM (D-06) carries state dm: members read and post; nobody adds, removes, archives or moderates", () => {
    const group = channelResource({
      visibility: "private",
      archived: false,
      viewerRole: "member",
      kind: "group",
    });
    expect(group.state.has("dm")).toBe(true);
    expect(allowed(sam, group, "channel.read")).toBe(true);
    expect(allowed(sam, group, "channel.post")).toBe(true);
    const asAdminMember = channelResource({
      visibility: "private",
      archived: false,
      viewerRole: "member",
      kind: "group",
    });
    for (const perm of [
      "channel.members.add",
      "channel.members.remove",
      "channel.archive",
      "message.delete_any",
    ] as const) {
      expect(decide(sam, group, [], perm).allowed).toBe(false);
      expect(decide(admin, asAdminMember, [], perm)).toEqual({
        allowed: false,
        denial: { permission: perm, layer: "resource", reason: "direct_conversation" },
      });
    }
    const theirs = channelResource({
      visibility: "private",
      archived: false,
      viewerRole: null,
      kind: "group",
    });
    expect(decide(admin, theirs, [], "channel.read").denial).toMatchObject({ reason: "private_channel" });
  });

  it("a non-member admin cannot read someone's DM (private_channel)", () => {
    const theirs = channelResource({ visibility: "private", archived: false, viewerRole: null, kind: "dm" });
    expect(decide(admin, theirs, [], "channel.read")).toEqual({
      allowed: false,
      denial: { permission: "channel.read", layer: "resource", reason: "private_channel" },
    });
  });
});

describe("AI chats (Phase 5, P-03): private, one owner, no membership, moderation or generic posting", () => {
  const SAM = "u-sam";
  const sam = user("standard", { id: SAM });
  const alex = user("standard", { id: "u-alex" });
  const admin = user("admin", { id: "u-admin" });
  const own = channelResource({
    visibility: "private",
    archived: false,
    viewerRole: "owner",
    kind: "ai_chat",
  });
  const notMine = channelResource({
    visibility: "private",
    archived: false,
    viewerRole: null,
    kind: "ai_chat",
  });

  it("carries states ai_chat and private", () => {
    expect(own.state.has("ai_chat")).toBe(true);
    expect(own.state.has("private")).toBe(true);
    expect(own.state.has("dm")).toBe(false);
  });

  it("the owner reads it and uses it (ai_chat.use, .web, .share)", () => {
    expect(allowed(sam, own, "channel.read")).toBe(true);
    for (const perm of ["ai_chat.use", "ai_chat.web", "ai_chat.share"] as const) {
      expect(allowed(sam, own, perm), perm).toBe(true);
    }
  });

  it("anyone else, admins included, cannot read it: hidden as a private channel", () => {
    for (const who of [alex, admin]) {
      expect(decide(who, notMine, [], "channel.read")).toEqual({
        allowed: false,
        denial: { permission: "channel.read", layer: "resource", reason: "private_channel" },
      });
    }
  });

  it("membership, archive, update, moderation, broadcast and generic posting are denied even for the owner", () => {
    for (const perm of [
      "channel.members.add",
      "channel.members.remove",
      "channel.archive",
      "channel.update",
      "message.delete_any",
      "channel.mention_all",
      "channel.post",
    ] as const) {
      // `own` is decided for whoever owns it: a standard owner and an admin owner (who holds every channel grant).
      expect(decide(sam, own, [], perm).allowed, perm).toBe(false);
      expect(decide(admin, own, [], perm), perm).toEqual({
        allowed: false,
        denial: { permission: perm, layer: "resource", reason: "ai_chat_private" },
      });
    }
    for (const perm of [
      "channel.post",
      "channel.members.add",
      "channel.archive",
      "channel.update",
    ] as const) {
      expect(decide(sam, own, [], perm).denial, perm).toMatchObject({ reason: "ai_chat_private" });
    }
  });

  it("ai_chat.* on a channel resource that is not an AI chat owned by the principal: not_ai_chat_owner", () => {
    const channel = channelResource({ visibility: "public", archived: false, viewerRole: "owner" });
    const dm = channelResource({ visibility: "private", archived: false, viewerRole: "owner", kind: "dm" });
    for (const [who, r] of [
      [alex, notMine],
      [admin, notMine],
      [sam, channel],
      [sam, dm],
    ] as const) {
      for (const perm of ["ai_chat.use", "ai_chat.web", "ai_chat.share"] as const) {
        expect(decide(who, r, [], perm)).toEqual({
          allowed: false,
          denial: { permission: perm, layer: "resource", reason: "not_ai_chat_owner" },
        });
      }
    }
  });

  it("at organization scope ai_chat.use stays role-based (starting a new chat)", () => {
    expect(allowed(sam, orgResource(), "ai_chat.use")).toBe(true);
    const deny = rule({ subjectKind: "user", subjectId: SAM, permission: "ai_chat.use", effect: "deny" });
    expect(allowed(sam, orgResource(), "ai_chat.use", [deny])).toBe(false);
    expect(allowed(sam, own, "ai_chat.use", [deny])).toBe(false);
  });
});

describe("AI chat grants (Phase 6, P-03/P-04): access from owner ∪ grants, management owner-only", () => {
  const VICTOR = "u-victor";
  const victor = user("admin", { id: VICTOR });
  const alex = user("developer", { id: "u-alex" });
  const sam = user("standard", { id: "u-sam" });
  const admin = user("admin", { id: "u-admin" });
  const ai = (aiAccess: "owner" | "chat" | "view" | null, viewerRole: "owner" | "member" | null = null) =>
    channelResource({ visibility: "private", archived: false, viewerRole, kind: "ai_chat", aiAccess });
  const owner = ai("owner", "owner");
  const chatGrant = ai("chat", "member");
  const viewGrant = ai("view", "member");
  const none = ai(null);

  it("relations come from aiAccess: owner → owner + member, chat → member, view → grantee, null → none", () => {
    expect([...owner.relations].sort()).toEqual(["member", "owner"]);
    expect([...chatGrant.relations]).toEqual(["member"]);
    expect([...viewGrant.relations]).toEqual(["grantee"]);
    expect([...none.relations]).toEqual([]);
  });

  it("a stale conversation_members row never confers access to a human (T-06-02-06)", () => {
    const stale = ai(null, "member");
    expect(stale.relations.size).toBe(0);
    expect(decide(sam, stale, [], "channel.read")).toEqual({
      allowed: false,
      denial: { permission: "channel.read", layer: "resource", reason: "private_channel" },
    });
    expect(ai(null, "owner").relations.size).toBe(0);
  });

  it("the owner reads, uses, searches the web, manages and shares", () => {
    for (const perm of [
      "channel.read",
      "ai_chat.use",
      "ai_chat.web",
      "ai_chat.manage",
      "ai_chat.share",
    ] as const) {
      expect(allowed(victor, owner, perm), perm).toBe(true);
      expect(allowed(sam, owner, perm), perm).toBe(true);
    }
  });

  it("a chat grantee reads, uses and searches the web; manage and share are denied not_ai_chat_owner", () => {
    for (const perm of ["channel.read", "ai_chat.use", "ai_chat.web"] as const) {
      expect(allowed(alex, chatGrant, perm), perm).toBe(true);
    }
    for (const perm of ["ai_chat.manage", "ai_chat.share"] as const) {
      expect(decide(alex, chatGrant, [], perm)).toEqual({
        allowed: false,
        denial: { permission: perm, layer: "resource", reason: "not_ai_chat_owner" },
      });
    }
  });

  it("a view grantee reads; use and web are ai_chat_view_only; manage and share not_ai_chat_owner", () => {
    expect(allowed(alex, viewGrant, "channel.read")).toBe(true);
    for (const perm of ["ai_chat.use", "ai_chat.web"] as const) {
      expect(decide(alex, viewGrant, [], perm)).toEqual({
        allowed: false,
        denial: { permission: perm, layer: "resource", reason: "ai_chat_view_only" },
      });
    }
    for (const perm of ["ai_chat.manage", "ai_chat.share"] as const) {
      expect(decide(alex, viewGrant, [], perm).denial).toMatchObject({ reason: "not_ai_chat_owner" });
    }
  });

  it("no relation, the admin included: read is hidden (private_channel), everything else denied", () => {
    for (const who of [admin, sam]) {
      expect(decide(who, none, [], "channel.read").denial).toMatchObject({ reason: "private_channel" });
      for (const perm of ["ai_chat.use", "ai_chat.web", "ai_chat.manage", "ai_chat.share"] as const) {
        expect(decide(who, none, [], perm).denial, perm).toMatchObject({ reason: "not_ai_chat_owner" });
      }
    }
  });

  it("an agent principal keeps the member relation of its row and reads the chat", () => {
    const agent: PrincipalFacts = {
      kind: "agent",
      id: "a-1",
      orgRole: null,
      deactivated: false,
      memberUnitPaths: [],
      leadOfUnitIds: new Set(),
    };
    const asMember = channelResource({
      visibility: "private",
      archived: false,
      viewerRole: "member",
      kind: "ai_chat",
    });
    expect(allowed(agent, asMember, "channel.read")).toBe(true);
    const notMember = channelResource({
      visibility: "private",
      archived: false,
      viewerRole: null,
      kind: "ai_chat",
    });
    expect(decide(agent, notMember, [], "channel.read").denial).toMatchObject({ reason: "agent_not_member" });
  });

  it("a deny rule on ai_chat.use beats a chat grant (and the owner)", () => {
    const deny = rule({
      subjectKind: "user",
      subjectId: "u-alex",
      permission: "ai_chat.use",
      effect: "deny",
    });
    expect(decide(alex, chatGrant, [deny], "ai_chat.use").denial).toMatchObject({ reason: "denied_by_rule" });
    expect(allowed(alex, chatGrant, "channel.read", [deny])).toBe(true);
  });

  it("the Phase 5 fixed denials still hold for the owner and every grantee", () => {
    for (const perm of [
      "channel.members.add",
      "channel.members.remove",
      "channel.archive",
      "channel.update",
      "message.delete_any",
      "channel.mention_all",
      "channel.post",
    ] as const) {
      for (const [who, r] of [
        [victor, owner],
        [alex, chatGrant],
        [alex, viewGrant],
      ] as const) {
        expect(decide(who, r, [], perm).allowed, perm).toBe(false);
      }
      expect(decide(victor, owner, [], perm).denial, perm).toMatchObject({ reason: "ai_chat_private" });
    }
  });

  it("agent_card.approve in an AI chat needs write access: owner and chat grantee yes, view grantee ai_chat_view_only (security fix)", () => {
    expect(allowed(victor, owner, "agent_card.approve")).toBe(true);
    expect(allowed(alex, chatGrant, "agent_card.approve")).toBe(true);
    expect(decide(alex, viewGrant, [], "agent_card.approve")).toEqual({
      allowed: false,
      denial: { permission: "agent_card.approve", layer: "resource", reason: "ai_chat_view_only" },
    });
    expect(decide(sam, none, [], "agent_card.approve").allowed).toBe(false);
    // Channels, DMs and organization scope are unchanged (role-based).
    const channel = channelResource({ visibility: "public", archived: false, viewerRole: "member" });
    const dm = channelResource({ visibility: "private", archived: false, viewerRole: "member", kind: "dm" });
    expect(allowed(sam, channel, "agent_card.approve")).toBe(true);
    expect(allowed(sam, dm, "agent_card.approve")).toBe(true);
    expect(allowed(sam, orgResource(), "agent_card.approve")).toBe(true);
  });

  it("ai_chat.manage at organization scope stays role-based", () => {
    expect(allowed(sam, orgResource(), "ai_chat.manage")).toBe(true);
  });
});

// ---------------------------------------------------------------- module access (Phase 07.3, ADR-0024)

describe("module catalog rules (Phase 07.3, ADR-0024)", () => {
  const D = "dept-D";
  const T = "team-T";
  const P = "proj-P";
  const S = "dept-S";
  /** One deny row per catalog pattern of `m` (distinct ids), as the module-access API writes them. */
  const rowsOf = (m: ModuleId, extra: Partial<RuleFact> = {}): RuleFact[] =>
    MODULE_CATALOG[m].patterns.map((permission, i) =>
      rule({ id: `${m}-${i}`, permission, effect: "deny", ...extra }),
    );
  const catalogGrains = (m: ModuleId) =>
    Permission.options.filter((perm) =>
      MODULE_CATALOG[m].patterns.some((pat) => permissionMatches(pat, perm)),
    );

  it("deny beats admin: a user-subject row set removes each module's entry and grains, nothing else", () => {
    const admin = user("admin", { id: "u-admin" });
    const before = resolveEffectivePermissions(admin, orgResource(), []).permissions;
    for (const m of ModuleId.options) {
      const { entry } = MODULE_CATALOG[m];
      const rows = rowsOf(m, { subjectKind: "user", subjectId: "u-admin" });
      expect(before.has(entry), `${m}: the admin holds ${entry} without rows`).toBe(true);
      expect(decide(admin, orgResource(), rows, entry).denial, m).toMatchObject({
        permission: entry,
        layer: "user",
        reason: "denied_by_rule",
      });
      const after = resolveEffectivePermissions(admin, orgResource(), rows).permissions;
      for (const perm of catalogGrains(m)) expect(after.has(perm), `${m}: ${perm}`).toBe(false);
      // Device hygiene, governance and module management stay with the admin.
      for (const keep of [
        "device.read",
        "device.revoke",
        "bot.manage",
        "work_zone.manage",
        "unit.modules.manage",
      ] as const) {
        expect(after.has(keep), `${m}: ${keep}`).toBe(true);
      }
      expect([...after].sort(), m).toEqual([...before].filter((p) => !catalogGrains(m).includes(p)).sort());
    }
  });

  it("unit inheritance: Work Zone rows on department D reach members of T and P under it, not sibling S", () => {
    const rows = rowsOf("work_zone", { scopeUnitId: D });
    const inT = user("developer", { id: "u-t", memberUnitPaths: [[D, T]] });
    const inP = user("developer", { id: "u-p", memberUnitPaths: [[D, T, P]] });
    const inS = user("developer", { id: "u-s", memberUnitPaths: [[S]] });
    expect(decide(inT, orgResource(), rows, "work_session.read").denial).toMatchObject({
      layer: "unit",
      reason: "denied_by_rule",
      unitId: D,
    });
    expect(allowed(inP, orgResource(), "work_session.read", rows)).toBe(false);
    expect(allowed(inP, orgResource(), "device.pair", rows)).toBe(false);
    expect(allowed(inS, orgResource(), "work_session.read", rows)).toBe(true);
    // Device hygiene is never a module grain.
    expect(allowed(inT, orgResource(), "device.read", rows)).toBe(true);
    const own = deviceResource({ ownerUserId: "u-t", shared: false, revoked: false }, "u-t");
    expect(allowed(inT, own, "device.revoke", rows)).toBe(true);
    expect(allowed(inT, own, "device.use", rows)).toBe(false);
  });

  it("a user-subject row scoped to T stops applying once the user's member paths no longer contain T", () => {
    const rows = rowsOf("work_zone", { scopeUnitId: T, subjectKind: "user", subjectId: "u-dana" });
    const danaInT = user("developer", { id: "u-dana", memberUnitPaths: [[D, T]] });
    expect(decide(danaInT, orgResource(), rows, "work_session.read").denial).toMatchObject({
      layer: "user",
      unitId: T,
    });
    const danaMoved = user("developer", { id: "u-dana", memberUnitPaths: [[S]] });
    expect(allowed(danaMoved, orgResource(), "work_session.read", rows)).toBe(true);
    // Another member of T is not the subject.
    expect(
      allowed(
        user("developer", { id: "u-other", memberUnitPaths: [[D, T]] }),
        orgResource(),
        "work_session.read",
        rows,
      ),
    ).toBe(true);
  });

  it("agent ∩ human: an organization team bot acting for Dana loses bot.internet and bot.tool.use, not for Sam", () => {
    const rows = rowsOf("bots", { subjectKind: "user", subjectId: "u-dana" });
    const bot: PrincipalFacts = { ...user(null), kind: "agent", id: "bot-team" };
    const team = { scope: "team" as const, ownerUserId: null, disabled: false };
    const dana = user("developer", { id: "u-dana" });
    const sam = user("standard", { id: "u-sam" });
    for (const perm of ["bot.internet", "bot.tool.use"] as const) {
      expect(
        decide(bot, agentResource(team, null), rows, perm, {
          principal: dana,
          resource: agentResource(team, "u-dana"),
        }).denial,
        perm,
      ).toMatchObject({ permission: perm, layer: "user", reason: "denied_by_rule" });
      expect(
        decide(bot, agentResource(team, null), rows, perm, {
          principal: sam,
          resource: agentResource(team, "u-sam"),
        }),
        perm,
      ).toEqual({ allowed: true });
    }
    expect(allowed(dana, agentResource(team, "u-dana"), "bot.read", rows)).toBe(false);
    expect(allowed(sam, agentResource(team, "u-sam"), "bot.read", rows)).toBe(true);
  });

  it("side effect pinned (D-05): Bots rows on Backend silence Backend's persona for everyone, admins included", () => {
    const ENG = "unit-eng";
    const BACKEND = "unit-backend";
    const FRONTEND = "unit-frontend";
    const rows = rowsOf("bots", { scopeUnitId: BACKEND });
    const persona = { scope: "team" as const, ownerUserId: null, disabled: false, unitPath: [ENG, BACKEND] };
    const orgBot = { scope: "team" as const, ownerUserId: null, disabled: false };
    const admin = user("admin", { id: "u-admin" }); // not a member of Backend
    const alex = user("standard", { id: "u-alex", memberUnitPaths: [[ENG, BACKEND]] });
    const jo = user("standard", { id: "u-jo", memberUnitPaths: [[ENG, FRONTEND]] });
    const personaBot: PrincipalFacts = { ...user(null), kind: "agent", id: "bot-backend" };

    // The admin outside Backend loses read and configure on the persona; governance stays.
    expect(decide(admin, agentResource(persona, "u-admin"), rows, "bot.read").denial).toMatchObject({
      layer: "unit",
      reason: "denied_by_rule",
      unitId: BACKEND,
    });
    expect(allowed(admin, agentResource(persona, "u-admin"), "bot.configure", rows)).toBe(false);
    expect(allowed(admin, agentResource(persona, "u-admin"), "bot.manage", rows)).toBe(true);
    // The persona, acting for anyone, has no internet.
    for (const human of [admin, alex, jo]) {
      expect(
        allowed(personaBot, agentResource(persona, null), "bot.internet", rows),
        `persona itself (${human.id})`,
      ).toBe(false);
      expect(
        decide(personaBot, agentResource(persona, null), rows, "bot.internet", {
          principal: human,
          resource: agentResource(persona, human.id),
        }).allowed,
        human.id,
      ).toBe(false);
    }
    // An organization team bot is untouched for people outside Backend; Backend's own members lose it (unit off).
    expect(allowed(jo, agentResource(orgBot, "u-jo"), "bot.read", rows)).toBe(true);
    expect(allowed(admin, agentResource(orgBot, "u-admin"), "bot.read", rows)).toBe(true);
    const orgAgent: PrincipalFacts = { ...user(null), kind: "agent", id: "bot-org" };
    expect(
      decide(orgAgent, agentResource(orgBot, null), rows, "bot.internet", {
        principal: jo,
        resource: agentResource(orgBot, "u-jo"),
      }),
    ).toEqual({ allowed: true });
    expect(allowed(alex, agentResource(orgBot, "u-alex"), "bot.read", rows)).toBe(false);
  });

  it("AI chats: an ai_chat.* deny removes ai_chat.read at organization scope (and every ai_chat grain)", () => {
    const sam = user("standard", { id: "u-sam" });
    const rows = rowsOf("ai_chats", { subjectKind: "user", subjectId: "u-sam" });
    expect(decide(sam, orgResource(), rows, "ai_chat.read").denial).toMatchObject({
      layer: "user",
      reason: "denied_by_rule",
    });
    const held = resolveEffectivePermissions(sam, orgResource(), rows).permissions;
    expect([...held].filter((p) => p.startsWith("ai_chat."))).toEqual([]);
    // A plain ai_chat.use deny leaves ai_chat.read (today's semantics, research Gap 1).
    const useOnly = [
      rule({ subjectKind: "user", subjectId: "u-sam", permission: "ai_chat.use", effect: "deny" }),
    ];
    expect(allowed(sam, orgResource(), "ai_chat.read", useOnly)).toBe(true);
  });
});

describe("unit.modules.manage and the lead ceiling (Phase 07.3, D-05 (1))", () => {
  const D = "dept-D";
  const T = "team-T";
  const P = "proj-P";
  const unitD = { id: D, path: [D] };
  const unitT = { id: T, path: [D, T] };
  const unitP = { id: P, path: [D, T, P] };
  const admin = user("admin", { id: "u-admin" });
  const lead = user("lead", { id: "u-lead", memberUnitPaths: [[D, T]], leadOfUnitIds: new Set([T]) });
  const dev = user("developer", { id: "u-dev", memberUnitPaths: [[D, T]] });

  it("admins hold it on the organization and on every unit", () => {
    for (const r of [orgResource(), unitResource(unitD), unitResource(unitT), unitResource(unitP)]) {
      expect(allowed(admin, r, "unit.modules.manage")).toBe(true);
    }
  });

  it("a lead of T holds it on T and its descendants, not on D nor the organization; a developer never", () => {
    expect(allowed(lead, unitResource(unitT), "unit.modules.manage")).toBe(true);
    expect(allowed(lead, unitResource(unitP), "unit.modules.manage")).toBe(true);
    expect(allowed(lead, unitResource(unitD), "unit.modules.manage")).toBe(false);
    expect(allowed(lead, orgResource(), "unit.modules.manage")).toBe(false);
    for (const r of [orgResource(), unitResource(unitD), unitResource(unitT), unitResource(unitP)]) {
      expect(allowed(dev, r, "unit.modules.manage")).toBe(false);
    }
  });

  it("moduleTargetResource is the unit (or organization) resource plus the target's role", () => {
    expect(moduleTargetResource(unitT)).toEqual(unitResource(unitT));
    expect(moduleTargetResource(null)).toEqual(orgResource());
    expect(moduleTargetResource(unitT, "admin")).toEqual({ ...unitResource(unitT), targetRole: "admin" });
    expect(moduleTargetResource(null, "standard")).toEqual({ ...orgResource(), targetRole: "standard" });
  });

  it("a lead never targets an admin (role_ceiling); lead, developer and standard targets are allowed", () => {
    expect(decide(lead, moduleTargetResource(unitT, "admin"), [], "unit.modules.manage")).toEqual({
      allowed: false,
      denial: { permission: "unit.modules.manage", layer: "resource", reason: "role_ceiling" },
    });
    expect(allowed(lead, moduleTargetResource(unitP, "admin"), "unit.modules.manage")).toBe(false);
    for (const target of ["lead", "developer", "standard"] as const) {
      expect(allowed(lead, moduleTargetResource(unitT, target), "unit.modules.manage"), target).toBe(true);
    }
    // The ceiling never widens: outside the led subtree the lead holds nothing, whatever the target.
    expect(allowed(lead, moduleTargetResource(unitD, "standard"), "unit.modules.manage")).toBe(false);
  });

  it("the ceiling compares role ranks: a unit lead with the developer role cannot target a lead", () => {
    const devLead = user("developer", { id: "u-dl", memberUnitPaths: [[D, T]], leadOfUnitIds: new Set([T]) });
    expect(
      decide(devLead, moduleTargetResource(unitT, "lead"), [], "unit.modules.manage").denial,
    ).toMatchObject({
      reason: "role_ceiling",
    });
    expect(allowed(devLead, moduleTargetResource(unitT, "developer"), "unit.modules.manage")).toBe(true);
  });

  it("an admin targets every role, on the organization and on units", () => {
    for (const target of OrgRole.options) {
      expect(allowed(admin, moduleTargetResource(null, target), "unit.modules.manage"), target).toBe(true);
      expect(allowed(admin, moduleTargetResource(unitT, target), "unit.modules.manage"), target).toBe(true);
    }
  });

  it("an organization deny rule on unit.modules.manage removes it from the lead (delegable, deny wins)", () => {
    const deny = rule({
      id: "no-modules",
      subjectKind: "user",
      subjectId: "u-lead",
      permission: "unit.modules.manage",
      effect: "deny",
    });
    expect(decide(lead, unitResource(unitT), [deny], "unit.modules.manage").denial).toMatchObject({
      layer: "user",
      ruleId: "no-modules",
    });
    expect(allowed(admin, unitResource(unitT), "unit.modules.manage", [deny])).toBe(true);
  });
});

// ---------------------------------------------------------------- properties (fast-check)

const UNITS = ["u0", "u1", "u2", "u3", "u4", "u5"] as const;
const RELATIONS: Relation[] = [
  "self",
  "owner",
  "member",
  "creator",
  "device_owner",
  "grantee",
  "full_access_grantee",
  "inviter",
];
const STATES: ResourceState[] = [
  "ai_chat",
  "private",
  "archived",
  "revoked",
  "device_revoked",
  "personal",
  "disabled",
  "dm",
  "unit_scoped",
];
const TYPES: ResourceType[] = [
  "organization",
  "unit",
  "user",
  "member",
  "channel",
  "channel_member",
  "device",
  "work_session",
  "invitation",
  "agent",
];
const PATTERNS = [...Permission.options, "channel.*", "device.*", "work_session.*", "unit.*", "invitation.*"];
const IDS = ["p1", "p2"];
const TOOLS = ["Bash", "Edit"];

/** Small random trees (depth ≤ 3, 6 units), each path root→self. */
const arbTree = fc
  .array(fc.option(fc.nat(5), { nil: null }), { minLength: UNITS.length, maxLength: UNITS.length })
  .map((parents) => {
    const paths: string[][] = [];
    parents.forEach((parent, i) => {
      const parentPath = parent !== null && parent < i ? paths[parent] : undefined;
      paths.push(parentPath && parentPath.length < 3 ? [...parentPath, UNITS[i]!] : [UNITS[i]!]);
    });
    return paths;
  });

const arbPrincipal = (
  paths: string[][],
  kinds: PrincipalFacts["kind"][] = ["user", "user", "user", "agent", "cell", "device"],
) =>
  fc
    .record({
      kind: fc.constantFrom(...kinds),
      id: fc.constantFrom(...IDS),
      orgRole: fc.constantFrom(...OrgRole.options),
      deactivated: fc.nat(4).map((n) => n === 0),
      memberUnitPaths: fc.subarray(paths),
      leadOf: fc.subarray([...UNITS]),
    })
    .map(
      (x): PrincipalFacts => ({
        kind: x.kind,
        id: x.id,
        orgRole: x.kind === "user" ? x.orgRole : null,
        deactivated: x.deactivated,
        memberUnitPaths: x.kind === "user" ? x.memberUnitPaths : [],
        leadOfUnitIds: new Set(x.kind === "user" ? x.leadOf : []),
      }),
    );

const arbResource = (paths: string[][]) =>
  fc
    .record({
      type: fc.constantFrom(...TYPES),
      unitPath: fc.oneof(fc.constant([] as string[]), fc.constantFrom(...paths)),
      relations: fc.subarray(RELATIONS),
      state: fc.subarray(STATES),
      tool: fc.option(fc.constantFrom(...TOOLS), { nil: undefined }),
      invitedRole: fc.option(fc.constantFrom(...OrgRole.options), { nil: undefined }),
    })
    .map(
      (x): ResourceFacts => ({
        type: x.type,
        unitPath: x.unitPath,
        relations: new Set(x.relations),
        state: new Set(x.state),
        ...(x.tool ? { tool: x.tool } : {}),
        ...(x.invitedRole ? { invitedRole: x.invitedRole } : {}),
      }),
    );

const arbRuleBody = fc
  .record({
    scopeUnitId: fc.option(fc.constantFrom(...UNITS), { nil: null }),
    subjectKind: fc.constantFrom(...RuleSubjectKind.options),
    role: fc.constantFrom(...OrgRole.options),
    who: fc.constantFrom(...IDS),
    permission: fc.constantFrom(...PATTERNS),
    tool: fc.option(fc.constantFrom(...TOOLS), { nil: null }),
    effect: fc.constantFrom("allow" as const, "deny" as const),
  })
  .map((x) => ({
    scopeUnitId: x.scopeUnitId,
    subjectKind: x.subjectKind,
    subjectId: x.subjectKind === "everyone" ? null : x.subjectKind === "role" ? x.role : x.who,
    permission: x.permission,
    tool: x.tool,
    effect: x.effect,
  }));

const withIds = (bodies: Omit<RuleFact, "id">[], prefix = "r"): RuleFact[] =>
  bodies.map((b, i) => ({ ...b, id: `${prefix}${i}` }));

const arbWorld = arbTree.chain((paths) =>
  fc.record({
    paths: fc.constant(paths),
    p: arbPrincipal(paths),
    r: arbResource(paths),
    rules: fc.array(arbRuleBody, { maxLength: 8 }).map((b) => withIds(b)),
  }),
);

const RUNS = { numRuns: 300 };
const subset = (a: ReadonlySet<Permission>, b: ReadonlySet<Permission>) => [...a].every((x) => b.has(x));
const snapshot = (res: ReturnType<typeof resolveEffectivePermissions>) =>
  JSON.stringify({
    permissions: [...res.permissions].sort(),
    denied: [...res.denied.entries()].sort(([a], [b]) => (a < b ? -1 : 1)),
    principalDenied: res.principalDenied ?? null,
  });

describe("resolver properties", () => {
  it("adding a deny never adds a permission", () => {
    fc.assert(
      fc.property(arbWorld, arbRuleBody, ({ p, r, rules }, extra) => {
        const before = resolveEffectivePermissions(p, r, rules).permissions;
        const after = resolveEffectivePermissions(p, r, [
          ...rules,
          { ...extra, effect: "deny", id: "extra" },
        ]).permissions;
        return subset(after, before);
      }),
      RUNS,
    );
  });

  it("adding an allow never removes a permission", () => {
    fc.assert(
      fc.property(arbWorld, arbRuleBody, ({ p, r, rules }, extra) => {
        const before = resolveEffectivePermissions(p, r, rules).permissions;
        const after = resolveEffectivePermissions(p, r, [
          ...rules,
          { ...extra, effect: "allow", id: "extra" },
        ]).permissions;
        return subset(before, after);
      }),
      RUNS,
    );
  });

  it("a deny scoped to any unit on the resource path or the principal's paths beats every allow", () => {
    const arb = arbTree.chain((paths) =>
      fc.record({
        p: arbPrincipal(paths, ["user", "agent"]),
        r: arbResource(paths),
        rules: fc.array(arbRuleBody, { maxLength: 8 }).map((b) => withIds(b)),
        perm: fc.constantFrom(...Permission.options),
        pick: fc.nat(),
      }),
    );
    fc.assert(
      fc.property(arb, ({ p, r, rules, perm, pick }) => {
        const candidates = [...r.unitPath, ...p.memberUnitPaths.flat()];
        if (candidates.length === 0) return true;
        const scope = candidates[pick % candidates.length]!;
        const allowEverything = withIds(
          PATTERNS.map((permission) => ({
            scopeUnitId: null,
            subjectKind: "everyone" as const,
            subjectId: null,
            permission,
            tool: null,
            effect: "allow" as const,
          })),
          "allow",
        );
        const deny: RuleFact = {
          id: "deny",
          scopeUnitId: scope,
          subjectKind: "everyone",
          subjectId: null,
          permission: perm,
          tool: null,
          effect: "deny",
        };
        return !resolveEffectivePermissions(p, r, [...rules, ...allowEverything, deny]).permissions.has(perm);
      }),
      RUNS,
    );
  });

  it("a deactivated principal holds nothing", () => {
    fc.assert(
      fc.property(arbWorld, ({ p, r, rules }) => {
        const res = resolveEffectivePermissions({ ...p, deactivated: true }, r, rules);
        return res.permissions.size === 0 && res.principalDenied !== undefined;
      }),
      RUNS,
    );
  });

  it("an agent acting for a human never exceeds the human", () => {
    const arb = arbTree.chain((paths) =>
      fc.record({
        agent: arbPrincipal(paths, ["agent"]),
        human: arbPrincipal(paths, ["user"]),
        r: arbResource(paths),
        humanR: arbResource(paths),
        rules: fc.array(arbRuleBody, { maxLength: 8 }).map((b) => withIds(b)),
      }),
    );
    fc.assert(
      fc.property(arb, ({ agent, human, r, humanR, rules }) => {
        const own = resolveEffectivePermissions(human, humanR, rules).permissions;
        const acting = resolveEffectivePermissions(agent, r, rules, {
          principal: human,
          resource: humanR,
        }).permissions;
        const alone = resolveEffectivePermissions(agent, r, rules).permissions;
        return subset(acting, own) && subset(acting, alone);
      }),
      RUNS,
    );
  });

  it("rule order and unit-path order never change the result", () => {
    const arb = arbWorld.chain((w) =>
      fc.record({
        w: fc.constant(w),
        rules: fc.shuffledSubarray(w.rules, { minLength: w.rules.length, maxLength: w.rules.length }),
        paths: fc.shuffledSubarray([...w.p.memberUnitPaths], {
          minLength: w.p.memberUnitPaths.length,
          maxLength: w.p.memberUnitPaths.length,
        }),
      }),
    );
    fc.assert(
      fc.property(arb, ({ w, rules, paths }) => {
        const a = resolveEffectivePermissions(w.p, w.r, w.rules);
        const b = resolveEffectivePermissions({ ...w.p, memberUnitPaths: paths }, w.r, rules);
        return snapshot(a) === snapshot(b);
      }),
      RUNS,
    );
  });

  it("without allow rules a standard user never holds a Work Zone permission", () => {
    fc.assert(
      fc.property(arbWorld, ({ p, r, rules }) => {
        const standard: PrincipalFacts = { ...p, kind: "user", orgRole: "standard" };
        const denies = rules.filter((x) => x.effect === "deny");
        const res = resolveEffectivePermissions(standard, r, denies);
        return [...res.permissions].every((perm) => PERMISSION_SURFACE[perm] !== "workzone");
      }),
      RUNS,
    );
  });

  it("allow rules never grant a non-delegable permission the role lacks", () => {
    fc.assert(
      fc.property(arbWorld, ({ p, r, rules }) => {
        const standard: PrincipalFacts = { ...p, kind: "user", orgRole: "standard" };
        const res = resolveEffectivePermissions(standard, r, rules);
        return NON_DELEGABLE_PERMISSIONS.every((perm) => !res.permissions.has(perm));
      }),
      RUNS,
    );
  });
});
