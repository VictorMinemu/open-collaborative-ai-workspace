import type { ModuleAccessModuleState, ModuleAccessPerson, ModuleAccessView } from "@ocw/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ModuleAccessPanel, ONE_TEAM_HINT, ORG_SWITCH_HINT, offConfirmation } from "./module-access-card";

/**
 * The Modules panel (07.3-04, ACCESS-02, P-06, P-07): one switch per catalog module with its state, what an ancestor
 * turned off (read-only, with the reason), the Bots warning, the people with an exception and the units inside that
 * differ. Pure rendering of the API's `ModuleAccessView`: who may edit what comes from `canEdit` and the states, never
 * a role check. Static markup in node.
 */

const UNIT = "01a11635-d6e7-7c87-9f17-b6b1dc048941";
const ENGINEERING = "01a11635-d6e7-7c87-9f17-b6b1dc048942";
const CORE = "01a11635-d6e7-7c87-9f17-b6b1dc048943";
const MIA = "01a11635-d6e7-7c87-9f17-b6b1dc048944";
const ADA = "01a11635-d6e7-7c87-9f17-b6b1dc048945";

const on = (module: ModuleAccessModuleState["module"]): ModuleAccessModuleState => ({
  module,
  state: "on",
  inherited: null,
});
const allOn = () => [on("work_zone"), on("ai_chats"), on("bots"), on("memory")];

function view(over: Partial<ModuleAccessView> = {}): ModuleAccessView {
  return {
    scope: { scopeUnitId: UNIT, name: "Platform" },
    modules: allOn(),
    people: [],
    overrides: [],
    unitBotCount: 0,
    ...over,
  };
}

function person(over: Partial<ModuleAccessPerson> = {}): ModuleAccessPerson {
  return { userId: MIA, displayName: "Mia Gate", avatarUrl: null, canEdit: true, modules: allOn(), ...over };
}

const noop = () => {};

function render(v: ModuleAccessView, scopeName = v.scope.name, canOpenScope = (_: string | null) => false) {
  return renderToStaticMarkup(
    <ModuleAccessPanel
      view={v}
      scopeName={scopeName}
      canOpenScope={canOpenScope}
      onToggle={noop}
      onEditPerson={noop}
      onAddPerson={noop}
    />,
  );
}

/** The opening tag of the element carrying `data-testid="<id>"`. */
const tagOf = (html: string, id: string) =>
  html.match(new RegExp(`<[^>]*data-testid="${id}"[^>]*>`))?.[0] ?? "";
/** Markup of one module row. */
const rowOf = (html: string, module: string) =>
  html.match(new RegExp(`<li[^>]*data-module="${module}"[\\s\\S]*?</li>`))?.[0] ?? "";

