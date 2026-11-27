import { ASSIGN_REFUSAL_TEXT, type WorkSession } from "@ocw/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SidebarFooterLinks } from "../sidebar/work-zone-sidebar";
import { filtersFrom, filtersQuery, hasFilters, NO_FILTERS, peopleModel } from "./model";
import { PeopleRow, RowMenu, rowActions } from "./people-row";
import { PEOPLE_COPY, PeopleFilterBar, PeopleViewBody } from "./people-view";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: unknown } & Record<string, unknown>) => (
    <a href={href} {...(rest as object)}>
      {children as never}
    </a>
  ),
}));

/**
 * Sessions by person (07.13.1.1-07, D-01): a pure grouping of the list the API already returned (`useWorkSessions()`,
 * the resolver's readable set). The model never adds a session and filters only by the three filters the viewer picks.
 */

const html = (node: React.ReactElement) => renderToStaticMarkup(node);
const text = (markup: string) =>
  markup
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
const noop = () => undefined;

const ANA = "01a11635-d6e7-7c87-9f17-0000000000a1";
const LUIS = "01a11635-d6e7-7c87-9f17-0000000000a2";
const PIA = "01a11635-d6e7-7c87-9f17-0000000000a3";
const GONE = "01a11635-d6e7-7c87-9f17-0000000000a4";
const P1 = "01a11635-d6e7-7c87-9f17-0000000000b1";
const P2 = "01a11635-d6e7-7c87-9f17-0000000000b2";
const D1 = "01a11635-d6e7-7c87-9f17-0000000000c1";
const D2 = "01a11635-d6e7-7c87-9f17-0000000000c2";

let n = 0;
function session(over: Partial<WorkSession> = {}): WorkSession {
  n += 1;
  const id = `01a11635-d6e7-7c87-9f17-${String(n).padStart(12, "0")}`;
  return {
    id,
    conversationId: id,
    projectId: P1,
    projectName: "web-app",
    deviceId: D1,
    deviceName: "build-server",
    deviceOnline: true,
    runtime: "claude-code",
    model: null,
    permissionMode: "default",
    worktree: false,
    branch: null,
    status: "idle",
    title: `Session ${n}`,
    titleSource: "auto",
    createdBy: ANA,
    createdByName: "Ana García",
    queuedCount: 0,
    pendingApprovals: 0,
    lastError: null,
    settings: {} as WorkSession["settings"],
    fullAccess: false,
    runningSince: null,
    diffStat: null,
    createdAt: "2026-11-27T08:00:00.000Z",
    updatedAt: "2026-11-27T09:00:00.000Z",
    deviceHostKind: "service",
    canRename: true,
    ...over,
  };
}

const ana = (over: Partial<WorkSession> = {}) =>
  session({ createdBy: ANA, createdByName: "Ana García", ...over });
const luis = (over: Partial<WorkSession> = {}) =>
  session({ createdBy: LUIS, createdByName: "Luis Pérez", ...over });
const pia = (over: Partial<WorkSession> = {}) =>
  session({ createdBy: PIA, createdByName: "Pia Lund", ...over });

const fixture = () => [
  pia({ title: "Pia old", updatedAt: "2026-11-20T09:00:00.000Z" }),
  ana({ title: "Ana a", updatedAt: "2026-11-26T09:00:00.000Z" }),
  luis({ title: "Luis a", projectId: P2, projectName: "api", deviceId: D2, deviceName: "Luis's MacBook" }),
  pia({ title: "Pia new", updatedAt: "2026-11-27T10:00:00.000Z" }),
  ana({ title: "Ana b", updatedAt: "2026-11-27T09:30:00.000Z", projectId: P2, projectName: "api" }),
  pia({
    title: "Pia mid",
    updatedAt: "2026-11-25T09:00:00.000Z",
    deviceId: D2,
    deviceName: "Luis's MacBook",
  }),
];

