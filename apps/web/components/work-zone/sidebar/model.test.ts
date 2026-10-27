import type { WorkProjectIndex, WorkProjectSummary, WorkSession } from "@ocw/contracts";
import { describe, expect, it } from "vitest";
import * as legacy from "../session-sidebar";
import {
  buildWorkZoneSidebar,
  elapsedLabel,
  isActiveSession,
  liveCount,
  NEEDS_YOU_CAP,
  needsViewer,
  orderActiveSessions,
  PERSONAL_REPO_CAP,
  projectInitials,
  rowProject,
  rowStatusText,
  SECTION_PROJECT_CAP,
  type SidebarInput,
  SUB_ROW_CAP,
  shortAgo,
} from "./model";
import { collapsedKeys, parseCollapseMap, SIDEBAR_STORAGE_KEY, toggledMap } from "./use-sidebar-collapse";

/**
 * The Work Zone sidebar model (07.10-03, UI-SPEC § 4-§ 7, PD-07): a pure grouping of what `/work-sessions` and
 * `/work-projects` returned. It never decides access; it only places rows.
 */

const NOW = Date.parse("2026-10-27T12:00:00Z");
const VIEWER = "01a11635-d6e7-7c87-9f17-0000000000a1";
const OTHER = "01a11635-d6e7-7c87-9f17-0000000000a2";

const ENG = { id: "01a11635-d6e7-7c87-9f17-0000000000e1", name: "Engineering", kind: "department" } as const;
const OPS = { id: "01a11635-d6e7-7c87-9f17-0000000000e2", name: "Operations", kind: "department" } as const;
const ADS = { id: "01a11635-d6e7-7c87-9f17-0000000000e3", name: "Ads", kind: "department" } as const;
const WEB = { id: "01a11635-d6e7-7c87-9f17-0000000000f1", name: "Web", kind: "team" } as const;

type Unit = { id: string; name: string; kind: "team" | "department" };

let n = 0;
const uid = (prefix: string) => {
  n += 1;
  return `01a11635-d6e7-7c87-9f17-${prefix}${String(n).padStart(10, "0")}`;
};

function project(
  name: string,
  over: Partial<Omit<WorkProjectSummary, "top">> & { top?: Unit; viewerIsMember?: boolean } = {},
): WorkProjectSummary {
  const { top = ENG, viewerIsMember = true, ...rest } = over;
  return {
    id: uid("d1"),
    name,
    trail: [top.name],
    peopleCount: 2,
    repoCount: 1,
    parent: top,
    membership: "member",
    ...rest,
    top: { ...top, viewerIsMember },
  };
}

function session(over: Partial<WorkSession> = {}): WorkSession {
  const id = uid("c1");
  return {
    id,
    conversationId: id,
    projectId: "01a11635-d6e7-7c87-9f17-0000000000b1",
    projectName: "web-app",
    deviceId: "01a11635-d6e7-7c87-9f17-0000000000c1",
    deviceName: "Ana's MacBook",
    deviceOnline: true,
    runtime: "claude-code",
    model: null,
    permissionMode: "default",
    worktree: false,
    branch: "main",
    status: "idle",
    title: "A session",
    titleSource: "user",
    createdBy: OTHER,
    createdByName: "Leo Park",
    queuedCount: 0,
    pendingApprovals: 0,
    lastError: null,
    settings: {} as WorkSession["settings"],
    fullAccess: false,
    runningSince: null,
    diffStat: null,
    createdAt: "2026-10-27T10:00:00Z",
    updatedAt: "2026-10-27T11:00:00Z",
    teamProject: null,
    ...over,
  };
}

const at = (p: WorkProjectSummary) => ({ id: p.id, name: p.name });

function index(teamProjects: WorkProjectSummary[], over: Partial<WorkProjectIndex> = {}): WorkProjectIndex {
  return { teamProjects, personalRepos: [], viewerCan: { create: false }, ...over };
}

