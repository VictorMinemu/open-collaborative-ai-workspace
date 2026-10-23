import { randomUUID } from "node:crypto";
import { WorkProjectDetail } from "@ocw/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";
import { eventually, FakeDevice } from "../../testing-device";
import { invite, pairDevice } from "../../testing-workzone";

/**
 * Phase 07.9-04 (D-01, D-02, D-03, D-10, D-13; ADR-0024): team projects as Control Plane entities. Organization A:
 * Víctor (admin), Lena (lead role, leads team Web), Dana (developer, member of Web), Oscar (developer, in no unit),
 * Otto (lead role, leads team Mobile); Engineering (department) › Web, Mobile (teams). Organization B: Eve (admin).
 */

let stack: TestStack;
let su: pg.Client;
let victor: TestClient;
let lena: TestClient;
let dana: TestClient;
let oscar: TestClient;
let otto: TestClient;
let eve: TestClient;
let orgA = "";
let lenaId = "";
let ottoId = "";
let danaId = "";
let engineering = "";
let web = "";
let mobile = "";
let portal = "";
let platform = "";
let eveUnit = "";

interface PairedDevice {
  deviceId: string;
  device: FakeDevice;
  /** Repository ids by name. */
  repo: Record<string, string>;
}
let lenaMac: PairedDevice;
let danaPc: PairedDevice;
let eveBox: PairedDevice;
const devicesToClose: FakeDevice[] = [];

/** Pair a device for `owner`, connect it and announce `repos` (names double as local ids). */
async function deviceWith(owner: TestClient, name: string, repos: string[]): Promise<PairedDevice> {
  const { deviceId, token } = await pairDevice(stack, owner, name);
  const device = await FakeDevice.connect(stack.baseUrl, token);
  devicesToClose.push(device);
  device.send({
    type: "projects.sync",
    projects: repos.map((r) => ({ localId: r, name: r, gitRemote: null, defaultBranch: "main" })),
  });
  await device.next((f) => f.type === "projects.ack");
  await eventually(
    async () =>
      (await su.query("select status from app.devices where id = $1", [deviceId])).rows[0]?.status ===
      "online",
  );
  const rows = (await su.query("select id, name from app.projects where device_id = $1", [deviceId])).rows;
  return { deviceId, device, repo: Object.fromEntries(rows.map((r) => [r.name as string, r.id as string])) };
}

type Res = { status: number; body: Record<string, unknown> | null };

async function ok(res: Promise<Res>, status = 200) {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  // biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
  return r.body as Record<string, any>;
}

/** The error of a failed request, asserting its status. */
async function fails(res: Promise<Res>, status: number) {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return (r.body as { error: { code: string; message: string; details?: unknown } }).error;
}

const audits = async (action: string, resourceId?: string) =>
  (
    await su.query(
      "select resource_id, metadata from app.audit_events where action = $1 and ($2::uuid is null or resource_id = $2::text) order by occurred_at",
      [action, resourceId ?? null],
    )
  ).rows as Array<{ resource_id: string; metadata: Record<string, unknown> }>;

const orgEvents = async (type: string) =>
  (
    await su.query("select payload from app.stream_events where stream_id = $1 and type = $2 order by seq", [
      `org:${orgA}`,
      type,
    ])
  ).rows.map((r) => r.payload as Record<string, unknown>);

const unit = async (kind: string, name: string, parentId: string | null) =>
  (await ok(victor.request("POST", "/api/v1/units", { kind, name, parentId }))).id as string;

/** Organization B: Eve leaves A and becomes the admin of her own organization (as the 07.5 matrix does). */
async function moveToOrgB(userId: string) {
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
  orgA = setup.organization.id;
  ({ client: lena, userId: lenaId } = await invite(stack, victor, "lena@example.test", "Lena Lead", "lead"));
  const { client: danaClient, userId: danaUserId } = await invite(
    stack,
    victor,
    "dana@example.test",
    "Dana Dev",
    "developer",
  );
  dana = danaClient;
  danaId = danaUserId;
  ({ client: oscar } = await invite(stack, victor, "oscar@example.test", "Oscar Out", "developer"));
  const { client: ottoClient, userId: ottoUserId } = await invite(
    stack,
    victor,
    "otto@example.test",
    "Otto Other",
    "lead",
  );
  otto = ottoClient;
  ottoId = ottoUserId;
  const { client: eveClient, userId: eveId } = await invite(
    stack,
    victor,
    "eve@example.test",
    "Eve",
    "developer",
  );
  eve = eveClient;
  await moveToOrgB(eveId);

  engineering = await unit("department", "Engineering", null);
  web = await unit("team", "Web", engineering);
  mobile = await unit("team", "Mobile", engineering);
  await ok(victor.request("POST", `/api/v1/units/${web}/members`, { userId: lenaId, role: "lead" }));
  await ok(victor.request("POST", `/api/v1/units/${web}/members`, { userId: danaId }));
  await ok(victor.request("POST", `/api/v1/units/${mobile}/members`, { userId: ottoId, role: "lead" }));
});

