import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDatabase, type TestDatabase } from "./testing";

/**
 * Phase 07.9 (D-09, D-13, P-10, C-01): the RESTRICTIVE `audience_backstop` policies, the database's second line of
 * defence under the resolver. A user request (withTenant with a user) reads and writes only the sessions where
 * `app.work_session_access` names that user with a seeing relation (creator, creator who left, device owner, viewer,
 * admin), and only the prompts, approvals and audience grants of those sessions; a user-less system transaction
 * (Device Link, sweeps, cell routes) passes explicitly (D-13; ADR-0030 records the limit). Everything is seeded as the
 * migrator and every statement runs as `ocw_app` with the settings withTenant() sets, so a route that forgot the
 * resolver is simulated by plain SQL.
 *
 * It also proves D-14 (assigned teams never reach nested projects) on the SQL rule itself.
 */

let tdb: TestDatabase;
let migrator: pg.Client;
let app: pg.Client;

const A = randomUUID();
const B = randomUUID();

const U = {
  admin: randomUUID(),
  creator: randomUUID(),
  deviceOwner: randomUUID(),
  viewer: randomUUID(),
  lead: randomUUID(),
  leftCreator: randomUUID(),
  olga: randomUUID(),
  teamMember: randomUUID(),
  nestedMember: randomUUID(),
  nestedDirect: randomUUID(),
} as const;
const BU = { admin: randomUUID() };

/** Engineering ⊃ Platform (assigned to Atlas) ⊃ Nested (a project under the assigned team); Atlas under Engineering. */
const UNIT = { dept: randomUUID(), team: randomUUID(), atlas: randomUUID(), nested: randomUUID() } as const;
const B_UNIT = randomUUID();
const DEV = randomUUID();
const B_DEV = randomUUID();
const REPO = randomUUID();
const B_REPO = randomUUID();

const S = {
  project: randomUUID(),
  owner: randomUUID(),
  left: randomUUID(),
  narrow: randomUUID(),
  teams: randomUUID(),
} as const;
const B_SESSION = randomUUID();

const CHILD_TABLES = ["app.work_prompts", "app.work_approvals", "app.work_session_grants"] as const;

type Q = pg.Client["query"];

