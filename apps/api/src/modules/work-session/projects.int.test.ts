import { randomUUID } from "node:crypto";
import { WorkProjectDetail } from "@ocw/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";
import { invite } from "../../testing-workzone";

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
let engineering = "";
let web = "";
let mobile = "";

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
  const { client: danaClient, userId: danaId } = await invite(
    stack,
    victor,
    "dana@example.test",
    "Dana Dev",
    "developer",
  );
  dana = danaClient;
  ({ client: oscar } = await invite(stack, victor, "oscar@example.test", "Oscar Out", "developer"));
  const { client: ottoClient, userId: ottoId } = await invite(
    stack,
    victor,
    "otto@example.test",
    "Otto Other",
    "lead",
  );
  otto = ottoClient;
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
  await su?.end();
  await stack?.stop();
});

describe("a parent lead creates a team project (D-01, D-10, D-13)", () => {
  let portal = "";

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
    const roles = (await su.query("select role from app.unit_memberships where unit_id = $1", [created.id]))
      .rows;
    expect(roles).toEqual([{ role: "lead" }]);
  });
});
