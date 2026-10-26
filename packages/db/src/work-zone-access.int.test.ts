import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDatabase, type TestDatabase } from "./testing";

/**
 * Phase 07.9 (C-01, D-02, D-04, D-09, D-11, D-12; P-03): the one audience rule, as the SECURITY DEFINER functions of
 * post-migrate.sql. Everything is seeded as the migrator and every function is called as `ocw_app` inside a tenant
 * transaction, exactly as withTenant() does, then rolled back. The functions bypass RLS, so each test also proves that
 * they never reach past the caller's organization.
 */

let tdb: TestDatabase;
let migrator: pg.Client;
let app: pg.Client;

const A = randomUUID();
const B = randomUUID();

/** Org A people (each named for the relation the fixtures give them). */
const U = {
  admin: randomUUID(),
  deactivatedAdmin: randomUUID(),
  lead: randomUUID(),
  member: randomUUID(),
  creator: randomUUID(),
  leftCreator: randomUUID(),
  teamMember: randomUUID(),
  subTeamMember: randomUUID(),
  deptOnly: randomUUID(),
  staleTeamMember: randomUUID(),
  personX: randomUUID(),
  personY: randomUUID(),
  personGone: randomUUID(),
  deviceOwner: randomUUID(),
  personalOwner: randomUUID(),
  grantee: randomUUID(),
  revokedUser: randomUUID(),
  outsider: randomUUID(),
} as const;
type Person = keyof typeof U;

/** Org A units: two departments, three teams, two team projects (P default on, P2 default off). */
const UNIT = {
  d1: randomUUID(),
  d2: randomUUID(),
  t1: randomUUID(),
  t2: randomUUID(),
  sub: randomUUID(),
  p: randomUUID(),
  p2: randomUUID(),
} as const;

const DEV = { team: randomUUID(), personal: randomUUID(), shared: randomUUID() } as const;
const REPO = {
  p: randomUUID(),
  p2: randomUUID(),
  personal: randomUUID(),
  shared: randomUUID(),
} as const;

/** Sessions: the audience under test is in the name. */
const S = {
  project: randomUUID(),
  owner: randomUUID(),
  teams: randomUUID(),
  people: randomUUID(),
  left: randomUUID(),
  archived: randomUUID(),
  p2Project: randomUUID(),
  personal: randomUUID(),
  personalOwner: randomUUID(),
  shared: randomUUID(),
} as const;

/** Org B: one admin, one team project with a linked repo and a session. */
const BU = { admin: randomUUID(), member: randomUUID() };
const B_UNIT = randomUUID();
const B_PROJECT_UNIT = randomUUID();
const B_DEV = randomUUID();
const B_REPO = randomUUID();
const B_SESSION = randomUUID();

const FUNCTIONS = [
  "work_project_access(uuid,uuid)",
  "work_project_people(uuid)",
  "work_session_access(uuid,uuid)",
  "work_session_viewers(uuid)",
  "work_session_visibility_summary(uuid)",
  "work_project_repo_session_count(uuid)",
] as const;

