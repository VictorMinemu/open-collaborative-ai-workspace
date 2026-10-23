import { describe, expect, it } from "vitest";
import { Project } from "./device";
import { SessionVisibilityKind, WORK_PROJECT_LIMITS } from "./work-projects";
import {
  AudiencePeople,
  AudiencePreview,
  CreateWorkSessionRequest,
  SessionAudienceInput,
  UpdateWorkSessionVisibilityRequest,
  UpdateWorkSessionVisibilityResult,
  WorkSession,
  WorkSessionDetail,
  WorkSessionRemovedEvent,
  WorkSessionVisibilityChangedEvent,
  WorkSessionVisibilityView,
} from "./work-session";

/** Distinct valid UUIDs (v4 layout) for bound and uniqueness tests. */
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const ids = (count: number, from = 1) => Array.from({ length: count }, (_, i) => uuid(from + i));
const [a, b, c] = ids(3);
const now = "2026-10-22T10:00:00.000Z";

/** A `work_session.updated` payload as the API sent it before 07.9 (no visibility, no team project). */
const oldSession = {
  id: uuid(100),
  conversationId: uuid(101),
  projectId: uuid(102),
  projectName: "web",
  deviceId: uuid(103),
  deviceName: "Ana's MacBook",
  deviceOnline: true,
  runtime: "claude-code",
  model: null,
  permissionMode: "default",
  worktree: false,
  branch: "main",
  status: "idle",
  title: "Fix the login redirect",
  titleSource: "user",
  createdBy: uuid(104),
  createdByName: "Ana",
  queuedCount: 0,
  pendingApprovals: 0,
  lastError: null,
  settings: { requested: {}, effective: null, pending: false },
  fullAccess: false,
  runningSince: null,
  diffStat: null,
  createdAt: now,
  updatedAt: now,
};

const person = (n: number, name: string) => ({ userId: uuid(n), name, avatarUrl: null });

const teamView = {
  kind: "teams",
  projectDefault: "project",
  project: { kind: "team", id: uuid(200), name: "Customer portal" },
  owner: { userId: uuid(104), name: "Ana Ruiz" },
  teams: [
    { id: uuid(201), name: "Web", kind: "team", memberCount: 6, selected: true, active: true },
    { id: uuid(202), name: "Design", kind: "department", memberCount: 3, selected: true, active: false },
  ],
  people: [
    { ...person(301, "Bea"), active: true },
    { ...person(302, "Carlos"), active: true },
    { ...person(303, "Dani"), active: false },
  ],
  viewers: {
    count: 12,
    people: [
      { ...person(104, "Ana Ruiz"), reason: "owner", via: null },
      { ...person(305, "Eva"), reason: "device_owner", via: null },
      { ...person(306, "Fran"), reason: "lead", via: null },
      { ...person(307, "Gus"), reason: "member", via: null },
      ...ids(8, 400).map((userId, i) => ({
        userId,
        name: `Person ${i}`,
        avatarUrl: "/api/v1/users/x/avatar",
        reason: "team",
        via: { id: uuid(201), name: "Web" },
      })),
    ],
    more: 0,
  },
  alwaysVisible: {
    admins: true,
    deviceOwner: { userId: uuid(305), firstName: "Eva", deviceName: "Eva's MacBook", isViewer: false },
  },
  viewerCan: { change: true },
  viewerState: null,
};

const personalView = {
  kind: "project",
  projectDefault: null,
  project: { kind: "personal", deviceName: "Ana's MacBook" },
  owner: { userId: uuid(104), name: "Ana Ruiz" },
  teams: [],
  people: [],
  viewers: {
    count: 2,
    people: [
      { ...person(104, "Ana Ruiz"), reason: "owner", via: null },
      { ...person(308, "Hugo"), reason: "device", via: { id: uuid(103), name: "Ana's MacBook" } },
    ],
    more: 0,
  },
  alwaysVisible: { admins: true, deviceOwner: null },
  viewerCan: { change: false },
  viewerState: null,
};

