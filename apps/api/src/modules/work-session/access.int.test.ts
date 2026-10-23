import { randomUUID } from "node:crypto";
import { deviceGrants, devices, type Tx } from "@ocw/db";
import { sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestStack, type TestStack } from "../../testing";
import { deviceModeCap, type GrantRow, loadDeviceAccess } from "../device";

/**
 * Phase 07.9-05 (C-01, P-03, ADR-0030): the one SQL rule and its TypeScript twin agree.
 *
 * 1. A personal project's audience is the use of its device. `app.work_session_access` re-states that rule in SQL (so
 *    lists, counts and the RLS backstop can use it); `deviceModeCap(...) !== null` is the TypeScript rule every device
 *    decision uses. On generated fixtures (shared × user grant × unit grant × membership, revoked rows included) the
 *    SQL fact `viewer` on a personal `project` session ⇔ the member's cap on its device is not null.
 * 2. `app.work_session_viewers` (the popover footer and the live fan-out) lists exactly the active members whose facts
 *    from `app.work_session_access` let them see the session (creator, creator who left, device owner, viewer): no
 *    admin for being an admin, no lead of the project who is outside the audience.
 *
 * Fixtures are seeded as the superuser in a fresh organization; every comparison runs as the app role inside a tenant
 * transaction, as the API does.
 */

let stack: TestStack;
let su: pg.Client;

const ORG = randomUUID();
const OTHER_ORG = randomUUID();
const OWNER = randomUUID();
const ADMIN = randomUUID();
const OUTSIDER_ORG_USER = randomUUID();
const UNIT = {
  dept: randomUUID(),
  team: randomUUID(),
  sibling: randomUUID(),
  project: randomUUID(),
} as const;

type Membership = "none" | "team" | "dept" | "sibling";
type UnitGrant = "none" | "team" | "dept" | "revoked";
type UserGrant = "none" | "active" | "revoked";

interface Combo {
  shared: boolean;
  userGrant: UserGrant;
  unitGrant: UnitGrant;
  membership: Membership;
}

/** Every combination of the dimensions: 2 × 3 × 4 × 4 = 96 fixtures (each a device, a member and a session). */
const COMBOS: Combo[] = [];
for (const shared of [false, true])
  for (const userGrant of ["none", "active", "revoked"] as const)
    for (const unitGrant of ["none", "team", "dept", "revoked"] as const)
      for (const membership of ["none", "team", "dept", "sibling"] as const)
        COMBOS.push({ shared, userGrant, unitGrant, membership });

interface Fixture extends Combo {
  user: string;
  device: string;
  project: string;
  session: string;
}
let fixtures: Fixture[] = [];
/** Team-project sessions (audiences project, owner, teams, people; a creator who left). */
const teamSessions: string[] = [];

const UNIT_OF: Record<Exclude<Membership, "none">, string> = {
  team: UNIT.team,
  dept: UNIT.dept,
  sibling: UNIT.sibling,
};