describe("peopleModel (D-01)", () => {
  it("groups by owner: the viewer first as You, then by name; newest activity first inside a group", () => {
    const m = peopleModel(fixture(), ANA, NO_FILTERS);
    expect(m.groups.map((g) => [g.ownerId, g.name, g.label, g.count])).toEqual([
      [ANA, "Ana García", "You", 2],
      [LUIS, "Luis Pérez", "Luis Pérez", 1],
      [PIA, "Pia Lund", "Pia Lund", 3],
    ]);
    expect(m.groups[0]?.isViewer).toBe(true);
    expect(m.groups[2]?.sessions.map((s) => s.title)).toEqual(["Pia new", "Pia mid", "Pia old"]);
    expect(m.groups[0]?.sessions.map((s) => s.title)).toEqual(["Ana b", "Ana a"]);
    expect(m.total).toBe(6);
    expect(m.shown).toBe(6);
  });

  it("names an owner who left 'a former member' and lists them after the named people", () => {
    const m = peopleModel(
      [session({ createdBy: GONE, createdByName: null }), luis(), pia()],
      ANA,
      NO_FILTERS,
    );
    expect(m.groups.map((g) => g.ownerId)).toEqual([LUIS, PIA, GONE]);
    expect(m.groups[2]?.name).toBe("a former member");
    expect(m.groups[2]?.label).toBe("A former member");
  });

  it("never adds a session: every group session is one of the listed sessions", () => {
    const list = fixture();
    const m = peopleModel(list, ANA, NO_FILTERS);
    const shown = m.groups.flatMap((g) => g.sessions);
    expect(shown).toHaveLength(list.length);
    for (const s of shown) expect(list).toContain(s);
    expect(peopleModel([], ANA, NO_FILTERS).groups).toEqual([]);
  });

  it("filters by project, device and person, combined with AND, and drops the empty groups", () => {
    const list = fixture();
    const byProject = peopleModel(list, ANA, { ...NO_FILTERS, project: P2 });
    expect(byProject.groups.map((g) => [g.ownerId, g.count])).toEqual([
      [ANA, 1],
      [LUIS, 1],
    ]);
    expect(byProject.shown).toBe(2);
    expect(byProject.total).toBe(6);

    const byDevice = peopleModel(list, ANA, { ...NO_FILTERS, device: D2 });
    expect(byDevice.groups.map((g) => [g.ownerId, g.count])).toEqual([
      [LUIS, 1],
      [PIA, 1],
    ]);

    const byPerson = peopleModel(list, ANA, { ...NO_FILTERS, person: LUIS });
    expect(byPerson.groups.map((g) => g.ownerId)).toEqual([LUIS]);

    const combined = peopleModel(list, ANA, { person: PIA, project: P1, device: D2 });
    expect(combined.groups.map((g) => g.sessions.map((s) => s.title))).toEqual([["Pia mid"]]);

    expect(peopleModel(list, ANA, { person: LUIS, project: P1, device: null }).groups).toEqual([]);
  });

  it("lists each owner, project and device once, sorted by name, the viewer as You", () => {
    const m = peopleModel(fixture(), ANA, { ...NO_FILTERS, person: LUIS });
    expect(m.options.people).toEqual([
      { id: ANA, label: "You" },
      { id: LUIS, label: "Luis Pérez" },
      { id: PIA, label: "Pia Lund" },
    ]);
    expect(m.options.projects).toEqual([
      { id: P2, label: "api" },
      { id: P1, label: "web-app" },
    ]);
    expect(m.options.devices).toEqual([
      { id: D1, label: "build-server" },
      { id: D2, label: "Luis's MacBook" },
    ]);
  });

  it("tells two repositories with the same name apart by their device", () => {
    const m = peopleModel(
      [ana(), ana({ projectId: P2, projectName: "web-app", deviceId: D2, deviceName: "Ana's MacBook" })],
      ANA,
      NO_FILTERS,
    );
    expect(m.options.projects.map((o) => o.label)).toEqual([
      "web-app · Ana's MacBook",
      "web-app · build-server",
    ]);
  });
});

describe("the URL filters (?person=&project=&device=)", () => {
  it("reads the three keys, blank or missing = no filter", () => {
    const params = new URLSearchParams(`person=${LUIS}&project=&device=${D2}&other=x`);
    expect(filtersFrom(params)).toEqual({ person: LUIS, project: null, device: D2 });
    expect(filtersFrom(new URLSearchParams())).toEqual(NO_FILTERS);
  });

  it("writes only the filters that are set, in a fixed order", () => {
    expect(filtersQuery(NO_FILTERS)).toBe("");
    expect(filtersQuery({ person: null, project: P1, device: D1 })).toBe(`?project=${P1}&device=${D1}`);
    expect(filtersQuery({ person: LUIS, project: null, device: null })).toBe(`?person=${LUIS}`);
    expect(hasFilters(NO_FILTERS)).toBe(false);
    expect(hasFilters({ ...NO_FILTERS, device: D1 })).toBe(true);
  });
});

const body = (
  list: WorkSession[] | undefined,
  filters = NO_FILTERS,
  avatars: ReadonlyMap<string, string | null> = new Map(),
) =>
  html(
    <PeopleViewBody
      model={list ? peopleModel(list, ANA, filters) : undefined}
      viewerId={ANA}
      avatars={avatars}
      filters={filters}
      onFilters={noop}
    />,
  );

