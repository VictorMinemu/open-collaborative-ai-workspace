import type { WorkSessionVisibilityView } from "@ocw/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  loseAccessOnChange,
  modelFromDraft,
  modelFromView,
  PanelBody,
  type PanelBodyProps,
} from "./visibility-panel";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: unknown } & Record<string, unknown>) => (
    <a href={href} {...(rest as object)}>
      {children as never}
    </a>
  ),
}));

/**
 * The visibility panel (07.9-10, UI-SPEC §1.2–1.6, D-04, D-07, D-11, D-12): static markup from fixture API views. The
 * panel words what the API answered and never decides who can see the session or who may change it.
 */

const ANA = "01a11635-d6e7-7c87-9f17-0000000000a1";
const LEO = "01a11635-d6e7-7c87-9f17-0000000000a2";
const PIA = "01a11635-d6e7-7c87-9f17-0000000000a3";
const UNIT = "01a11635-d6e7-7c87-9f17-0000000000e1";
const WEB = "01a11635-d6e7-7c87-9f17-0000000000d1";
const OPS = "01a11635-d6e7-7c87-9f17-0000000000d2";

const person = (userId: string, name: string) => ({ userId, name, avatarUrl: null });

const view = (over: Partial<WorkSessionVisibilityView> = {}): WorkSessionVisibilityView => ({
  kind: "project",
  projectDefault: "project",
  project: { kind: "team", id: UNIT, name: "Customer portal" },
  owner: { userId: ANA, name: "Ana Ruiz" },
  teams: [{ id: WEB, name: "Web", kind: "team", memberCount: 8, selected: false, active: true }],
  people: [],
  viewers: {
    count: 12,
    people: [
      { ...person(ANA, "Ana Ruiz"), reason: "owner", via: null },
      { ...person(LEO, "Leo Park"), reason: "member", via: null },
      { ...person(PIA, "Pia Gómez"), reason: "team", via: { id: WEB, name: "Web" } },
    ],
    more: 0,
  },
  alwaysVisible: { admins: true, deviceOwner: null },
  viewerCan: { change: true },
  viewerState: null,
  ...over,
});

const noop = () => Promise.resolve(true);

function render(model: PanelBodyProps["model"], over: Partial<PanelBodyProps> = {}): string {
  return renderToStaticMarkup(
    <PanelBody
      model={model}
      surface="inline"
      apply={noop}
      search={{ q: "", onQuery: () => undefined, results: undefined, searching: false }}
      announce=""
      {...over}
    />,
  );
}

const count = (html: string, needle: string) => html.split(needle).length - 1;

describe("editable panel", () => {
  it("shows the four choices as radios in a fieldset, with Default on the project's default", () => {
    const html = render(modelFromView(view(), ANA, null));
    expect(html).toContain('data-testid="visibility-panel"');
    expect(html).toContain('data-editable="true"');
    expect(html).toMatch(/<fieldset[^>]*>\s*<legend class="sr-only">Who can see this session<\/legend>/);
    for (const kind of ["owner", "project", "teams", "people"])
      expect(html).toContain(`data-testid="visibility-option-${kind}"`);
    expect(count(html, 'type="radio"')).toBe(4);
    expect(html).toContain("Only me");
    expect(html).toContain("Everyone in Customer portal · 12 people");
    expect(html).toContain("Choose from Customer portal&#x27;s teams");
    expect(count(html, ">Default<")).toBe(1);
    expect(html).toMatch(/data-testid="visibility-option-project"[\s\S]*?>Default</);
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).not.toContain("visibility-readonly-note");
  });

  it("marks Only me as the default when the project's switch is off", () => {
    const html = render(modelFromView(view({ kind: "owner", projectDefault: "owner" }), ANA, null));
    expect(html).toMatch(/data-testid="visibility-option-owner"[\s\S]*?>Default</);
    expect(html).toMatch(/<input type="radio"[^>]*checked=""[^>]*value="owner"/);
  });

  it("names the owner for an editor who is not the owner", () => {
    const html = render(modelFromView(view(), LEO, null));
    expect(html).toContain("Only Ana Ruiz");
    expect(html).toContain("Just Ana Ruiz.");
  });
});