async function seed(): Promise<void> {
  const q = (text: string, values: unknown[]) => migrator.query(text, values);
  for (const org of [A, B]) {
    await q("insert into auth.organization (id, name, slug) values ($1, 'Org', $2)", [org, `org-${org}`]);
  }
  const person = async (org: string, id: string, role: string) => {
    await q("insert into auth.user (id, name, email) values ($1, 'P', $2)", [id, `${id}@audience.test`]);
    await q(
      "insert into app.org_members (organization_id, user_id, display_name, role) values ($1, $2, 'P', $3)",
      [org, id, role],
    );
  };
  for (const [name, id] of Object.entries(U)) await person(A, id, name === "admin" ? "admin" : "standard");
  await person(B, BU.admin, "admin");

  const unit = (org: string, id: string, kind: string, path: string[], parent: string | null) =>
    q(
      "insert into app.org_units (id, organization_id, parent_id, kind, name, path) values ($1, $2, $3, $4, $6, $5::uuid[])",
      [id, org, parent, kind, path, `U-${id}`],
    );
  await unit(A, UNIT.dept, "department", [UNIT.dept], null);
  await unit(A, UNIT.team, "team", [UNIT.dept, UNIT.team], UNIT.dept);
  await unit(A, UNIT.atlas, "project", [UNIT.dept, UNIT.atlas], UNIT.dept);
  await unit(A, UNIT.nested, "project", [UNIT.dept, UNIT.team, UNIT.nested], UNIT.team);
  await unit(B, B_UNIT, "project", [B_UNIT], null);

  const membership = (unitId: string, userId: string, role = "member") =>
    q("insert into app.unit_memberships (organization_id, unit_id, user_id, role) values ($1, $2, $3, $4)", [
      A,
      unitId,
      userId,
      role,
    ]);
  await membership(UNIT.atlas, U.creator);
  await membership(UNIT.atlas, U.viewer);
  await membership(UNIT.atlas, U.lead, "lead");
  await membership(UNIT.team, U.teamMember);
  // D-14: a member of a project nested under the assigned team, and a direct Atlas member who also sits in it.
  await membership(UNIT.nested, U.nestedMember);
  await membership(UNIT.nested, U.nestedDirect);
  await membership(UNIT.atlas, U.nestedDirect);
  await q(
    "insert into app.work_project_teams (organization_id, project_unit_id, team_unit_id, assigned_by) values ($1, $2, $3, $4)",
    [A, UNIT.atlas, UNIT.team, U.admin],
  );

  await q(
    "insert into app.devices (id, organization_id, owner_user_id, name, platform, token_hash) values ($1, $2, $3, 'laptop', 'darwin', $4)",
    [DEV, A, U.deviceOwner, `tok-${DEV}`],
  );
  await q(
    "insert into app.devices (id, organization_id, owner_user_id, name, platform, token_hash) values ($1, $2, $3, 'laptop', 'darwin', $4)",
    [B_DEV, B, BU.admin, `tok-${B_DEV}`],
  );
  for (const [org, repo, dev, u] of [
    [A, REPO, DEV, UNIT.atlas],
    [B, B_REPO, B_DEV, B_UNIT],
  ] as const) {
    await q(
      "insert into app.projects (id, organization_id, device_id, local_id, name) values ($1, $2, $3, $4, 'repo')",
      [repo, org, dev, `l-${repo}`],
    );
    await q(
      "insert into app.work_project_repos (organization_id, project_id, device_id, unit_id, linked_by) values ($1, $2, $3, $4, $5)",
      [org, repo, dev, u, org === A ? U.admin : BU.admin],
    );
  }
  await session(q, A, S.project, REPO, DEV, U.creator, "project");
  await session(q, A, S.owner, REPO, DEV, U.creator, "owner");
  await session(q, A, S.left, REPO, DEV, U.leftCreator, "project");
  await session(q, A, S.narrow, REPO, DEV, U.creator, "project");
  await session(q, A, S.teams, REPO, DEV, U.creator, "teams");
  await session(q, B, B_SESSION, B_REPO, B_DEV, BU.admin, "project");
  await q(
    "insert into app.work_session_grants (organization_id, work_session_id, subject_kind, subject_id, granted_by) values ($1, $2, 'unit', $3, $4)",
    [A, S.teams, UNIT.team, U.creator],
  );
  for (const [org, sid] of [
    [A, S.project],
    [A, S.owner],
    [A, S.left],
    [B, B_SESSION],
  ] as const)
    await children(q, org, sid);
}

async function session(
  q: (text: string, values: unknown[]) => Promise<unknown>,
  org: string,
  id: string,
  repo: string,
  dev: string,
  createdBy: string,
  visibility: string,
): Promise<void> {
  const conv = randomUUID();
  await q(
    "insert into app.conversations (id, organization_id, kind, name) values ($1, $2, 'work_session', 'ws')",
    [conv, org],
  );
  await q(
    "insert into app.work_sessions (id, organization_id, conversation_id, project_id, device_id, title, created_by, visibility) values ($1, $2, $3, $4, $5, 'T', $6, $7)",
    [id, org, conv, repo, dev, createdBy, visibility],
  );
}

/** One prompt, one approval and one audience grant on the session (the three per-session tables the backstop covers). */
async function children(
  q: (text: string, values: unknown[]) => Promise<unknown>,
  org: string,
  sid: string,
): Promise<void> {
  const author = org === A ? U.creator : BU.admin;
  await q(
    "insert into app.work_prompts (organization_id, work_session_id, author_user_id, body, position) values ($1, $2, $3, 'hello', 1)",
    [org, sid, author],
  );
  await q(
    "insert into app.work_approvals (organization_id, work_session_id, request) values ($1, $2, $3::jsonb)",
    [org, sid, JSON.stringify({ tool: "Bash", summary: "ls", paths: [] })],
  );
  await q(
    "insert into app.work_session_grants (organization_id, work_session_id, subject_kind, subject_id, granted_by, revoked_at) values ($1, $2, 'user', $3, $3, now())",
    [org, sid, author],
  );
}

