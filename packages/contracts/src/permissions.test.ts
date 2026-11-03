import { describe, expect, it } from "vitest";
import { OrgRole, ROLE_LABELS } from "./common";
import { MODULE_CATALOG, ModuleId } from "./module-access";
import {
  AccessTokenClaims,
  AGENT_PERMISSIONS,
  ALLOWED_PARENT_KINDS,
  AuthzDenial,
  DEVICE_TOKEN_AUDIENCE,
  DeviceTokenClaims,
  INVITABLE_ROLES,
  LEAD_PERMISSIONS,
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
  it("has exactly the 78 agreed permissions", () => {
    // 64 through 07.4; 07.5-01 appended `tool_approval.manage`; 07.8-30 appended the five sandbox and browser grains;
    // 07.9-01 appended `work_session.visibility` and `work_project.manage`; 07.11-01 appended `device.maintain`;
    // 07.6-01 appended the three automation grains and `record.watch`; 07.7-01 appended `agent.message` (ADR-0027).
    expect(Permission.options).toHaveLength(78);
    expect(new Set(Permission.options).size).toBe(78);
  });

  it("Phase 07.7 `agent.message` is a delegable Bots grain every role holds and agents do not (D-02, D-04)", () => {
    // Appended at the end, never renamed (position 77).
    expect(Permission.options[77]).toBe("agent.message");
    expect(PERMISSION_SURFACE["agent.message"]).toBe("bots");
    const holders = OrgRole.options.filter((role) => ROLE_PERMISSIONS[role].includes("agent.message"));
    expect(holders).toEqual(["standard", "developer", "lead", "admin"]);
    // Closed by default for agents: only an explicit allow rule opens a consult (the org switch or a per-bot rule).
    expect(AGENT_PERMISSIONS).not.toContain("agent.message");
    expect(AGENT_PERMISSIONS).toHaveLength(9);
    expect(LEAD_PERMISSIONS).not.toContain("agent.message");
    expect(NON_DELEGABLE_PERMISSIONS).not.toContain("agent.message");
    expect(PermissionPattern.safeParse("agent.message").success).toBe(true);
    expect(PermissionPattern.safeParse("agent.*").success).toBe(true);
    expect(PERMISSION_DESCRIPTIONS["agent.message"]).toBe(
      "Consult another bot, or let bots consult other bots for you",
    );
    expect(PERMISSION_DESCRIPTIONS["agent.message"].length).toBeGreaterThan(10);
    // ADR-0027: the Bots switch also stops consults.
    const modulesOf = (p: Permission) =>
      ModuleId.options.filter((m) =>
        MODULE_CATALOG[m].patterns.some((pattern) => permissionMatches(pattern, p)),
      );
    expect(modulesOf("agent.message")).toEqual(["bots"]);
  });

  it("Phase 07.6 automation and watched-record grains exist exactly as 07.6-01 defines them (D-07, P-04, P-05)", () => {
    const grains = ["automation.create", "automation.webhook", "automation.manage", "record.watch"] as const;
    // Appended at the end, never renamed (positions 73–76).
    expect(Permission.options.slice(73, 77)).toEqual([...grains]);
    expect(PERMISSION_SURFACE["automation.create"]).toBe("bots");
    expect(PERMISSION_SURFACE["automation.webhook"]).toBe("bots");
    expect(PERMISSION_SURFACE["automation.manage"]).toBe("admin");
    expect(PERMISSION_SURFACE["record.watch"]).toBe("chat");
    // D-07 defaults: every role creates its own; webhooks for leads and admins; managing everyone's for admins.
    const holders = (p: Permission) => OrgRole.options.filter((role) => ROLE_PERMISSIONS[role].includes(p));
    expect(holders("automation.create")).toEqual(["standard", "developer", "lead", "admin"]);
    expect(holders("automation.webhook")).toEqual(["lead", "admin"]);
    expect(holders("automation.manage")).toEqual(["admin"]);
    expect(holders("record.watch")).toEqual(["standard", "developer", "lead", "admin"]);
    for (const p of grains) {
      // Agents act only through the run-as human (D-07); no unit lead grant.
      expect(AGENT_PERMISSIONS, p).not.toContain(p);
      expect(LEAD_PERMISSIONS, p).not.toContain(p);
      expect(PermissionPattern.safeParse(p).success, p).toBe(true);
    }
    // Webhooks are grantable by an allow rule (D-07); managing everyone's automations is an admin-surface grain, which
    // the existing rule keeps non-delegable (no allow rule confers it).
    for (const p of ["automation.create", "automation.webhook", "record.watch"] as const) {
      expect(NON_DELEGABLE_PERMISSIONS, p).not.toContain(p);
    }
    expect(NON_DELEGABLE_PERMISSIONS).toContain("automation.manage");
    expect(PermissionPattern.safeParse("automation.*").success).toBe(true);
    expect(PERMISSION_DESCRIPTIONS["automation.create"]).toBe("Create and run your own automations");
    expect(PERMISSION_DESCRIPTIONS["automation.webhook"]).toBe(
      "Create webhook endpoints that other apps can call",
    );
    expect(PERMISSION_DESCRIPTIONS["automation.manage"]).toBe("See, pause and delete everyone's automations");
    expect(PERMISSION_DESCRIPTIONS["record.watch"]).toBe("Watch an external record from a board card");
    // P-05: the bots-surface grains join the Bots module (a Bots-off rule also hides automations); the others none.
    const modulesOf = (p: Permission) =>
      ModuleId.options.filter((m) =>
        MODULE_CATALOG[m].patterns.some((pattern) => permissionMatches(pattern, p)),
      );
    expect(modulesOf("automation.create")).toEqual(["bots"]);
    expect(modulesOf("automation.webhook")).toEqual(["bots"]);
    expect(modulesOf("automation.manage")).toEqual([]);
    expect(modulesOf("record.watch")).toEqual([]);
  });

  it("Phase 07.9 session visibility and team project grains exist exactly as 07.9-01 defines them (D-04, D-10, D-13)", () => {
    // Appended at the end, never renamed (positions 70–71).
    expect(Permission.options.slice(70, 72)).toEqual(["work_session.visibility", "work_project.manage"]);
    expect(PERMISSION_SURFACE["work_session.visibility"]).toBe("workzone");
    expect(PERMISSION_SURFACE["work_project.manage"]).toBe("team");
    // Organization-wide only for admins; the session creator gets `work_session.visibility` as a relation (resolver).
    for (const role of OrgRole.options) {
      for (const p of ["work_session.visibility", "work_project.manage"] as const) {
        if (role === "admin") expect(ROLE_PERMISSIONS[role], `${role}: ${p}`).toContain(p);
        else expect(ROLE_PERMISSIONS[role], `${role}: ${p}`).not.toContain(p);
      }
    }
    // Leads hold both on the subtree they lead (ADR-0024 as implemented); agents never decide who sees a session.
    expect(LEAD_PERMISSIONS).toEqual(
      expect.arrayContaining(["work_session.visibility", "work_project.manage"]),
    );
    for (const p of ["work_session.visibility", "work_project.manage"] as const) {
      expect(AGENT_PERMISSIONS, p).not.toContain(p);
      // Workzone and team surfaces stay delegable by explicit allow rules (like `unit.members.manage`).
      expect(NON_DELEGABLE_PERMISSIONS, p).not.toContain(p);
      expect(PermissionPattern.safeParse(p).success, p).toBe(true);
    }
    expect(PERMISSION_DESCRIPTIONS["work_session.visibility"]).toBe("Change who can see a Work Zone session");
    expect(PERMISSION_DESCRIPTIONS["work_project.manage"]).toBe(
      "Create team projects, assign their teams, link repositories and set their default",
    );
    // P-05 (C-05 not needed): the Work Zone module's `work_session.*` already covers the session grain, so an existing
    // "Work Zone off" rule set denies it with no backfill; project governance belongs to no module.
    const modulesOf = (p: Permission) =>
      ModuleId.options.filter((m) =>
        MODULE_CATALOG[m].patterns.some((pattern) => permissionMatches(pattern, p)),
      );
    expect(modulesOf("work_session.visibility")).toEqual(["work_zone"]);
    expect(MODULE_CATALOG.work_zone.patterns).toContain("work_session.*");
    expect(modulesOf("work_project.manage")).toEqual([]);
    // D-13: a project sits under a team or department, never at the top level (unchanged).
    expect(ALLOWED_PARENT_KINDS).toEqual({
      department: [null, "department"],
      team: ["department", "team"],
      project: ["team", "department"],
    });
  });

  it("Phase 07.8 sandbox and browser grains exist exactly as 07.8-30 defines them (D-09, D-12, P-05)", () => {
    const grains = [
      "sandbox.use",
      "sandbox.files",
      "browser.use",
      "browser.watch",
      "browser.control",
    ] as const;
    // Appended at the end, never renamed (positions 65–69; 07.9-01 appended two grains after them).
    expect(Permission.options.slice(65, 70)).toEqual([...grains]);
    for (const p of grains) {
      expect(PERMISSION_SURFACE[p], p).toBe("bots");
      // Every role that lets bots use tools holds them; module deny rules take them away (delegable).
      for (const role of OrgRole.options) {
        expect(ROLE_PERMISSIONS[role].includes("bot.tool.use"), role).toBe(true);
        expect(ROLE_PERMISSIONS[role], `${role}: ${p}`).toContain(p);
      }
      expect(NON_DELEGABLE_PERMISSIONS, p).not.toContain(p);
      expect(LEAD_PERMISSIONS, p).not.toContain(p);
      expect(PermissionPattern.safeParse(p).success, p).toBe(true);
    }
    // Bots use their sandbox and browser for the human; they never watch, take control or manage files (T-07.8-30-03).
    expect(AGENT_PERMISSIONS).toEqual(expect.arrayContaining(["sandbox.use", "browser.use"]));
    for (const p of ["sandbox.files", "browser.watch", "browser.control"] as const) {
      expect(AGENT_PERMISSIONS, p).not.toContain(p);
    }
    expect(PermissionPattern.safeParse("sandbox.*").success).toBe(true);
    expect(PermissionPattern.safeParse("browser.*").success).toBe(true);
    expect(PERMISSION_DESCRIPTIONS["sandbox.use"]).toBe(
      "Let bots run commands and keep files in their sandbox when they work for you",
    );
    expect(PERMISSION_DESCRIPTIONS["sandbox.files"]).toBe(
      "Browse, upload and delete files in the sandboxes of bots you configure",
    );
    expect(PERMISSION_DESCRIPTIONS["browser.use"]).toBe(
      "Let bots open web pages in their browser when they work for you",
    );
    expect(PERMISSION_DESCRIPTIONS["browser.watch"]).toBe(
      "Watch a bot's browser in conversations you can read",
    );
    expect(PERMISSION_DESCRIPTIONS["browser.control"]).toBe(
      "Take control of a bot's browser to sign in yourself",
    );
  });

  it("Phase 07.5 approval-policy grain exists exactly as 07.5-01 defines it (D-04, P-03)", () => {
    // Appended at the end, never renamed (position 64; 07.8-30 appended five grains after it).
    expect(Permission.options[64]).toBe("tool_approval.manage");
    // `team` like `unit.modules.manage`: delegable to leads, outside the 07.3 module catalog's classified surfaces.
    expect(PERMISSION_SURFACE["tool_approval.manage"]).toBe("team");
    for (const role of OrgRole.options) {
      if (role === "admin") expect(ROLE_PERMISSIONS[role]).toContain("tool_approval.manage");
      else expect(ROLE_PERMISSIONS[role], role).not.toContain("tool_approval.manage");
    }
    // Leads manage rules on the subtree they lead (resolver); agents never decide what needs a person.
    expect(LEAD_PERMISSIONS).toContain("tool_approval.manage");
    expect(AGENT_PERMISSIONS).not.toContain("tool_approval.manage");
    expect(NON_DELEGABLE_PERMISSIONS).not.toContain("tool_approval.manage");
    expect(PermissionPattern.safeParse("tool_approval.manage").success).toBe(true);
    expect(PERMISSION_DESCRIPTIONS["tool_approval.manage"]).toBe(
      "Decide which bot actions need a person's approval (for the units you lead)",
    );
  });

  it("Phase 07.4 connector, keychain and template grains exist exactly as 07.4-01 defines them (D-01, D-04, D-05)", () => {
    const grains = ["connector.connect", "vault.use", "vault.manage", "agent_template.manage"] as const;
    // Appended at the end, never renamed.
    // Positions 60–63 (07.5-01 appended `tool_approval.manage` after them).
    expect(Permission.options.slice(60, 64)).toEqual([...grains]);
    expect(PERMISSION_SURFACE).toMatchObject({
      "connector.connect": "bots",
      "vault.use": "bots",
      "vault.manage": "team",
      "agent_template.manage": "team",
    });
    for (const role of OrgRole.options) {
      // Every member connects their own accounts and lets bots use their keys (deniable by rules and modules).
      expect(ROLE_PERMISSIONS[role], `${role}: connector.connect`).toContain("connector.connect");
      expect(ROLE_PERMISSIONS[role], `${role}: vault.use`).toContain("vault.use");
      // Unit keys and templates: admins organization-wide, leads on the units they lead (resolver).
      for (const p of ["vault.manage", "agent_template.manage"] as const) {
        if (role === "admin") expect(ROLE_PERMISSIONS[role], `${role}: ${p}`).toContain(p);
        else expect(ROLE_PERMISSIONS[role], `${role}: ${p}`).not.toContain(p);
      }
    }
    expect(LEAD_PERMISSIONS).toEqual(expect.arrayContaining(["vault.manage", "agent_template.manage"]));
    expect(LEAD_PERMISSIONS).not.toContain("vault.use");
    // An agent uses a key only within the human's rights; it never manages keys or templates, nor connects accounts.
    expect(AGENT_PERMISSIONS).toContain("vault.use");
    for (const p of ["vault.manage", "agent_template.manage", "connector.connect"] as const) {
      expect(AGENT_PERMISSIONS, p).not.toContain(p);
    }
    for (const p of grains) {
      expect(NON_DELEGABLE_PERMISSIONS, p).not.toContain(p);
      expect(PermissionPattern.safeParse(p).success, p).toBe(true);
    }
    expect(PERMISSION_DESCRIPTIONS["connector.connect"]).toBe("Connect your own accounts to connectors");
    expect(PERMISSION_DESCRIPTIONS["vault.use"]).toBe("Let bots use keys from the keychain");
    expect(PERMISSION_DESCRIPTIONS["vault.manage"]).toBe("Manage a unit's keychain keys");
    expect(PERMISSION_DESCRIPTIONS["agent_template.manage"]).toBe("Manage a unit's agent templates");
  });

  it("Phase 07.2 memory grains exist exactly as 07.2-01 defines them (MEM-04, MEM-07, D-04)", () => {
    const memory = ["memory.read", "memory.write", "memory.promote"] as const;
    // Appended after 07.3's grains, never renamed (D-09); 07.4 and 07.5 append after them (positions 57–59).
    expect(Permission.options.slice(57, 60)).toEqual([...memory]);
    expect(PERMISSION_SURFACE).toMatchObject({
      "memory.read": "bots",
      "memory.write": "bots",
      "memory.promote": "team",
    });
    for (const role of OrgRole.options) {
      // Every role reads (STANDARD); only admins hold write and promote organization-wide.
      expect(ROLE_PERMISSIONS[role], `${role}: memory.read`).toContain("memory.read");
      for (const p of ["memory.write", "memory.promote"] as const) {
        if (role === "admin") expect(ROLE_PERMISSIONS[role], `${role}: ${p}`).toContain(p);
        else expect(ROLE_PERMISSIONS[role], `${role}: ${p}`).not.toContain(p);
      }
    }
    expect(ROLE_PERMISSIONS.standard.filter((p) => p.startsWith("memory."))).toEqual(["memory.read"]);
    // Leads write and promote on the subtree they lead (resolver).
    expect(LEAD_PERMISSIONS).toEqual(expect.arrayContaining(["memory.write", "memory.promote"]));
    expect(LEAD_PERMISSIONS).not.toContain("memory.read");
    // Agents read and write within the human's rights; they only ever propose into shared memory.
    expect(AGENT_PERMISSIONS).toEqual(expect.arrayContaining(["memory.read", "memory.write"]));
    expect(AGENT_PERMISSIONS).not.toContain("memory.promote");
    for (const p of memory) {
      expect(NON_DELEGABLE_PERMISSIONS, p).not.toContain(p);
      expect(PermissionPattern.safeParse(p).success, p).toBe(true);
    }
    expect(PermissionPattern.safeParse("memory.*").success).toBe(true);
    expect(PERMISSION_DESCRIPTIONS["memory.read"]).toBe("Read the memory files you have access to");
    expect(PERMISSION_DESCRIPTIONS["memory.write"]).toBe("Edit memory files directly");
    expect(PERMISSION_DESCRIPTIONS["memory.promote"]).toBe("Approve agent proposals into shared memory");
  });

  it("Phase 07.3 permissions exist exactly as 07.3-01 defines them (ADR-0024)", () => {
    expect(PERMISSION_SURFACE).toMatchObject({ "ai_chat.read": "chat", "unit.modules.manage": "team" });
    for (const role of OrgRole.options) {
      // STANDARD holds `ai_chat.read`, so every role does; a module deny rule takes it away (delegable).
      expect(ROLE_PERMISSIONS[role], `${role}: ai_chat.read`).toContain("ai_chat.read");
      if (role === "admin") expect(ROLE_PERMISSIONS[role]).toContain("unit.modules.manage");
      else expect(ROLE_PERMISSIONS[role], role).not.toContain("unit.modules.manage");
    }
    // Leads hold it on the subtree they lead only (resolver), like `bot.manage_unit`.
    expect(LEAD_PERMISSIONS).toContain("unit.modules.manage");
    for (const p of ["ai_chat.read", "unit.modules.manage"] as const) {
      expect(NON_DELEGABLE_PERMISSIONS, p).not.toContain(p);
      expect(PERMISSION_DESCRIPTIONS[p].length, p).toBeGreaterThan(10);
      expect(PermissionPattern.safeParse(p).success, p).toBe(true);
      expect(AGENT_PERMISSIONS, p).not.toContain(p);
    }
    expect(PERMISSION_DESCRIPTIONS["ai_chat.read"]).toBe(
      "See and open AI chats you own or that are shared with you",
    );
    expect(PERMISSION_DESCRIPTIONS["unit.modules.manage"]).toBe(
      "Turn modules on or off for the units you lead and their people",
    );
    // `ai_chat.*` (the AI chats module) covers the new read grain.
    expect(permissionMatches("ai_chat.*", "ai_chat.read")).toBe(true);
  });

  it("Phase 6 permissions exist exactly as 06-01 defines them (P-04)", () => {
    expect(PERMISSION_SURFACE).toMatchObject({
      "ai_chat.manage": "chat",
      "bot.manage_unit": "team",
      "agent_card.approve": "chat",
    });
    for (const role of OrgRole.options) {
      // STANDARD holds them, so every role does; deny rules can still take them away (delegable).
      expect(ROLE_PERMISSIONS[role], `${role}: ai_chat.manage`).toContain("ai_chat.manage");
      expect(ROLE_PERMISSIONS[role], `${role}: agent_card.approve`).toContain("agent_card.approve");
      if (role === "admin") expect(ROLE_PERMISSIONS[role]).toContain("bot.manage_unit");
      else expect(ROLE_PERMISSIONS[role], role).not.toContain("bot.manage_unit");
    }
    // ADR-0024 (07.3-01) appended `unit.modules.manage`: lead rights over module access on the led subtree;
    // 07.2-01 appended `memory.write` and `memory.promote` (shared memory of the led subtree); 07.4-01 appended
    // `vault.manage` and `agent_template.manage` (unit keys and templates of the led subtree); 07.5-01 appended
    // `tool_approval.manage`.
    expect(LEAD_PERMISSIONS).toEqual([
      "unit.members.manage",
      "bot.manage_unit",
      "bot.configure",
      "unit.modules.manage",
      "memory.write",
      "memory.promote",
      "vault.manage",
      "agent_template.manage",
      // 07.5-01: approval policies of the led subtree.
      "tool_approval.manage",
      // 07.9-01: who sees a session in the subtree's projects, and the projects' settings.
      "work_session.visibility",
      "work_project.manage",
    ]);
    for (const p of ["ai_chat.manage", "bot.manage_unit", "agent_card.approve"] as const) {
      expect(NON_DELEGABLE_PERMISSIONS, p).not.toContain(p);
      expect(PERMISSION_DESCRIPTIONS[p].length, p).toBeGreaterThan(10);
      expect(PermissionPattern.safeParse(p).success, p).toBe(true);
    }
    expect(PERMISSION_DESCRIPTIONS["ai_chat.manage"]).toBe(
      "Rename, archive and change the settings of AI chats you own",
    );
    expect(PERMISSION_DESCRIPTIONS["bot.manage_unit"]).toBe(
      "Create and manage the bots of the units you lead",
    );
    expect(PERMISSION_DESCRIPTIONS["agent_card.approve"]).toBe(
      "Approve or deny what an agent asks for in a card",
    );
    expect(PERMISSION_DESCRIPTIONS["ai_chat.share"]).toBe(
      "Share your AI chats with people, teams or the organization, and create read-only links",
    );
    expect(AGENT_PERMISSIONS).not.toContain("agent_card.approve");
  });

  it("Phase 5 AI chat permissions exist exactly as 05-01 defines them", () => {
    const ai = ["ai_chat.use", "ai_chat.web", "ai_chat.share", "ai_chat.share.read"] as const;
    for (const p of ai) {
      expect(PERMISSION_SURFACE[p], p).toBe("chat");
      expect(PERMISSION_DESCRIPTIONS[p].length, p).toBeGreaterThan(10);
      // Every role holds them (STANDARD); explicit deny rules can still take them away (delegable).
      for (const role of OrgRole.options) expect(ROLE_PERMISSIONS[role], `${role}: ${p}`).toContain(p);
      expect(NON_DELEGABLE_PERMISSIONS).not.toContain(p);
      expect(PermissionPattern.safeParse(p).success, p).toBe(true);
    }
    expect(PermissionPattern.safeParse("ai_chat.*").success).toBe(true);
    expect(AGENT_PERMISSIONS).not.toContain("ai_chat.use");
  });

  it("Phase 4 chat permissions exist exactly as 04-01 defines them", () => {
    expect(PERMISSION_SURFACE).toMatchObject({
      "message.delete_any": "admin",
      "channel.mention_all": "chat",
      "attachment.upload": "chat",
      "channel.update": "chat",
    });
    for (const role of OrgRole.options) {
      expect(ROLE_PERMISSIONS[role], `${role}: channel.mention_all`).toContain("channel.mention_all");
      expect(ROLE_PERMISSIONS[role], `${role}: attachment.upload`).toContain("attachment.upload");
      for (const p of ["message.delete_any", "channel.update"] as const) {
        if (role === "admin") expect(ROLE_PERMISSIONS[role], `${role}: ${p}`).toContain(p);
        else expect(ROLE_PERMISSIONS[role], `${role}: ${p}`).not.toContain(p);
      }
    }
    // Moderation is an admin power: an allow rule can never hand it to anyone else.
    expect(NON_DELEGABLE_PERMISSIONS).toContain("message.delete_any");
    expect(NON_DELEGABLE_PERMISSIONS).not.toContain("channel.mention_all");
    for (const p of [
      "message.delete_any",
      "channel.mention_all",
      "attachment.upload",
      "channel.update",
    ] as const) {
      expect(PERMISSION_DESCRIPTIONS[p].length, p).toBeGreaterThan(10);
    }
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
    // Sharing a device (grants, share max mode) is the owner's alone; an allow rule never confers it.
    expect(NON_DELEGABLE_PERMISSIONS).toContain("device.update");
    for (const p of ["work_session.configure", "device.full_access", "work_zone.manage"] as const) {
      expect(PERMISSION_DESCRIPTIONS[p].length, p).toBeGreaterThan(10);
    }
  });

  it("Phase 07.11 device.maintain: Work Zone surface, admins by role, owners by relation, never delegable (D-11)", () => {
    // Position 72; 07.6-01 appended four grains after it.
    expect(Permission.options.slice(72, 73)).toEqual(["device.maintain"]);
    expect(PERMISSION_SURFACE["device.maintain"]).toBe("workzone");
    for (const role of OrgRole.options) {
      if (role === "admin") expect(ROLE_PERMISSIONS[role]).toContain("device.maintain");
      else expect(ROLE_PERMISSIONS[role], role).not.toContain("device.maintain");
    }
    expect(NON_DELEGABLE_PERMISSIONS).toContain("device.maintain");
    expect(PERMISSION_DESCRIPTIONS["device.maintain"]).toBe(
      "Update the coding CLIs on your devices, or on any device as an admin",
    );
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

  it("non-delegable permissions are exactly the admin- and runtime-surface permissions plus device.full_access, device.update and device.maintain", () => {
    const expected = Permission.options.filter(
      (p) =>
        PERMISSION_SURFACE[p] === "admin" ||
        PERMISSION_SURFACE[p] === "runtime" ||
        p === "device.full_access" ||
        p === "device.update" ||
        p === "device.maintain",
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