async function seed(): Promise<void> {
  const q = (text: string, values: unknown[]) => migrator.query(text, values);
  for (const [org, name] of [
    [A, "Org A"],
    [B, "Org B"],
  ] as const) {
    await q("insert into auth.organization (id, name, slug) values ($1, $2, $3)", [org, name, `org-${org}`]);
  }
  const person = async (org: string, id: string, role: string, deactivated = false) => {
    await q("insert into auth.user (id, name, email) values ($1, 'P', $2)", [id, `${id}@example.test`]);
    await q(
      "insert into app.org_members (organization_id, user_id, display_name, role, deactivated_at) values ($1, $2, 'P', $3, $4)",
      [org, id, role, deactivated ? new Date().toISOString() : null],
    );
  };
  for (const [name, id] of Object.entries(U) as Array<[Person, string]>) {
    const role = name === "admin" || name === "deactivatedAdmin" ? "admin" : "standard";
    await person(A, id, role, name === "deactivatedAdmin");
  }
  await person(B, BU.admin, "admin");
  await person(B, BU.member, "standard");

  const unit = (org: string, id: string, kind: string, name: string, path: string[], parent: string | null) =>
    q(
      "insert into app.org_units (id, organization_id, parent_id, kind, name, path) values ($1, $2, $3, $4, $5, $6::uuid[])",
      [id, org, parent, kind, name, path],
    );
  await unit(A, UNIT.d1, "department", "Engineering", [UNIT.d1], null);
  await unit(A, UNIT.d2, "department", "Design", [UNIT.d2], null);
  await unit(A, UNIT.t1, "team", "Platform", [UNIT.d1, UNIT.t1], UNIT.d1);
  // Sorts before "Platform": a stale team must never be the first name of a summary.
  await unit(A, UNIT.t2, "team", "Alpha", [UNIT.d1, UNIT.t2], UNIT.d1);
  await unit(A, UNIT.sub, "team", "Brand", [UNIT.d2, UNIT.sub], UNIT.d2);
  await unit(A, UNIT.p, "project", "Atlas", [UNIT.d1, UNIT.p], UNIT.d1);
  await unit(A, UNIT.p2, "project", "Borealis", [UNIT.d1, UNIT.p2], UNIT.d1);
  await unit(B, B_UNIT, "team", "B team", [B_UNIT], null);
  await unit(B, B_PROJECT_UNIT, "project", "B project", [B_UNIT, B_PROJECT_UNIT], B_UNIT);

  const membership = (org: string, unitId: string, userId: string, role = "member") =>
    q("insert into app.unit_memberships (organization_id, unit_id, user_id, role) values ($1, $2, $3, $4)", [
      org,
      unitId,
      userId,
      role,
    ]);
  await membership(A, UNIT.p, U.lead, "lead");
  await membership(A, UNIT.p, U.member);
  await membership(A, UNIT.p, U.creator);
  await membership(A, UNIT.p, U.personX);
  await membership(A, UNIT.p, U.personY);
  await membership(A, UNIT.t1, U.teamMember);
  await membership(A, UNIT.sub, U.subTeamMember);
  await membership(A, UNIT.d1, U.deptOnly);
  await membership(A, UNIT.t2, U.staleTeamMember);
  // A direct project member who also belongs to Alpha (selected in S.teams, never assigned).
  await membership(A, UNIT.t2, U.personY);
  await membership(A, UNIT.p2, U.creator);
  await membership(B, B_PROJECT_UNIT, BU.member);

  // P: Platform and the Design department (so its Brand team) assigned; Alpha is not. P2: default off.
  for (const team of [UNIT.t1, UNIT.d2]) {
    await q(
      "insert into app.work_project_teams (organization_id, project_unit_id, team_unit_id, assigned_by) values ($1, $2, $3, $4)",
      [A, UNIT.p, team, U.admin],
    );
  }
  await q(
    "insert into app.work_project_settings (organization_id, unit_id, default_visibility, updated_by) values ($1, $2, 'owner', $3)",
    [A, UNIT.p2, U.admin],
  );

  const device = (org: string, id: string, owner: string, shared = false) =>
    q(
      "insert into app.devices (id, organization_id, owner_user_id, name, platform, token_hash, shared) values ($1, $2, $3, 'laptop', 'darwin', $4, $5)",
      [id, org, owner, `tok-${id}`, shared],
    );
  await device(A, DEV.team, U.deviceOwner);
  await device(A, DEV.personal, U.personalOwner);
  await device(A, DEV.shared, U.personalOwner, true);
  await device(B, B_DEV, BU.admin);
  const repo = (org: string, id: string, deviceId: string) =>
    q(
      "insert into app.projects (id, organization_id, device_id, local_id, name) values ($1, $2, $3, $4, 'repo')",
      [id, org, deviceId, `l-${id}`],
    );
  await repo(A, REPO.p, DEV.team);
  await repo(A, REPO.p2, DEV.team);
  await repo(A, REPO.personal, DEV.personal);
  await repo(A, REPO.shared, DEV.shared);
  await repo(B, B_REPO, B_DEV);
  const link = (org: string, repoId: string, deviceId: string, unitId: string, by: string) =>
    q(
      "insert into app.work_project_repos (organization_id, project_id, device_id, unit_id, linked_by) values ($1, $2, $3, $4, $5)",
      [org, repoId, deviceId, unitId, by],
    );
  await link(A, REPO.p, DEV.team, UNIT.p, U.admin);
  await link(A, REPO.p2, DEV.team, UNIT.p2, U.admin);
  await link(B, B_REPO, B_DEV, B_PROJECT_UNIT, BU.admin);

  // Personal device access: a user grant, a unit grant on Design (so Brand's member), a revoked user grant; the shared
  // device carries a revoked user grant too.
  const deviceGrant = (deviceId: string, kind: string, principal: string, revoked = false) =>
    q(
      "insert into app.device_grants (organization_id, device_id, principal_kind, principal_id, max_mode, revoked_at) values ($1, $2, $3, $4, 'acceptEdits', $5)",
      [A, deviceId, kind, principal, revoked ? new Date().toISOString() : null],
    );
  await deviceGrant(DEV.personal, "user", U.grantee);
  await deviceGrant(DEV.personal, "unit", UNIT.d2);
  await deviceGrant(DEV.personal, "user", U.revokedUser, true);
  await deviceGrant(DEV.shared, "user", U.revokedUser, true);

  const session = async (
    org: string,
    id: string,
    repoId: string,
    deviceId: string,
    createdBy: string,
    visibility: string,
    status = "idle",
  ) => {
    const conv = randomUUID();
    await q(
      "insert into app.conversations (id, organization_id, kind, name) values ($1, $2, 'work_session', 'ws')",
      [conv, org],
    );
    await q(
      "insert into app.work_sessions (id, organization_id, conversation_id, project_id, device_id, title, created_by, visibility, status) values ($1, $2, $3, $4, $5, 'T', $6, $7, $8)",
      [id, org, conv, repoId, deviceId, createdBy, visibility, status],
    );
  };
  await session(A, S.project, REPO.p, DEV.team, U.creator, "project");
  await session(A, S.owner, REPO.p, DEV.team, U.creator, "owner");
  await session(A, S.teams, REPO.p, DEV.team, U.creator, "teams");
  await session(A, S.people, REPO.p, DEV.team, U.creator, "people");
  await session(A, S.left, REPO.p, DEV.team, U.leftCreator, "project");
  await session(A, S.archived, REPO.p, DEV.team, U.creator, "project", "archived");
  await session(A, S.p2Project, REPO.p2, DEV.team, U.creator, "project");
  await session(A, S.personal, REPO.personal, DEV.personal, U.personalOwner, "project");
  await session(A, S.personalOwner, REPO.personal, DEV.personal, U.personalOwner, "owner");
  await session(A, S.shared, REPO.shared, DEV.shared, U.personalOwner, "project");
  await session(B, B_SESSION, B_REPO, B_DEV, BU.member, "project");

  const grant = (sessionId: string, kind: string, subject: string, revoked = false) =>
    q(
      "insert into app.work_session_grants (organization_id, work_session_id, subject_kind, subject_id, granted_by, revoked_at) values ($1, $2, $3, $4, $5, $6)",
      [A, sessionId, kind, subject, U.creator, revoked ? new Date().toISOString() : null],
    );
  // teams [Platform] + a stale grant on Alpha (never assigned) + a revoked grant on Design.
  await grant(S.teams, "unit", UNIT.t1);
  await grant(S.teams, "unit", UNIT.t2);
  await grant(S.teams, "unit", UNIT.d2, true);
  // people [X, Y] + one who never had project access + the creator + a revoked grant of the member.
  await grant(S.people, "user", U.personX);
  await grant(S.people, "user", U.personY);
  await grant(S.people, "user", U.personGone);
  await grant(S.people, "user", U.creator);
  await grant(S.people, "user", U.member, true);
}

