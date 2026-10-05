import { describe, expect, it } from "vitest";
import { OrgRole, ROLE_LABELS } from "./common";
import {
  AccessTokenClaims,
  AGENT_PERMISSIONS,
  ALLOWED_PARENT_KINDS,
  AuthzDenial,
  DEVICE_TOKEN_AUDIENCE,
  DeviceTokenClaims,
  INVITABLE_ROLES,
  NON_DELEGABLE_PERMISSIONS,
  PERMISSION_DESCRIPTIONS,
  PERMISSION_SURFACE,
  Permission,
  PermissionPattern,
  permissionMatches,
  ROLE_PERMISSIONS,
  ROLE_RANK,
  ROLE_SURFACES,
} from "./permissions";

const id = "0190d5e2-7c3a-7cc2-9d2e-6a1b2c3d4e5f";
const now = 1_790_000_000;

describe("permission vocabulary", () => {
  it("has exactly the 44 agreed permissions", () => {
    expect(Permission.options).toHaveLength(44);
    expect(new Set(Permission.options).size).toBe(44);
  });

  it("Phase 03.2 Work Zone control permissions exist exactly as P-06 defines them", () => {
    expect(PERMISSION_SURFACE).toMatchObject({
      "work_session.configure": "workzone",
      "device.full_access": "workzone",
      "work_zone.manage": "admin",
    });
    expect(ROLE_PERMISSIONS.developer).toContain("work_session.configure");
    expect(ROLE_PERMISSIONS.standard).not.toContain("work_session.configure");
    for (const role of OrgRole.options) {
      if (role === "admin") expect(ROLE_PERMISSIONS[role]).toContain("work_zone.manage");
      else expect(ROLE_PERMISSIONS[role], role).not.toContain("work_zone.manage");
      // Relation-only: full access always comes from the person's own grain on one device.
      expect(ROLE_PERMISSIONS[role], role).not.toContain("device.full_access");
    }
    expect(NON_DELEGABLE_PERMISSIONS).toContain("work_zone.manage");
    // ADR-0012: Full access comes only from the device owner's grant; an allow rule never confers it.
    expect(NON_DELEGABLE_PERMISSIONS).toContain("device.full_access");
    for (const p of ["work_session.configure", "device.full_access", "work_zone.manage"] as const) {
      expect(PERMISSION_DESCRIPTIONS[p].length, p).toBeGreaterThan(10);
    }
  });

  it("Phase 3.1 bot permissions exist exactly as D-02 defines them", () => {
    expect(PERMISSION_SURFACE).toMatchObject({
      "bot.create_personal": "bots",
      "bot.configure": "bots",
      "bot.internet": "bots",
      "bot.tool.use": "bots",
      "plugin.manage": "admin",
      "mcp.manage": "admin",
    });
    for (const role of OrgRole.options) {
      for (const p of ["bot.create_personal", "bot.internet", "bot.tool.use"] as const) {
        expect(ROLE_PERMISSIONS[role], `${role}: ${p}`).toContain(p);
      }
      for (const p of ["bot.configure", "plugin.manage", "mcp.manage"] as const) {
        if (role === "admin") expect(ROLE_PERMISSIONS[role], `${role}: ${p}`).toContain(p);
        else expect(ROLE_PERMISSIONS[role], `${role}: ${p}`).not.toContain(p);
      }
    }
    expect(AGENT_PERMISSIONS).toEqual(expect.arrayContaining(["bot.internet", "bot.tool.use"]));
    expect(AGENT_PERMISSIONS).not.toContain("bot.configure");
    expect(NON_DELEGABLE_PERMISSIONS).toEqual(expect.arrayContaining(["plugin.manage", "mcp.manage"]));
    expect(NON_DELEGABLE_PERMISSIONS).not.toContain("bot.create_personal");
    for (const p of [
      "bot.create_personal",
      "bot.configure",
      "bot.internet",
      "bot.tool.use",
      "plugin.manage",
      "mcp.manage",
    ] as const) {
      expect(PERMISSION_DESCRIPTIONS[p].length, p).toBeGreaterThan(10);
    }
  });

  it("roles are the four PRD roles with labels and ranks", () => {
    expect(OrgRole.options).toEqual(["standard", "developer", "lead", "admin"]);
    expect(ROLE_LABELS).toEqual({
      standard: "Standard User",
      developer: "Developer",
      lead: "Team Lead",
      admin: "Organization Admin",
    });
    expect(OrgRole.options.map((r) => ROLE_RANK[r])).toEqual([0, 1, 2, 3]);
  });

  it("role grants are cumulative and strictly growing: standard ⊂ developer ⊂ lead ⊂ admin (PRD §7)", () => {
    const order = OrgRole.options;
    for (let i = 1; i < order.length; i++) {
      const lower = new Set(ROLE_PERMISSIONS[order[i - 1] as OrgRole]);
      const upper = new Set(ROLE_PERMISSIONS[order[i] as OrgRole]);
      for (const p of lower) expect(upper.has(p), `${order[i]} lacks ${p}`).toBe(true);
      expect(upper.size).toBeGreaterThan(lower.size);
    }
  });

  it("a role only grants permissions on the surfaces it unlocks", () => {
    for (const role of OrgRole.options) {
      for (const p of ROLE_PERMISSIONS[role]) {
        expect(ROLE_SURFACES[role], `${role}: ${p}`).toContain(PERMISSION_SURFACE[p]);
      }
    }
  });

  it("relation-only and principal-only permissions are never granted by a role", () => {
    for (const p of [
      "account.manage",
      "device.use",
      "device.update",
      "cell.sync",
      "device.link",
      "device.full_access",
    ] as const) {
      expect(ROLE_PERMISSIONS.admin).not.toContain(p);
    }
  });

  it("developers keep Work Zone (members of MVP 0 become developers, Pitfall 8)", () => {
    expect(ROLE_PERMISSIONS.developer).toEqual(
      expect.arrayContaining(["device.pair", "work_session.create", "work_session.prompt"]),
    );
    expect(ROLE_PERMISSIONS.standard).not.toContain("work_session.create");
  });

  it("every permission has a surface and a description", () => {
    for (const p of Permission.options) {
      expect(PERMISSION_SURFACE[p], p).toBeDefined();
      expect(PERMISSION_DESCRIPTIONS[p]?.length, p).toBeGreaterThan(5);
    }
    expect(Object.keys(PERMISSION_SURFACE).sort()).toEqual([...Permission.options].sort());
    expect(Object.keys(PERMISSION_DESCRIPTIONS).sort()).toEqual([...Permission.options].sort());
  });

  it("non-delegable permissions are exactly the admin- and runtime-surface permissions plus device.full_access", () => {
    const expected = Permission.options.filter(
      (p) =>
        PERMISSION_SURFACE[p] === "admin" ||
        PERMISSION_SURFACE[p] === "runtime" ||
        p === "device.full_access",
    );
    expect([...NON_DELEGABLE_PERMISSIONS].sort()).toEqual(expected.sort());
    expect(NON_DELEGABLE_PERMISSIONS).toContain("member.manage");
    expect(NON_DELEGABLE_PERMISSIONS).toContain("device.link");
    expect(NON_DELEGABLE_PERMISSIONS).not.toContain("channel.create");
  });

  it("invitation role ceiling: admin → all four, lead → standard and developer, others → none", () => {
    expect(INVITABLE_ROLES.admin).toEqual(["standard", "developer", "lead", "admin"]);
    expect(INVITABLE_ROLES.lead).toEqual(["standard", "developer"]);
    expect(INVITABLE_ROLES.developer).toEqual([]);
    expect(INVITABLE_ROLES.standard).toEqual([]);
  });

  it("unit kinds nest department → team → project", () => {
    expect(ALLOWED_PARENT_KINDS.department).toContain(null);
    expect(ALLOWED_PARENT_KINDS.team).not.toContain(null);
    expect(ALLOWED_PARENT_KINDS.project).not.toContain("project");
  });
});