/** Runs `fn` as ocw_app with withTenant()'s two settings (`''` = a user-less system transaction); always rolled back. */
async function as<T>(userId: string | null, fn: (q: Q) => Promise<T>, org = A): Promise<T> {
  await app.query("begin");
  try {
    await app.query(
      "select set_config('app.organization_id', $1, true), set_config('app.user_id', $2, true)",
      [org, userId ?? ""],
    );
    return await fn(app.query.bind(app) as Q);
  } finally {
    await app.query("rollback");
  }
}

/** Runs `fn` as ocw_app and commits (for a change whose aftermath a later transaction reads). */
async function committed<T>(userId: string | null, fn: (q: Q) => Promise<T>): Promise<T> {
  await app.query("begin");
  try {
    await app.query(
      "select set_config('app.organization_id', $1, true), set_config('app.user_id', $2, true)",
      [A, userId ?? ""],
    );
    const out = await fn(app.query.bind(app) as Q);
    await app.query("commit");
    return out;
  } catch (err) {
    await app.query("rollback");
    throw err;
  }
}

/** What the person reads of one session, table by table (a forgotten reader: plain SQL, no resolver). */
async function seen(userId: string | null, sid: string): Promise<Record<string, number>> {
  return as(userId, async (q) => {
    const out: Record<string, number> = {
      "app.work_sessions": (await q("select count(*)::int as n from app.work_sessions where id = $1", [sid]))
        .rows[0].n,
    };
    for (const t of CHILD_TABLES) {
      out[t] = (await q(`select count(*)::int as n from ${t} where work_session_id = $1`, [sid])).rows[0].n;
    }
    return out;
  });
}

const none = {
  "app.work_sessions": 0,
  "app.work_prompts": 0,
  "app.work_approvals": 0,
  "app.work_session_grants": 0,
};
const all = {
  "app.work_sessions": 1,
  "app.work_prompts": 1,
  "app.work_approvals": 1,
  "app.work_session_grants": 1,
};

/** The SQLSTATE of a statement that must fail, or null when it succeeded. */
async function errorCode(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (err) {
    return (err as { code?: string }).code ?? "unknown";
  }
}

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

describe("audience_backstop: the policies exist and only restrict (P-10)", () => {
  it("is RESTRICTIVE on the four session tables, next to an unchanged tenant_isolation", async () => {
    const res = await migrator.query(
      `select tablename, policyname, permissive, cmd from pg_policies
        where schemaname = 'app' and tablename in ('work_sessions', 'work_prompts', 'work_approvals', 'work_session_grants')
        order by tablename, policyname`,
    );
    const rows = res.rows.map((r) => `${r.tablename}:${r.policyname}:${r.permissive}:${r.cmd}`);
    for (const t of ["work_approvals", "work_prompts", "work_session_grants", "work_sessions"]) {
      expect(rows).toContain(`${t}:audience_backstop:RESTRICTIVE:ALL`);
      expect(rows).toContain(`${t}:tenant_isolation:PERMISSIVE:ALL`);
    }
    expect(rows).toHaveLength(8);
  });
});