/** Runs `fn` as ocw_app in a tenant transaction (withTenant's settings), always rolled back. */
async function inTenant<T>(org: string, fn: (q: pg.Client["query"]) => Promise<T>): Promise<T> {
  await app.query("begin");
  try {
    await app.query("select set_config('app.organization_id', $1, true)", [org]);
    return await fn(app.query.bind(app) as pg.Client["query"]);
  } finally {
    await app.query("rollback");
  }
}

const projectAccess = (unit: string, user: string, org = A) =>
  inTenant(
    org,
    async (q) =>
      (await q("select app.work_project_access($1, $2) as a", [unit, user])).rows[0].a as string | null,
  );

const facts = (session: string, user: string, org = A) =>
  inTenant(org, async (q) =>
    ((await q("select app.work_session_access($1, $2) as f", [session, user])).rows[0].f as string[]).sort(),
  );

type Viewer = { user_id: string; reason: string; via: string | null };
const viewers = (session: string, org = A) =>
  inTenant(
    org,
    async (q) =>
      (await q("select user_id, reason, via from app.work_session_viewers($1) order by user_id", [session]))
        .rows as Viewer[],
  );

const people = (unit: string, org = A) =>
  inTenant(
    org,
    async (q) =>
      (await q("select user_id, reason, via from app.work_project_people($1) order by user_id", [unit]))
        .rows as Viewer[],
  );