function build(over: Partial<SidebarInput>) {
  return buildWorkZoneSidebar({
    sessions: [],
    index: index([]),
    viewerId: VIEWER,
    now: NOW,
    openSessionId: null,
    openProjectId: null,
    collapsed: new Set(),
    expanded: new Set(),
    ...over,
  });
}

describe("department sections (D-01, D-02, UI-SPEC § 4)", () => {
  it("groups the viewer's member, team and lead projects under their top unit; manager projects are never rows", () => {
    const portal = project("Customer portal", { parent: WEB });
    const billing = project("Billing", { top: OPS, membership: "team" });
    const led = project("Design system", { membership: "lead" });
    const managed = project("Payroll", { membership: "manager" });
    const onlyManaged = project("Ledger", { top: ADS, membership: "manager" });
    const model = build({ index: index([managed, portal, billing, led, onlyManaged]) });
    expect(model.sections.map((s) => [s.key, s.title])).toEqual([
      [ENG.id, "Engineering"],
      [OPS.id, "Operations"],
    ]);
    expect(model.sections[0]?.projects.map((p) => p.name)).toEqual(["Customer portal", "Design system"]);
    expect(model.sections[1]?.projects.map((p) => p.name)).toEqual(["Billing"]);
    const names = model.sections.flatMap((s) => s.projects.map((p) => p.name));
    expect(names).not.toContain("Payroll");
    expect(names).not.toContain("Ledger");
  });

  it("puts the viewer's own departments first, then the rest, each alphabetically (numeric, accent-blind)", () => {
    const ops9: Unit = { id: uid("e9"), name: "Ops 9", kind: "department" };
    const ops10: Unit = { id: uid("e9"), name: "Ops 10", kind: "department" };
    const eclair: Unit = { id: uid("e9"), name: "Éclair", kind: "department" };
    const model = build({
      index: index([
        project("a", { top: ops10, viewerIsMember: false }),
        project("b", { top: ops9, viewerIsMember: false }),
        project("c", { top: OPS }),
        project("d", { top: eclair }),
        project("e", { top: ADS, viewerIsMember: false }),
      ]),
    });
    expect(model.sections.map((s) => s.title)).toEqual(["Éclair", "Operations", "Ads", "Ops 9", "Ops 10"]);
    expect(model.sections.map((s) => s.viewerIsMember)).toEqual([true, true, false, false, false]);
  });

  it("orders projects alphabetically and gives a team pill only to a project below its department", () => {
    const model = build({
      index: index([
        project("zeta"),
        project("Customer portal", { parent: WEB }),
        project("alpha"),
        project("Beta 10"),
        project("Beta 9"),
      ]),
    });
    const rows = model.sections[0]?.projects ?? [];
    expect(rows.map((p) => p.name)).toEqual(["alpha", "Beta 9", "Beta 10", "Customer portal", "zeta"]);
    expect(rows.map((p) => p.pill)).toEqual([null, null, null, "Web", null]);
  });

  it("marks the open project (any tab)", () => {
    const portal = project("Customer portal");
    const other = project("Other");
    const model = build({ index: index([portal, other]), openProjectId: portal.id });
    expect(model.sections[0]?.projects.map((p) => [p.name, p.active])).toEqual([
      ["Customer portal", true],
      ["Other", false],
    ]);
  });

  it("has no section before the projects index arrives", () => {
    expect(build({ index: null }).sections).toEqual([]);
  });
});