describe("read-only panel (§1.4)", () => {
  it("shows only the current choice, its names and who may change it, with no radio", () => {
    const v = view({
      kind: "teams",
      teams: [
        { id: WEB, name: "Web", kind: "team", memberCount: 8, selected: true, active: true },
        { id: OPS, name: "Ops", kind: "team", memberCount: 3, selected: true, active: true },
      ],
      viewerCan: { change: false },
    });
    const html = render(modelFromView(v, LEO, null));
    expect(html).toContain('data-editable="false"');
    expect(html).not.toContain('type="radio"');
    expect(html).toContain('data-testid="visibility-current"');
    expect(html).toContain("Web, Ops");
    expect(html).toContain('data-testid="visibility-readonly-note"');
    expect(html).toContain("Only Ana Ruiz, project leads and admins can change this.");
  });

  it("tells a creator who left the project why they can't change it (D-12)", () => {
    const v = view({ viewerCan: { change: false }, viewerState: "left_project" });
    const html = render(modelFromView(v, ANA, null));
    expect(html).toContain("You left Customer portal, so you can&#x27;t change this.");
  });
});

describe("the hidden form: a project the viewer can't open (07.10-07, HI-01)", () => {
  const hidden = (over: Partial<WorkSessionVisibilityView> = {}) =>
    view({
      kind: "teams",
      projectDefault: null,
      project: { kind: "hidden" },
      teams: [],
      people: [],
      viewers: {
        count: 3,
        people: [
          { ...person(ANA, "Ana Ruiz"), reason: "owner", via: null },
          { ...person(LEO, "Leo Park"), reason: "device_owner", via: null },
          { ...person(PIA, "Pia Gómez"), reason: "team", via: null },
        ],
        more: 0,
      },
      alwaysVisible: {
        admins: true,
        deviceOwner: { userId: LEO, firstName: "Leo", deviceName: "Leo's Mac", isViewer: true },
      },
      viewerCan: { change: false },
      ...over,
    });

  it("is read-only and says the session is linked to a project the viewer can't open, naming none", () => {
    const html = render(modelFromView(hidden(), LEO, null), { initialSeeAll: true });
    expect(html).toContain('data-editable="false"');
    expect(html).not.toContain('type="radio"');
    expect(html).toContain('data-testid="visibility-readonly-note"');
    expect(html).toContain("Linked to a project you can&#x27;t open.");
    // Teams with no team listed is still "3 people can see this", never "Only Ana Ruiz".
    expect(html).toContain("3 people can see this");
    expect(html).toContain("Admins and you can always see it: it runs on Leo&#x27;s Mac.");
    expect(html).toContain("Through a team");
    expect(html).not.toContain("/work-zone/projects/");
    expect(html).not.toContain("Customer portal");
    expect(html).not.toContain("Everyone in </");
  });

  it("words a whole-project audience without a project name", () => {
    const html = render(modelFromView(hidden({ kind: "project" }), LEO, null));
    expect(html).toContain("Everyone in a project you can&#x27;t open · 3 people");
  });

  it("stays read-only even if the API ever said the viewer may change it", () => {
    const html = render(modelFromView(hidden({ viewerCan: { change: true } }), LEO, null));
    expect(html).toContain('data-editable="false"');
    expect(html).not.toContain('type="radio"');
  });
});

describe("empty states", () => {
  it("disables Teams on a personal project and names the device (U-9)", () => {
    const v = view({
      projectDefault: null,
      project: { kind: "personal", deviceName: "Ana's MacBook" },
      teams: [],
      viewers: { count: 3, people: [], more: 0 },
    });
    const html = render(modelFromView(v, ANA, null));
    expect(html).toMatch(/<input type="radio" disabled=""[^>]*value="teams"/);
    expect(html).toContain("Personal projects have no teams");
    expect(html).toContain("Everyone who can use Ana&#x27;s MacBook · 3 people");
    expect(html).toContain("Choose people who can use Ana&#x27;s MacBook");
    expect(html).toMatch(/data-testid="visibility-option-project"[\s\S]*?>Default</);
  });

  it("disables Teams on a team project without teams; editors get Assign teams", () => {
    const v = view({ teams: [] });
    const editor = render(modelFromView(v, ANA, null));
    expect(editor).toContain("Customer portal has no teams yet");
    expect(editor).toContain(`href="/work-zone/projects/${UNIT}?tab=settings"`);
    expect(editor).toContain(">Assign teams<");
    const reader = render(modelFromView({ ...v, viewerCan: { change: false } }, LEO, null));
    expect(reader).not.toContain("Assign teams");
  });
});