const summary = (session: string, org = A) =>
  inTenant(
    org,
    async (q) =>
      (await q("select * from app.work_session_visibility_summary($1)", [session])).rows as Array<{
        kind: string;
        active_count: number;
        differs_from_default: boolean;
        first_team_name: string | null;
        team_project_id: string | null;
        team_project_name: string | null;
      }>,
  );

const SEEING = ["creator", "creator_left", "device_owner", "viewer"];
const nameOf = (id: string) => (Object.entries(U).find(([, v]) => v === id)?.[0] ?? id) as string;

beforeAll(async () => {
  tdb = await startTestDatabase();
  migrator = new pg.Client({ connectionString: tdb.migratorUrl });
  app = new pg.Client({ connectionString: tdb.appUrl });
  await migrator.connect();
  await app.connect();
  await seed();
});

afterAll(async () => {
  await migrator?.end();
  await app?.end();
  await tdb?.stop();
});

describe("app.work_project_access (D-02)", () => {
  it("is lead, member or team for project access, admin for an active admin, and NULL otherwise", async () => {
    const expected: Partial<Record<Person, string | null>> = {
      lead: "lead",
      member: "member",
      creator: "member",
      teamMember: "team",
      // Below an assigned department (Design → Brand).
      subTeamMember: "team",
      // The project's parent department is not assigned: its members have no access.
      deptOnly: null,
      // Alpha is not assigned.
      staleTeamMember: null,
      admin: "admin",
      deactivatedAdmin: null,
      outsider: null,
      deviceOwner: null,
      leftCreator: null,
    };
    for (const [name, level] of Object.entries(expected)) {
      expect(await projectAccess(UNIT.p, U[name as Person]), name).toBe(level);
    }
  });

  it("is NULL for a unit that is not a project and for any id of another organization", async () => {
    expect(await projectAccess(UNIT.t1, U.teamMember)).toBeNull();
    expect(await projectAccess(B_PROJECT_UNIT, BU.member)).toBeNull();
    expect(await projectAccess(B_PROJECT_UNIT, U.admin)).toBeNull();
    expect(await projectAccess(UNIT.p, BU.admin)).toBeNull();
    // From org B's tenant, org A's project does not exist.
    expect(await projectAccess(UNIT.p, U.lead, B)).toBeNull();
    expect(await projectAccess(B_PROJECT_UNIT, BU.member, B)).toBe("member");
  });

  it("follows membership changes at read time (no stored copy)", async () => {
    const after = await inTenant(A, async (q) => {
      await q("delete from app.unit_memberships where unit_id = $1 and user_id = $2", [
        UNIT.t1,
        U.teamMember,
      ]);
      await q("delete from app.work_project_teams where project_unit_id = $1 and team_unit_id = $2", [
        UNIT.p,
        UNIT.d2,
      ]);
      return (
        await q("select app.work_project_access($1, $2) as t, app.work_project_access($1, $3) as s", [
          UNIT.p,
          U.teamMember,
          U.subTeamMember,
        ])
      ).rows[0];
    });
    expect(after).toEqual({ t: null, s: null });
  });
});

