import { describe, expect, it } from "vitest";
import {
  MODULE_CATALOG,
  MODULE_EXCLUDED,
  ModuleAccessView,
  ModuleId,
  modulePatternOf,
  SetModuleAccessRequest,
} from "./module-access";
import { PERMISSION_SURFACE, Permission, PermissionPattern, permissionMatches } from "./permissions";

const id = "0190d5e2-7c3a-7cc2-9d2e-6a1b2c3d4e5f";

/** The modules whose patterns match `perm`. */
const modulesMatching = (perm: Permission) =>
  ModuleId.options.filter((m) => MODULE_CATALOG[m].patterns.some((p) => permissionMatches(p, perm)));

describe("module catalog (Phase 07.3, ADR-0024)", () => {
  it("never matches an admin- or runtime-surface grain, nor an excluded one", () => {
    for (const perm of Permission.options) {
      const surface = PERMISSION_SURFACE[perm];
      if (surface === "admin" || surface === "runtime" || MODULE_EXCLUDED.includes(perm)) {
        expect(modulesMatching(perm), perm).toEqual([]);
      }
    }
    // The named examples: device hygiene and governance are never module grains.
    for (const perm of ["device.revoke", "device.read", "bot.manage", "work_zone.manage"] as const) {
      expect(modulesMatching(perm), perm).toEqual([]);
    }
  });

  it("classifies every Work Zone, Bots and ai_chat. grain: one module or MODULE_EXCLUDED (Phase 8 guard)", () => {
    for (const perm of Permission.options) {
      const surface = PERMISSION_SURFACE[perm];
      if (surface !== "workzone" && surface !== "bots" && !perm.startsWith("ai_chat.")) continue;
      const owners = modulesMatching(perm);
      const excluded = MODULE_EXCLUDED.includes(perm);
      expect(owners.length + (excluded ? 1 : 0), `${perm} must be classified exactly once`).toBe(1);
    }
  });

  it("patterns parse, every module has one, every entry is its own module's, no grain is in two modules", () => {
    for (const m of ModuleId.options) {
      const { patterns, entry, label, description } = MODULE_CATALOG[m];
      expect(patterns.length, m).toBeGreaterThan(0);
      expect(label.length, m).toBeGreaterThan(0);
      expect(description.length, m).toBeGreaterThan(10);
      for (const p of patterns) expect(PermissionPattern.safeParse(p).success, `${m}: ${p}`).toBe(true);
      expect(new Set(patterns).size, m).toBe(patterns.length);
      expect(modulesMatching(entry), `${m}: entry ${entry}`).toEqual([m]);
    }
    for (const perm of Permission.options) expect(modulesMatching(perm).length, perm).toBeLessThanOrEqual(1);
    // Excluded grains are real grains, listed once.
    for (const perm of MODULE_EXCLUDED) expect(Permission.options, perm).toContain(perm);
    expect(new Set(MODULE_EXCLUDED).size).toBe(MODULE_EXCLUDED.length);
  });

  it("is exactly the agreed catalog (P-03)", () => {
    // Phase 07.8 (07.8-30, D-09): Sandbox and Browser appended after Memory.
    expect(ModuleId.options).toEqual(["work_zone", "ai_chats", "bots", "memory", "sandbox", "browser"]);
    expect(MODULE_CATALOG.work_zone).toMatchObject({
      entry: "work_session.read",
      patterns: ["work_session.*", "device.pair", "device.use", "device.full_access"],
    });
    expect(MODULE_CATALOG.ai_chats).toMatchObject({ entry: "ai_chat.read", patterns: ["ai_chat.*"] });
    // Phase 07.4 (07.4-01): Bots off also hides member connections and keychain use.
    expect(MODULE_CATALOG.bots).toMatchObject({
      entry: "bot.read",
      patterns: [
        "bot.read",
        "bot.create_personal",
        "bot.configure",
        "bot.internet",
        "bot.tool.use",
        "connector.connect",
        "vault.use",
      ],
    });
    expect(modulesMatching("connector.connect")).toEqual(["bots"]);
    expect(modulesMatching("vault.use")).toEqual(["bots"]);
    // Governance grains of the team surface stay out of every module (like bot.manage_unit).
    expect(modulesMatching("vault.manage")).toEqual([]);
    expect(modulesMatching("agent_template.manage")).toEqual([]);
    // Phase 07.2 (07.2-01): memory files, all three grains (read, write, promote).
    expect(MODULE_CATALOG.memory).toMatchObject({
      label: "Memory",
      entry: "memory.read",
      patterns: ["memory.*"],
    });
    expect(modulesMatching("memory.read")).toEqual(["memory"]);
    expect(modulesMatching("memory.write")).toEqual(["memory"]);
    expect(modulesMatching("memory.promote")).toEqual(["memory"]);
    expect([...MODULE_EXCLUDED].sort()).toEqual(
      [
        "device.read",
        "device.update",
        "device.revoke",
        "device.maintain",
        "device.link",
        "bot.manage",
        "bot.manage_unit",
        "agent_card.approve",
      ].sort(),
    );
  });

  it("modulePatternOf names the module of an exact catalog pattern, null otherwise", () => {
    expect(modulePatternOf("ai_chat.*")).toBe("ai_chats");
    expect(modulePatternOf("work_session.*")).toBe("work_zone");
    expect(modulePatternOf("device.pair")).toBe("work_zone");
    expect(modulePatternOf("bot.tool.use")).toBe("bots");
    expect(modulePatternOf("memory.*")).toBe("memory");
    expect(modulePatternOf("sandbox.*")).toBe("sandbox");
    expect(modulePatternOf("browser.*")).toBe("browser");
    expect(modulePatternOf("browser.watch")).toBeNull();
    expect(modulePatternOf("memory.read")).toBeNull();
    expect(modulePatternOf("device.revoke")).toBeNull();
    // Exact pattern, not a match: a hand-written grain under a catalog prefix is not a catalog row.
    expect(modulePatternOf("ai_chat.use")).toBeNull();
    expect(modulePatternOf("bot.*")).toBeNull();
    expect(modulePatternOf("nope")).toBeNull();
  });
});

