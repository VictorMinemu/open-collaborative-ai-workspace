import type { WorkProjectIndex, WorkProjectSummary, WorkSession } from "@ocw/contracts";
import { describe, expect, it } from "vitest";
import * as legacy from "../session-sidebar";
import {
  buildWorkZoneSidebar,
  elapsedLabel,
  isActiveSession,
  liveCount,
  orderActiveSessions,
  projectInitials,
  rowProject,
  rowStatusText,
  type SidebarInput,
  SUB_ROW_CAP,
  shortAgo,
} from "./model";

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