describe("sessions under a project (D-04, UI-SPEC § 6)", () => {
  const portal = project("Customer portal");
  const ref = at(portal);

  it("lists only active sessions, approval first, then live, then most recent, at most 3, then the rest as more", () => {
    const idleNew = session({ teamProject: ref, title: "idle new", updatedAt: "2026-10-27T11:59:00Z" });
    const idleOld = session({ teamProject: ref, title: "idle old", updatedAt: "2026-10-27T09:00:00Z" });
    const running = session({ teamProject: ref, title: "running", status: "running" });
    const approval = session({ teamProject: ref, title: "approval", pendingApprovals: 1 });
    const settled = session({ teamProject: ref, title: "done", status: "completed" });
    const model = build({ index: index([portal]), sessions: [idleOld, settled, idleNew, running, approval] });
    const row = model.sections[0]?.projects[0];
    expect(SUB_ROW_CAP).toBe(3);
    expect(row?.sessions.map((s) => s.title)).toEqual(["approval", "running", "idle new"]);
    expect(row?.more).toBe(1);
  });

  it("a project with no active session is one line: no sub-rows, no more, no live count", () => {
    const model = build({
      index: index([portal]),
      sessions: [session({ teamProject: ref, status: "completed" })],
    });
    expect(model.sections[0]?.projects[0]).toMatchObject({ sessions: [], more: 0, live: 0 });
  });

  it("always shows the open session, even settled or beyond the cap, as an extra row", () => {
    const four = [1, 2, 3, 4].map((i) =>
      session({ teamProject: ref, title: `s${i}`, updatedAt: `2026-10-27T11:0${i}:00Z` }),
    );
    const beyond = four[0] as WorkSession;
    let row = build({ index: index([portal]), sessions: four, openSessionId: beyond.id }).sections[0]
      ?.projects[0];
    expect(row?.sessions.map((s) => s.title)).toEqual(["s4", "s3", "s2", "s1"]);
    expect(row?.more).toBe(0);
    const settled = session({ teamProject: ref, title: "settled", status: "failed" });
    row = build({ index: index([portal]), sessions: [...four, settled], openSessionId: settled.id })
      .sections[0]?.projects[0];
    expect(row?.sessions.map((s) => s.title)).toEqual(["s4", "s3", "s2", "settled"]);
    expect(row?.more).toBe(1);
  });

  it("counts live sessions (provisioning, running, waiting approval) for the project's live count", () => {
    const sessions = [
      session({ teamProject: ref, status: "provisioning" }),
      session({ teamProject: ref, status: "running" }),
      session({ teamProject: ref, status: "waiting_approval" }),
      session({ teamProject: ref, status: "host_offline" }),
      session({ teamProject: ref, status: "idle", queuedCount: 2 }),
    ];
    expect(liveCount(sessions)).toBe(3);
    expect(build({ index: index([portal]), sessions }).sections[0]?.projects[0]?.live).toBe(3);
  });

  it("places a session under its member project and lists it in the scope; a manager project's session is not", () => {
    const managed = project("Payroll", { membership: "manager" });
    const mine = session({ teamProject: ref });
    const admins = session({ teamProject: at(managed) });
    const model = build({ index: index([portal, managed]), sessions: [mine, admins] });
    expect(model.scope.has(mine.id)).toBe(true);
    expect(model.scope.has(admins.id)).toBe(false);
    expect(model.sections.flatMap((s) => s.projects.flatMap((p) => p.sessions.map((x) => x.id)))).toEqual([
      mine.id,
    ]);
  });
});

describe("row status text (the old RowStatus texts and tones)", () => {
  it("words each state as the old row did", () => {
    expect(rowStatusText(session({ status: "waiting_approval" }), NOW)).toEqual({
      tone: "warning",
      text: "Needs approval",
    });
    expect(rowStatusText(session({ pendingApprovals: 2 }), NOW)).toEqual({
      tone: "warning",
      text: "Needs approval",
    });
    expect(rowStatusText(session({ status: "running", runningSince: "2026-10-27T11:59:48Z" }), NOW)).toEqual({
      tone: "primary",
      text: "Working 12s",
    });
    expect(rowStatusText(session({ status: "running" }), NOW)).toEqual({ tone: "primary", text: "Working" });
    expect(rowStatusText(session({ status: "provisioning" }), NOW)).toEqual({
      tone: "muted",
      text: "Starting",
    });
    expect(rowStatusText(session({ status: "host_offline" }), NOW)).toEqual({
      tone: "muted",
      text: "Offline",
    });
    expect(rowStatusText(session({ queuedCount: 2 }), NOW)).toEqual({ tone: "muted", text: "2 queued" });
    expect(rowStatusText(session({ updatedAt: "2026-10-27T09:00:00Z" }), NOW)).toEqual({
      tone: "muted",
      text: "3h",
    });
  });
});

