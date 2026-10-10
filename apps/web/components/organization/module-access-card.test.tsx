import type { ModuleAccessModuleState, ModuleAccessPerson, ModuleAccessView } from "@ocw/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ModuleAccessPanel } from "./module-access-card";

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
const allOn = () => [on("work_zone"), on("ai_chats"), on("bots")];

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
        modules: [on("work_zone"), { module: "ai_chats", state: "custom", inherited: null }, on("bots")],
        unitBotCount: 2,
      }),
    );
    expect([...html.matchAll(/data-testid="module-switch-([a-z_]+)"/g)].map((m) => m[1])).toEqual([
      "work_zone",
      "ai_chats",
      "bots",
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
});