describe("pickers and entries outside the project (§1.3, §1.5)", () => {
  it("lists the project's teams with their size, and a team no longer assigned as inactive", () => {
    const v = view({
      kind: "teams",
      teams: [
        { id: WEB, name: "Web", kind: "team", memberCount: 8, selected: true, active: true },
        { id: OPS, name: "Ops", kind: "department", memberCount: 1, selected: true, active: false },
      ],
    });
    const html = render(modelFromView(v, ANA, null));
    expect(html).toContain('data-testid="team-picker"');
    expect(html).toContain(`data-testid="team-option-${WEB}"`);
    expect(html).toContain("8 people");
    expect(html).toMatch(
      /data-testid="visibility-inactive"[\s\S]*?Ops[\s\S]*?No longer assigned to Customer portal/,
    );
    expect(html).toContain('aria-label="Remove Ops"');
    expect(html).not.toContain("Pick at least one team.");
  });

  it("shows the owner first, the chosen people with Remove, a person who left as inactive, and the search", () => {
    const v = view({
      kind: "people",
      people: [
        { ...person(LEO, "Leo Park"), active: true },
        { ...person(PIA, "Pia Gómez"), active: false },
      ],
    });
    const html = render(modelFromView(v, ANA, null), {
      search: {
        q: "zed",
        onQuery: () => undefined,
        results: [],
        searching: false,
      },
    });
    expect(html).toContain('data-testid="people-picker"');
    expect(html).toMatch(/Ana Ruiz \(you\)[\s\S]*?Owner/);
    expect(html).toContain(`data-testid="people-remove-${LEO}"`);
    expect(html).toContain('aria-label="Remove Leo Park"');
    expect(html).toMatch(/data-testid="visibility-inactive"[\s\S]*?Pia Gómez[\s\S]*?Left Customer portal/);
    expect(html).toContain('data-testid="people-input"');
    expect(html).toContain('role="combobox"');
    expect(html).toContain('aria-label="Add people in Customer portal"');
  });

  it("says who may be picked when the search finds nobody", () => {
    const v = view({ kind: "people", people: [{ ...person(LEO, "Leo Park"), active: true }] });
    const html = render(modelFromView(v, ANA, null), {
      search: { q: "zed", onQuery: () => undefined, results: [], searching: false },
      initialSearchOpen: true,
    });
    expect(html).toContain("No one in Customer portal matches “zed”.");
  });

  it("lists matching people inline as options", () => {
    const v = view({ kind: "people", people: [{ ...person(LEO, "Leo Park"), active: true }] });
    const html = render(modelFromView(v, ANA, null), {
      search: { q: "pi", onQuery: () => undefined, results: [person(PIA, "Pia Gómez")], searching: false },
      initialSearchOpen: true,
    });
    expect(html).toContain('role="listbox"');
    expect(html).toContain(`data-testid="people-option-${PIA}"`);
  });
});