describe("moved helpers", () => {
  it("stay importable from session-sidebar with the same behaviour", () => {
    expect(legacy.isActiveSession).toBe(isActiveSession);
    expect(legacy.projectInitials).toBe(projectInitials);
    expect(legacy.shortAgo).toBe(shortAgo);
    expect(legacy.elapsedLabel).toBe(elapsedLabel);
    expect(legacy.rowProject).toBe(rowProject);
    expect(legacy.orderActiveSessions).toBe(orderActiveSessions);
    expect(projectInitials("Customer portal")).toBe("CP");
    expect(shortAgo("2026-10-27T11:58:00Z", NOW)).toBe("2m");
    expect(elapsedLabel("2026-10-27T10:55:00Z", NOW)).toBe("1h 5m");
    expect(isActiveSession(session({ status: "idle", updatedAt: "2026-10-25T11:00:00Z" }), NOW)).toBe(false);
  });
});

// ---------------------------------------------------------------- 07.10-03 Task 2: Personal, collapse, caps

const REPO_A = "01a11635-d6e7-7c87-9f17-0000000000b1";
const REPO_B = "01a11635-d6e7-7c87-9f17-0000000000b2";
const REPO_C = "01a11635-d6e7-7c87-9f17-0000000000b3";
const DEVICE = "01a11635-d6e7-7c87-9f17-0000000000c1";
const personalRepo = (projectId: string, name: string) => ({
  projectId,
  name,
  deviceId: DEVICE,
  deviceName: "Pia's Mac",
  deviceOnline: true,
});