describe("app.work_session_access (D-04, D-11, D-12)", () => {
  it("project audience: the project's people see it; others hold only their own facts", async () => {
    expect(await facts(S.project, U.member)).toEqual(["viewer"]);
    expect(await facts(S.project, U.teamMember)).toEqual(["viewer"]);
    expect(await facts(S.project, U.subTeamMember)).toEqual(["viewer"]);
    expect(await facts(S.project, U.lead)).toEqual(["project_lead", "viewer"]);
    expect(await facts(S.project, U.creator)).toEqual(["creator", "viewer"]);
    expect(await facts(S.project, U.deviceOwner)).toEqual(["device_owner"]);
    // The admin sees through the resolver's explicit admin rule, never as a project viewer (P-03).
    expect(await facts(S.project, U.admin)).toEqual(["admin"]);
    for (const p of ["deptOnly", "staleTeamMember", "outsider", "deactivatedAdmin", "personGone"] as const) {
      expect(await facts(S.project, U[p]), p).toEqual([]);
    }
  });

  it("owner audience: only the creator, plus the device owner, admin and lead facts", async () => {
    expect(await facts(S.owner, U.creator)).toEqual(["creator"]);
    expect(await facts(S.owner, U.member)).toEqual([]);
    expect(await facts(S.owner, U.teamMember)).toEqual([]);
    expect(await facts(S.owner, U.lead)).toEqual(["project_lead"]);
    expect(await facts(S.owner, U.deviceOwner)).toEqual(["device_owner"]);
    expect(await facts(S.owner, U.admin)).toEqual(["admin"]);
  });

  it("teams audience: members of a selected, assigned team; a stale or revoked team grants nothing", async () => {
    expect(await facts(S.teams, U.teamMember)).toEqual(["viewer"]);
    // Alpha's grant row is active but Alpha is not assigned: its member has no project access at all.
    expect(await facts(S.teams, U.staleTeamMember)).toEqual([]);
    // Design is assigned but its grant is revoked: Brand's member keeps project access, not this session.
    expect(await facts(S.teams, U.subTeamMember)).toEqual([]);
    // Alpha's grant gives nothing even to someone with project access of their own: Alpha is not assigned.
    expect(await facts(S.teams, U.personY)).toEqual([]);
    // Direct project members are not in a selected team.
    expect(await facts(S.teams, U.member)).toEqual([]);
    expect(await facts(S.teams, U.lead)).toEqual(["project_lead"]);
    expect(await facts(S.teams, U.creator)).toEqual(["creator"]);
  });

  it("teams audience: unassigning a selected team stops its grant at once, although the row stays", async () => {
    const after = await inTenant(A, async (q) => {
      await q("delete from app.work_project_teams where project_unit_id = $1 and team_unit_id = $2", [
        UNIT.p,
        UNIT.t1,
      ]);
      const f = (await q("select app.work_session_access($1, $2) as f", [S.teams, U.teamMember])).rows[0].f;
      const rows = (
        await q(
          "select count(*)::int as n from app.work_session_grants where work_session_id = $1 and subject_id = $2 and revoked_at is null",
          [S.teams, UNIT.t1],
        )
      ).rows[0].n;
      return { f, rows };
    });
    expect(after).toEqual({ f: [], rows: 1 });
  });

  it("people audience: a granted person sees it while in the project and not after leaving, the row staying", async () => {
    expect(await facts(S.people, U.personX)).toEqual(["viewer"]);
    expect(await facts(S.people, U.personY)).toEqual(["viewer"]);
    expect(await facts(S.people, U.personGone)).toEqual([]);
    // A revoked grant grants nothing.
    expect(await facts(S.people, U.member)).toEqual([]);
    const left = await inTenant(A, async (q) => {
      await q("delete from app.unit_memberships where unit_id = $1 and user_id = $2", [UNIT.p, U.personX]);
      const f = (await q("select app.work_session_access($1, $2) as f", [S.people, U.personX])).rows[0].f;
      const rows = (
        await q(
          "select count(*)::int as n from app.work_session_grants where work_session_id = $1 and subject_id = $2 and revoked_at is null",
          [S.people, U.personX],
        )
      ).rows[0].n;
      return { f, rows };
    });
    expect(left).toEqual({ f: [], rows: 1 });
  });

  it("a creator who left the team project keeps `creator_left` (D-12); one still in it is `creator`", async () => {
    expect(await facts(S.left, U.leftCreator)).toEqual(["creator_left"]);
    const leaving = await inTenant(A, async (q) => {
      await q("delete from app.unit_memberships where unit_id = $1 and user_id = $2", [UNIT.p, U.creator]);
      return (await q("select app.work_session_access($1, $2) as f", [S.project, U.creator])).rows[0].f;
    });
    expect(leaving).toEqual(["creator_left"]);
  });

  it("the device owner always holds `device_owner` (D-11) and an admin always holds `admin`, with their other facts", async () => {
    const both = await inTenant(A, async (q) => {
      await q("update app.org_members set role = 'admin' where user_id = $1", [U.member]);
      return (await q("select app.work_session_access($1, $2) as f", [S.project, U.member])).rows[0].f;
    });
    expect(both.sort()).toEqual(["admin", "viewer"]);
    for (const s of [S.project, S.owner, S.teams, S.people, S.left]) {
      expect(await facts(s, U.deviceOwner), s).toEqual(["device_owner"]);
      expect(await facts(s, U.admin), s).toEqual(["admin"]);
    }
  });

  it("personal project (unlinked repo) with audience `project`: whoever may use the device (deviceModeCap parity)", async () => {
    expect(await facts(S.personal, U.personalOwner)).toEqual(["creator", "device_owner", "viewer"]);
    expect(await facts(S.personal, U.grantee)).toEqual(["viewer"]);
    // A unit grant on Design reaches the member of Brand, below it.
    expect(await facts(S.personal, U.subTeamMember)).toEqual(["viewer"]);
    // A revoked grant never matches: on an unshared device it gives nothing.
    expect(await facts(S.personal, U.revokedUser)).toEqual([]);
    expect(await facts(S.personal, U.outsider)).toEqual([]);
    expect(await facts(S.personal, U.lead)).toEqual([]);
    expect(await facts(S.personal, U.admin)).toEqual(["admin"]);
    // Shared with everyone: every active member, including one whose own grant was revoked, exactly as
    // `deviceModeCap` (revoked rows never match; `shared` still applies).
    for (const p of ["outsider", "lead", "revokedUser", "deptOnly"] as const) {
      expect(await facts(S.shared, U[p]), p).toEqual(["viewer"]);
    }
    expect(await facts(S.shared, U.deactivatedAdmin)).toEqual([]);
    // `owner` adds nobody, on a personal project too.
    expect(await facts(S.personalOwner, U.grantee)).toEqual([]);
    expect(await facts(S.personalOwner, U.personalOwner)).toEqual(["creator", "device_owner"]);
  });

  it("returns '{}' for any session or person of another organization", async () => {
    expect(await facts(B_SESSION, BU.member)).toEqual([]);
    expect(await facts(B_SESSION, BU.admin)).toEqual([]);
    expect(await facts(S.project, BU.admin)).toEqual([]);
    expect(await facts(S.project, U.creator, B)).toEqual([]);
    expect(await facts(B_SESSION, BU.member, B)).toEqual(["creator", "viewer"]);
    expect(await facts(randomUUID(), U.admin)).toEqual([]);
  });
});

