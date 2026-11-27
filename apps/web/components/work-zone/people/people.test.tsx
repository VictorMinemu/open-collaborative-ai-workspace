import type { WorkSession } from "@ocw/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { filtersFrom, filtersQuery, hasFilters, NO_FILTERS, peopleModel } from "./model";
import { PEOPLE_COPY, PeopleViewBody } from "./people-view";

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