afterAll(async () => {
  for (const d of devicesToClose) await d.close();
  await su?.end();
  await stack?.stop();
});

describe("a parent lead creates a team project (D-01, D-10, D-13)", () => {
  it("creates it under the team, becomes its lead, and both are audited with the unit event", async () => {
    const created = await ok(
      lena.request("POST", "/api/v1/work-projects", { name: "  Customer portal ", parentId: web }),
    );
    expect(WorkProjectDetail.safeParse(created).success).toBe(true);
    portal = created.id;
    expect(created).toMatchObject({
      name: "Customer portal",
      parentId: web,
      trail: ["Engineering", "Web"],
      defaultVisibility: "project",
      access: { count: 1, people: [{ userId: lenaId, name: "Lena Lead" }] },
      teams: [],
      repos: [],
      viewerCan: { manage: true, assignTeams: true, members: true },
    });

    const row = (await su.query("select kind, parent_id, path from app.org_units where id = $1", [portal]))
      .rows[0];
    expect(row).toEqual({ kind: "project", parent_id: web, path: [engineering, web, portal] });
    const membership = (
      await su.query("select user_id, role from app.unit_memberships where unit_id = $1", [portal])
    ).rows;
    expect(membership).toEqual([{ user_id: lenaId, role: "lead" }]);

    // The existing unit.created action (the one creation path) and the auto-lead, ids only for the membership.
    expect((await audits("unit.created", portal)).map((a) => a.metadata)).toEqual([
      { name: "Customer portal", kind: "project", parentId: web },
    ]);
    expect((await audits("unit_membership.added", portal)).map((a) => a.metadata)).toEqual([
      { unitId: portal, userId: lenaId, role: "lead" },
    ]);
    expect(await orgEvents("units.updated")).toContainEqual({ unitId: portal, action: "created" });
  });

  it("only people with project access open it; everyone else gets the unknown-id 404", async () => {
    const mine = await ok(lena.request("GET", `/api/v1/work-projects/${portal}`));
    expect(mine.access.count).toBeGreaterThanOrEqual(1);
    const admin = await ok(victor.request("GET", `/api/v1/work-projects/${portal}`));
    expect(admin).toMatchObject({
      id: portal,
      viewerCan: { manage: true, assignTeams: true, members: true },
    });

    const unknown = await fails(oscar.request("GET", `/api/v1/work-projects/${randomUUID()}`), 404);
    for (const outsider of [oscar, dana, otto]) {
      expect(await fails(outsider.request("GET", `/api/v1/work-projects/${portal}`), 404)).toEqual(unknown);
    }
    // A unit that is not a project answers the same.
    expect(await fails(victor.request("GET", `/api/v1/work-projects/${web}`), 404)).toEqual(unknown);
    expect(await fails(eve.request("GET", `/api/v1/work-projects/${portal}`), 404)).toEqual(unknown);
  });

  it("refuses another team's lead, a plain member, a project parent and the top level", async () => {
    expect(
      (await fails(lena.request("POST", "/api/v1/work-projects", { name: "X", parentId: mobile }), 403)).code,
    ).toBe("forbidden");
    expect(
      (await fails(otto.request("POST", "/api/v1/work-projects", { name: "X", parentId: web }), 403)).code,
    ).toBe("forbidden");
    expect(
      (await fails(dana.request("POST", "/api/v1/work-projects", { name: "X", parentId: web }), 403)).code,
    ).toBe("forbidden");
    expect(
      (await fails(lena.request("POST", "/api/v1/work-projects", { name: "Nested", parentId: portal }), 400))
        .code,
    ).toBe("invalid_parent_kind");
    await fails(lena.request("POST", "/api/v1/work-projects", { name: "Top" }), 400);
    await fails(lena.request("POST", "/api/v1/work-projects", { name: "Top", parentId: null }), 400);
    await fails(lena.request("POST", "/api/v1/work-projects", { name: "", parentId: web }), 400);
    await fails(lena.request("POST", "/api/v1/work-projects", { name: "X", parentId: web, extra: 1 }), 400);
    // A sibling name is taken like any unit's.
    expect(
      (
        await fails(
          lena.request("POST", "/api/v1/work-projects", { name: "customer portal", parentId: web }),
          409,
        )
      ).code,
    ).toBe("unit_name_taken");
    // Org B's admin never reaches A's units.
    expect(
      (await fails(eve.request("POST", "/api/v1/work-projects", { name: "X", parentId: web }), 404)).code,
    ).toBe("unit_not_found");
  });

  it("an admin creates under a department and becomes its lead too", async () => {
    const created = await ok(
      victor.request("POST", "/api/v1/work-projects", { name: "Platform", parentId: engineering }),
    );
    expect(created).toMatchObject({ parentId: engineering, trail: ["Engineering"], access: { count: 1 } });
    platform = created.id;
    const roles = (await su.query("select role from app.unit_memberships where unit_id = $1", [created.id]))
      .rows;
    expect(roles).toEqual([{ role: "lead" }]);
  });

  it("a creator whose role cannot lead (a delegated allow rule) joins as a member, never as a lead", async () => {
    const rule = await ok(
      victor.request("POST", "/api/v1/permission-rules", {
        scopeUnitId: web,
        subjectKind: "user",
        subjectId: danaId,
        permission: "work_project.manage",
        effect: "allow",
      }),
    );
    try {
      const created = await ok(
        dana.request("POST", "/api/v1/work-projects", { name: "Sketch", parentId: web }),
      );
      const roles = (
        await su.query("select user_id, role from app.unit_memberships where unit_id = $1", [created.id])
      ).rows;
      expect(roles).toEqual([{ user_id: danaId, role: "member" }]);
      expect((await audits("unit_membership.added", created.id)).map((a) => a.metadata)).toEqual([
        { unitId: created.id, userId: danaId, role: "member" },
      ]);
      await ok(victor.request("DELETE", `/api/v1/units/${created.id}`));
    } finally {
      await ok(victor.request("DELETE", `/api/v1/permission-rules/${rule.id}`));
    }
  });
});