describe("a forgotten reader gets nothing (D-09)", () => {
  it("a member outside every relation reads no row of the session, its prompts, approvals or grants", async () => {
    for (const sid of [S.project, S.owner, S.left]) expect(await seen(U.olga, sid)).toEqual(none);
    // A list query that forgot the resolver: Olga sees no session of the organization at all.
    const n = await as(
      U.olga,
      async (q) => (await q("select count(*)::int as n from app.work_sessions")).rows[0].n,
    );
    expect(n).toBe(0);
  });

  it("a member outside the audience cannot change, delete or add to the session", async () => {
    await as(U.olga, async (q) => {
      expect((await q("update app.work_sessions set title = 'x' where id = $1", [S.project])).rowCount).toBe(
        0,
      );
      expect((await q("delete from app.work_prompts where work_session_id = $1", [S.project])).rowCount).toBe(
        0,
      );
      expect(
        (await q("update app.work_approvals set status = 'approved' where work_session_id = $1", [S.project]))
          .rowCount,
      ).toBe(0);
      expect((await q("delete from app.work_sessions where id = $1", [S.project])).rowCount).toBe(0);
    });
    const insert = (sql: string, values: unknown[]) => () => as(U.olga, (q) => q(sql, values));
    expect(
      await errorCode(
        insert(
          "insert into app.work_prompts (organization_id, work_session_id, author_user_id, body, position) values ($1, $2, $3, 'p', 9)",
          [A, S.project, U.olga],
        ),
      ),
    ).toBe("42501");
    expect(
      await errorCode(
        insert(
          "insert into app.work_session_grants (organization_id, work_session_id, subject_kind, subject_id, granted_by) values ($1, $2, 'user', $3, $3)",
          [A, S.owner, U.olga],
        ),
      ),
    ).toBe("42501");
    expect(
      await errorCode(
        insert(
          "insert into app.work_approvals (organization_id, work_session_id, request) values ($1, $2, '{}'::jsonb)",
          [A, S.project],
        ),
      ),
    ).toBe("42501");
    // Nothing changed on disk.
    const title = await migrator.query("select title from app.work_sessions where id = $1", [S.project]);
    expect(title.rows[0].title).toBe("T");
  });

  it("an `owner` session is hidden from a project member who sees the `project` one", async () => {
    expect(await seen(U.viewer, S.project)).toEqual(all);
    expect(await seen(U.viewer, S.owner)).toEqual(none);
  });
});

describe("the people the rule names read their rows", () => {
  it("the creator, the device owner and an admin read an `owner` session; a viewer reads a `project` one", async () => {
    for (const who of [U.creator, U.deviceOwner, U.admin]) expect(await seen(who, S.owner)).toEqual(all);
    expect(await seen(U.viewer, S.project)).toEqual(all);
  });

  it("a creator who left the project still reads their session (D-12, creator_left)", async () => {
    const facts = await as(
      U.leftCreator,
      async (q) =>
        (await q("select app.work_session_access($1, $2) as f", [S.left, U.leftCreator])).rows[0].f,
    );
    expect(facts).toEqual(["creator_left"]);
    expect(await seen(U.leftCreator, S.left)).toEqual(all);
  });

  it("a project lead alone does not read an `owner` session (project_lead is not a seeing relation)", async () => {
    const facts = await as(
      U.lead,
      async (q) => (await q("select app.work_session_access($1, $2) as f", [S.owner, U.lead])).rows[0].f,
    );
    expect(facts).toEqual(["project_lead"]);
    expect(await seen(U.lead, S.owner)).toEqual(none);
  });
});

describe("writes: WITH CHECK", () => {
  it("a creator inserts their own new session, never one in someone else's name they cannot see", async () => {
    const insert =
      (createdBy: string, visibility: string, returning = "") =>
      () =>
        as(U.creator, async (q) => {
          const conv = randomUUID();
          await q(
            "insert into app.conversations (id, organization_id, kind, name) values ($1, $2, 'work_session', 'ws')",
            [conv, A],
          );
          await q(
            `insert into app.work_sessions (id, organization_id, conversation_id, project_id, device_id, title, created_by, visibility) values ($1, $2, $3, $4, $5, 'N', $6, $7) ${returning}`,
            [randomUUID(), A, conv, REPO, DEV, createdBy, visibility],
          );
        });
    expect(await errorCode(insert(U.creator, "owner"))).toBeNull();
    // INSERT … RETURNING judges the new row by USING too (the API creates sessions this way).
    expect(await errorCode(insert(U.creator, "owner", "returning id"))).toBeNull();
    expect(await errorCode(insert(U.olga, "owner"))).toBe("42501");
    expect(await errorCode(insert(U.olga, "owner", "returning id"))).toBe("42501");
  });

  it("a creator adds a prompt and an audience grant to their own session", async () => {
    await as(U.creator, async (q) => {
      await q(
        "insert into app.work_prompts (organization_id, work_session_id, author_user_id, body, position) values ($1, $2, $3, 'p', 2)",
        [A, S.owner, U.creator],
      );
      await q(
        "insert into app.work_session_grants (organization_id, work_session_id, subject_kind, subject_id, granted_by) values ($1, $2, 'user', $3, $4)",
        [A, S.owner, U.viewer, U.creator],
      );
    });
  });

  it("a lead who is not the creator narrows a session to `owner` in one statement, then reads 0 rows of it", async () => {
    const changed = await committed(
      U.lead,
      async (q) =>
        (await q("update app.work_sessions set visibility = 'owner' where id = $1", [S.narrow])).rowCount,
    );
    expect(changed).toBe(1);
    expect(await seen(U.lead, S.narrow)).toEqual(none);
    const onDisk = await migrator.query("select visibility from app.work_sessions where id = $1", [S.narrow]);
    expect(onDisk.rows[0].visibility).toBe("owner");
  });
});