describe("app.work_session_viewers and app.work_project_people (C-01: the same rule)", () => {
  const ALL_SESSIONS = Object.entries(S);

  it("viewers are exactly the people whose facts let them see the session, never admins by role", async () => {
    for (const [label, s] of ALL_SESSIONS) {
      const expected: string[] = [];
      for (const id of Object.values(U)) {
        const f = await facts(s, id);
        if (f.some((x) => SEEING.includes(x))) expected.push(id);
      }
      const got = await viewers(s);
      expect(got.map((v) => nameOf(v.user_id)).sort(), label).toEqual(expected.map(nameOf).sort());
    }
    // An admin is listed only through a relation of their own (here: the device shared with everyone).
    for (const s of [S.project, S.owner, S.teams, S.people, S.personal]) {
      expect((await viewers(s)).map((v) => v.user_id)).not.toContain(U.admin);
    }
    expect((await viewers(S.shared)).find((v) => v.user_id === U.admin)?.reason).toBe("device");
  });

  it("names the UI-SPEC reasons, with the team a person comes through", async () => {
    const reasons = (rows: Viewer[]) =>
      Object.fromEntries(rows.map((r) => [nameOf(r.user_id), r.via ? `${r.reason}:${r.via}` : r.reason]));
    expect(reasons(await viewers(S.project))).toEqual({
      creator: "owner",
      deviceOwner: "device_owner",
      lead: "lead",
      member: "member",
      personX: "member",
      personY: "member",
      subTeamMember: `team:${UNIT.d2}`,
      teamMember: `team:${UNIT.t1}`,
    });
    expect(reasons(await viewers(S.teams))).toEqual({
      creator: "owner",
      deviceOwner: "device_owner",
      teamMember: `team:${UNIT.t1}`,
    });
    expect(reasons(await viewers(S.people))).toEqual({
      creator: "owner",
      deviceOwner: "device_owner",
      personX: "member",
      personY: "member",
    });
    expect(reasons(await viewers(S.left))).toEqual({
      leftCreator: "owner_left",
      deviceOwner: "device_owner",
      lead: "lead",
      member: "member",
      creator: "member",
      personX: "member",
      personY: "member",
      subTeamMember: `team:${UNIT.d2}`,
      teamMember: `team:${UNIT.t1}`,
    });
    expect(reasons(await viewers(S.personal))).toEqual({
      personalOwner: "owner",
      grantee: "device",
      subTeamMember: "device",
    });
  });

  it("project people are exactly lead, member and team access, never admins", async () => {
    for (const unit of [UNIT.p, UNIT.p2]) {
      const expected: Record<string, string> = {};
      for (const [name, id] of Object.entries(U)) {
        const level = await projectAccess(unit, id);
        if (level === "lead" || level === "member" || level === "team") expected[name] = level;
      }
      const got = await people(unit);
      expect(Object.fromEntries(got.map((r) => [nameOf(r.user_id), r.reason]))).toEqual(expected);
    }
    const viaOf = Object.fromEntries((await people(UNIT.p)).map((r) => [nameOf(r.user_id), r.via]));
    expect(viaOf).toMatchObject({ teamMember: UNIT.t1, subTeamMember: UNIT.d2, lead: null, member: null });
  });

  it("enumerate nothing for another organization's session or project", async () => {
    expect(await viewers(B_SESSION)).toEqual([]);
    expect(await people(B_PROJECT_UNIT)).toEqual([]);
    expect(await viewers(S.project, B)).toEqual([]);
    expect(await people(UNIT.p, B)).toEqual([]);
  });
});