describe("permission patterns", () => {
  it("matches exact names and prefix.* only", () => {
    expect(permissionMatches("channel.archive", "channel.archive")).toBe(true);
    expect(permissionMatches("channel.archive", "channel.post")).toBe(false);
    expect(permissionMatches("channel.*", "channel.members.add")).toBe(true);
    expect(permissionMatches("channel.members.*", "channel.members.remove")).toBe(true);
    expect(permissionMatches("channel.members.*", "channel.post")).toBe(false);
    expect(permissionMatches("work_session.*", "work_session.approve")).toBe(true);
    expect(permissionMatches("work.*", "work_session.read")).toBe(false);
    expect(permissionMatches("*", "channel.read")).toBe(false);
    expect(permissionMatches(".*", "channel.read")).toBe(false);
  });

  it("PermissionPattern accepts permissions and matching prefixes only", () => {
    for (const ok of ["channel.create", "channel.*", "work_session.*", "device.*"]) {
      expect(PermissionPattern.safeParse(ok).success, ok).toBe(true);
    }
    for (const bad of ["channel", "nope.*", "*", "channel.foo", `${"a".repeat(70)}.*`]) {
      expect(PermissionPattern.safeParse(bad).success, bad).toBe(false);
    }
  });

  it("AuthzDenial carries permission, layer and reason", () => {
    expect(
      AuthzDenial.parse({ permission: "channel.archive", layer: "role", reason: "requires admin" }),
    ).toMatchObject({ layer: "role" });
    expect(AuthzDenial.safeParse({ permission: "x", layer: "role", reason: "r" }).success).toBe(false);
  });
});

describe("token claims", () => {
  const access = {
    sub: id,
    sid: id,
    org: id,
    ck: "web",
    iat: now,
    exp: now + 600,
    iss: "http://api",
    aud: "http://api",
  };

  it("AccessTokenClaims accepts the minimal claim set", () => {
    expect(AccessTokenClaims.parse(access)).toEqual(access);
    expect(AccessTokenClaims.parse({ ...access, aud: ["http://api"] }).aud).toEqual(["http://api"]);
  });

  it("AccessTokenClaims rejects device tokens and extra (PII) claims", () => {
    expect(AccessTokenClaims.safeParse({ ...access, typ: "device" }).success).toBe(false);
    expect(AccessTokenClaims.safeParse({ ...access, email: "a@b.test" }).success).toBe(false);
  });

  it("DeviceTokenClaims requires typ device and the device-link audience", () => {
    const device = {
      sub: id,
      org: id,
      typ: "device",
      iat: now,
      exp: now + 600,
      iss: "http://api",
      aud: DEVICE_TOKEN_AUDIENCE,
    };
    expect(DeviceTokenClaims.parse(device)).toEqual(device);
    expect(DeviceTokenClaims.safeParse({ ...device, typ: "user" }).success).toBe(false);
    expect(DeviceTokenClaims.safeParse({ ...device, aud: "http://api" }).success).toBe(false);
    expect(DeviceTokenClaims.safeParse(access).success).toBe(false);
  });
});