describe("who can see it (footer, D-11)", () => {
  it("counts people, shows faces and names admins", () => {
    const html = render(modelFromView(view(), ANA, null));
    expect(html).toContain('data-testid="who-can-see"');
    expect(html).toContain('data-count="12"');
    expect(html).toContain("12 people can see this");
    expect(html).toContain("Admins can always see it.");
    expect(html).toContain("See all");
  });

  it("names the device owner when someone else's device runs it", () => {
    const v = view({
      alwaysVisible: {
        admins: true,
        deviceOwner: { userId: PIA, firstName: "Pia", deviceName: "Pia's PC", isViewer: false },
      },
    });
    expect(render(modelFromView(v, ANA, null))).toContain(
      "Admins and Pia can always see it: it runs on Pia&#x27;s PC.",
    );
  });

  it("lists everyone with their reason under See all, including an owner who left (D-12)", () => {
    const v = view({
      viewers: {
        count: 51,
        people: [
          { ...person(ANA, "Ana Ruiz"), reason: "owner_left", via: null },
          { ...person(PIA, "Pia Gómez"), reason: "team", via: { id: WEB, name: "Web" } },
        ],
        more: 1,
      },
    });
    const html = render(modelFromView(v, LEO, null), { initialSeeAll: true });
    expect(html).toContain('data-testid="who-can-see-all"');
    expect(html).toContain("Owner · left Customer portal");
    expect(html).toContain("Through Web");
    expect(html).toContain("and 1 more");
  });
});

describe("draft mode (the new-session dialog, Surface 3)", () => {
  const place = {
    kind: "team" as const,
    unitId: UNIT,
    name: "Customer portal",
    defaultVisibility: "project" as const,
  };

  it("keeps the choice local and shows the preview's count, with no See all", () => {
    const model = modelFromDraft({
      value: { kind: "project" },
      place,
      teams: [{ id: WEB, name: "Web", kind: "team", memberCount: 8 }],
      preview: {
        count: 7,
        people: [person(ANA, "Ana Ruiz")],
        alwaysVisible: { admins: true, deviceOwner: null },
      },
      previewFailed: false,
      viewer: { userId: ANA, name: "Ana Ruiz" },
    });
    const html = render(model);
    expect(html).toContain('data-mode="draft"');
    expect(html).toContain("7 people can see this");
    expect(html).not.toContain("See all");
    expect(html).not.toContain("Undo");
    expect(count(html, 'type="radio"')).toBe(4);
  });

  it("shows — when the preview failed", () => {
    const model = modelFromDraft({
      value: { kind: "owner" },
      place,
      teams: [],
      preview: undefined,
      previewFailed: true,
      viewer: { userId: ANA, name: "Ana Ruiz" },
    });
    const html = render(model);
    expect(html).toContain('data-count=""');
    expect(html).toContain("—");
  });
});

it("never uses the words ACL, grant, audience, scope or visibility rule (N4)", () => {
  const html = [
    render(modelFromView(view(), ANA, null)),
    render(modelFromView(view({ viewerCan: { change: false } }), LEO, null)),
  ]
    .join(" ")
    .replace(/<[^>]*>/g, " ");
  expect(html).not.toMatch(/\b(acl|grant|grants|audience|scope|visibility rule)\b/i);
});

describe("warning an editor who would lose the session (07.9-06 broken-window 4)", () => {
  // Leo is listed as a member in the fixture view: he sees it through the project.
  it("asks someone who sees it through the project before Only the owner or people without themselves", () => {
    expect(loseAccessOnChange(view(), LEO, { kind: "owner" })).toBe(true);
    expect(loseAccessOnChange(view(), LEO, { kind: "people", userIds: [PIA] })).toBe(true);
    expect(loseAccessOnChange(view(), LEO, { kind: "people", userIds: [PIA, LEO] })).toBe(false);
    expect(loseAccessOnChange(view(), LEO, { kind: "project" })).toBe(false);
    expect(loseAccessOnChange(view(), LEO, { kind: "teams", teamIds: [WEB] })).toBe(false);
  });

  it("never asks the owner, the device owner, or someone the API does not list (an admin keeps it)", () => {
    expect(loseAccessOnChange(view(), ANA, { kind: "owner" })).toBe(false);
    const admin = "01a11635-d6e7-7c87-9f17-0000000000a9";
    expect(loseAccessOnChange(view(), admin, { kind: "owner" })).toBe(false);
    const onLeosDevice = view({
      viewers: {
        count: 2,
        people: [{ ...person(LEO, "Leo Park"), reason: "device_owner", via: null }],
        more: 0,
      },
    });
    expect(loseAccessOnChange(onLeosDevice, LEO, { kind: "owner" })).toBe(false);
  });
});
