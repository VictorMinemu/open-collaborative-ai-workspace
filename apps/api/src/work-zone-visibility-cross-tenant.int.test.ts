import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "./testing";
import type { FakeDevice } from "./testing-device";
import { connectWithProject, invite, pairDevice, startSession } from "./testing-workzone";

/**
 * 07.9-12 Task 3 (C-02, WZP-07; 07.4 #169): the phase's cross-tenant matrix, derived from the authz registry. Every
 * registered route whose URL names `/work-projects`, `/visibility` or `/audience/` has one organization-B case, run by
 * organization B's ADMIN with organization A's ids: a route with an id answers 404 (the body never names A's objects),
 * a route without one answers organization B's own (empty) result. No case changes anything of organization A: its
 * project rows, audiences and audit rows are compared before and after. The registered set must equal the covered set:
 * a new route without a case fails this test.
 */

let stack: TestStack;
let su: pg.Client;
let victor: TestClient;
let eve: TestClient;
let device: FakeDevice | null = null;

/** Organization A's objects every case names. */
const a = { org: "", dept: "", team: "", project: "", repo: "", session: "", deviceId: "" };
/** Organization B's own team project (to mix B's ids with A's). */
let bProject = "";

type Res = { status: number; body: Record<string, unknown> | null };

async function ok(res: Promise<Res>) {
  const r = await res;
  if (r.status !== 200) throw new Error(`expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
  // biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
  return r.body as Record<string, any>;
}

/** Organization B: Eve leaves A and becomes the admin of her own organization (the 07.5 / 07.9-04 matrix pattern). */
async function moveToOrgB(userId: string): Promise<string> {
  const orgB = randomUUID();
  await su.query("insert into auth.organization (id, name, slug) values ($1, 'Other', $2)", [
    orgB,
    `o-${orgB}`,
  ]);
  await su.query("delete from auth.member where user_id = $1", [userId]);
  await su.query("delete from app.org_members where user_id = $1", [userId]);
  await su.query("insert into auth.member (organization_id, user_id, role) values ($1, $2, 'owner')", [
    orgB,
    userId,
  ]);
  await su.query(
    "insert into app.org_members (organization_id, user_id, display_name, role) values ($1, $2, 'Eve', 'admin')",
    [orgB, userId],
  );
  await su.query("update auth.session set active_organization_id = $1 where user_id = $2", [orgB, userId]);
  return orgB;
}

beforeAll(async () => {
  stack = await startTestStack();
  su = new pg.Client({ connectionString: stack.db.superuserUrl });
  await su.connect();
  victor = new TestClient(stack.baseUrl);
  const setup = await ok(
    victor.request("POST", "/api/v1/setup", {
      token: TEST_SETUP_TOKEN,
      name: "Víctor Ruiz",
      email: "victor@example.test",
      password: "correct-horse-battery",
      orgName: "Autofy Labs",
    }),
  );
  a.org = setup.organization.id;
  const { client: eveClient, userId: eveId } = await invite(
    stack,
    victor,
    "eve@example.test",
    "Eve",
    "developer",
  );
  eve = eveClient;
  await moveToOrgB(eveId);

  // Organization A: Engineering › Platform (team) and Atlas (team project, Platform assigned, a linked repo, a session
  // with a `teams` audience).
  a.dept = (
    await ok(
      victor.request("POST", "/api/v1/units", { kind: "department", name: "Engineering", parentId: null }),
    )
  ).id;
  a.team = (
    await ok(victor.request("POST", "/api/v1/units", { kind: "team", name: "Platform", parentId: a.dept }))
  ).id;
  a.project = (
    await ok(victor.request("POST", "/api/v1/work-projects", { name: "Atlas", parentId: a.dept }))
  ).id;
  await ok(victor.request("POST", `/api/v1/work-projects/${a.project}/teams`, { unitId: a.team }));
  const paired = await pairDevice(stack, victor, "Victor's Mac");
  a.deviceId = paired.deviceId;
  const connected = await connectWithProject(stack, victor, paired.token, {
    localId: "atlas",
    name: "atlas-repo",
  });
  device = connected.device;
  a.repo = connected.projectId;
  await ok(victor.request("POST", `/api/v1/work-projects/${a.project}/repos`, { projectId: a.repo }));
  a.session = await startSession(victor, connected.device, a.repo);
  await ok(
    victor.request("PUT", `/api/v1/work-sessions/${a.session}/visibility`, {
      kind: "teams",
      teamIds: [a.team],
    }),
  );

  // Organization B's own team project.
  const bDept = (
    await ok(eve.request("POST", "/api/v1/units", { kind: "department", name: "B dept", parentId: null }))
  ).id;
  bProject = (await ok(eve.request("POST", "/api/v1/work-projects", { name: "B project", parentId: bDept })))
    .id;
}, 240_000);

afterAll(async () => {
  await device?.close();
  await su?.end();
  await stack?.stop();
});

/** Everything of organization A a case could touch: project rows, audiences, units and audit rows. */
async function snapshotOfA(): Promise<string> {
  const rows = async (sql: string) => (await su.query(sql, [a.org])).rows;
  return JSON.stringify({
    units: await rows(
      "select id, kind, name, parent_id from app.org_units where organization_id = $1 order by id",
    ),
    memberships: await rows(
      "select unit_id, user_id, role from app.unit_memberships where organization_id = $1 order by unit_id, user_id",
    ),
    settings: await rows(
      "select unit_id, default_visibility from app.work_project_settings where organization_id = $1",
    ),
    teams: await rows(
      "select project_unit_id, team_unit_id from app.work_project_teams where organization_id = $1 order by team_unit_id",
    ),
    repos: await rows("select project_id, unit_id from app.work_project_repos where organization_id = $1"),
    sessions: await rows(
      "select id, visibility, title, status from app.work_sessions where organization_id = $1 order by id",
    ),
    grants: await rows(
      "select subject_kind, subject_id, revoked_at from app.work_session_grants where organization_id = $1 order by subject_id",
    ),
    audit: await rows("select count(*)::int as n from app.audit_events where organization_id = $1"),
  });
}

/** The words of organization A that must never appear in an answer to organization B. */
const SECRETS = () => [
  "Atlas",
  "Platform",
  "Engineering",
  "atlas-repo",
  "Victor's Mac",
  a.project,
  a.team,
  a.session,
];

function expectNoLeak(key: string, r: Res): void {
  const text = JSON.stringify(r.body ?? {});
  for (const s of SECRETS()) expect(text, `${key} leaks ${s}`).not.toContain(s);
}

type Case = (key: string) => Promise<void>;

const notFound =
  (method: string, path: () => string, body?: () => unknown): Case =>
  async (key) => {
    const r = await eve.request(method, path(), body?.());
    expect(r.status, `${key}: ${JSON.stringify(r.body)}`).toBe(404);
    expectNoLeak(key, r);
  };

const CASES: Record<string, Case> = {
  // ---- team projects (07.9-04)
  "GET /api/v1/work-projects": async (key) => {
    const r = await eve.request("GET", "/api/v1/work-projects");
    expect(r.status, key).toBe(200);
    expectNoLeak(key, r);
    const body = r.body as { teamProjects: Array<{ id: string }>; personalRepos: unknown[] };
    expect(body.teamProjects.map((p) => p.id)).toEqual([bProject]);
    expect(body.personalRepos).toEqual([]);
  },
  "GET /api/v1/work-projects/parents": async (key) => {
    const r = await eve.request("GET", "/api/v1/work-projects/parents");
    expect(r.status, key).toBe(200);
    expectNoLeak(key, r);
    expect((r.body as { parents: Array<{ name: string }> }).parents.map((p) => p.name)).toEqual(["B dept"]);
  },
  "POST /api/v1/work-projects": notFound(
    "POST",
    () => "/api/v1/work-projects",
    () => ({ name: "Intruder", parentId: a.dept }),
  ),
  "GET /api/v1/work-projects/:unitId": notFound("GET", () => `/api/v1/work-projects/${a.project}`),
  "PATCH /api/v1/work-projects/:unitId": notFound(
    "PATCH",
    () => `/api/v1/work-projects/${a.project}`,
    () => ({ defaultVisibility: "owner" }),
  ),
  "GET /api/v1/work-projects/:unitId/assignable-teams": notFound(
    "GET",
    () => `/api/v1/work-projects/${a.project}/assignable-teams`,
  ),
  "POST /api/v1/work-projects/:unitId/teams": async (key) => {
    await notFound(
      "POST",
      () => `/api/v1/work-projects/${a.project}/teams`,
      () => ({ unitId: a.team }),
    )(key);
    // B's own project with A's team: the team is not found in B.
    await notFound(
      "POST",
      () => `/api/v1/work-projects/${bProject}/teams`,
      () => ({ unitId: a.team }),
    )(key);
  },
  "DELETE /api/v1/work-projects/:unitId/teams/:teamId": async (key) => {
    await notFound("DELETE", () => `/api/v1/work-projects/${a.project}/teams/${a.team}`)(key);
    await notFound("DELETE", () => `/api/v1/work-projects/${bProject}/teams/${a.team}`)(key);
  },
  "GET /api/v1/work-projects/:unitId/linkable-repos": notFound(
    "GET",
    () => `/api/v1/work-projects/${a.project}/linkable-repos`,
  ),
  "POST /api/v1/work-projects/:unitId/repos": async (key) => {
    await notFound(
      "POST",
      () => `/api/v1/work-projects/${a.project}/repos`,
      () => ({ projectId: a.repo }),
    )(key);
    // B's own project with A's repository: the repository is not found in B.
    await notFound(
      "POST",
      () => `/api/v1/work-projects/${bProject}/repos`,
      () => ({ projectId: a.repo }),
    )(key);
  },
  "GET /api/v1/work-projects/:unitId/repos/:projectId/impact": async (key) => {
    await notFound("GET", () => `/api/v1/work-projects/${a.project}/repos/${a.repo}/impact`)(key);
    await notFound("GET", () => `/api/v1/work-projects/${bProject}/repos/${a.repo}/impact`)(key);
  },
  "DELETE /api/v1/work-projects/:unitId/repos/:projectId": async (key) => {
    await notFound("DELETE", () => `/api/v1/work-projects/${a.project}/repos/${a.repo}`)(key);
    await notFound("DELETE", () => `/api/v1/work-projects/${bProject}/repos/${a.repo}`)(key);
  },
  // ---- session audiences (07.9-06)
  "GET /api/v1/work-sessions/:id/visibility": notFound(
    "GET",
    () => `/api/v1/work-sessions/${a.session}/visibility`,
  ),
  "PUT /api/v1/work-sessions/:id/visibility": async (key) => {
    for (const body of [{ kind: "owner" }, { kind: "project" }, { kind: "teams", teamIds: [a.team] }]) {
      await notFound(
        "PUT",
        () => `/api/v1/work-sessions/${a.session}/visibility`,
        () => body,
      )(key);
    }
  },
  "GET /api/v1/work-sessions/:id/visibility/people": notFound(
    "GET",
    () => `/api/v1/work-sessions/${a.session}/visibility/people`,
  ),
  "GET /api/v1/projects/:projectId/audience/people": notFound(
    "GET",
    () => `/api/v1/projects/${a.repo}/audience/people`,
  ),
  "GET /api/v1/projects/:projectId/audience/preview": async (key) => {
    await notFound("GET", () => `/api/v1/projects/${a.repo}/audience/preview?kind=project`)(key);
    await notFound(
      "GET",
      () => `/api/v1/projects/${a.repo}/audience/preview?kind=teams&teamIds=${a.team}`,
    )(key);
  },
};

const PHASE_ROUTE = /\/work-projects|\/visibility|\/audience\//u;

describe("the phase's cross-tenant matrix, derived from the authz registry (C-02, WZP-07)", () => {
  it("every registered project, audience and visibility route has an organization-B case; none reaches organization A", async () => {
    const routes = stack.built.authz.routes;
    const registered = [...routes.keys()].filter((k) => !k.startsWith("HEAD ") && PHASE_ROUTE.test(k)).sort();
    expect(registered).toEqual(Object.keys(CASES).sort());

    const before = await snapshotOfA();
    for (const [key, run] of Object.entries(CASES)) {
      expect(routes.get(key), key).toBe("user");
      await run(key);
    }
    expect(await snapshotOfA()).toEqual(before);
  });

  it("organization A still reads its own objects through the same routes (the cases above prove isolation, not breakage)", async () => {
    const detail = await ok(victor.request("GET", `/api/v1/work-projects/${a.project}`));
    expect(detail.teams.map((t: { id: string }) => t.id)).toEqual([a.team]);
    const view = await ok(victor.request("GET", `/api/v1/work-sessions/${a.session}/visibility`));
    expect(view.kind).toBe("teams");
  });
});