describe("teams, repositories and the default (D-01, D-03, D-10, UI-SPEC U-7)", () => {
  let billing = "";

  beforeAll(async () => {
    lenaMac = await deviceWith(lena, "Lena's Mac", ["web-app", "docs"]);
    danaPc = await deviceWith(dana, "Dana's PC", ["api"]);
    eveBox = await deviceWith(eve, "Eve's box", ["evil"]);
    eveUnit = (
      await ok(eve.request("POST", "/api/v1/units", { kind: "department", name: "Ops", parentId: null }))
    ).id;
    // Otto leads the project itself (not its parent): an admin appoints him.
    await ok(victor.request("POST", `/api/v1/units/${portal}/members`, { userId: ottoId, role: "lead" }));
  });

  it("a parent lead assigns a team and a department; their members get access and the counts follow", async () => {
    const before = (await audits("work_project.team_assigned")).length;
    await ok(lena.request("POST", `/api/v1/work-projects/${portal}/teams`, { unitId: mobile }));
    const detail = await ok(
      lena.request("POST", `/api/v1/work-projects/${portal}/teams`, { unitId: engineering }),
    );
    expect(detail.teams).toEqual([
      // Engineering's subtree: Lena and Dana (Web), Otto (Mobile, the portal) and Víctor (who leads Platform).
      { id: engineering, name: "Engineering", kind: "department", memberCount: 4 },
      { id: mobile, name: "Mobile", kind: "team", memberCount: 1 },
    ]);
    // Lena and Otto (leads), Dana and Víctor (through Engineering: Víctor by his membership, never by his role).
    expect(detail.access.count).toBe(4);
    expect(await audits("work_project.team_assigned", portal)).toHaveLength(before + 2);
    expect((await audits("work_project.team_assigned", portal)).map((a) => a.metadata)).toEqual([
      { teamId: mobile },
      { teamId: engineering },
    ]);
    // Dana now opens the project through the department.
    await ok(dana.request("GET", `/api/v1/work-projects/${portal}`));
  });

  it("refuses the project itself, another project, an assigned team, org B's unit and a project lead alone", async () => {
    const assign = (as: TestClient, unitId: string) =>
      as.request("POST", `/api/v1/work-projects/${portal}/teams`, { unitId });
    expect((await fails(assign(lena, portal), 400)).code).toBe("invalid_team_kind");
    expect((await fails(assign(victor, platform), 400)).code).toBe("invalid_team_kind");
    expect((await fails(assign(lena, mobile), 409)).code).toBe("team_already_assigned");
    expect((await fails(assign(lena, eveUnit), 404)).code).toBe("unit_not_found");
    expect((await fails(assign(lena, randomUUID()), 404)).code).toBe("unit_not_found");
    // Otto leads the project, not its parent: he opens it (403, not 404) but assigns nothing.
    expect((await fails(assign(otto, web), 403)).code).toBe("forbidden");
    expect(
      (await fails(otto.request("DELETE", `/api/v1/work-projects/${portal}/teams/${mobile}`), 403)).code,
    ).toBe("forbidden");
    // Oscar cannot open it: the refusal is the unknown-id 404.
    expect((await fails(assign(oscar, web), 404)).code).toBe("not_found");
  });

  it("lists assignable teams and departments, never projects or assigned units, filtered by name", async () => {
    const all = await ok(lena.request("GET", `/api/v1/work-projects/${portal}/assignable-teams`));
    expect(all.teams.map((t: { name: string }) => t.name)).toEqual(["Web"]);
    const none = await ok(lena.request("GET", `/api/v1/work-projects/${portal}/assignable-teams?q=mob`));
    expect(none.teams).toEqual([]);
    const byName = await ok(lena.request("GET", `/api/v1/work-projects/${portal}/assignable-teams?q=WE`));
    // Web's subtree: Lena, Dana, and Otto through the portal under it.
    expect(byName.teams).toEqual([{ id: web, name: "Web", kind: "team", memberCount: 3 }]);
    // Wildcards are plain text.
    expect(
      (await ok(lena.request("GET", `/api/v1/work-projects/${portal}/assignable-teams?q=%25`))).teams,
    ).toEqual([]);
    await fails(otto.request("GET", `/api/v1/work-projects/${portal}/assignable-teams`), 403);
  });

  it("removes an assigned team (audited) and refuses one that is not assigned", async () => {
    const detail = await ok(lena.request("DELETE", `/api/v1/work-projects/${portal}/teams/${mobile}`));
    expect(detail.teams.map((t: { id: string }) => t.id)).toEqual([engineering]);
    expect((await audits("work_project.team_removed", portal)).map((a) => a.metadata)).toEqual([
      { teamId: mobile },
    ]);
    expect(
      (await fails(lena.request("DELETE", `/api/v1/work-projects/${portal}/teams/${mobile}`), 404)).code,
    ).toBe("team_not_assigned");
  });

  it("a project lead who can use the device links its repository; without device.use the link is refused", async () => {
    const linked = await ok(
      lena.request("POST", `/api/v1/work-projects/${portal}/repos`, { projectId: lenaMac.repo["web-app"] }),
    );
    expect(linked.repos).toEqual([
      {
        projectId: lenaMac.repo["web-app"],
        name: "web-app",
        deviceId: lenaMac.deviceId,
        deviceName: "Lena's Mac",
        deviceOnline: true,
        branch: "main",
        available: true,
      },
    ]);
    expect((await audits("work_project.repo_linked", portal)).map((a) => a.metadata)).toEqual([
      { projectId: lenaMac.repo["web-app"], deviceId: lenaMac.deviceId },
    ]);
    const link = (repo: string, as: TestClient = lena, unitId = portal) =>
      as.request("POST", `/api/v1/work-projects/${unitId}/repos`, { projectId: repo });
    // Lena manages the project but cannot use Dana's PC; an admin cannot either (device.use is relation-only).
    expect((await fails(link(danaPc.repo.api!), 403)).details).toMatchObject({ permission: "device.use" });
    expect((await fails(link(danaPc.repo.api!, victor), 403)).details).toMatchObject({
      permission: "device.use",
    });
    // One team project per repository.
    billing = (await ok(lena.request("POST", "/api/v1/work-projects", { name: "Billing", parentId: web })))
      .id;
    expect((await fails(link(lenaMac.repo["web-app"]!, lena, billing), 409)).code).toBe(
      "repo_already_linked",
    );
    expect((await fails(link(lenaMac.repo["web-app"]!), 409)).code).toBe("repo_already_linked");
    // Org B's repository is not found; a plain member manages nothing.
    expect((await fails(link(eveBox.repo.evil!), 404)).code).toBe("project_not_found");
    expect((await fails(link(lenaMac.repo.docs!, dana), 403)).code).toBe("forbidden");
  });

  it("lists linkable repositories on the devices the caller can use, naming the project of a linked one", async () => {
    const mine = await ok(lena.request("GET", `/api/v1/work-projects/${billing}/linkable-repos`));
    expect(mine.devices).toEqual([
      {
        deviceId: lenaMac.deviceId,
        deviceName: "Lena's Mac",
        deviceOnline: true,
        repos: [
          { projectId: lenaMac.repo.docs, name: "docs", linkedTo: null },
          {
            projectId: lenaMac.repo["web-app"],
            name: "web-app",
            linkedTo: { id: portal, name: "Customer portal" },
          },
        ],
      },
    ]);
    // Otto manages the portal but uses no device: nothing to link.
    expect((await ok(otto.request("GET", `/api/v1/work-projects/${portal}/linkable-repos`))).devices).toEqual(
      [],
    );
    await fails(dana.request("GET", `/api/v1/work-projects/${portal}/linkable-repos`), 403);
  });

  it("the unlink impact is the server's count of the repository's sessions; unlinking is audited with it", async () => {
    const ws = await ok(
      lena.request("POST", "/api/v1/work-sessions", { projectId: lenaMac.repo["web-app"] }),
    );
    expect(ws.id).toBeTruthy();
    const path = `/api/v1/work-projects/${portal}/repos/${lenaMac.repo["web-app"]}`;
    expect(await ok(lena.request("GET", `${path}/impact`))).toEqual({ sessions: 1 });
    // A manager who uses no device gets the same count.
    expect(await ok(otto.request("GET", `${path}/impact`))).toEqual({ sessions: 1 });
    await fails(dana.request("GET", `${path}/impact`), 403);
    await fails(dana.request("DELETE", path), 403);
    expect(
      (
        await fails(
          lena.request("GET", `/api/v1/work-projects/${billing}/repos/${lenaMac.repo["web-app"]}/impact`),
          404,
        )
      ).code,
    ).toBe("repo_not_linked");

    // Otto unlinks without using the device: unlinking only narrows (the must-have names linking only).
    const detail = await ok(otto.request("DELETE", path));
    expect(detail.repos).toEqual([]);
    expect((await audits("work_project.repo_unlinked", portal)).map((a) => a.metadata)).toEqual([
      { projectId: lenaMac.repo["web-app"], deviceId: lenaMac.deviceId, sessions: 1 },
    ]);
    await fails(otto.request("DELETE", path), 404);
    // Linked again for the rest of the suite.
    await ok(
      lena.request("POST", `/api/v1/work-projects/${portal}/repos`, { projectId: lenaMac.repo["web-app"] }),
    );
  });

  it("project leads switch the default (audited once per change); a plain member cannot; absent row = project", async () => {
    expect((await ok(dana.request("GET", `/api/v1/work-projects/${portal}`))).defaultVisibility).toBe(
      "project",
    );
    const patch = (as: TestClient, v: string) =>
      as.request("PATCH", `/api/v1/work-projects/${portal}`, { defaultVisibility: v });
    expect((await ok(patch(otto, "owner"))).defaultVisibility).toBe("owner");
    await ok(patch(otto, "owner"));
    expect((await audits("work_project.default_changed", portal)).map((a) => a.metadata)).toEqual([
      { from: "project", to: "owner" },
    ]);
    expect((await fails(patch(dana, "project"), 403)).code).toBe("forbidden");
    expect((await fails(patch(oscar, "project"), 404)).code).toBe("not_found");
    await fails(patch(otto, "teams"), 400);
    expect((await ok(lena.request("GET", `/api/v1/work-projects/${portal}`))).defaultVisibility).toBe(
      "owner",
    );
    // A lead above the project (Lena leads Web) changes it too.
    expect((await ok(patch(lena, "project"))).defaultVisibility).toBe("project");
  });

  it("every write announces work_project.updated with the unit id only", async () => {
    const events = await orgEvents("work_project.updated");
    expect(events.length).toBeGreaterThanOrEqual(8);
    for (const e of events) expect(Object.keys(e)).toEqual(["unitId"]);
    expect(new Set(events.map((e) => e.unitId))).toEqual(new Set([portal]));
  });

  it("organization B reaches none of A's projects, teams or repositories, on every route (registry-derived)", async () => {
    const eveProject = (
      await ok(
        eve.request("POST", "/api/v1/work-projects", {
          name: "Evil plan",
          parentId: eveUnit,
        }),
      )
    ).id as string;
    const repo = lenaMac.repo["web-app"]!;
    const snapshot = async () =>
      JSON.stringify(
        (
          await su.query(
            `select (select json_agg(t order by t.project_unit_id, t.team_unit_id) from app.work_project_teams t where organization_id = $1) as teams,
                    (select json_agg(r order by r.project_id) from app.work_project_repos r where organization_id = $1) as repos,
                    (select json_agg(s order by s.unit_id) from app.work_project_settings s where organization_id = $1) as settings,
                    (select count(*) from app.org_units where organization_id = $1) as units`,
            [orgA],
          )
        ).rows[0],
      );
    const before = await snapshot();
    const notFound = async (res: Promise<Res>) => (await fails(res, 404)).code;
    const P = `/api/v1/work-projects/${portal}`;
    const cases: Record<string, () => Promise<unknown>> = {
      "GET /api/v1/work-projects": async () =>
        expect(
          (await ok(eve.request("GET", "/api/v1/work-projects"))).teamProjects.map(
            (p: { id: string }) => p.id,
          ),
        ).toEqual([eveProject]),
      "GET /api/v1/work-projects/parents": async () =>
        expect(
          (await ok(eve.request("GET", "/api/v1/work-projects/parents"))).parents.map(
            (p: { id: string }) => p.id,
          ),
        ).toEqual([eveUnit]),
      "POST /api/v1/work-projects": async () =>
        expect(
          await notFound(eve.request("POST", "/api/v1/work-projects", { name: "X", parentId: web })),
        ).toBe("unit_not_found"),
      "GET /api/v1/work-projects/:unitId": async () => notFound(eve.request("GET", P)),
      "PATCH /api/v1/work-projects/:unitId": async () =>
        notFound(eve.request("PATCH", P, { defaultVisibility: "owner" })),
      "GET /api/v1/work-projects/:unitId/assignable-teams": async () =>
        notFound(eve.request("GET", `${P}/assignable-teams`)),
      "POST /api/v1/work-projects/:unitId/teams": async () => {
        await notFound(eve.request("POST", `${P}/teams`, { unitId: eveUnit }));
        // Her own project never takes A's team.
        expect(
          await notFound(eve.request("POST", `/api/v1/work-projects/${eveProject}/teams`, { unitId: web })),
        ).toBe("unit_not_found");
      },
      "DELETE /api/v1/work-projects/:unitId/teams/:teamId": async () =>
        notFound(eve.request("DELETE", `${P}/teams/${engineering}`)),
      "GET /api/v1/work-projects/:unitId/linkable-repos": async () =>
        notFound(eve.request("GET", `${P}/linkable-repos`)),
      "POST /api/v1/work-projects/:unitId/repos": async () => {
        await notFound(eve.request("POST", `${P}/repos`, { projectId: eveBox.repo.evil }));
        expect(
          await notFound(
            eve.request("POST", `/api/v1/work-projects/${eveProject}/repos`, { projectId: repo }),
          ),
        ).toBe("project_not_found");
      },
      "GET /api/v1/work-projects/:unitId/repos/:projectId/impact": async () =>
        notFound(eve.request("GET", `${P}/repos/${repo}/impact`)),
      "DELETE /api/v1/work-projects/:unitId/repos/:projectId": async () =>
        notFound(eve.request("DELETE", `${P}/repos/${repo}`)),
    };
    const routes = stack.built.authz.routes;
    const registered = [...routes.keys()].filter((k) => / \/api\/v1\/work-projects/u.test(k)).sort();
    expect(registered).toEqual(Object.keys(cases).sort());
    for (const [key, run] of Object.entries(cases)) {
      expect(routes.get(key), key).toBe("user");
      await run();
    }
    expect(await snapshot()).toBe(before);
  });

  it("a project with a linked repository cannot be deleted; unlinked, it goes with its settings and teams", async () => {
    expect((await fails(victor.request("DELETE", `/api/v1/units/${portal}`), 409)).code).toBe(
      "unit_has_repositories",
    );
    await ok(lena.request("DELETE", `/api/v1/work-projects/${portal}/repos/${lenaMac.repo["web-app"]}`));
    await ok(lena.request("PATCH", `/api/v1/work-projects/${portal}`, { defaultVisibility: "owner" }));
    await ok(victor.request("DELETE", `/api/v1/units/${portal}`));
    for (const table of ["work_project_settings", "work_project_teams"]) {
      const col = table === "work_project_settings" ? "unit_id" : "project_unit_id";
      expect((await su.query(`select 1 from app.${table} where ${col} = $1`, [portal])).rowCount, table).toBe(
        0,
      );
    }
  });

  it("deleting a team assigned to a project records the unassignment and announces the project", async () => {
    const temp = await unit("team", "Temp", engineering);
    await ok(lena.request("POST", `/api/v1/work-projects/${billing}/teams`, { unitId: temp }));
    await ok(victor.request("DELETE", `/api/v1/units/${temp}`));
    const [deleted] = await audits("unit.deleted", temp);
    expect(deleted?.metadata).toMatchObject({ unassignedFromProjectIds: [billing] });
    expect(await orgEvents("work_project.updated")).toContainEqual({ unitId: billing });
  });
});