describe("app.work_session_visibility_summary (UI-SPEC R1, § 1.5)", () => {
  it("counts only active entries and names only an active team", async () => {
    expect(await summary(S.teams)).toEqual([
      {
        kind: "teams",
        active_count: 1,
        differs_from_default: true,
        first_team_name: "Platform",
        team_project_id: UNIT.p,
        team_project_name: "Atlas",
      },
    ]);
    // X and Y count; the person outside the project, the creator and the revoked grant do not.
    expect(await summary(S.people)).toMatchObject([
      { kind: "people", active_count: 2, differs_from_default: true, first_team_name: null },
    ]);
  });

  it("compares with the project's default (absent = project; personal = project)", async () => {
    expect(await summary(S.project)).toMatchObject([
      { kind: "project", active_count: 0, differs_from_default: false, team_project_name: "Atlas" },
    ]);
    expect(await summary(S.owner)).toMatchObject([{ kind: "owner", differs_from_default: true }]);
    expect(await summary(S.p2Project)).toMatchObject([
      {
        kind: "project",
        differs_from_default: true,
        team_project_id: UNIT.p2,
        team_project_name: "Borealis",
      },
    ]);
    expect(await summary(S.personal)).toEqual([
      {
        kind: "project",
        active_count: 0,
        differs_from_default: false,
        first_team_name: null,
        team_project_id: null,
        team_project_name: null,
      },
    ]);
    expect(await summary(S.personalOwner)).toMatchObject([{ kind: "owner", differs_from_default: true }]);
  });

  it("returns no row for another organization's session", async () => {
    expect(await summary(B_SESSION)).toEqual([]);
    expect(await summary(S.teams, B)).toEqual([]);
  });
});