describe("session audience input (07.9-01, D-04, D-07)", () => {
  it("has exactly one request shape per visibility kind", () => {
    expect([...SessionAudienceInput.options.map((o) => o.shape.kind.value)].sort()).toEqual(
      [...SessionVisibilityKind.options].sort(),
    );
  });

  it("parses the four kinds", () => {
    for (const input of [
      { kind: "owner" },
      { kind: "project" },
      { kind: "teams", teamIds: [a] },
      { kind: "people", userIds: [a, b] },
    ]) {
      expect(SessionAudienceInput.parse(input), input.kind).toEqual(input);
      expect(UpdateWorkSessionVisibilityRequest.parse(input), input.kind).toEqual(input);
    }
  });

  it("refuses a request whose kind and entries disagree, empty or oversized lists and duplicates", () => {
    const tooManyTeams = ids(WORK_PROJECT_LIMITS.teamIdsMax + 1);
    const tooManyPeople = ids(WORK_PROJECT_LIMITS.userIdsMax + 1);
    expect(tooManyTeams).toHaveLength(51);
    expect(tooManyPeople).toHaveLength(101);
    for (const bad of [
      { kind: "teams" },
      { kind: "teams", teamIds: [] },
      { kind: "teams", teamIds: tooManyTeams },
      { kind: "people", userIds: [] },
      { kind: "people", userIds: tooManyPeople },
      { kind: "teams", teamIds: [a, a] },
      { kind: "people", userIds: [a, b, a] },
      { kind: "owner", userIds: [a] },
      { kind: "project", teamIds: [a] },
      { kind: "teams", teamIds: [a], userIds: [b] },
      { kind: "everyone" },
      { kind: "people", userIds: [a], extra: true },
      { kind: "people", userIds: ["not-a-uuid"] },
      {},
    ]) {
      expect(SessionAudienceInput.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    // The bounds are exactly the limits (50 teams, 100 people).
    expect(SessionAudienceInput.safeParse({ kind: "teams", teamIds: ids(50) }).success).toBe(true);
    expect(SessionAudienceInput.safeParse({ kind: "people", userIds: ids(100) }).success).toBe(true);
  });

  it("CreateWorkSessionRequest parses as before without visibility and accepts an audience", () => {
    const projectId = uuid(102);
    const before = CreateWorkSessionRequest.parse({ projectId });
    expect(before).toEqual({ projectId, runtime: "claude-code", worktree: false });
    expect(before).not.toHaveProperty("visibility");
    expect(
      CreateWorkSessionRequest.parse({ projectId, visibility: { kind: "people", userIds: [a] } }).visibility,
    ).toEqual({ kind: "people", userIds: [a] });
    expect(
      CreateWorkSessionRequest.safeParse({ projectId, visibility: { kind: "teams", teamIds: [] } }).success,
    ).toBe(false);
  });
});

describe("work session list DTO summary (07.9-01, R1)", () => {
  it("an old replayed DTO without visibility or teamProject still parses", () => {
    const parsed = WorkSession.parse(oldSession);
    expect(parsed.visibility).toBeUndefined();
    expect(parsed.teamProject).toBeUndefined();
  });

  it("parses the summary and the team project; refuses a negative count", () => {
    const visibility = { kind: "teams", activeCount: 2, differsFromDefault: true, firstTeamName: "Web" };
    const teamProject = { id: uuid(200), name: "Customer portal" };
    const parsed = WorkSession.parse({ ...oldSession, visibility, teamProject });
    expect(parsed.visibility).toEqual(visibility);
    expect(parsed.teamProject).toEqual(teamProject);
    expect(WorkSession.parse({ ...oldSession, teamProject: null }).teamProject).toBeNull();
    expect(
      WorkSession.safeParse({ ...oldSession, visibility: { ...visibility, activeCount: -1 } }).success,
    ).toBe(false);
    expect(WorkSession.safeParse({ ...oldSession, visibility: { ...visibility, kind: "org" } }).success).toBe(
      false,
    );
  });
});

describe("visibility panel view (07.9-01, D-04, D-11, D-12, R2, R12)", () => {
  it("parses a team-project view and a personal view", () => {
    expect(WorkSessionVisibilityView.parse(teamView).viewers.people).toHaveLength(12);
    expect(WorkSessionVisibilityView.parse(personalView).project).toEqual({
      kind: "personal",
      deviceName: "Ana's MacBook",
    });
    expect(
      WorkSessionVisibilityView.parse({ ...personalView, viewerState: "left_project" }).viewerState,
    ).toBe("left_project");
  });

  it("refuses more than 50 viewer rows, an unknown reason, a project kind outside team/personal", () => {
    const rows = ids(WORK_PROJECT_LIMITS.viewersMax + 1, 500).map((userId) => ({
      userId,
      name: "x",
      avatarUrl: null,
      reason: "member",
      via: null,
    }));
    expect(
      WorkSessionVisibilityView.safeParse({ ...teamView, viewers: { count: 51, people: rows, more: 0 } })
        .success,
    ).toBe(false);
    expect(
      WorkSessionVisibilityView.safeParse({
        ...teamView,
        viewers: { count: 50, people: rows.slice(0, 50), more: 1 },
      }).success,
    ).toBe(true);
    const badReason = {
      ...teamView,
      viewers: { ...teamView.viewers, people: [{ ...person(104, "Ana"), reason: "admin", via: null }] },
    };
    expect(WorkSessionVisibilityView.safeParse(badReason).success).toBe(false);
    expect(
      WorkSessionVisibilityView.safeParse({ ...teamView, project: { kind: "org", id: uuid(1), name: "x" } })
        .success,
    ).toBe(false);
    expect(WorkSessionVisibilityView.safeParse({ ...teamView, viewerState: "gone" }).success).toBe(false);
    expect(
      WorkSessionVisibilityView.safeParse({
        ...teamView,
        alwaysVisible: { admins: false, deviceOwner: null },
      }).success,
    ).toBe(false);
  });

  it("the update result reports who lost access, at most three names", () => {
    const result = { visibility: teamView, removedCount: 4, removedNames: ["Bea", "Carlos", "Dani"] };
    expect(UpdateWorkSessionVisibilityResult.parse(result).removedCount).toBe(4);
    expect(
      UpdateWorkSessionVisibilityResult.safeParse({
        ...result,
        removedNames: ["Bea", "Carlos", "Dani", "Eva"],
      }).success,
    ).toBe(false);
    expect(UpdateWorkSessionVisibilityResult.safeParse({ ...result, removedCount: -1 }).success).toBe(false);
  });

  it("the draft people search and preview are bounded", () => {
    const people = ids(10, 600).map((userId) => ({ userId, name: "x", avatarUrl: null }));
    expect(AudiencePeople.parse({ people }).people).toHaveLength(10);
    expect(
      AudiencePeople.safeParse({ people: [...people, { userId: uuid(700), name: "y", avatarUrl: null }] })
        .success,
    ).toBe(false);
    const preview = {
      count: 9,
      people: people.slice(0, 5),
      alwaysVisible: { admins: true, deviceOwner: null },
    };
    expect(AudiencePreview.parse(preview).count).toBe(9);
    expect(AudiencePreview.safeParse({ ...preview, people: people.slice(0, 6) }).success).toBe(false);
  });

  it("WorkSessionDetail carries an optional viewerState", () => {
    const detail = { session: oldSession, prompts: [], approvals: [], events: [], lastSeq: 0 };
    expect(WorkSessionDetail.parse(detail).viewerState).toBeUndefined();
    expect(WorkSessionDetail.parse({ ...detail, viewerState: null }).viewerState).toBeNull();
    expect(WorkSessionDetail.parse({ ...detail, viewerState: "left_project" }).viewerState).toBe(
      "left_project",
    );
    expect(WorkSessionDetail.safeParse({ ...detail, viewerState: "removed" }).success).toBe(false);
  });

  it("realtime payloads carry ids only", () => {
    expect(WorkSessionRemovedEvent.parse({ id: a })).toEqual({ id: a });
    expect(WorkSessionVisibilityChangedEvent.parse({ workSessionId: c })).toEqual({ workSessionId: c });
    expect(WorkSessionRemovedEvent.safeParse({ id: "x" }).success).toBe(false);
    expect(Object.keys(WorkSessionRemovedEvent.shape)).toEqual(["id"]);
    expect(Object.keys(WorkSessionVisibilityChangedEvent.shape)).toEqual(["workSessionId"]);
  });
});

describe("Project.teamProject (07.9-01, R5)", () => {
  const project = {
    id: uuid(102),
    deviceId: uuid(103),
    deviceName: "Ana's MacBook",
    deviceOnline: true,
    name: "web",
    gitRemote: null,
    defaultBranch: "main",
    available: true,
    createdAt: now,
  };

  it("parses without teamProject, with null and with the team project and its default", () => {
    expect(Project.parse(project).teamProject).toBeUndefined();
    expect(Project.parse({ ...project, teamProject: null }).teamProject).toBeNull();
    const teamProject = { id: uuid(200), name: "Customer portal", defaultVisibility: "owner" };
    expect(Project.parse({ ...project, teamProject }).teamProject).toEqual(teamProject);
    expect(
      Project.safeParse({ ...project, teamProject: { ...teamProject, defaultVisibility: "teams" } }).success,
    ).toBe(false);
  });
});