describe("ModuleAccessPanel", () => {
  it("renders one switch per module in catalog order with its state, Custom, and the Bots warning", () => {
    const html = render(
      view({
        modules: [
          on("work_zone"),
          { module: "ai_chats", state: "custom", inherited: null },
          on("bots"),
          on("memory"),
          on("sandbox"),
          on("browser"),
        ],
        unitBotCount: 2,
      }),
    );
    // 07.8-30: Sandbox and Browser follow Memory (exact list updated to the new correct value).
    expect([...html.matchAll(/data-testid="module-switch-([a-z_]+)"/g)].map((m) => m[1])).toEqual([
      "work_zone",
      "ai_chats",
      "bots",
      "memory",
      "sandbox",
      "browser",
    ]);
    expect(tagOf(html, "module-switch-work_zone")).toContain('aria-checked="true"');
    expect(tagOf(html, "module-switch-work_zone")).toContain(
      'aria-label="Work Zone for everyone in Platform"',
    );
    expect(tagOf(html, "module-switch-work_zone")).not.toContain("aria-disabled");
    expect(tagOf(html, "module-switch-ai_chats")).toContain('aria-checked="false"');
    expect(rowOf(html, "ai_chats")).toContain(">Custom<");
    expect(rowOf(html, "ai_chats")).toContain(
      "Part of this module is off by a manual rule. Turn it on to clear it.",
    );
    expect(rowOf(html, "bots")).toContain(
      "Platform has 2 bots. Turning Bots off also stops them for everyone, admins included.",
    );
    expect(rowOf(html, "work_zone")).not.toContain("Custom");
  });

  it("says one bot, and no warning once Bots is off or the scope owns none", () => {
    expect(render(view({ unitBotCount: 1 }))).toContain("Platform has 1 bot. Turning Bots off");
    const off = render(
      view({
        modules: [on("work_zone"), on("ai_chats"), { module: "bots", state: "off", inherited: null }],
        unitBotCount: 1,
      }),
    );
    expect(off).not.toContain("Turning Bots off also stops");
    expect(tagOf(off, "module-switch-bots")).toContain('aria-checked="false"');
    expect(render(view())).not.toContain("Turning Bots off also stops");
  });

  it("renders a module an ancestor turned off as a disabled switch with the reason and, when allowed, a link", () => {
    const inherited = view({
      modules: [
        {
          module: "work_zone",
          state: "on",
          inherited: { scopeUnitId: ENGINEERING, name: "Engineering", state: "off" },
        },
        {
          module: "ai_chats",
          state: "on",
          inherited: { scopeUnitId: null, name: "Organization", state: "off" },
        },
        on("bots"),
      ],
    });
    const html = render(inherited);
    const wz = tagOf(html, "module-switch-work_zone");
    expect(wz).toContain('aria-checked="false"');
    expect(wz).toMatch(/data-disabled|aria-disabled="true"/);
    expect(rowOf(html, "work_zone")).toContain("Off for everyone in Engineering");
    expect(rowOf(html, "ai_chats")).toContain("Off for the whole organization");
    expect(html).not.toContain('href="/settings/organization?unit=');
    expect(html).not.toContain('href="/settings/modules"');

    const linked = render(inherited, "Platform", () => true);
    expect(rowOf(linked, "work_zone")).toContain(`href="/settings/organization?unit=${ENGINEERING}"`);
    expect(rowOf(linked, "ai_chats")).toContain('href="/settings/modules"');
  });

  it("lists people with an exception (own or from above), and an admin's row is read-only with the reason", () => {
    const html = render(
      view({
        people: [
          person({
            modules: [on("work_zone"), { module: "ai_chats", state: "off", inherited: null }, on("bots")],
          }),
          person({
            userId: ADA,
            displayName: "Ada Stone",
            canEdit: false,
            modules: [
              on("work_zone"),
              on("ai_chats"),
              {
                module: "bots",
                state: "on",
                inherited: { scopeUnitId: null, name: "Organization", state: "off" },
              },
            ],
          }),
          person({ userId: CORE, displayName: "Everything On" }),
        ],
      }),
    );
    const people = [...html.matchAll(/data-testid="module-person"[^>]*data-user-id="([^"]+)"/g)].map(
      (m) => m[1],
    );
    expect(people).toEqual([MIA, ADA]);
    expect(html).toContain(">AI chats off<");
    expect(html).toContain(">Bots off in Organization<");
    expect(html).toContain("Only an organization admin can change modules for an admin.");
    expect(html).not.toContain("Everything On");
  });

  it("does not list a person only for what reaches everyone in the scope", () => {
    const fromAbove = { scopeUnitId: ENGINEERING, name: "Engineering", state: "off" as const };
    const html = render(
      view({
        modules: [{ module: "work_zone", state: "on", inherited: fromAbove }, on("ai_chats"), on("bots")],
        people: [
          person({
            modules: [{ module: "work_zone", state: "on", inherited: fromAbove }, on("ai_chats"), on("bots")],
          }),
        ],
      }),
    );
    expect(html).not.toContain('data-testid="module-person"');
  });

  it("lists the units inside that differ, each a link, and nothing when none does", () => {
    expect(render(view())).not.toContain("Turned off inside");
    const html = render(
      view({
        overrides: [
          {
            unitId: CORE,
            name: "Core",
            modules: [
              on("work_zone"),
              { module: "ai_chats", state: "off", inherited: null },
              { module: "bots", state: "custom", inherited: null },
            ],
          },
        ],
      }),
    );
    expect(html).toContain("Turned off inside Platform");
    expect(html).toMatch(
      new RegExp(
        `<a[^>]*href="/settings/organization\\?unit=${CORE}"[^>]*>[\\s\\S]*Core[\\s\\S]*AI chats off, Bots custom`,
      ),
    );
  });

  it("at organization scope speaks of the organization and lists the units inside that differ", () => {
    const org = view({
      scope: { scopeUnitId: null, name: "Organization" },
      overrides: [
        {
          unitId: ENGINEERING,
          name: "Engineering",
          modules: [{ module: "work_zone", state: "off", inherited: null }, on("ai_chats"), on("bots")],
        },
      ],
    });
    const html = render(org, "Autofy Labs");
    expect(tagOf(html, "module-switch-ai_chats")).toContain(
      'aria-label="AI chats for everyone in Autofy Labs"',
    );
    expect(html).toContain("Turn a module off for one person in the organization.");
    expect(html).toContain("Turned off inside Autofy Labs");
    expect(html).toMatch(
      new RegExp(
        `<a[^>]*href="/settings/organization\\?unit=${ENGINEERING}"[^>]*>[\\s\\S]*Engineering[\\s\\S]*Work Zone off`,
      ),
    );
  });
});