describe("app.work_project_repo_session_count (D-09 unlink impact)", () => {
  it("counts the repo's non-archived sessions whatever their audience, within the caller's organization", async () => {
    const count = (repo: string, org = A) =>
      inTenant(
        org,
        async (q) =>
          (await q("select app.work_project_repo_session_count($1) as n", [repo])).rows[0].n as number,
      );
    // project, owner, teams, people, left (the archived one does not count).
    expect(await count(REPO.p)).toBe(5);
    expect(await count(REPO.personal)).toBe(2);
    expect(await count(B_REPO)).toBe(0);
    expect(await count(REPO.p, B)).toBe(0);
    expect(await count(B_REPO, B)).toBe(1);
  });
});

describe("function privileges (T-07.9-02-07)", () => {
  it("are SECURITY DEFINER as ocw_migrator with a fixed search_path; ocw_app may execute them, PUBLIC and ocw_auth may not", async () => {
    for (const fn of FUNCTIONS) {
      const r = await migrator.query(
        `select p.prosecdef, pg_get_userbyid(p.proowner) as owner, p.proconfig,
                has_function_privilege('ocw_app', p.oid, 'EXECUTE') as app,
                has_function_privilege('ocw_auth', p.oid, 'EXECUTE') as auth,
                exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0) as public
         from pg_proc p where p.oid = $1::regprocedure`,
        [`app.${fn}`],
      );
      expect(r.rows[0], fn).toEqual({
        prosecdef: true,
        owner: "ocw_migrator",
        proconfig: ["search_path=pg_catalog, pg_temp"],
        app: true,
        auth: false,
        public: false,
      });
    }
    // The internal `team` helper is called only by the functions above (as their owner), never by the API.
    const helper = await migrator.query(
      "select has_function_privilege('ocw_app', 'app.work_project_team_via(uuid,uuid,uuid)', 'EXECUTE') as app",
    );
    expect(helper.rows[0].app).toBe(false);
  });
});