describe("PeopleViewBody (D-01)", () => {
  it("renders one group per owner with the avatar, the name and the count", () => {
    const markup = body(fixture());
    const t = text(markup);
    expect(t).toContain("You · 2 sessions");
    expect(t).toContain("Luis Pérez · 1 session");
    expect(t).toContain("Pia Lund · 3 sessions");
    expect(markup.match(/data-testid="people-group"/g)).toHaveLength(3);
    expect(markup.match(/data-testid="people-group-avatar"/g)).toHaveLength(3);
    expect(t.indexOf("You ·")).toBeLessThan(t.indexOf("Luis Pérez ·"));
  });

  it("each row links to its session with the project, the device and the last activity", () => {
    const s = luis({ title: "Fix the login page", projectName: "web-app", deviceName: "build-server" });
    const markup = body([s]);
    expect(markup).toContain(`href="/work-zone/${s.id}"`);
    const t = text(markup);
    expect(t).toContain("Fix the login page");
    expect(t).toContain("web-app");
    expect(t).toContain("build-server");
    expect(markup).toContain('data-testid="people-row-time"');
  });

  it("marks only rows on a server with Server", () => {
    const markup = body([
      luis({ deviceHostKind: "service" }),
      luis({ deviceHostKind: "desktop" }),
      luis({ deviceHostKind: null }),
      luis({ deviceHostKind: undefined }),
    ]);
    expect(markup.match(/data-testid="server-marker"/g)).toHaveLength(1);
    expect(text(markup)).toContain(PEOPLE_COPY.server);
  });

  it("says when the viewer can see no session yet", () => {
    const t = text(body([]));
    expect(t).toContain("No sessions you can see yet.");
    expect(t).not.toContain(PEOPLE_COPY.clear);
  });

  it("says when nothing matches the filters, with Clear filters", () => {
    const markup = body(fixture(), { person: LUIS, project: P1, device: null });
    const t = text(markup);
    expect(t).toContain("No sessions match these filters.");
    expect(markup).toContain('data-testid="people-clear-empty"');
    expect(t).toContain("Clear filters");
  });

  it("shows skeleton rows while the list loads", () => {
    const markup = body(undefined);
    expect(markup).toContain('data-testid="people-loading"');
    expect(markup).not.toContain('data-testid="people-group"');
  });

  it("renders names and titles as text, never as markup", () => {
    const t = text(body([luis({ createdByName: "<img src=x onerror=alert(1)>", title: "<b>x</b>" })]));
    expect(t).toContain("&lt;img");
    const markup = body([luis({ createdByName: "<img src=x>", title: "<b>x</b>" })]);
    expect(markup).not.toContain("<img src=x>");
    expect(markup).not.toContain("<b>x</b>");
  });
});

const BOT = { agentId: "01a11635-d6e7-7c87-9f17-0000000000f1", displayName: "Scout", handle: "scout" };

describe("rowActions (D-04, D-06): a hint from viewer-neutral fields; the dialogs show the API's decision", () => {
  it("offers Assign to me on someone else's session on a server", () => {
    expect(rowActions(pia({ deviceHostKind: "service" }), ANA)).toEqual({
      actions: ["open", "rename", "assign"],
      reason: null,
    });
  });

  it("explains why not on a desktop or an unreported host", () => {
    for (const deviceHostKind of ["desktop", null, undefined] as const) {
      expect(rowActions(pia({ deviceHostKind }), ANA)).toEqual({
        actions: ["open", "rename"],
        reason: "Only sessions on a server can be assigned.",
      });
    }
    expect(ASSIGN_REFUSAL_TEXT.not_on_server).toBe("Only sessions on a server can be assigned.");
  });

  it("explains why not on a bot-started session (the sponsor keeps it)", () => {
    for (const deviceHostKind of ["service", "desktop"] as const) {
      expect(rowActions(pia({ deviceHostKind, startedByAgent: BOT }), ANA)).toEqual({
        actions: ["open", "rename"],
        reason: "A bot started this session; it stays with the bot's sponsor.",
      });
    }
  });

  it("gives the viewer's own session neither the item nor a reason, bot-started or not", () => {
    expect(rowActions(ana({ deviceHostKind: "service" }), ANA)).toEqual({
      actions: ["open", "rename"],
      reason: null,
    });
    expect(rowActions(ana({ deviceHostKind: "desktop" }), ANA)).toEqual({
      actions: ["open", "rename"],
      reason: null,
    });
    expect(rowActions(ana({ startedByAgent: BOT }), ANA)).toEqual({
      actions: ["open", "rename"],
      reason: null,
    });
  });

  it("offers Rename only to a viewer the API says may rename (WR-03); Assign still follows the row's fields", () => {
    for (const canRename of [false, undefined] as const) {
      expect(rowActions(pia({ deviceHostKind: "service", canRename }), ANA)).toEqual({
        actions: ["open", "assign"],
        reason: null,
      });
      expect(rowActions(ana({ canRename }), ANA)).toEqual({ actions: ["open"], reason: null });
      expect(rowActions(pia({ deviceHostKind: "desktop", canRename }), ANA)).toEqual({
        actions: ["open"],
        reason: "Only sessions on a server can be assigned.",
      });
    }
  });

  it("an archived session only opens", () => {
    expect(rowActions(pia({ status: "archived" }), ANA)).toEqual({ actions: ["open"], reason: null });
    expect(rowActions(ana({ status: "archived" }), ANA)).toEqual({ actions: ["open"], reason: null });
  });

  it("compares the session's owner, never the device's: Pia's session on Ana's own server is Ana's to take", () => {
    // The DTO carries no device owner; Ana owning the server changes nothing for the hint (the API decides device.use).
    const onAnasServer = pia({ deviceHostKind: "service", deviceId: D1, deviceName: "Ana's server" });
    expect(rowActions(onAnasServer, ANA).actions).toContain("assign");
    const anasOwn = ana({ deviceHostKind: "service", deviceId: D1, deviceName: "Ana's server" });
    expect(rowActions(anasOwn, ANA)).toEqual({ actions: ["open", "rename"], reason: null });
  });
});

