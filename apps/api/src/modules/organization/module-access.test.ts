import { MODULE_CATALOG, type ModuleAccessModuleState, type ModuleId } from "@ocw/contracts";
import { describe, expect, it } from "vitest";
import { moduleTargetResource } from ".";
import { deriveModuleAccess, type ModuleAccessInput, moduleStateOf } from "./module-access";
import type { RuleFact } from "./permissions/resolve";

describe("public interface", () => {
  it("exports moduleTargetResource for other modules (07.3-01 open item 4)", () => {
    expect(moduleTargetResource({ id: "u1", path: ["u0", "u1"] }, "admin")).toMatchObject({
      type: "unit",
      unitPath: ["u0", "u1"],
      targetRole: "admin",
    });
    expect(moduleTargetResource(null)).not.toHaveProperty("targetRole");
  });
});

const D = "00000000-0000-4000-8000-00000000000d";
const T = "00000000-0000-4000-8000-00000000000e";
const P = "00000000-0000-4000-8000-00000000000f";
const S = "00000000-0000-4000-8000-000000000010";
const DANA = "00000000-0000-4000-8000-0000000000da";
const SAM = "00000000-0000-4000-8000-0000000000aa";

let seq = 0;
function rule(r: Partial<RuleFact> & { permission: string }): RuleFact {
  seq += 1;
  return {
    id: `r${seq}`,
    scopeUnitId: null,
    subjectKind: "everyone",
    subjectId: null,
    tool: null,
    pathPrefix: null,
    effect: "deny",
    ...r,
  };
}

/** Every catalog row of `module` at one scope and subject. */
const rows = (module: ModuleId, extra: Partial<RuleFact> = {}) =>
  MODULE_CATALOG[module].patterns.map((permission) => rule({ permission, ...extra }));

const everyone = { kind: "everyone" } as const;

describe("moduleStateOf: exact rows only", () => {
  it("on with no rows, off with every pattern, custom with some", () => {
    expect(moduleStateOf([], "work_zone", null, everyone)).toBe("on");
    expect(moduleStateOf(rows("work_zone"), "work_zone", null, everyone)).toBe("off");
    expect(moduleStateOf([rule({ permission: "device.pair" })], "work_zone", null, everyone)).toBe("custom");
  });

  it("ignores allow rows, tool rows, other scopes, other subjects and non-catalog permissions", () => {
    const noise = [
      ...rows("ai_chats", { effect: "allow" }),
      rule({ permission: "ai_chat.*", tool: "web_search" }),
      ...rows("ai_chats", { scopeUnitId: T }),
      ...rows("ai_chats", { subjectKind: "user", subjectId: DANA }),
      ...rows("ai_chats", { subjectKind: "role", subjectId: "standard" }),
      rule({ permission: "ai_chat.use" }),
      rule({ permission: "channel.read" }),
    ];
    expect(moduleStateOf(noise, "ai_chats", null, everyone)).toBe("on");
    expect(moduleStateOf(noise, "ai_chats", T, everyone)).toBe("off");
    expect(moduleStateOf(noise, "ai_chats", null, { kind: "user", userId: DANA })).toBe("off");
    expect(moduleStateOf(noise, "ai_chats", null, { kind: "user", userId: SAM })).toBe("on");
  });

  it("ignores folder rows (Phase 07.2): a memory.* deny on one folder is not the Memory module turned off", () => {
    const folder = [rule({ permission: "memory.*", pathPrefix: "hr/" })];
    expect(moduleStateOf(folder, "memory", null, everyone)).toBe("on");
    expect(moduleStateOf([...folder, ...rows("memory")], "memory", null, everyone)).toBe("off");
  });

  it("counts duplicates once", () => {
    const dup = [...rows("bots"), rule({ permission: "bot.read" })];
    expect(moduleStateOf(dup, "bots", null, everyone)).toBe("off");
    const partial = [rule({ permission: "bot.read" }), rule({ permission: "bot.read" })];
    expect(moduleStateOf(partial, "bots", null, everyone)).toBe("custom");
  });
});

function input(over: Partial<ModuleAccessInput> = {}): ModuleAccessInput {
  return {
    rules: [],
    scope: { unitId: T, path: [D, T], name: "Backend" },
    unitNames: new Map([
      [D, "Engineering"],
      [T, "Backend"],
      [P, "Payments"],
      [S, "Sales"],
    ]),
    unitsInside: [{ id: P, name: "Payments", path: [D, T, P] }],
    people: [{ userId: DANA, displayName: "Dana Dev", avatarUrl: null, canEdit: true }],
    unitBotCount: 2,
    ...over,
  };
}

const stateIn = (modules: readonly ModuleAccessModuleState[], module: ModuleId) =>
  modules.find((m) => m.module === module);

