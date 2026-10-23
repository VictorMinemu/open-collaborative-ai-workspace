import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "./testing";
import { FakeDevice } from "./testing-device";
import {
  createTeamProject,
  invite,
  linkRepo,
  pairDevice,
  shareDevice,
  startSession,
} from "./testing-workzone";

/**
 * Phase 07.9-03 (P-07): the fixture helpers that give a test explicit access to another member's session write
 * exactly the access they claim — a team project with the given members (`createTeamProject`), one repo link
 * (`linkRepo`) and a device grant (`shareDevice`) — and that access is a fact of the D-06 audience rule
 * (`app.work_session_access`), so tests built on them stay valid when the flip (07.9-05) narrows visibility.
 */

const ADMIN = { name: "Víctor Ruiz", email: "victor@example.test", password: "correct-horse-battery" };

let stack: TestStack;
let su: pg.Client;
let admin: TestClient;
let orgId: string;
let adminId: string;
let ana: TestClient;
let anaId: string;
let pia: TestClient;
let piaId: string;
let leeId: string;
let gus: TestClient;
let gusId: string;
let device: FakeDevice;
let deviceId: string;
/** Ana's two repos: `billing-api` (linked to a team project below) and `notes` (personal). */
let billingId: string;
let notesId: string;

beforeAll(async () => {
  stack = await startTestStack();
  su = new pg.Client({ connectionString: stack.db.superuserUrl });
  await su.connect();
  admin = new TestClient(stack.baseUrl);
  const setup = await admin.request("POST", "/api/v1/setup", {
    token: TEST_SETUP_TOKEN,
    ...ADMIN,
    orgName: "Autofy Labs",
  });
  expect(setup.status).toBe(200);
  orgId = (setup.body!.organization as { id: string }).id;
  adminId = (setup.body!.user as { id: string }).id;
  ({ client: ana, userId: anaId } = await invite(stack, admin, "ana@example.test", "Ana", "developer"));
  ({ client: pia, userId: piaId } = await invite(stack, admin, "pia@example.test", "Pia", "developer"));
  ({ userId: leeId } = await invite(stack, admin, "lee@example.test", "Lee", "lead"));
  ({ client: gus, userId: gusId } = await invite(stack, admin, "gus@example.test", "Gus", "developer"));
  const paired = await pairDevice(stack, ana, "Ana's MacBook");
  deviceId = paired.deviceId;
  device = await FakeDevice.connect(stack.baseUrl, paired.token);
  device.send({
    type: "projects.sync",
    projects: [
      { localId: "lp_billing", name: "billing-api", gitRemote: null, defaultBranch: "main" },
      { localId: "lp_notes", name: "notes", gitRemote: null, defaultBranch: "main" },
    ],
  });
  await device.next((f) => f.type === "projects.ack");
  const projects = (await ana.request("GET", "/api/v1/projects")).body!.projects as Array<{
    id: string;
    name: string;
  }>;
  billingId = projects.find((p) => p.name === "billing-api")!.id;
  notesId = projects.find((p) => p.name === "notes")!.id;
}, 180_000);

afterAll(async () => {
  try {
    await device?.close().catch(() => {});
    await su?.end();
  } finally {
    await stack?.stop();
  }
});

/** The audience facts of `userId` on a session, from the D-06 rule itself (what 07.9-05's resolver reads). */
function accessOf(sessionId: string, userId: string): Promise<string[]> {
  return stack.built.core.db.withTenant({ organizationId: orgId, userId: null }, async (tx) => {
    const r = await tx.execute(sql`select app.work_session_access(${sessionId}::uuid, ${userId}::uuid) as a`);
    return [...((r.rows[0] as { a: string[] }).a ?? [])].sort();
  });
}

/** The PostgreSQL constraint a failed write names (drizzle wraps the driver error in `cause`). */
async function violatedConstraint(write: Promise<unknown>): Promise<string | undefined> {
  try {
    await write;
  } catch (err) {
    for (let e: unknown = err; e && typeof e === "object"; e = (e as { cause?: unknown }).cause) {
      const c = (e as { constraint?: unknown }).constraint;
      if (typeof c === "string") return c;
    }
    throw err;
  }
  throw new Error("the write succeeded");
}

const projectsOf = async (as: TestClient) =>
  ((await as.request("GET", "/api/v1/projects")).body!.projects as Array<{ id: string }>).map((p) => p.id);