describe("Personal (D-06, UI-SPEC § 7, PD-07 (b))", () => {
  it("is null when the viewer has no unlinked repository and no session under one", () => {
    expect(build({}).personal).toBeNull();
  });

  it("lists the index's personal repositories with their active sessions; active ones first, then by name", () => {
    const scratch = session({ projectId: REPO_B, projectName: "scratch", title: "on scratch" });
    const model = build({
      index: index([], {
        personalRepos: [
          personalRepo(REPO_A, "zeta-tools"),
          personalRepo(REPO_B, "scratch"),
          personalRepo(REPO_C, "alpha"),
        ],
      }),
      sessions: [scratch],
    });
    expect(model.personal?.repos.map((r) => [r.name, r.sessions.map((s) => s.title)])).toEqual([
      ["scratch", ["on scratch"]],
      ["alpha", []],
      ["zeta-tools", []],
    ]);
    expect(model.scope.has(scratch.id)).toBe(true);
    expect(model.personal?.repos[0]).toMatchObject({ hiddenProject: false, live: 0 });
  });

  it("orders repositories with an active session by their latest activity", () => {
    const older = session({ projectId: REPO_A, projectName: "older", updatedAt: "2026-10-27T10:00:00Z" });
    const newer = session({ projectId: REPO_B, projectName: "newer", updatedAt: "2026-10-27T11:30:00Z" });
    const model = build({
      index: index([], { personalRepos: [personalRepo(REPO_A, "older"), personalRepo(REPO_B, "newer")] }),
      sessions: [older, newer],
    });
    expect(model.personal?.repos.map((r) => r.name)).toEqual(["newer", "older"]);
  });

  it("puts a hidden-project session under its repository, flagged, and never names the project", () => {
    const hidden = session({
      projectId: REPO_A,
      projectName: "payroll-api",
      teamProject: null,
      teamProjectHidden: true,
      status: "running",
    });
    const model = build({ index: index([]), sessions: [hidden] });
    expect(model.personal?.repos).toHaveLength(1);
    expect(model.personal?.repos[0]).toMatchObject({
      projectId: REPO_A,
      name: "payroll-api",
      hiddenProject: true,
      live: 1,
    });
    expect(model.personal?.repos[0]?.sessions.map((s) => s.id)).toEqual([hidden.id]);
    expect(model.scope.has(hidden.id)).toBe(true);
  });

  it("a session the viewer created in a project they left lands under its repository, without the hint (X1)", () => {
    const left = project("Left project", { membership: "manager" });
    const mine = session({
      projectId: REPO_A,
      projectName: "web-app",
      teamProject: at(left),
      createdBy: VIEWER,
    });
    const model = build({ index: index([left]), sessions: [mine] });
    expect(model.sections).toEqual([]);
    expect(model.personal?.repos[0]).toMatchObject({
      projectId: REPO_A,
      name: "web-app",
      hiddenProject: false,
    });
    expect(model.scope.has(mine.id)).toBe(true);
  });

  it("an admin-only session (named, not the viewer's project, not theirs, repository not personal) is nowhere", () => {
    const managed = project("Payroll", { membership: "manager" });
    const theirs = session({ projectId: REPO_A, teamProject: at(managed), createdBy: OTHER });
    const elsewhere = session({ projectId: REPO_B, teamProject: null, createdBy: OTHER });
    const model = build({ index: index([managed]), sessions: [theirs, elsewhere] });
    expect(model.sections).toEqual([]);
    expect(model.personal).toBeNull();
    expect(model.scope.size).toBe(0);
  });

  it("someone else's session on a repository personal to the viewer (a shared device) is under that repository", () => {
    const shared = session({ projectId: REPO_A, projectName: "scratch", createdBy: OTHER });
    const model = build({
      index: index([], { personalRepos: [personalRepo(REPO_A, "scratch")] }),
      sessions: [shared],
    });
    expect(model.personal?.repos[0]?.sessions.map((s) => s.id)).toEqual([shared.id]);
  });

  it("shows 3 sessions per repository, then +N more that expands inline", () => {
    const five = [1, 2, 3, 4, 5].map((i) =>
      session({
        projectId: REPO_A,
        projectName: "scratch",
        createdBy: VIEWER,
        updatedAt: `2026-10-27T11:0${i}:00Z`,
      }),
    );
    let repo = build({ index: index([]), sessions: five }).personal?.repos[0];
    expect(repo).toMatchObject({ more: 2, expanded: false });
    expect(repo?.sessions).toHaveLength(SUB_ROW_CAP);
    repo = build({ index: index([]), sessions: five, expanded: new Set([`repo:${REPO_A}`]) }).personal
      ?.repos[0];
    expect(repo).toMatchObject({ more: 0, expanded: true });
    expect(repo?.sessions).toHaveLength(5);
  });

  it("shows 5 repositories, then {n} more that expands inline; the open session's repository always shows", () => {
    expect(PERSONAL_REPO_CAP).toBe(5);
    const repos = Array.from({ length: 8 }, (_, i) =>
      personalRepo(`01a11635-d6e7-7c87-9f17-0000000001${String(i).padStart(2, "0")}`, `repo ${i + 1}`),
    );
    const last = repos[7] as (typeof repos)[number];
    const settled = session({ projectId: last.projectId, projectName: last.name, status: "completed" });
    let personal = build({ index: index([], { personalRepos: repos }) }).personal;
    expect(personal?.repos.map((r) => r.name)).toEqual(["repo 1", "repo 2", "repo 3", "repo 4", "repo 5"]);
    expect(personal).toMatchObject({ moreRepos: 3, expanded: false });
    personal = build({
      index: index([], { personalRepos: repos }),
      sessions: [settled],
      openSessionId: settled.id,
    }).personal;
    // The cap counts the kept repository: 4 by name, then the open one.
    expect(personal?.repos.map((r) => r.name)).toEqual(["repo 1", "repo 2", "repo 3", "repo 4", "repo 8"]);
    expect(personal?.repos.at(-1)?.sessions.map((s) => s.id)).toEqual([settled.id]);
    expect(personal?.moreRepos).toBe(3);
    personal = build({
      index: index([], { personalRepos: repos }),
      expanded: new Set(["personal"]),
    }).personal;
    expect(personal?.repos).toHaveLength(8);
    expect(personal).toMatchObject({ moreRepos: 0, expanded: true });
  });

  it("collapsed, keeps only the repository of the open session (and needs), and counts the rest", () => {
    const open = session({ projectId: REPO_A, projectName: "scratch", createdBy: VIEWER });
    const other = session({ projectId: REPO_A, projectName: "scratch", createdBy: VIEWER });
    const model = build({
      index: index([], { personalRepos: [personalRepo(REPO_A, "scratch"), personalRepo(REPO_B, "tools")] }),
      sessions: [open, other],
      openSessionId: open.id,
      collapsed: new Set(["personal"]),
    });
    expect(model.personal).toMatchObject({ collapsed: true, hidden: 1, moreRepos: 0 });
    expect(model.personal?.repos.map((r) => [r.name, r.sessions.map((s) => s.id), r.more])).toEqual([
      ["scratch", [open.id], 0],
    ]);
  });
});