beforeAll(async () => {
  stack = await startTestStack();
  su = new pg.Client({ connectionString: stack.db.superuserUrl });
  await su.connect();
  const q = (text: string, values: unknown[]) => su.query(text, values);

  for (const org of [ORG, OTHER_ORG]) {
    await q("insert into auth.organization (id, name, slug) values ($1, 'Parity', $2)", [
      org,
      `parity-${org}`,
    ]);
  }
  const person = async (id: string, role: string, org = ORG) => {
    await q("insert into auth.user (id, name, email) values ($1, 'P', $2)", [id, `${id}@parity.test`]);
    await q(
      "insert into app.org_members (organization_id, user_id, display_name, role) values ($1, $2, 'P', $3)",
      [org, id, role],
    );
  };
  await person(OWNER, "developer");
  await person(ADMIN, "admin");
  await person(OUTSIDER_ORG_USER, "admin", OTHER_ORG);

  const unit = (id: string, kind: string, name: string, path: string[], parent: string | null) =>
    q(
      "insert into app.org_units (id, organization_id, parent_id, kind, name, path) values ($1, $2, $3, $4, $5, $6::uuid[])",
      [id, ORG, parent, kind, name, path],
    );
  await unit(UNIT.dept, "department", "Engineering", [UNIT.dept], null);
  await unit(UNIT.team, "team", "Platform", [UNIT.dept, UNIT.team], UNIT.dept);
  await unit(UNIT.sibling, "team", "Web", [UNIT.dept, UNIT.sibling], UNIT.dept);
  await unit(UNIT.project, "project", "Atlas", [UNIT.dept, UNIT.project], UNIT.dept);

  const membership = (unitId: string, userId: string, role = "member") =>
    q("insert into app.unit_memberships (organization_id, unit_id, user_id, role) values ($1, $2, $3, $4)", [
      ORG,
      unitId,
      userId,
      role,
    ]);
  const grant = (deviceId: string, kind: string, principal: string, revoked: boolean) =>
    q(
      "insert into app.device_grants (organization_id, device_id, principal_kind, principal_id, max_mode, revoked_at) values ($1, $2, $3, $4, 'acceptEdits', $5)",
      [ORG, deviceId, kind, principal, revoked ? new Date().toISOString() : null],
    );
  const session = async (
    id: string,
    projectId: string,
    deviceId: string,
    createdBy: string,
    visibility: string,
  ) => {
    const conv = randomUUID();
    await q(
      "insert into app.conversations (id, organization_id, kind, name) values ($1, $2, 'work_session', 'ws')",
      [conv, ORG],
    );
    await q(
      "insert into app.work_sessions (id, organization_id, conversation_id, project_id, device_id, title, created_by, visibility, status) values ($1, $2, $3, $4, $5, 'T', $6, $7, 'idle')",
      [id, ORG, conv, projectId, deviceId, createdBy, visibility],
    );
  };

  fixtures = COMBOS.map((c) => ({
    ...c,
    user: randomUUID(),
    device: randomUUID(),
    project: randomUUID(),
    session: randomUUID(),
  }));
  for (const f of fixtures) {
    await person(f.user, "developer");
    if (f.membership !== "none") await membership(UNIT_OF[f.membership], f.user);
    await q(
      "insert into app.devices (id, organization_id, owner_user_id, name, platform, token_hash, shared) values ($1, $2, $3, 'laptop', 'darwin', $4, $5)",
      [f.device, ORG, OWNER, `tok-${f.device}`, f.shared],
    );
    if (f.userGrant !== "none") await grant(f.device, "user", f.user, f.userGrant === "revoked");
    if (f.unitGrant !== "none") {
      await grant(
        f.device,
        "unit",
        f.unitGrant === "dept" ? UNIT.dept : UNIT.team,
        f.unitGrant === "revoked",
      );
    }
    await q(
      "insert into app.projects (id, organization_id, device_id, local_id, name) values ($1, $2, $3, $4, 'repo')",
      [f.project, ORG, f.device, `l-${f.project}`],
    );
    await session(f.session, f.project, f.device, OWNER, "project");
  }

  // Team project Atlas: a lead, two direct members, the Platform team assigned; four repos of the first devices linked.
  const [lead, memberA, memberB] = [fixtures[0]!.user, fixtures[1]!.user, fixtures[2]!.user];
  await membership(UNIT.project, lead, "lead");
  await membership(UNIT.project, memberA);
  await membership(UNIT.project, memberB);
  await q(
    "insert into app.work_project_teams (organization_id, project_unit_id, team_unit_id, assigned_by) values ($1, $2, $3, $4)",
    [ORG, UNIT.project, UNIT.team, ADMIN],
  );
  const audiences: Array<[string, string]> = [
    ["project", memberA],
    ["owner", memberA],
    ["teams", memberB],
    ["people", memberB],
    // Created by someone with no project access: `creator_left`.
    ["project", fixtures[40]!.user],
  ];
  for (const [i, [visibility, creator]] of audiences.entries()) {
    const f = fixtures[i]!;
    const repo = randomUUID();
    await q(
      "insert into app.projects (id, organization_id, device_id, local_id, name) values ($1, $2, $3, $4, 'team')",
      [repo, ORG, f.device, `t-${repo}`],
    );
    await q(
      "insert into app.work_project_repos (organization_id, project_id, device_id, unit_id, linked_by) values ($1, $2, $3, $4, $5)",
      [ORG, repo, f.device, UNIT.project, ADMIN],
    );
    const id = randomUUID();
    await session(id, repo, f.device, creator, visibility);
    if (visibility === "teams") {
      await q(
        "insert into app.work_session_grants (organization_id, work_session_id, subject_kind, subject_id, granted_by) values ($1, $2, 'unit', $3, $4)",
        [ORG, id, UNIT.team, creator],
      );
    }
    if (visibility === "people") {
      await q(
        "insert into app.work_session_grants (organization_id, work_session_id, subject_kind, subject_id, granted_by) values ($1, $2, 'user', $3, $4)",
        [ORG, id, memberA, creator],
      );
    }
    teamSessions.push(id);
  }
}, 240_000);