describe("deriveModuleAccess", () => {
  it("everything on: scope, catalog order, people with their states, no overrides", () => {
    const v = deriveModuleAccess(input());
    expect(v.scope).toEqual({ scopeUnitId: T, name: "Backend" });
    expect(v.modules).toEqual([
      { module: "work_zone", state: "on", inherited: null },
      { module: "ai_chats", state: "on", inherited: null },
      { module: "bots", state: "on", inherited: null },
      { module: "memory", state: "on", inherited: null },
    ]);
    expect(v.people).toEqual([
      { userId: DANA, displayName: "Dana Dev", avatarUrl: null, canEdit: true, modules: v.modules },
    ]);
    expect(v.overrides).toEqual([]);
    expect(v.unitBotCount).toBe(2);
  });

  it("a department off is inherited by the team", () => {
    const v = deriveModuleAccess(input({ rules: rows("work_zone", { scopeUnitId: D }) }));
    expect(stateIn(v.modules, "work_zone")).toEqual({
      module: "work_zone",
      state: "on",
      inherited: { scopeUnitId: D, name: "Engineering", state: "off" },
    });
    expect(stateIn(v.modules, "bots")?.inherited).toBeNull();
  });

  it("an organization row is inherited when no ancestor has one; the deepest ancestor wins over it", () => {
    const org = rows("ai_chats");
    expect(stateIn(deriveModuleAccess(input({ rules: org })).modules, "ai_chats")?.inherited).toEqual({
      scopeUnitId: null,
      name: "Organization",
      state: "off",
    });
    const both = [...org, rule({ permission: "ai_chat.*", scopeUnitId: D })];
    expect(stateIn(deriveModuleAccess(input({ rules: both })).modules, "ai_chats")?.inherited).toEqual({
      scopeUnitId: D,
      name: "Engineering",
      state: "off",
    });
    // A partial ancestor reports custom.
    const custom = [rule({ permission: "device.pair", scopeUnitId: D })];
    expect(stateIn(deriveModuleAccess(input({ rules: custom })).modules, "work_zone")?.inherited).toEqual({
      scopeUnitId: D,
      name: "Engineering",
      state: "custom",
    });
  });

  it("the scope's own rows are its state, never its inherited", () => {
    const v = deriveModuleAccess(input({ rules: rows("bots", { scopeUnitId: T }) }));
    expect(stateIn(v.modules, "bots")).toEqual({ module: "bots", state: "off", inherited: null });
  });

  it("a person's state is her rows at this scope; her inherited also sees her rows at ancestors", () => {
    const rules = [
      ...rows("bots", { scopeUnitId: T, subjectKind: "user", subjectId: DANA }),
      ...rows("work_zone", { scopeUnitId: D, subjectKind: "user", subjectId: DANA }),
      ...rows("ai_chats", { subjectKind: "user", subjectId: DANA }),
      ...rows("ai_chats", { scopeUnitId: T, subjectKind: "user", subjectId: SAM }),
    ];
    const v = deriveModuleAccess(input({ rules }));
    const dana = v.people[0];
    expect(dana?.modules).toEqual([
      { module: "work_zone", state: "on", inherited: { scopeUnitId: D, name: "Engineering", state: "off" } },
      {
        module: "ai_chats",
        state: "on",
        inherited: { scopeUnitId: null, name: "Organization", state: "off" },
      },
      { module: "bots", state: "off", inherited: null },
      { module: "memory", state: "on", inherited: null },
    ]);
    // Person rows never change the unit's own state.
    expect(v.modules.every((m) => m.state === "on" && m.inherited === null)).toBe(true);
  });

  it("overrides list units strictly inside the scope whose everyone rows are not all on, in tree order", () => {
    const X = "00000000-0000-4000-8000-000000000011";
    const v = deriveModuleAccess(
      input({
        scope: { unitId: null, path: [], name: "Organization" },
        unitNames: new Map([
          [D, "Engineering"],
          [T, "Backend"],
          [P, "Payments"],
          [S, "Sales"],
          [X, "Frontend"],
        ]),
        unitsInside: [
          { id: S, name: "Sales", path: [S] },
          { id: P, name: "Payments", path: [D, T, P] },
          { id: X, name: "Frontend", path: [D, X] },
          { id: D, name: "Engineering", path: [D] },
          { id: T, name: "Backend", path: [D, T] },
        ],
        rules: [
          ...rows("bots", { scopeUnitId: S }),
          rule({ permission: "device.pair", scopeUnitId: P }),
          ...rows("ai_chats", { scopeUnitId: X }),
          ...rows("work_zone", { scopeUnitId: D }),
          // Person rows inside a unit are not unit overrides.
          ...rows("bots", { scopeUnitId: T, subjectKind: "user", subjectId: DANA }),
        ],
        unitBotCount: 0,
      }),
    );
    expect(v.overrides.map((o) => o.name)).toEqual(["Engineering", "Payments", "Frontend", "Sales"]);
    expect(v.overrides[0]).toEqual({
      unitId: D,
      name: "Engineering",
      modules: [
        { module: "work_zone", state: "off", inherited: null },
        { module: "ai_chats", state: "on", inherited: null },
        { module: "bots", state: "on", inherited: null },
        { module: "memory", state: "on", inherited: null },
      ],
    });
    expect(stateIn(v.overrides[1]?.modules ?? [], "work_zone")?.state).toBe("custom");
  });

  it("the organization scope has no inherited, for the scope or its people", () => {
    const v = deriveModuleAccess(
      input({
        scope: { unitId: null, path: [], name: "Organization" },
        rules: [...rows("bots"), ...rows("bots", { subjectKind: "user", subjectId: DANA })],
      }),
    );
    expect(stateIn(v.modules, "bots")).toEqual({ module: "bots", state: "off", inherited: null });
    expect(stateIn(v.people[0]?.modules ?? [], "bots")).toEqual({
      module: "bots",
      state: "off",
      inherited: null,
    });
  });
});