describe("collapsed department sections (D-01, UI-SPEC § 4)", () => {
  it("keep the open project, the project of the open session and those with a session that needs the viewer", () => {
    const a = project("A");
    const b = project("B");
    const c = project("C");
    const d = project("D");
    const openSession = session({ teamProject: at(b), status: "completed" });
    const bOther = session({ teamProject: at(b) });
    const needed = session({ teamProject: at(c), pendingApprovals: 1 });
    const cOther = session({ teamProject: at(c), status: "running" });
    const model = build({
      index: index([a, b, c, d]),
      sessions: [openSession, bOther, needed, cOther, session({ teamProject: at(d) })],
      openSessionId: openSession.id,
      openProjectId: a.id,
      collapsed: new Set([ENG.id]),
      needs: new Set([needed.id]),
    });
    const section = model.sections[0];
    expect(section).toMatchObject({ collapsed: true, hidden: 1, moreProjects: 0 });
    expect(section?.projects.map((p) => [p.name, p.sessions.map((s) => s.id), p.more])).toEqual([
      ["A", [], 0],
      ["B", [openSession.id], 0],
      ["C", [needed.id], 0],
    ]);
    // The live count still reads every live session of the project.
    expect(section?.projects[2]?.live).toBe(1);
  });

  it("with nothing to keep, show no project and count them all", () => {
    const model = build({ index: index([project("A"), project("B")]), collapsed: new Set([ENG.id]) });
    expect(model.sections[0]).toMatchObject({ collapsed: true, hidden: 2, projects: [] });
  });
});

describe("the project cap of a section (D-09, UI-SPEC § 4)", () => {
  const names = Array.from({ length: 20 }, (_, i) => `P${String(i + 1).padStart(2, "0")}`);

  it("over 15: every active project, the open one, then alphabetical fill to 15, in name order; then {n} more", () => {
    expect(SECTION_PROJECT_CAP).toBe(15);
    const projects = names.map((name) => project(name));
    const p19 = projects[18] as WorkProjectSummary;
    const p20 = projects[19] as WorkProjectSummary;
    const p17 = projects[16] as WorkProjectSummary;
    const model = build({
      index: index(projects),
      sessions: [session({ teamProject: at(p19) }), session({ teamProject: at(p20), status: "running" })],
      openProjectId: p17.id,
    });
    const section = model.sections[0];
    expect(section?.projects.map((p) => p.name)).toEqual([...names.slice(0, 12), "P17", "P19", "P20"]);
    expect(section).toMatchObject({ moreProjects: 5, expanded: false, collapsed: false, hidden: 0 });
  });

  it("expanded inline, shows all of them", () => {
    const projects = names.map((name) => project(name));
    const section = build({ index: index(projects), expanded: new Set([`section:${ENG.id}`]) }).sections[0];
    expect(section?.projects).toHaveLength(20);
    expect(section).toMatchObject({ moreProjects: 0, expanded: true });
  });

  it("at 15 or fewer, shows every project with no more row", () => {
    const projects = names.slice(0, 15).map((name) => project(name));
    expect(build({ index: index(projects) }).sections[0]).toMatchObject({ moreProjects: 0, expanded: false });
  });
});