afterAll(async () => {
  try {
    await su?.end();
  } finally {
    await stack?.stop();
  }
});

const inTenant = <T>(fn: (tx: Tx) => Promise<T>) =>
  stack.built.core.db.withTenant({ organizationId: ORG, userId: null }, fn);

/** `app.work_session_access` for every (session, user) pair, in one query. */
async function accessMatrix(tx: Tx, sessions: string[], users: string[]): Promise<Map<string, string[]>> {
  const res = await tx.execute(sql`
    select s.id::text as s, u.id::text as u, app.work_session_access(s.id, u.id) as access
      from unnest(${`{${sessions.join(",")}}`}::uuid[]) as s(id)
      cross join unnest(${`{${users.join(",")}}`}::uuid[]) as u(id)`);
  const out = new Map<string, string[]>();
  for (const r of res.rows as Array<{ s: string; u: string; access: string[] }>)
    out.set(`${r.s}:${r.u}`, r.access);
  return out;
}

describe("personal projects: the SQL audience is deviceModeCap(...) !== null (P-03)", () => {
  it("covers at least 40 combinations of sharing, grants, revoked rows and memberships", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(40);
    expect(
      new Set(fixtures.map((f) => JSON.stringify([f.shared, f.userGrant, f.unitGrant, f.membership]))).size,
    ).toBe(fixtures.length);
  });

  it("for every member and every personal session: viewer ⇔ the member's cap on the device is not null", async () => {
    const mismatches: string[] = [];
    let yes = 0;
    let no = 0;
    await inTenant(async (tx) => {
      const users = [OWNER, ADMIN, ...fixtures.map((f) => f.user)];
      const sessions = fixtures.map((f) => f.session);
      const matrix = await accessMatrix(tx, sessions, users);
      const rows = await tx
        .select({
          id: devices.id,
          ownerUserId: devices.ownerUserId,
          shared: devices.shared,
          shareMaxMode: devices.shareMaxMode,
          revokedAt: devices.revokedAt,
        })
        .from(devices);
      const byId = new Map(rows.map((d) => [d.id, d]));
      const grants: GrantRow[] = (await tx.select().from(deviceGrants)).map((g) => ({
        deviceId: g.deviceId,
        principalKind: g.principalKind,
        principalId: g.principalId,
        maxMode: g.maxMode,
        revokedAt: g.revokedAt,
      }));
      for (const userId of users) {
        const access = await loadDeviceAccess(tx, userId);
        for (const f of fixtures) {
          const device = byId.get(f.device)!;
          const cap = deviceModeCap(device, grants, access.principal);
          // The API's own loader agrees with the pure function.
          expect(access.capOf(device)).toBe(cap);
          const viewer = (matrix.get(`${f.session}:${userId}`) ?? []).includes("viewer");
          if (viewer !== (cap !== null)) {
            mismatches.push(
              `${JSON.stringify({ ...f, user: userId === f.user ? "own" : userId })} sql=${viewer} ts=${cap}`,
            );
          }
          if (viewer) yes++;
          else no++;
        }
      }
    });
    expect(mismatches).toEqual([]);
    // The generator exercises both sides of the rule.
    expect(yes).toBeGreaterThan(100);
    expect(no).toBeGreaterThan(100);
  });

  it("a revoked user grant on a device shared with everyone does not hide its sessions (D-14)", async () => {
    const f = fixtures.find(
      (x) => x.shared && x.userGrant === "revoked" && x.unitGrant === "none" && x.membership === "none",
    )!;
    const access = await inTenant(async (tx) =>
      (await accessMatrix(tx, [f.session], [f.user])).get(`${f.session}:${f.user}`),
    );
    expect(access).toEqual(["viewer"]);
  });
});