describe("createTeamProject", () => {
  it("creates a project unit under a new department with exactly the given members and roles", async () => {
    const team = await createTeamProject(stack, admin, {
      name: "Billing",
      members: [{ userId: anaId }, { userId: piaId, role: "member" }, { userId: leeId, role: "lead" }],
    });
    const units = (await admin.request("GET", "/api/v1/units")).body!.units as Array<{
      id: string;
      kind: string;
      parentId: string | null;
    }>;
    const unit = units.find((u) => u.id === team.unitId);
    const parent = units.find((u) => u.id === team.parentId);
    expect(unit).toMatchObject({ kind: "project", parentId: team.parentId });
    expect(parent).toMatchObject({ kind: "department", parentId: null });

    const members = (await admin.request("GET", `/api/v1/units/${team.unitId}/members`)).body!
      .members as Array<{
      userId: string;
      role: string;
    }>;
    expect(members.map((m) => [m.userId, m.role]).sort()).toEqual(
      [
        [anaId, "member"],
        [piaId, "member"],
        [leeId, "lead"],
      ].sort(),
    );
    // The department itself has no members: access comes from the project unit only.
    const deptMembers = await admin.request("GET", `/api/v1/units/${team.parentId}/members`);
    expect(deptMembers.body!.members).toEqual([]);
  });

  it("places the project under a given parent without creating a department", async () => {
    const first = await createTeamProject(stack, admin, { name: "Platform", members: [] });
    const before = ((await admin.request("GET", "/api/v1/units")).body!.units as unknown[]).length;
    const second = await createTeamProject(stack, admin, {
      name: "Platform tools",
      members: [{ userId: gusId }],
      parentId: first.parentId,
    });
    expect(second.parentId).toBe(first.parentId);
    const after = ((await admin.request("GET", "/api/v1/units")).body!.units as unknown[]).length;
    expect(after).toBe(before + 1);
  });
});

describe("linkRepo", () => {
  it("writes one link for the repo, its device and the unit; a second link of the same repo is refused", async () => {
    const team = await createTeamProject(stack, admin, {
      name: "Payments",
      members: [{ userId: anaId }, { userId: piaId }],
    });
    await linkRepo(stack, {
      organizationId: orgId,
      unitId: team.unitId,
      projectId: billingId,
      deviceId,
      linkedBy: anaId,
    });
    const rows = await su.query(
      "select organization_id, project_id, device_id, unit_id, linked_by from app.work_project_repos where project_id = $1",
      [billingId],
    );
    expect(rows.rows).toEqual([
      {
        organization_id: orgId,
        project_id: billingId,
        device_id: deviceId,
        unit_id: team.unitId,
        linked_by: anaId,
      },
    ]);

    // One team project per repo.
    const other = await createTeamProject(stack, admin, { name: "Refunds", members: [] });
    expect(
      await violatedConstraint(
        linkRepo(stack, {
          organizationId: orgId,
          unitId: other.unitId,
          projectId: billingId,
          deviceId,
          linkedBy: adminId,
        }),
      ),
    ).toBe("work_project_repos_pkey");
    expect((await su.query("select count(*)::int as n from app.work_project_repos")).rows[0].n).toBe(1);
  });

  it("refuses a link written in another organization's context (composite FK)", async () => {
    const orgB = randomUUID();
    await su.query("insert into auth.organization (id, name, slug) values ($1, 'Other', $2)", [
      orgB,
      `o-${orgB}`,
    ]);
    const team = await createTeamProject(stack, admin, { name: "Ledger", members: [] });
    // The repo, its device and the unit all belong to org A: no row of org B matches the composite keys.
    expect(
      await violatedConstraint(
        linkRepo(stack, {
          organizationId: orgB,
          unitId: team.unitId,
          projectId: notesId,
          deviceId,
          linkedBy: anaId,
        }),
      ),
    ).toMatch(/^work_project_repos_(project|unit)_fk$/);
    expect(
      (
        await su.query("select count(*)::int as n from app.work_project_repos where project_id = $1", [
          notesId,
        ])
      ).rows[0].n,
    ).toBe(0);
  });

  it("gives a fellow project member the viewer fact on a session of the linked repo, and nobody else", async () => {
    const id = await startSession(ana, device, billingId);
    expect(await accessOf(id, piaId)).toEqual(["viewer"]);
    expect(await accessOf(id, anaId)).toEqual(["creator", "device_owner", "viewer"]);
    expect(await accessOf(id, gusId)).toEqual([]);
  });
});

describe("shareDevice", () => {
  it("lets the grantee list the owner's repos and gives them the viewer fact on a personal session", async () => {
    expect(await projectsOf(gus)).not.toContain(notesId);
    const id = await startSession(ana, device, notesId);
    expect(await accessOf(id, gusId)).toEqual([]);

    await shareDevice(ana, deviceId, gusId);

    expect(await projectsOf(gus)).toContain(notesId);
    const grants = await su.query(
      "select principal_kind, max_mode, revoked_at from app.device_grants where device_id = $1 and principal_id = $2",
      [deviceId, gusId],
    );
    expect(grants.rows).toEqual([{ principal_kind: "user", max_mode: "default", revoked_at: null }]);
    expect(await accessOf(id, gusId)).toEqual(["viewer"]);
    // Pia has neither the share nor a project with this repo.
    expect(await accessOf(id, piaId)).toEqual([]);
  });

  it("passes the given max mode", async () => {
    expect(await projectsOf(pia)).not.toContain(notesId);
    await shareDevice(ana, deviceId, piaId, "plan");
    expect(await projectsOf(pia)).toContain(notesId);
    const grants = await su.query(
      "select max_mode from app.device_grants where device_id = $1 and principal_id = $2",
      [deviceId, piaId],
    );
    expect(grants.rows).toEqual([{ max_mode: "plan" }]);
  });
});
