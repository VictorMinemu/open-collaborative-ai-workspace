import {
  NON_DELEGABLE_PERMISSIONS,
  OrgRole,
  PERMISSION_SURFACE,
  Permission,
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

  it("a non-member admin cannot read someone's DM (private_channel)", () => {
    const theirs = channelResource({ visibility: "private", archived: false, viewerRole: null, kind: "dm" });
    expect(decide(admin, theirs, [], "channel.read")).toEqual({
      allowed: false,
      denial: { permission: "channel.read", layer: "resource", reason: "private_channel" },
    });
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
  "private",
  "archived",
  "revoked",
  "device_revoked",
  "personal",
  "disabled",
  "dm",
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