describe("PeopleRow and its menu (D-01, D-04, D-06)", () => {
  it("puts the 44 px menu button outside the session link, named after the session", () => {
    const s = pia({ title: "Fix the login page" });
    const markup = html(
      <PeopleRow session={s} viewerId={ANA} actions={<RowMenu session={s} viewerId={ANA} />} />,
    );
    const link = markup.match(/<a [^>]*href="\/work-zone\/[^"]+"[^>]*>[\s\S]*?<\/a>/)?.[0] ?? "";
    expect(link).not.toBe("");
    expect(link).not.toContain("Session actions");
    const button =
      markup.match(/<button[^>]*aria-label="Session actions for Fix the login page"[^>]*>/)?.[0] ?? "";
    expect(button).not.toBe("");
    expect(button).toContain("size-9");
    expect(button).toContain("max-md:size-11");
    expect(markup.indexOf("</a>")).toBeLessThan(markup.indexOf("Session actions for"));
  });
});

describe("PeopleFilterBar (D-01)", () => {
  const bar = (filters = NO_FILTERS) =>
    html(<PeopleFilterBar model={peopleModel(fixture(), ANA, filters)} filters={filters} onFilters={noop} />);

  it("renders three labelled selects, 44 px on touch screens, Person full width on a phone", () => {
    const markup = bar();
    for (const label of ["Person", "Project", "Device"]) {
      const trigger = markup.match(new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`))?.[0] ?? "";
      expect(trigger, label).not.toBe("");
      expect(trigger, label).toContain("max-md:h-11");
    }
    expect(markup).toContain("grid-cols-2");
    expect(markup).toContain("col-span-2 sm:w-52");
    expect(markup).toContain("sm:flex");
    expect(text(markup)).toContain("Everyone");
    expect(text(markup)).toContain("All projects");
    expect(text(markup)).toContain("All devices");
  });

  it("shows Clear filters only when a filter is set, and the count either way", () => {
    expect(bar()).not.toContain('data-testid="people-clear"');
    expect(text(bar())).toContain("6 sessions");
    const filtered = bar({ ...NO_FILTERS, project: P2 });
    expect(filtered).toContain('data-testid="people-clear"');
    expect(text(filtered)).toContain("2 of 6 sessions");
  });

  it("names a filter from an old link that no listed session has, never its raw id", () => {
    const stale = "01a11635-d6e7-7c87-9f17-0000000000ff";
    const markup = bar({ ...NO_FILTERS, device: stale });
    expect(text(markup)).toContain(PEOPLE_COPY.notListed);
    expect(text(markup)).not.toContain(stale);
  });
});

describe("the sidebar footer (D-01, Pitfall 9)", () => {
  it("links Sessions by person between Browse projects and Devices, 44 px on phones", () => {
    const markup = html(<SidebarFooterLinks pathname="/work-zone" />);
    const t = text(markup);
    expect(t.indexOf("Browse projects")).toBeLessThan(t.indexOf("Sessions by person"));
    expect(t.indexOf("Sessions by person")).toBeLessThan(t.indexOf("Devices"));
    const link = markup.match(/<a [^>]*data-testid="sidebar-people"[^>]*>/)?.[0] ?? "";
    expect(link).toContain('href="/work-zone/people"');
    expect(link).toContain("max-md:h-11");
    expect(link).not.toContain("aria-current");
  });

  it("marks the link current on the people view", () => {
    const link = html(<SidebarFooterLinks pathname="/work-zone/people" />).match(
      /<a [^>]*data-testid="sidebar-people"[^>]*>/,
    )?.[0];
    expect(link).toContain('aria-current="page"');
  });
});