describe("user-less system transactions pass (D-13: Device Link, sweeps, cell routes)", () => {
  it("every row of the organization is visible and writable without a user", async () => {
    for (const sid of [S.project, S.owner, S.left]) expect(await seen(null, sid)).toEqual(all);
    await as(null, async (q) => {
      expect((await q("update app.work_sessions set title = 'sys' where id = $1", [S.owner])).rowCount).toBe(
        1,
      );
      await q(
        "insert into app.work_prompts (organization_id, work_session_id, author_user_id, body, position) values ($1, $2, $3, 'p', 3)",
        [A, S.owner, U.creator],
      );
      await q(
        "insert into app.work_approvals (organization_id, work_session_id, request) values ($1, $2, '{}'::jsonb)",
        [A, S.owner],
      );
    });
  });

  it("tenant isolation still holds without a user and for another organization's admin", async () => {
    expect(await seen(null, B_SESSION)).toEqual(none);
    expect(
      await as(
        BU.admin,
        async (q) =>
          (await q("select count(*)::int as n from app.work_sessions where id = $1", [S.owner])).rows[0].n,
        B,
      ),
    ).toBe(0);
    expect(
      await as(
        BU.admin,
        async (q) => (await q("select count(*)::int as n from app.work_sessions")).rows[0].n,
        B,
      ),
    ).toBe(1);
  });
});

describe("assigned teams never reach nested projects (D-14)", () => {
  it("a member of a project nested under an assigned team has no access to the project", async () => {
    const access = (user: string) =>
      as(
        user,
        async (q) => (await q("select app.work_project_access($1, $2) as a", [UNIT.atlas, user])).rows[0].a,
      );
    expect(await access(U.teamMember)).toBe("team");
    expect(await access(U.nestedMember)).toBeNull();
    const people = await as(null, async (q) =>
      (await q("select user_id::text as id from app.work_project_people($1)", [UNIT.atlas])).rows.map(
        (r) => r.id,
      ),
    );
    expect(people).toContain(U.teamMember);
    expect(people).not.toContain(U.nestedMember);
    expect(await seen(U.nestedMember, S.project)).toEqual(none);
  });

  it("a `teams` audience on the assigned team does not reach a direct member who only sits in a nested project", async () => {
    const facts = (user: string) =>
      as(
        user,
        async (q) => (await q("select app.work_session_access($1, $2) as f", [S.teams, user])).rows[0].f,
      );
    expect(await facts(U.teamMember)).toEqual(["viewer"]);
    expect(await facts(U.nestedDirect)).toEqual([]);
    const viewers = await as(null, async (q) =>
      (await q("select user_id::text as id from app.work_session_viewers($1)", [S.teams])).rows.map(
        (r) => r.id,
      ),
    );
    expect(viewers).toContain(U.teamMember);
    expect(viewers).not.toContain(U.nestedDirect);
    expect(viewers).not.toContain(U.nestedMember);
  });
});