describe("the projects index, the creatable parents and Project.teamProject (D-01, D-13 start rule, R5, R6)", () => {
  let sam: TestClient;
  let billing = "";

  beforeAll(async () => {
    ({ client: sam } = await invite(stack, victor, "sam@example.test", "Sam Standard", "standard"));
    billing = (await su.query("select id from app.org_units where name = 'Billing'")).rows[0].id as string;
    await ok(
      lena.request("POST", `/api/v1/work-projects/${billing}/repos`, { projectId: lenaMac.repo.docs }),
    );
    // Dana's repository in Billing (a fixture: Lena cannot use Dana's PC, so no route would link it for her).
    await su.query(
      "insert into app.work_project_repos (organization_id, project_id, device_id, unit_id, linked_by) values ($1, $2, $3, $4, $5)",
      [orgA, danaPc.repo.api, danaPc.deviceId, billing, lenaId],
    );
    // Everyone may use Lena's Mac.
    await ok(lena.request("PATCH", `/api/v1/devices/${lenaMac.deviceId}`, { shared: true }));
  });

  const names = (list: Array<{ name: string }>) => list.map((x) => x.name);

  it("lists the projects the caller can open with counts, their usable unlinked repos and whether they may create", async () => {
    const mine = await ok(lena.request("GET", "/api/v1/work-projects"));
    expect(mine).toEqual({
      teamProjects: [
        { id: billing, name: "Billing", trail: ["Engineering", "Web"], peopleCount: 1, repoCount: 2 },
      ],
      personalRepos: [
        {
          projectId: lenaMac.repo["web-app"],
          name: "web-app",
          deviceId: lenaMac.deviceId,
          deviceName: "Lena's Mac",
          deviceOnline: true,
        },
      ],
      viewerCan: { create: true },
    });
    // Platform exists, but Lena has no access: absent, never named.
    expect(JSON.stringify(mine)).not.toContain(platform);

    const admin = await ok(victor.request("GET", "/api/v1/work-projects"));
    expect(names(admin.teamProjects)).toEqual(["Billing", "Platform"]);
    expect(names(admin.personalRepos)).toEqual(["web-app"]);
    expect(admin.viewerCan).toEqual({ create: true });

    const plain = await ok(dana.request("GET", "/api/v1/work-projects"));
    expect(plain.teamProjects).toEqual([]);
    expect(names(plain.personalRepos)).toEqual(["web-app"]);
    expect(plain.viewerCan).toEqual({ create: false });

    expect((await fails(sam.request("GET", "/api/v1/work-projects"), 403)).details).toMatchObject({
      permission: "work_session.read",
    });
    expect(
      (await ok(eve.request("GET", "/api/v1/work-projects"))).teamProjects.map((p: { id: string }) => p.id),
    ).not.toContain(billing);
  });

  it("D-14: linkable repositories name a linked project only to someone who can open it", async () => {
    // Otto creates a project under Mobile (he leads it) and may use Lena's shared Mac; docs is in Billing, which he
    // cannot open.
    const apps = (await ok(otto.request("POST", "/api/v1/work-projects", { name: "Apps", parentId: mobile })))
      .id as string;
    const otto_ = await ok(otto.request("GET", `/api/v1/work-projects/${apps}/linkable-repos`));
    const mac = (otto_.devices as Array<{ deviceId: string; repos: unknown[] }>).find(
      (d) => d.deviceId === lenaMac.deviceId,
    );
    expect(mac?.repos).toEqual([
      { projectId: lenaMac.repo.docs, name: "docs", linkedTo: null, linkedToHidden: true },
      { projectId: lenaMac.repo["web-app"], name: "web-app", linkedTo: null },
    ]);
    expect(JSON.stringify(otto_)).not.toContain("Billing");
    await ok(victor.request("DELETE", `/api/v1/units/${apps}`));
    // Lena leads Billing: she sees its name.
    const lena_ = await ok(lena.request("GET", `/api/v1/work-projects/${billing}/linkable-repos`));
    expect(
      (lena_.devices as Array<{ repos: Array<{ name: string; linkedTo: unknown }> }>)
        .flatMap((d) => d.repos)
        .find((r) => r.name === "docs")?.linkedTo,
    ).toEqual({ id: billing, name: "Billing" });
  });

  it("lists the teams and departments where the caller may create a project, never a project", async () => {
    expect((await ok(lena.request("GET", "/api/v1/work-projects/parents"))).parents).toEqual([
      { id: web, name: "Web", kind: "team", trail: ["Engineering"] },
    ]);
    expect((await ok(victor.request("GET", "/api/v1/work-projects/parents"))).parents).toEqual([
      { id: engineering, name: "Engineering", kind: "department", trail: [] },
      { id: mobile, name: "Mobile", kind: "team", trail: ["Engineering"] },
      { id: web, name: "Web", kind: "team", trail: ["Engineering"] },
    ]);
    expect((await ok(dana.request("GET", "/api/v1/work-projects/parents"))).parents).toEqual([]);
    expect((await ok(otto.request("GET", "/api/v1/work-projects/parents"))).parents).toEqual([
      { id: mobile, name: "Mobile", kind: "team", trail: ["Engineering"] },
    ]);
    const eveParents = (await ok(eve.request("GET", "/api/v1/work-projects/parents"))).parents;
    expect(eveParents.map((p: { id: string }) => p.id)).toEqual([eveUnit]);
  });

  it("GET /projects names each repo's team project, hides the ones the caller cannot open, keeps device.use", async () => {
    type P = { id: string; name: string; teamProject?: unknown };
    const list = async (as: TestClient) => (await ok(as.request("GET", "/api/v1/projects"))).projects as P[];
    const billingRef = { id: billing, name: "Billing", defaultVisibility: "project" };

    // Lena: docs in Billing, web-app personal; Dana's api is in her project but on a device she cannot use.
    expect((await list(lena)).map((p) => [p.name, p.teamProject])).toEqual([
      ["docs", billingRef],
      ["web-app", null],
    ]);
    // Oscar can use the shared Mac but cannot open Billing: docs is absent.
    expect((await list(oscar)).map((p) => [p.name, p.teamProject])).toEqual([["web-app", null]]);
    // Dana's PC: its repo is in a project she cannot open. As its device owner she still lists it (D-14), without the
    // project's name; starting there needs project access (D-13), so the repo is marked, never offered as personal.
    expect(
      (await list(dana)).map((p) => [
        p.name,
        p.teamProject,
        (p as { teamProjectHidden?: boolean }).teamProjectHidden,
      ]),
    ).toEqual([
      ["api", null, true],
      ["web-app", null, undefined],
    ]);
    expect(JSON.stringify(await list(dana))).not.toContain("Billing");
    // An admin opens every project but still only lists repos on devices they can use.
    expect((await list(victor)).map((p) => [p.name, p.teamProject])).toEqual([
      ["docs", billingRef],
      ["web-app", null],
    ]);

    // Oscar is not the device owner of the shared Mac: a repo in a project he cannot open stays absent (no flag).
    expect(JSON.stringify(await list(oscar))).not.toContain("teamProjectHidden");

    await ok(lena.request("PATCH", `/api/v1/work-projects/${billing}`, { defaultVisibility: "owner" }));
    expect((await list(lena)).find((p) => p.name === "docs")?.teamProject).toEqual({
      ...billingRef,
      defaultVisibility: "owner",
    });
  });
});