describe("work_session_viewers lists exactly the people the access facts let see (P-03)", () => {
  it("for every session, personal and team project: viewers ⇔ facts ∩ {creator, creator_left, device_owner, viewer}", async () => {
    const SEEING = ["creator", "creator_left", "device_owner", "viewer"];
    await inTenant(async (tx) => {
      const members = (
        (await tx.execute(sql`select user_id::text as u from app.org_members where deactivated_at is null`))
          .rows as Array<{
          u: string;
        }>
      ).map((r) => r.u);
      const sessions = [...fixtures.map((f) => f.session), ...teamSessions];
      const matrix = await accessMatrix(tx, sessions, members);
      let adminOnly = 0;
      for (const s of sessions) {
        const listed = (
          (await tx.execute(sql`select user_id::text as u from app.work_session_viewers(${s}::uuid)`))
            .rows as Array<{
            u: string;
          }>
        )
          .map((r) => r.u)
          .sort();
        const expected = members
          .filter((u) => (matrix.get(`${s}:${u}`) ?? []).some((x) => SEEING.includes(x)))
          .sort();
        expect(listed, s).toEqual(expected);
        // Admins are never listed for being admins: where the admin's only fact is `admin` (no device use, no project
        // access), they are not a viewer; on a device shared with everyone they are, like any member.
        const adminFacts = matrix.get(`${s}:${ADMIN}`) ?? [];
        expect(adminFacts).toContain("admin");
        if (adminFacts.length === 1) {
          expect(listed).not.toContain(ADMIN);
          adminOnly++;
        }
      }
      expect(adminOnly).toBeGreaterThan(40);
    });
  });

  it("the team-project fixtures hit every audience path (viewer, creator_left, project_lead alone)", async () => {
    const lead = fixtures[0]!.user;
    const leftCreator = fixtures[40]!.user;
    const owner = teamSessions[1]!;
    await inTenant(async (tx) => {
      const m = await accessMatrix(tx, teamSessions, [lead, leftCreator]);
      // The lead sees the `project` session and is only `project_lead` on the `owner` one (not a viewer).
      expect(m.get(`${teamSessions[0]}:${lead}`)).toEqual(expect.arrayContaining(["viewer", "project_lead"]));
      expect(m.get(`${owner}:${lead}`)).not.toContain("viewer");
      expect(m.get(`${owner}:${lead}`)).toContain("project_lead");
      expect(m.get(`${teamSessions[4]}:${leftCreator}`)).toContain("creator_left");
    });
  });

  it("another organization's person has no facts on these sessions", async () => {
    await inTenant(async (tx) => {
      const m = await accessMatrix(tx, [fixtures[0]!.session, teamSessions[0]!], [OUTSIDER_ORG_USER]);
      for (const v of m.values()) expect(v).toEqual([]);
    });
  });
});