describe("Sandbox and Browser modules (Phase 07.8, D-09, D-12, P-05)", () => {
  it("are ordinary catalog modules with the UI-SPEC copy, one pattern each and no exclusion", () => {
    expect(MODULE_CATALOG.sandbox).toEqual({
      label: "Sandbox",
      description: "Bots get their own workspace to keep files and run commands",
      entry: "sandbox.use",
      patterns: ["sandbox.*"],
    });
    expect(MODULE_CATALOG.browser).toEqual({
      label: "Browser",
      description: "Bots open web pages in a real browser that people can watch and sign in to",
      entry: "browser.use",
      patterns: ["browser.*"],
    });
    for (const perm of MODULE_EXCLUDED) {
      expect(perm.startsWith("sandbox.") || perm.startsWith("browser."), perm).toBe(false);
    }
  });

  it("every sandbox. and browser. grain belongs to exactly its module", () => {
    const sandbox = Permission.options.filter((p) => p.startsWith("sandbox."));
    const browserGrains = Permission.options.filter((p) => p.startsWith("browser."));
    expect(sandbox).toEqual(["sandbox.use", "sandbox.files"]);
    expect(browserGrains).toEqual(["browser.use", "browser.watch", "browser.control"]);
    for (const p of sandbox) expect(modulesMatching(p), p).toEqual(["sandbox"]);
    for (const p of browserGrains) expect(modulesMatching(p), p).toEqual(["browser"]);
  });

  it("C-05 does not apply: no grain is added to an existing module", () => {
    expect(MODULE_CATALOG.work_zone.patterns).toEqual([
      "work_session.*",
      "device.pair",
      "device.use",
      "device.full_access",
    ]);
    expect(MODULE_CATALOG.ai_chats.patterns).toEqual(["ai_chat.*"]);
    expect(MODULE_CATALOG.bots.patterns).toEqual([
      "bot.read",
      "bot.create_personal",
      "bot.configure",
      "bot.internet",
      "bot.tool.use",
      "connector.connect",
      "vault.use",
    ]);
    expect(MODULE_CATALOG.memory.patterns).toEqual(["memory.*"]);
    for (const m of ["work_zone", "ai_chats", "bots", "memory"] as const) {
      for (const p of [
        "sandbox.use",
        "sandbox.files",
        "browser.use",
        "browser.watch",
        "browser.control",
      ] as const) {
        expect(modulesMatching(p), `${m}: ${p}`).not.toContain(m);
      }
    }
  });
});

describe("module-access API schemas", () => {
  it("SetModuleAccessRequest accepts everyone and user subjects", () => {
    expect(
      SetModuleAccessRequest.parse({
        module: "bots",
        scopeUnitId: null,
        subject: { kind: "everyone" },
        enabled: false,
      }),
    ).toEqual({ module: "bots", scopeUnitId: null, subject: { kind: "everyone" }, enabled: false });
    expect(
      SetModuleAccessRequest.safeParse({
        module: "work_zone",
        scopeUnitId: id,
        subject: { kind: "user", userId: id },
        enabled: true,
      }).success,
    ).toBe(true);
  });

  it("SetModuleAccessRequest refuses unknown modules, malformed subjects and non-boolean enabled", () => {
    const base = { module: "bots", scopeUnitId: null, subject: { kind: "everyone" }, enabled: false };
    for (const bad of [
      { ...base, module: "chat" },
      { ...base, subject: { kind: "user" } },
      { ...base, subject: { kind: "everyone", userId: id } },
      { ...base, subject: { kind: "role", roleId: "admin" } },
      { ...base, enabled: "false" },
      { ...base, scopeUnitId: "not-a-uuid" },
    ]) {
      expect(SetModuleAccessRequest.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("ModuleAccessView parses a minimal organization view", () => {
    const view = {
      scope: { scopeUnitId: null, name: "Autofy Labs" },
      modules: [
        { module: "work_zone", state: "on", inherited: null },
        { module: "ai_chats", state: "custom", inherited: null },
        { module: "bots", state: "off", inherited: null },
      ],
      people: [
        {
          userId: id,
          displayName: "Dana Dev",
          avatarUrl: null,
          canEdit: true,
          modules: [
            { module: "bots", state: "off", inherited: { scopeUnitId: id, name: "IT", state: "off" } },
          ],
        },
      ],
      overrides: [],
      unitBotCount: 0,
    };
    expect(ModuleAccessView.parse(view)).toEqual(view);
    expect(ModuleAccessView.safeParse({ ...view, unitBotCount: -1 }).success).toBe(false);
  });
});
