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
  agentTemplateResource,
  channelMemberResource,
  channelResource,
  deviceResource,
  invitationResource,
  type MemoryScopeFacts,
  memoryResource,
  moduleTargetResource,
  orgResource,
  unitResource,
  userResource,
  workProjectResource,
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
  return {
    id: "rule-1",
    scopeUnitId: null,
    subjectKind: "everyone",
    subjectId: null,
    tool: null,
    pathPrefix: null,
    ...extra,
  };
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
    "memory.read": true,
    "memory.write": false,
    "memory.promote": false,
    "connector.connect": true,
    "vault.use": true,
    "vault.manage": false,
    "agent_template.manage": false,
    "tool_approval.manage": false,
    "sandbox.use": true,
    "sandbox.files": true,
    "browser.use": true,
    "browser.watch": true,
    "browser.control": true,
    "work_session.visibility": false,
    "work_project.manage": false,
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
    "memory.read": true,
    "memory.write": false,
    "memory.promote": false,
    "connector.connect": true,
    "vault.use": true,
    "vault.manage": false,
    "agent_template.manage": false,
    "tool_approval.manage": false,
    "sandbox.use": true,
    "sandbox.files": true,
    "browser.use": true,
    "browser.watch": true,
    "browser.control": true,
    "work_session.visibility": false,
    "work_project.manage": false,
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
    "memory.read": true,
    "memory.write": false,
    "memory.promote": false,
    "connector.connect": true,
    "vault.use": true,
    "vault.manage": false,
    "agent_template.manage": false,
    "tool_approval.manage": false,
    "sandbox.use": true,
    "sandbox.files": true,
    "browser.use": true,
    "browser.watch": true,
    "browser.control": true,
    "work_session.visibility": false,
    "work_project.manage": false,
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
    "memory.read": true,
    "memory.write": true,
    "memory.promote": true,
    "connector.connect": true,
    "vault.use": true,
    "vault.manage": true,
    "agent_template.manage": true,
    "tool_approval.manage": true,
    "sandbox.use": true,
    "sandbox.files": true,
    "browser.use": true,
    "browser.watch": true,
    "browser.control": true,
    "work_session.visibility": true,
    "work_project.manage": true,
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

  it("leading confers the team surface; a lead grain on another surface still needs the role's surface (07.9-01)", () => {
    const unitP = unitResource({ id: P, path: [D, T, P] });
    const standardLead = user("standard", { memberUnitPaths: [[D, T]], leadOfUnitIds: new Set([T]) });
    const developerLead = user("developer", { memberUnitPaths: [[D, T]], leadOfUnitIds: new Set([T]) });
    expect(allowed(standardLead, unitP, "work_project.manage")).toBe(true);
    expect(allowed(standardLead, unitP, "work_session.visibility")).toBe(false);
    expect(allowed(developerLead, unitP, "work_project.manage")).toBe(true);
    expect(allowed(developerLead, unitP, "work_session.visibility")).toBe(true);
    expect(allowed(developerLead, unitResource({ id: D, path: [D] }), "work_project.manage")).toBe(false);
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
  "project_member",
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
  "work_project",
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
    pathPrefix: null,
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
            pathPrefix: null,
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
          pathPrefix: null,
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

// ---------------------------------------------------------------- memory (Phase 07.2)

describe("memory scopes and folder rules (Phase 07.2, MEM-04, MEM-07, D-04, D-08)", () => {
  // Department D holds teams A and B.
  const D = "unit-d";
  const A = "unit-a";
  const B = "unit-b";
  const PATH_D = [D];
  const PATH_A = [D, A];
  const PATH_B = [D, B];
  const aMember = user("standard", { id: "u-a", memberUnitPaths: [PATH_A] });
  const bMember = user("standard", { id: "u-b", memberUnitPaths: [PATH_B] });
  const dOnly = user("standard", { id: "u-d", memberUnitPaths: [PATH_D] });
  const dLead = user("lead", { id: "u-dl", memberUnitPaths: [PATH_D], leadOfUnitIds: new Set([D]) });
  const aLead = user("lead", { id: "u-al", memberUnitPaths: [PATH_A], leadOfUnitIds: new Set([A]) });
  const admin = user("admin", { id: "u-admin" });

  const unitScope = (unitPath: readonly string[]): MemoryScopeFacts => ({
    kind: "unit",
    ownerUserId: null,
    agent: null,
    unitPath,
  });
  const ORG: MemoryScopeFacts = { kind: "org", ownerUserId: null, agent: null, unitPath: [] };
  const principalOf = (p: PrincipalFacts) =>
    ({ kind: p.kind === "agent" ? "agent" : "user", id: p.id }) as const;
  const res = (p: PrincipalFacts, scope: MemoryScopeFacts, path?: string) =>
    memoryResource(scope, path, principalOf(p));
  const can = (
    p: PrincipalFacts,
    scope: MemoryScopeFacts,
    perm: Permission,
    path?: string,
    rules: RuleFact[] = [],
  ) => decide(p, res(p, scope, path), rules, perm).allowed;
  const why = (
    p: PrincipalFacts,
    scope: MemoryScopeFacts,
    perm: Permission,
    path?: string,
    rules: RuleFact[] = [],
  ) => decide(p, res(p, scope, path), rules, perm).denial;

  describe("folder rules: the path prefix narrows a rule, deny wins", () => {
    const hrDeny = rule({
      id: "hr-deny",
      scopeUnitId: A,
      subjectKind: "user",
      subjectId: aMember.id,
      permission: "memory.read",
      pathPrefix: "hr/",
      effect: "deny",
    });

    it("a user deny on hr/ hides that folder (any casing, any depth) and nothing else", () => {
      const scope = unitScope(PATH_A);
      expect(can(aMember, scope, "memory.read", "clients/x.md", [hrDeny])).toBe(true);
      for (const path of ["hr/a.md", "HR/a.md", "Hr/Sub/b.md", "hr/sub/b.md"]) {
        expect(why(aMember, scope, "memory.read", path, [hrDeny]), path).toEqual({
          permission: "memory.read",
          layer: "user",
          reason: "denied_by_rule",
          ruleId: "hr-deny",
          unitId: A,
        });
      }
      // Segment boundary: a sibling folder or a file named like the folder stays readable.
      expect(can(aMember, scope, "memory.read", "hr-public/c.md", [hrDeny])).toBe(true);
      expect(can(aMember, scope, "memory.read", "hr.md", [hrDeny])).toBe(true);
      expect(can(aMember, scope, "memory.read", "clients/hr/x.md", [hrDeny])).toBe(true);
      // The rule names one person: the lead of A still reads the folder.
      expect(can(aLead, scope, "memory.read", "hr/a.md", [hrDeny])).toBe(true);
    });

    it("the same deny for everyone removes an admin's read too", () => {
      const everyoneDeny = { ...hrDeny, subjectKind: "everyone" as const, subjectId: null };
      expect(why(admin, unitScope(PATH_A), "memory.read", "hr/a.md", [everyoneDeny])).toMatchObject({
        layer: "unit",
        reason: "denied_by_rule",
        ruleId: "hr-deny",
      });
      expect(can(admin, unitScope(PATH_A), "memory.read", "notes/a.md", [everyoneDeny])).toBe(true);
    });

    it("a folder allow grants that folder only, never a sibling or the scope root", () => {
      const notesAllow = rule({
        id: "notes-allow",
        scopeUnitId: A,
        permission: "memory.write",
        pathPrefix: "notes/",
        effect: "allow",
      });
      const scope = unitScope(PATH_A);
      expect(can(aMember, scope, "memory.write", "notes/x.md", [notesAllow])).toBe(true);
      expect(can(aMember, scope, "memory.write", "Notes/deep/x.md", [notesAllow])).toBe(true);
      for (const path of ["y.md", "notes.md", "notes-old/x.md", "other/notes/x.md"]) {
        expect(can(aMember, scope, "memory.write", path, [notesAllow]), path).toBe(false);
      }
      expect(can(aMember, scope, "memory.write", undefined, [notesAllow])).toBe(false);
    });

    it("a path rule never applies to a scope-level decision; a rule without a path applies everywhere", () => {
      const scope = unitScope(PATH_A);
      expect(can(aMember, scope, "memory.read", undefined, [hrDeny])).toBe(true);
      const wholeDeny = { ...hrDeny, id: "whole", pathPrefix: null };
      expect(can(aMember, scope, "memory.read", undefined, [wholeDeny])).toBe(false);
      for (const path of ["MEMORY.md", "clients/x.md", "hr/a.md"]) {
        expect(can(aMember, scope, "memory.read", path, [wholeDeny]), path).toBe(false);
      }
    });

    it("a deny on a folder beats an allow higher up (organization) and the lead grant", () => {
      const orgAllow = rule({ id: "org-allow", permission: "memory.write", effect: "allow" });
      const hrWriteDeny = rule({
        id: "hr-write-deny",
        scopeUnitId: A,
        permission: "memory.write",
        pathPrefix: "hr/",
        effect: "deny",
      });
      const scope = unitScope(PATH_A);
      expect(can(aMember, scope, "memory.write", "clients/x.md", [orgAllow, hrWriteDeny])).toBe(true);
      expect(can(aMember, scope, "memory.write", "hr/x.md", [orgAllow, hrWriteDeny])).toBe(false);
      expect(can(aLead, scope, "memory.write", "hr/x.md", [orgAllow, hrWriteDeny])).toBe(false);
      expect(can(admin, scope, "memory.write", "hr/x.md", [orgAllow, hrWriteDeny])).toBe(false);
      // `memory.*` on a folder denies every memory grain under it.
      const allMemory = { ...hrWriteDeny, id: "hr-all", permission: "memory.*" };
      for (const perm of ["memory.read", "memory.write", "memory.promote"] as const) {
        expect(can(dLead, scope, perm, "hr/x.md", [allMemory]), perm).toBe(false);
        expect(can(dLead, scope, perm, "ops/x.md", [allMemory]), perm).toBe(true);
      }
    });

    it("folder rules reach the people they name on any scope (personal, notebook, organization)", () => {
      const SAM = "u-sam";
      const sam = user("standard", { id: SAM });
      const personal: MemoryScopeFacts = {
        kind: "personal",
        ownerUserId: SAM,
        agent: { id: "bot-1", scope: "team", ownerUserId: null, disabled: false },
        unitPath: [],
      };
      const deny = rule({ id: "d", permission: "memory.write", pathPrefix: "drafts/", effect: "deny" });
      expect(can(sam, personal, "memory.write", "drafts/a.md", [deny])).toBe(false);
      expect(can(sam, personal, "memory.write", "a.md", [deny])).toBe(true);
      expect(can(admin, ORG, "memory.write", "drafts/a.md", [deny])).toBe(false);
    });

    it("property: adding a folder deny never adds a permission and beats an allow of everything", () => {
      const scopes = [unitScope(PATH_A), unitScope(PATH_B), unitScope(PATH_D), ORG];
      const people = [aMember, bMember, dOnly, dLead, aLead, admin];
      const paths = ["MEMORY.md", "hr/a.md", "HR/b.md", "hr-x/c.md", "notes/x.md", "a/b/c.md"];
      const folders = ["hr/", "notes/", "a/", "a/b/", "zz/"];
      const memoryPerms = ["memory.read", "memory.write", "memory.promote"] as const;
      const arbRule = fc.record({
        scopeUnitId: fc.constantFrom(null, A, B, D),
        subjectKind: fc.constant("everyone" as const),
        subjectId: fc.constant(null),
        permission: fc.constantFrom<string>(...memoryPerms, "memory.*"),
        tool: fc.constant(null),
        pathPrefix: fc.option(fc.constantFrom(...folders), { nil: null }),
        effect: fc.constantFrom("allow" as const, "deny" as const),
      });
      fc.assert(
        fc.property(
          fc.constantFrom(...people),
          fc.constantFrom(...scopes),
          fc.constantFrom(...paths),
          fc.array(arbRule, { maxLength: 6 }).map((b) => withIds(b)),
          fc.constantFrom(...folders),
          fc.constantFrom(...memoryPerms),
          (p, scope, path, rules, folder, perm) => {
            const r = res(p, scope, path);
            const before = resolveEffectivePermissions(p, r, rules).permissions;
            const deny: RuleFact = {
              id: "deny",
              scopeUnitId: null,
              subjectKind: "everyone",
              subjectId: null,
              permission: perm,
              tool: null,
              pathPrefix: folder,
              effect: "deny",
            };
            const allowAll = rule({ id: "allow-all", permission: "memory.*", effect: "allow" });
            const after = resolveEffectivePermissions(p, r, [...rules, allowAll, deny]).permissions;
            const denied = resolveEffectivePermissions(p, r, [...rules, deny]).permissions;
            const under = path.toLowerCase().startsWith(folder);
            return subset(denied, before) && (!under || !after.has(perm));
          },
        ),
        RUNS,
      );
    });
  });

  describe("unit scopes (D ⊃ A, B): the unit-persona audience reads, leads write and promote their subtree", () => {
    it("a member of A reads A and D, not B; a member of D only reads D, not A", () => {
      expect(can(aMember, unitScope(PATH_A), "memory.read", "x.md")).toBe(true);
      expect(can(aMember, unitScope(PATH_D), "memory.read", "x.md")).toBe(true);
      expect(why(aMember, unitScope(PATH_B), "memory.read", "x.md")).toEqual({
        permission: "memory.read",
        layer: "resource",
        reason: "unit_memory",
      });
      expect(can(dOnly, unitScope(PATH_D), "memory.read")).toBe(true);
      expect(why(dOnly, unitScope(PATH_A), "memory.read")).toMatchObject({ reason: "unit_memory" });
    });

    it("the lead of D reads, writes and promotes A and B", () => {
      for (const path of [PATH_A, PATH_B, PATH_D]) {
        for (const perm of ["memory.read", "memory.write", "memory.promote"] as const) {
          expect(can(dLead, unitScope(path), perm, "x.md"), `${perm} ${path.join("/")}`).toBe(true);
        }
      }
    });

    it("the lead of A writes and promotes A only: never B, never D", () => {
      expect(can(aLead, unitScope(PATH_A), "memory.write", "x.md")).toBe(true);
      expect(can(aLead, unitScope(PATH_A), "memory.promote", "x.md")).toBe(true);
      expect(can(aLead, unitScope(PATH_B), "memory.promote", "x.md")).toBe(false);
      expect(can(aLead, unitScope(PATH_B), "memory.write", "x.md")).toBe(false);
      expect(can(aLead, unitScope(PATH_D), "memory.promote", "x.md")).toBe(false);
      expect(can(aLead, unitScope(PATH_D), "memory.read", "x.md")).toBe(true);
    });

    it("an admin reads, writes and promotes A, B and D", () => {
      for (const path of [PATH_A, PATH_B, PATH_D]) {
        for (const perm of ["memory.read", "memory.write", "memory.promote"] as const) {
          expect(can(admin, unitScope(path), perm, "x.md"), `${perm} ${path.join("/")}`).toBe(true);
        }
      }
    });

    it("a standard member never writes or promotes their unit's memory by default", () => {
      expect(why(aMember, unitScope(PATH_A), "memory.write", "x.md")).toMatchObject({
        layer: "role",
        reason: "missing_permission",
      });
      expect(can(aMember, unitScope(PATH_A), "memory.promote", "x.md")).toBe(false);
    });

    it("no allow rule opens a unit's memory to someone outside its audience, for any grain", () => {
      const allowAll = rule({
        id: "allow-b",
        subjectKind: "user",
        subjectId: bMember.id,
        permission: "memory.*",
        effect: "allow",
      });
      for (const perm of ["memory.read", "memory.write", "memory.promote"] as const) {
        expect(why(bMember, unitScope(PATH_A), perm, "x.md", [allowAll]), perm).toMatchObject({
          reason: "unit_memory",
        });
      }
      // Inside the audience the same rule does grant: an allow extends, the audience bounds.
      const allowA = { ...allowAll, subjectId: aMember.id };
      expect(can(aMember, unitScope(PATH_A), "memory.write", "x.md", [allowA])).toBe(true);
    });

    it("the facts: a unit scope carries the unit path and state memory_unit; the path rides along", () => {
      const r = memoryResource(unitScope(PATH_A), "hr/a.md", { kind: "user", id: aMember.id });
      expect(r).toMatchObject({ type: "memory", unitPath: PATH_A, path: "hr/a.md" });
      expect([...r.state]).toEqual(["memory_unit"]);
      expect(r.relations.size).toBe(0);
      expect(memoryResource(unitScope(PATH_A), undefined, null).path).toBeUndefined();
    });
  });

  describe("personal scopes: owner-only for every human, the scope's own bot for its owner", () => {
    const SAM = "u-sam";
    const ALEX = "u-alex";
    const sam = user("standard", { id: SAM });
    const alex = user("developer", { id: ALEX });
    const teamBot = { id: "bot-1", scope: "team" as const, ownerUserId: null, disabled: false };
    const personal: MemoryScopeFacts = { kind: "personal", ownerUserId: SAM, agent: teamBot, unitPath: [] };
    const bot: PrincipalFacts = { ...user(null), kind: "agent", id: "bot-1" };
    const otherBot: PrincipalFacts = { ...user(null), kind: "agent", id: "bot-2" };
    const forHuman = (h: PrincipalFacts, path = "MEMORY.md") => ({
      principal: h,
      resource: memoryResource(personal, path, { kind: "user", id: h.id }),
    });

    it("the owner reads and writes their personal memory", () => {
      const r = memoryResource(personal, "MEMORY.md", { kind: "user", id: SAM });
      expect(r.relations.has("owner")).toBe(true);
      expect(r.state.has("memory_personal")).toBe(true);
      expect(r.unitPath).toEqual([]);
      expect(can(sam, personal, "memory.read", "MEMORY.md")).toBe(true);
      expect(can(sam, personal, "memory.write", "MEMORY.md")).toBe(true);
      expect(can(sam, personal, "memory.read")).toBe(true);
    });

    it("an admin and another member are denied with personal_memory, even with an allow rule", () => {
      const allowAll = rule({ id: "allow", permission: "memory.*", effect: "allow" });
      for (const who of [admin, alex]) {
        for (const perm of ["memory.read", "memory.write", "memory.promote"] as const) {
          expect(why(who, personal, perm, "MEMORY.md", [allowAll]), `${who.id} ${perm}`).toEqual({
            permission: perm,
            layer: "resource",
            reason: "personal_memory",
          });
          expect(can(who, personal, perm, undefined, [allowAll])).toBe(false);
        }
      }
    });

    it("the scope's own bot acting for the owner reads and writes", () => {
      const r = memoryResource(personal, "MEMORY.md", { kind: "agent", id: "bot-1" });
      expect(r.relations.has("scope_agent")).toBe(true);
      expect(r.relations.has("owner")).toBe(false);
      expect(decide(bot, r, [], "memory.read", forHuman(sam))).toEqual({ allowed: true });
      expect(decide(bot, r, [], "memory.write", forHuman(sam))).toEqual({ allowed: true });
    });

    it("another bot of the same owner is denied with agent_memory", () => {
      const r = memoryResource(personal, "MEMORY.md", { kind: "agent", id: "bot-2" });
      expect(r.relations.has("scope_agent")).toBe(false);
      for (const perm of ["memory.read", "memory.write"] as const) {
        expect(decide(otherBot, r, [], perm, forHuman(sam)).denial, perm).toEqual({
          permission: perm,
          layer: "resource",
          reason: "agent_memory",
        });
      }
    });

    it("the right bot acting for another human (an admin included) is denied with personal_memory", () => {
      const r = memoryResource(personal, "MEMORY.md", { kind: "agent", id: "bot-1" });
      for (const h of [alex, admin]) {
        expect(decide(bot, r, [], "memory.read", forHuman(h)).denial).toEqual({
          permission: "memory.read",
          layer: "resource",
          reason: "personal_memory",
        });
      }
    });

    it("an agent never promotes, not even its own scope for its owner with an allow rule naming it", () => {
      const r = memoryResource(personal, "MEMORY.md", { kind: "agent", id: "bot-1" });
      const allowBot = rule({
        id: "allow-bot",
        subjectKind: "agent",
        subjectId: "bot-1",
        permission: "memory.*",
        effect: "allow",
      });
      expect(decide(bot, r, [allowBot], "memory.promote", forHuman(sam)).denial).toEqual({
        permission: "memory.promote",
        layer: "resource",
        reason: "agent_memory",
      });
      expect(decide(bot, r, [allowBot], "memory.promote").allowed).toBe(false);
    });
  });

  describe("bot notebooks", () => {
    const SAM = "u-sam";
    const OWNER = "u-owner";
    const sam = user("standard", { id: SAM });
    const personalBot = { id: "bot-p", scope: "personal" as const, ownerUserId: SAM, disabled: false };
    const notebookOf = (agent: MemoryScopeFacts["agent"]): MemoryScopeFacts => ({
      kind: "agent",
      ownerUserId: null,
      agent,
      unitPath: [],
    });
    const personalNotebook = notebookOf(personalBot);
    const teamBot = {
      id: "bot-t",
      scope: "team" as const,
      ownerUserId: OWNER,
      disabled: false,
      unitPath: PATH_A,
    };
    const teamNotebook = notebookOf(teamBot);
    // The owner sits in B: the owner relation, not the unit, gives them the notebook.
    const owner = user("standard", { id: OWNER, memberUnitPaths: [PATH_B] });

    it("a personal bot's notebook is personal: its owner only, admins included", () => {
      const r = memoryResource(personalNotebook, "MEMORY.md", { kind: "user", id: SAM });
      expect(r.state.has("memory_personal")).toBe(true);
      expect(r.relations.has("owner")).toBe(true);
      expect(can(sam, personalNotebook, "memory.read", "MEMORY.md")).toBe(true);
      expect(can(sam, personalNotebook, "memory.write", "MEMORY.md")).toBe(true);
      for (const who of [admin, aMember]) {
        expect(why(who, personalNotebook, "memory.read", "MEMORY.md")).toMatchObject({
          reason: "personal_memory",
        });
      }
      const bot: PrincipalFacts = { ...user(null), kind: "agent", id: "bot-p" };
      const forSam = {
        principal: sam,
        resource: memoryResource(personalNotebook, "a.md", { kind: "user", id: SAM }),
      };
      const asBot = memoryResource(personalNotebook, "a.md", { kind: "agent", id: "bot-p" });
      expect(decide(bot, asBot, [], "memory.write", forSam)).toEqual({ allowed: true });
    });

    it("a team bot's notebook is read by A members, the leads on its path, its owner and admins; not by B", () => {
      const r = memoryResource(teamNotebook, "x.md", { kind: "user", id: aMember.id });
      expect([...r.state].sort()).toEqual(["memory_agent", "unit_scoped"]);
      expect(r.unitPath).toEqual(PATH_A);
      for (const who of [aMember, aLead, dLead, owner, admin]) {
        expect(can(who, teamNotebook, "memory.read", "x.md"), who.id).toBe(true);
      }
      for (const who of [bMember, dOnly]) {
        expect(why(who, teamNotebook, "memory.read", "x.md"), who.id).toEqual({
          permission: "memory.read",
          layer: "resource",
          reason: "unit_memory",
        });
      }
    });

    it("it is written by its owner, the A/D leads and admins, never by a plain member", () => {
      for (const who of [owner, aLead, dLead, admin]) {
        expect(can(who, teamNotebook, "memory.write", "x.md"), who.id).toBe(true);
      }
      expect(can(aMember, teamNotebook, "memory.write", "x.md")).toBe(false);
      // Promotion is a team-surface grain: leads and admins; a standard owner writes but does not promote.
      for (const who of [aLead, dLead, admin]) {
        expect(can(who, teamNotebook, "memory.promote", "x.md"), who.id).toBe(true);
      }
      expect(can(owner, teamNotebook, "memory.promote", "x.md")).toBe(false);
      expect(can(user("lead", { id: OWNER }), teamNotebook, "memory.promote", "x.md")).toBe(true);
    });

    it("an organization bot's notebook is read by every member", () => {
      const orgNotebook = notebookOf({ id: "bot-o", scope: "team", ownerUserId: null, disabled: false });
      expect(memoryResource(orgNotebook, undefined, null).state.has("unit_scoped")).toBe(false);
      for (const who of [aMember, bMember, dOnly]) {
        expect(can(who, orgNotebook, "memory.read", "x.md"), who.id).toBe(true);
        expect(can(who, orgNotebook, "memory.write", "x.md"), who.id).toBe(false);
      }
    });

    it("an agent cannot write a shared notebook, its own included (agent_shared_write)", () => {
      const bot: PrincipalFacts = { ...user(null), kind: "agent", id: "bot-t" };
      const asBot = memoryResource(teamNotebook, "x.md", { kind: "agent", id: "bot-t" });
      const forLead = {
        principal: aLead,
        resource: memoryResource(teamNotebook, "x.md", { kind: "user", id: aLead.id }),
      };
      expect(decide(bot, asBot, [], "memory.write", forLead).denial).toEqual({
        permission: "memory.write",
        layer: "resource",
        reason: "agent_shared_write",
      });
      // Reading it for someone who may read it is fine; for someone who may not, the human pass refuses.
      expect(decide(bot, asBot, [], "memory.read", forLead)).toEqual({ allowed: true });
      const forB = {
        principal: bMember,
        resource: memoryResource(teamNotebook, "x.md", { kind: "user", id: bMember.id }),
      };
      expect(decide(bot, asBot, [], "memory.read", forB).denial).toMatchObject({ reason: "unit_memory" });
    });
  });

  describe("organization scope and agents on shared scopes", () => {
    it("every member reads the organization's memory; only admins write and promote", () => {
      for (const who of [aMember, bMember, dOnly, aLead, dLead]) {
        expect(can(who, ORG, "memory.read", "x.md"), who.id).toBe(true);
        expect(can(who, ORG, "memory.write", "x.md"), who.id).toBe(false);
        expect(can(who, ORG, "memory.promote", "x.md"), who.id).toBe(false);
      }
      for (const perm of ["memory.read", "memory.write", "memory.promote"] as const) {
        expect(can(admin, ORG, perm, "x.md"), perm).toBe(true);
      }
      const r = memoryResource(ORG, "x.md", null);
      expect(r).toMatchObject({ type: "memory", unitPath: [], path: "x.md" });
      expect(r.state.size).toBe(0);
    });

    it("an agent reads unit and organization memory for a human who may, and never writes or promotes there", () => {
      const bot: PrincipalFacts = { ...user(null), kind: "agent", id: "bot-1" };
      const allowBot = rule({
        id: "allow-bot",
        subjectKind: "agent",
        subjectId: "bot-1",
        permission: "memory.*",
        effect: "allow",
      });
      for (const scope of [unitScope(PATH_A), ORG]) {
        const r = memoryResource(scope, "x.md", { kind: "agent", id: "bot-1" });
        const forAdmin = {
          principal: admin,
          resource: memoryResource(scope, "x.md", { kind: "user", id: admin.id }),
        };
        expect(decide(bot, r, [], "memory.read", forAdmin)).toEqual({ allowed: true });
        expect(decide(bot, r, [allowBot], "memory.write", forAdmin).denial).toMatchObject({
          reason: "agent_shared_write",
        });
        expect(decide(bot, r, [allowBot], "memory.promote", forAdmin).denial).toMatchObject({
          reason: "agent_memory",
        });
      }
      const forB = {
        principal: bMember,
        resource: memoryResource(unitScope(PATH_A), "x.md", { kind: "user", id: bMember.id }),
      };
      expect(
        decide(
          bot,
          memoryResource(unitScope(PATH_A), "x.md", { kind: "agent", id: "bot-1" }),
          [],
          "memory.read",
          forB,
        ).denial,
      ).toMatchObject({ reason: "unit_memory" });
    });

    it("memory preconditions never touch other resources (a bot, a unit) carrying the same states", () => {
      const persona = agentResource(
        { scope: "team", ownerUserId: null, disabled: false, unitPath: PATH_A },
        bMember.id,
      );
      expect(why(bMember, unitScope(PATH_A), "memory.read")).toMatchObject({ reason: "unit_memory" });
      expect(decide(bMember, persona, [], "bot.read").denial).toMatchObject({ reason: "unit_agent" });
      expect(can(bMember, unitScope(PATH_B), "memory.read")).toBe(true);
      // `memory.read` decided on a non-memory resource keeps the role answer.
      expect(allowed(bMember, unitResource({ id: A, path: PATH_A }), "memory.read")).toBe(true);
    });
  });
});

// ---------------------------------------------------------------- unit keys and unit templates (Phase 07.4, N5)

describe("unit keys and unit templates: the unit audience is decided in the resolver (Phase 07.4, N5)", () => {
  // Department D holds teams A and B; A holds the sub-team A1.
  const D = "unit-d";
  const A = "unit-a";
  const A1 = "unit-a1";
  const B = "unit-b";
  const PATH_A = [D, A];
  const unitA = unitResource({ id: A, path: PATH_A });
  const aMember = user("standard", { id: "u-a", memberUnitPaths: [PATH_A] });
  const below = user("standard", { id: "u-a1", memberUnitPaths: [[D, A, A1]] });
  const aLead = user("lead", { id: "u-al", memberUnitPaths: [PATH_A], leadOfUnitIds: new Set([A]) });
  // A lead of the department above A (on A's path), not a member of A.
  const dLead = user("standard", { id: "u-dl", memberUnitPaths: [[D]], leadOfUnitIds: new Set([D]) });
  const dOnly = user("standard", { id: "u-d", memberUnitPaths: [[D]] });
  const outsider = user("standard", { id: "u-b", memberUnitPaths: [[D, B]] });
  const nowhere = user("developer", { id: "u-x" });
  const admin = user("admin", { id: "u-admin" });
  const bot: PrincipalFacts = { ...user(null), kind: "agent", id: "bot-1" };

  describe("vault.use on a unit key", () => {
    it("an outsider is denied with unit_key, even with an allow rule", () => {
      expect(decide(outsider, unitA, [], "vault.use")).toEqual({
        allowed: false,
        denial: { permission: "vault.use", layer: "resource", reason: "unit_key" },
      });
      const allowAll = rule({
        subjectKind: "user",
        subjectId: outsider.id,
        permission: "vault.*",
        effect: "allow",
      });
      expect(decide(outsider, unitA, [allowAll], "vault.use").denial).toMatchObject({ reason: "unit_key" });
      // A member of the unit above (not a lead) and a member of no unit are outside A's audience too.
      expect(decide(dOnly, unitA, [], "vault.use").denial).toMatchObject({ reason: "unit_key" });
      expect(decide(nowhere, unitA, [], "vault.use").denial).toMatchObject({ reason: "unit_key" });
    });

    it("a member of the unit, a member below it, a lead on its path and an admin are allowed", () => {
      for (const p of [aMember, below, aLead, dLead, admin])
        expect(allowed(p, unitA, "vault.use"), p.id).toBe(true);
    });

    it("cross-tenant is never an allow: a person of another organization loads as not a member here", () => {
      // facts.ts: no membership row in the tenant = deactivated, no role, no units (facts.int.test.ts proves the load).
      const foreign = user(null, { id: "u-foreign", deactivated: true });
      const foreignAdmin = user("admin", {
        id: "u-foreign-admin",
        deactivated: true,
        memberUnitPaths: [PATH_A],
      });
      for (const p of [foreign, foreignAdmin]) {
        expect(allowed(p, unitA, "vault.use"), p.id).toBe(false);
        expect(allowed(p, orgResource(), "vault.use"), p.id).toBe(false);
      }
    });

    it("an explicit deny still wins, for a member and for an admin", () => {
      const denyA = rule({
        id: "deny-a",
        scopeUnitId: A,
        subjectKind: "user",
        subjectId: aMember.id,
        permission: "vault.use",
        effect: "deny",
      });
      expect(decide(aMember, unitA, [denyA], "vault.use").denial).toMatchObject({
        layer: "user",
        reason: "denied_by_rule",
        ruleId: "deny-a",
      });
      const denyAdmin = rule({
        id: "deny-admin",
        subjectKind: "user",
        subjectId: admin.id,
        permission: "vault.use",
        effect: "deny",
      });
      expect(decide(admin, unitA, [denyAdmin], "vault.use").denial).toMatchObject({
        reason: "denied_by_rule",
      });
      // Bots off for everyone in A (a module catalog row) removes it from A's own members too.
      const botsOff = rule({ id: "bots-off", scopeUnitId: A, permission: "vault.use", effect: "deny" });
      expect(decide(below, unitA, [botsOff], "vault.use").denial).toMatchObject({ layer: "unit", unitId: A });
    });

    it("an agent acting for a person gets the person's answer (agent ∩ human)", () => {
      const forOutsider = { principal: outsider, resource: unitA };
      expect(decide(bot, unitA, [], "vault.use", forOutsider).denial).toMatchObject({ reason: "unit_key" });
      expect(decide(bot, unitA, [], "vault.use", { principal: aMember, resource: unitA }).allowed).toBe(true);
    });

    it("organization keys stay usable by every member; vault.manage and unit reading are untouched", () => {
      for (const p of [aMember, outsider, nowhere, dOnly, admin])
        expect(allowed(p, orgResource(), "vault.use"), p.id).toBe(true);
      expect(allowed(aLead, unitA, "vault.manage")).toBe(true);
      expect(allowed(aMember, unitA, "vault.manage")).toBe(false);
      expect(allowed(outsider, unitA, "unit.read")).toBe(true);
    });
  });

  describe("unit.read on an agent template", () => {
    const templateA = agentTemplateResource({ id: A, path: PATH_A });

    it("the template carries its unit path and state unit_scoped; an organization template carries none", () => {
      expect(templateA).toMatchObject({ type: "agent_template", unitPath: PATH_A });
      expect(templateA.state.has("unit_scoped")).toBe(true);
      const org = agentTemplateResource(null);
      expect(org).toMatchObject({ type: "agent_template", unitPath: [] });
      expect(org.state.has("unit_scoped")).toBe(false);
    });

    it("an outsider does not see a unit template (unit_template), even with an allow rule", () => {
      expect(decide(outsider, templateA, [], "unit.read")).toEqual({
        allowed: false,
        denial: { permission: "unit.read", layer: "resource", reason: "unit_template" },
      });
      const allowAll = rule({
        subjectKind: "user",
        subjectId: outsider.id,
        permission: "unit.*",
        effect: "allow",
      });
      expect(decide(outsider, templateA, [allowAll], "unit.read").denial).toMatchObject({
        reason: "unit_template",
      });
      expect(allowed(dOnly, templateA, "unit.read")).toBe(false);
      expect(allowed(nowhere, templateA, "unit.read")).toBe(false);
    });

    it("the unit's members, members below it, leads on its path and admins see it", () => {
      for (const p of [aMember, below, aLead, dLead, admin])
        expect(allowed(p, templateA, "unit.read"), p.id).toBe(true);
    });

    it("an organization template is seen by every member; never across tenants; an explicit deny wins", () => {
      const org = agentTemplateResource(null);
      for (const p of [aMember, outsider, nowhere, admin])
        expect(allowed(p, org, "unit.read"), p.id).toBe(true);
      expect(allowed(user("admin", { deactivated: true }), templateA, "unit.read")).toBe(false);
      expect(allowed(user(null, { deactivated: true }), org, "unit.read")).toBe(false);
      const deny = rule({
        id: "deny-tpl",
        scopeUnitId: A,
        subjectKind: "user",
        subjectId: aMember.id,
        permission: "unit.read",
        effect: "deny",
      });
      expect(decide(aMember, templateA, [deny], "unit.read").denial).toMatchObject({
        reason: "denied_by_rule",
      });
    });
  });
});

describe("sandbox.files needs bot.configure on the same bot (Phase 07.8, D-04, P-04; 07.8-11)", () => {
  const OWNER = "u-owner";
  const OTHER = "u-other";
  const ADMIN_ID = "u-admin";
  const UNIT = "unit-ops";
  const owner = user("standard", { id: OWNER });
  const other = user("developer", { id: OTHER });
  const admin = user("admin", { id: ADMIN_ID });
  const lead = user("lead", { id: "u-lead", memberUnitPaths: [[UNIT]], leadOfUnitIds: new Set([UNIT]) });
  const personal = { scope: "personal" as const, ownerUserId: OWNER, disabled: false };
  const team = { scope: "team" as const, ownerUserId: null, disabled: false };
  const persona = { scope: "team" as const, ownerUserId: null, disabled: false, unitPath: [UNIT] };
  const bot: PrincipalFacts = { ...user(null), kind: "agent", id: "bot-1" };
  const denied = (p: PrincipalFacts, r: ResourceFacts, rules: RuleFact[] = []) =>
    decide(p, r, rules, "sandbox.files");

  it("the configurers of a bot hold it: the personal bot's owner, an admin on a team bot, a lead on a unit persona", () => {
    expect(allowed(owner, agentResource(personal, OWNER), "sandbox.files")).toBe(true);
    expect(allowed(admin, agentResource(team, ADMIN_ID), "sandbox.files")).toBe(true);
    expect(allowed(lead, agentResource(persona, lead.id), "sandbox.files")).toBe(true);
  });

  it("anyone without bot.configure on that bot is denied, whatever their role", () => {
    expect(denied(other, agentResource(team, OTHER))).toEqual({
      allowed: false,
      denial: { permission: "sandbox.files", layer: "resource", reason: "not_bot_configurer" },
    });
    expect(denied(other, agentResource(personal, OTHER)).allowed).toBe(false);
    // An admin on someone else's personal bot: the personal-bot precondition removes bot.configure, so files go too.
    expect(denied(admin, agentResource(personal, ADMIN_ID))).toEqual({
      allowed: false,
      denial: { permission: "sandbox.files", layer: "resource", reason: "not_bot_configurer" },
    });
    // A lead of another unit and a standard member of the persona's unit do not configure it.
    expect(
      denied(user("lead", { id: "u-l2", leadOfUnitIds: new Set(["unit-x"]) }), agentResource(persona, "u-l2"))
        .allowed,
    ).toBe(false);
    expect(
      denied(user("standard", { id: "u-m", memberUnitPaths: [[UNIT]] }), agentResource(persona, "u-m"))
        .allowed,
    ).toBe(false);
  });

  it("an allow rule for bot.configure grants it; a deny rule on bot.configure takes files away with it", () => {
    const allowCfg = rule({
      subjectKind: "user",
      subjectId: OTHER,
      permission: "bot.configure",
      effect: "allow",
    });
    expect(allowed(other, agentResource(team, OTHER), "sandbox.files", [allowCfg])).toBe(true);
    const denyCfg = rule({
      subjectKind: "user",
      subjectId: ADMIN_ID,
      permission: "bot.configure",
      effect: "deny",
    });
    expect(denied(admin, agentResource(team, ADMIN_ID), [denyCfg])).toMatchObject({
      allowed: false,
      denial: { reason: "not_bot_configurer" },
    });
  });

  it("the Sandbox module off (a sandbox.* deny) removes it from a configurer", () => {
    const moduleOff = rule({
      subjectKind: "user",
      subjectId: OWNER,
      permission: "sandbox.*",
      effect: "deny",
    });
    expect(denied(owner, agentResource(personal, OWNER), [moduleOff])).toMatchObject({
      allowed: false,
      denial: { reason: "denied_by_rule" },
    });
  });

  it("every agent principal is denied, also its own bot and also acting for an owner", () => {
    expect(denied(bot, agentResource(personal, null)).allowed).toBe(false);
    expect(
      decide(bot, agentResource(personal, null), [], "sandbox.files", {
        principal: owner,
        resource: agentResource(personal, OWNER),
      }).allowed,
    ).toBe(false);
  });

  it("the organization-scope answer stays the role's (the module gate reads it)", () => {
    expect(allowed(user("standard"), orgResource(), "sandbox.files")).toBe(true);
  });
});

describe("team projects: who opens one and who manages it (Phase 07.9, D-02, D-10, D-13, ADR-0024)", () => {
  const D = "dept-D";
  const T = "team-T";
  const P = "proj-P";
  const OTHER = "team-X";
  const project = (access: "lead" | "member" | "team" | "admin" | null, principal: string | null = "u-1") =>
    workProjectResource({ id: P, path: [D, T, P], access }, principal);
  const developer = user("developer");
  /** The Work Zone module turned off for everyone on a unit, as the module-access API writes it. */
  const rowsOfModule = (m: ModuleId, extra: Partial<RuleFact> = {}): RuleFact[] =>
    MODULE_CATALOG[m].patterns.map((permission, i) =>
      rule({ id: `${m}-${i}`, permission, effect: "deny", ...extra }),
    );

  it("project access (member, lead, team) opens it for a developer; no access is not_in_project", () => {
    for (const access of ["member", "lead", "team"] as const) {
      expect(allowed(developer, project(access), "work_session.read"), access).toBe(true);
    }
    expect(decide(developer, project(null), [], "work_session.read")).toEqual({
      allowed: false,
      denial: { permission: "work_session.read", layer: "resource", reason: "not_in_project" },
    });
    // The admin rule is the explicit role check, never an `admin` access value or a relation.
    expect(allowed(developer, project("admin"), "work_session.read")).toBe(false);
    expect(allowed(user("admin"), project(null), "work_session.read")).toBe(true);
    // A principal-less resource never carries the relation.
    expect(project("member", null).relations.has("project_member")).toBe(false);
  });

  it("a unit deny on the project's parent, or the Work Zone off on its path, hides it from members and admins", () => {
    const denyT = rule({ id: "deny-T", scopeUnitId: T, permission: "work_session.*", effect: "deny" });
    expect(allowed(developer, project("member"), "work_session.read", [denyT])).toBe(false);
    expect(allowed(user("admin"), project(null), "work_session.read", [denyT])).toBe(false);
    const workZoneOff = rowsOfModule("work_zone", { scopeUnitId: D });
    expect(allowed(developer, project("member"), "work_session.read", workZoneOff)).toBe(false);
    expect(allowed(user("admin"), project(null), "work_session.read", workZoneOff)).toBe(false);
    // Elsewhere the rule changes nothing.
    const elsewhere = workProjectResource({ id: "proj-Q", path: [OTHER, "proj-Q"], access: "member" }, "u-1");
    expect(allowed(developer, elsewhere, "work_session.read", [denyT])).toBe(true);
  });

  it("a lead of the parent manages the project and creates under the parent; a plain member does neither", () => {
    const parentLead = user("lead", { memberUnitPaths: [[D, T]], leadOfUnitIds: new Set([T]) });
    expect(allowed(parentLead, unitResource({ id: T, path: [D, T] }), "work_project.manage")).toBe(true);
    // Managing is not opening: the lead above has no project access, the precondition leaves the grain alone.
    expect(allowed(parentLead, project(null), "work_project.manage")).toBe(true);
    expect(allowed(parentLead, project(null), "work_session.read")).toBe(false);
    const projectLead = user("lead", { memberUnitPaths: [[D, T, P]], leadOfUnitIds: new Set([P]) });
    expect(allowed(projectLead, project("lead"), "work_project.manage")).toBe(true);
    expect(allowed(projectLead, unitResource({ id: T, path: [D, T] }), "work_project.manage")).toBe(false);
    const member = user("developer", { memberUnitPaths: [[D, T]] });
    expect(allowed(member, unitResource({ id: T, path: [D, T] }), "work_project.manage")).toBe(false);
    expect(allowed(member, project("member"), "work_project.manage")).toBe(false);
    const otherLead = user("lead", { memberUnitPaths: [[OTHER]], leadOfUnitIds: new Set([OTHER]) });
    expect(allowed(otherLead, unitResource({ id: T, path: [D, T] }), "work_project.manage")).toBe(false);
    expect(allowed(user("admin"), unitResource({ id: T, path: [D, T] }), "work_project.manage")).toBe(true);
    expect(allowed(user("admin"), project(null), "work_project.manage")).toBe(true);
  });

  it("an explicit deny of work_project.manage on the parent beats the lead grant", () => {
    const parentLead = user("lead", { memberUnitPaths: [[D, T]], leadOfUnitIds: new Set([T]) });
    const deny = rule({ id: "deny-pm", scopeUnitId: T, permission: "work_project.manage", effect: "deny" });
    expect(allowed(parentLead, project(null), "work_project.manage", [deny])).toBe(false);
  });
});