describe("collapse state (useSidebarCollapse, UI-SPEC § 2)", () => {
  it("lives in one versioned localStorage key", () => {
    expect(SIDEBAR_STORAGE_KEY).toBe("ocw.workzone.sidebar.v1");
  });

  it("reads a map of booleans; corrupt or foreign values mean defaults", () => {
    expect(parseCollapseMap(null)).toEqual({});
    expect(parseCollapseMap("{not json")).toEqual({});
    expect(parseCollapseMap("[1,2]")).toEqual({});
    expect(parseCollapseMap('"x"')).toEqual({});
    expect(parseCollapseMap('{"a":true,"b":false,"c":"yes","d":1}')).toEqual({ a: true, b: false });
  });

  it("defaults every section to expanded except Settled", () => {
    expect([...collapsedKeys({})]).toEqual(["settled"]);
    expect([...collapsedKeys({ settled: false, [ENG.id]: true, [OPS.id]: false })]).toEqual([ENG.id]);
  });

  it("a toggle flips the effective state of one key", () => {
    expect(toggledMap({}, ENG.id)).toEqual({ [ENG.id]: true });
    expect(toggledMap({ [ENG.id]: true }, ENG.id)).toEqual({ [ENG.id]: false });
    expect(toggledMap({}, "settled")).toEqual({ settled: false });
  });
});