describe("Sandbox and Browser rows (07.8-19; D-12, P-02, U-1)", () => {
  const all = () => [on("work_zone"), on("ai_chats"), on("bots"), on("memory"), on("sandbox"), on("browser")];

  it("follow Memory with the organization switch's hint, and only they carry it", () => {
    const html = render(view({ modules: all() }));
    expect(ORG_SWITCH_HINT).toBe("Runs only when Sandbox & Browser is on for the organization.");
    for (const m of ["sandbox", "browser"])
      expect(rowOf(html, m).replace(/&amp;/g, "&")).toContain(ORG_SWITCH_HINT);
    for (const m of ["work_zone", "ai_chats", "bots", "memory"])
      expect(rowOf(html, m)).not.toContain("module-org-hint");
    expect(html.indexOf('data-module="memory"')).toBeLessThan(html.indexOf('data-module="sandbox"'));
    expect(html.indexOf('data-module="sandbox"')).toBeLessThan(html.indexOf('data-module="browser"'));
  });

  it("a unit row locked by the organization adds how to get one team only; other locks and modules do not", () => {
    const fromOrg = { scopeUnitId: null, name: "Organization", state: "off" as const };
    const fromDept = { scopeUnitId: ENGINEERING, name: "Engineering", state: "off" as const };
    const html = render(
      view({
        modules: [
          on("work_zone"),
          on("ai_chats"),
          { module: "bots", state: "on", inherited: fromOrg },
          on("memory"),
          { module: "sandbox", state: "on", inherited: fromOrg },
          { module: "browser", state: "on", inherited: fromDept },
        ],
      }),
    );
    expect(rowOf(html, "sandbox")).toContain("Off for the whole organization");
    expect(rowOf(html, "sandbox").replace(/&#x27;/g, "'")).toContain(ONE_TEAM_HINT);
    expect(rowOf(html, "browser")).not.toContain("module-unit-hint");
    expect(rowOf(html, "bots")).not.toContain("module-unit-hint");
    // The inherited line itself is unchanged (07.3 specs read it exactly).
    expect(rowOf(html, "sandbox")).toMatch(
      /data-testid="module-inherited"[^>]*><span[^>]*>Off for the whole organization<\/span>/,
    );
  });
});

describe("offConfirmation", () => {
  it("asks before turning a module off for the whole organization, admins included", () => {
    const org = view({ scope: { scopeUnitId: null, name: "Organization" } });
    expect(offConfirmation(org, "ai_chats", "Autofy Labs")).toEqual({
      title: "Turn AI chats off for everyone?",
      body: "Everyone in the organization loses AI chats right away, admins included. Turning it back on restores it.",
    });
  });

  it("asks before Bots goes off on a unit that owns bots, with the warning; otherwise a unit toggles at once", () => {
    expect(offConfirmation(view({ unitBotCount: 3 }), "bots", "Platform")).toEqual({
      title: "Turn Bots off for everyone in Platform?",
      body: "Platform has 3 bots. Turning Bots off also stops them for everyone, admins included.",
    });
    expect(offConfirmation(view(), "bots", "Platform")).toBeNull();
    expect(offConfirmation(view({ unitBotCount: 3 }), "ai_chats", "Platform")).toBeNull();
  });
});