describe("D-14: managing a project opens its page", () => {
  it("a lead of the parent who is not in the project opens it and finds it in the index; others still get the 404", async () => {
    const ledger = (
      await ok(lena.request("POST", "/api/v1/work-projects", { name: "Ledger", parentId: web }))
    ).id as string;
    try {
      // Lena leaves the project but still leads Web, its parent: she manages it (D-10) without project access.
      await ok(victor.request("DELETE", `/api/v1/units/${ledger}/members/${lenaId}`));
      const page = await ok(lena.request("GET", `/api/v1/work-projects/${ledger}`));
      expect(WorkProjectDetail.safeParse(page).success).toBe(true);
      expect(page).toMatchObject({
        id: ledger,
        access: { count: 0, people: [] },
        viewerCan: { manage: true, assignTeams: true, members: true },
      });
      const index = await ok(lena.request("GET", "/api/v1/work-projects"));
      expect(index.teamProjects.map((p: { id: string }) => p.id)).toContain(ledger);

      // A plain member of Web, another team's lead and org B still get the unknown-id 404 and no index row.
      const unknown = await fails(oscar.request("GET", `/api/v1/work-projects/${randomUUID()}`), 404);
      for (const outsider of [dana, otto, eve]) {
        expect(await fails(outsider.request("GET", `/api/v1/work-projects/${ledger}`), 404)).toEqual(unknown);
        const theirs = await outsider.request("GET", "/api/v1/work-projects");
        expect(JSON.stringify(theirs.body)).not.toContain(ledger);
      }
    } finally {
      await ok(victor.request("DELETE", `/api/v1/units/${ledger}`));
    }
  });
});