describe("Needs you (D-05, UI-SPEC § 3, PD-05, PD-07)", () => {
  const portal = project("Customer portal", { parent: WEB });
  const ref = at(portal);
  const attention = (approval: boolean, lastTurnEndedAt: string | null = null) => ({
    approval,
    lastTurnEndedAt,
  });
  const approval = (over: Partial<WorkSession> = {}) =>
    session({ status: "waiting_approval", pendingApprovals: 1, attention: attention(true), ...over });

  describe("needsViewer", () => {
    it("is an approval when the API says the viewer may decide a pending one, even while it is open", () => {
      const s = approval();
      expect(needsViewer(s, {}, NOW, null)).toBe("approval");
      expect(needsViewer(s, {}, NOW, s.id)).toBe("approval");
    });

    it("is nothing without attention (a ws: snapshot) or when the viewer can't decide", () => {
      expect(
        needsViewer(session({ status: "waiting_approval", pendingApprovals: 1 }), {}, NOW, null),
      ).toBeNull();
      expect(needsViewer(approval({ attention: attention(false) }), {}, NOW, null)).toBeNull();
    });

    it("is the viewer's turn when their last turn ended within 24 h, unseen, idle with an empty queue, not open", () => {
      const ended = "2026-10-27T11:30:00Z";
      const s = session({ status: "idle", attention: attention(false, ended) });
      expect(needsViewer(s, {}, NOW, null)).toBe("turn");
      expect(needsViewer(s, { [s.id]: "2026-10-27T11:00:00Z" }, NOW, null)).toBe("turn");
      // Seen at or after the turn ended: nothing.
      expect(needsViewer(s, { [s.id]: ended }, NOW, null)).toBeNull();
      expect(needsViewer(s, { [s.id]: "2026-10-27T11:45:00Z" }, NOW, null)).toBeNull();
      // Open now, running again, queued or settled: nothing.
      expect(needsViewer(s, {}, NOW, s.id)).toBeNull();
      expect(needsViewer({ ...s, status: "running" }, {}, NOW, null)).toBeNull();
      expect(needsViewer({ ...s, queuedCount: 1 }, {}, NOW, null)).toBeNull();
      expect(needsViewer({ ...s, status: "completed" }, {}, NOW, null)).toBeNull();
      // Someone else's turn (the API sends null) and a turn over 24 h old: nothing.
      expect(needsViewer({ ...s, attention: attention(false) }, {}, NOW, null)).toBeNull();
      expect(
        needsViewer({ ...s, attention: attention(false, "2026-10-26T11:59:59Z") }, {}, NOW, null),
      ).toBeNull();
      expect(needsViewer({ ...s, attention: attention(false, "2026-10-26T12:00:01Z") }, {}, NOW, null)).toBe(
        "turn",
      );
    });
  });

  it("lists approvals first, then turns, each most recent first, from the viewer's scope only", () => {
    const managed = project("Payroll", { membership: "manager" });
    const oldApproval = approval({
      teamProject: ref,
      title: "old approval",
      updatedAt: "2026-10-27T10:00:00Z",
    });
    const newApproval = approval({
      teamProject: ref,
      title: "new approval",
      updatedAt: "2026-10-27T11:50:00Z",
    });
    const turn = session({
      teamProject: ref,
      title: "turn",
      attention: attention(false, "2026-10-27T11:55:00Z"),
      updatedAt: "2026-10-27T11:55:00Z",
    });
    // An admin-only session: a pending approval the admin may decide, in a project they only manage (PD-07 (c)).
    const adminOnly = approval({ teamProject: at(managed), title: "admin only" });
    const quiet = session({ teamProject: ref, title: "quiet" });
    const model = build({
      index: index([portal, managed]),
      sessions: [turn, oldApproval, adminOnly, quiet, newApproval],
    });
    expect(model.needsYou?.rows.map((r) => [r.session.title, r.reason, r.place])).toEqual([
      ["new approval", "approval", "Customer portal"],
      ["old approval", "approval", "Customer portal"],
      ["turn", "turn", "Customer portal"],
    ]);
    expect(model.needsYou?.more).toBe(0);
  });

  it("is null when nothing waits on the viewer", () => {
    expect(build({ index: index([portal]), sessions: [session({ teamProject: ref })] }).needsYou).toBeNull();
  });

  it("names a hidden project's session by its repository, never by the project", () => {
    const hidden = approval({ teamProject: null, teamProjectHidden: true, projectName: "pia-linked" });
    expect(build({ sessions: [hidden] }).needsYou?.rows.map((r) => r.place)).toEqual(["pia-linked"]);
  });

  it("shows 5, then the rest behind Show {n} more, all of them when expanded", () => {
    const many = Array.from({ length: 7 }, (_, i) =>
      approval({ teamProject: ref, title: `a${i}`, updatedAt: `2026-10-27T11:0${i}:00Z` }),
    );
    expect(NEEDS_YOU_CAP).toBe(5);
    const model = build({ index: index([portal]), sessions: many });
    expect(model.needsYou?.rows.map((r) => r.session.title)).toEqual(["a6", "a5", "a4", "a3", "a2"]);
    expect(model.needsYou?.more).toBe(2);
    expect(model.needsYou?.expanded).toBe(false);
    const open = build({ index: index([portal]), sessions: many, expanded: new Set(["needs"]) });
    expect(open.needsYou?.rows).toHaveLength(7);
    expect(open.needsYou?.more).toBe(0);
    expect(open.needsYou?.expanded).toBe(true);
  });

  it("collapsed, shows no row and counts them all", () => {
    const model = build({
      index: index([portal]),
      sessions: [approval({ teamProject: ref })],
      collapsed: new Set(["needs"]),
    });
    expect(model.needsYou).toMatchObject({ collapsed: true, rows: [], hidden: 1 });
  });

  it("a collapsed department keeps the project and only the session that needs the viewer (D-01)", () => {
    const other = project("Design system");
    const waiting = approval({ teamProject: ref, title: "waiting" });
    const running = session({ teamProject: ref, title: "running", status: "running" });
    const model = build({
      index: index([portal, other]),
      sessions: [waiting, running],
      collapsed: new Set([ENG.id]),
    });
    const eng = model.sections[0];
    expect(eng?.projects.map((p) => p.name)).toEqual(["Customer portal"]);
    expect(eng?.projects[0]?.sessions.map((s) => s.title)).toEqual(["waiting"]);
    expect(eng?.hidden).toBe(1);
  });

  it("a turn the viewer already saw is not in it", () => {
    const turn = session({ teamProject: ref, attention: attention(false, "2026-10-27T11:30:00Z") });
    expect(build({ index: index([portal]), sessions: [turn] }).needsYou?.rows).toHaveLength(1);
    const seen = { [turn.id]: "2026-10-27T11:31:00Z" };
    expect(build({ index: index([portal]), sessions: [turn], seen }).needsYou).toBeNull();
  });
});
