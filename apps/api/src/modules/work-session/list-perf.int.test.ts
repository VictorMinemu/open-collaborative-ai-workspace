import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";
import { invite } from "../../testing-workzone";
import { WorkSessionService } from "./service";

/**
 * Phase 07.9-12 (Pitfall 8, A6; WINDOWS #306, #308, #311, #314): the audience rule at a realistic organization size,
 * with the RESTRICTIVE `audience_backstop` on. One organization: 5,000 sessions over 20 devices, 10 team projects
 * (2 linked repositories each, 15 direct members each, one assigned team of 100 people on all of them), 200 members, a
 * shared personal device. Dana (developer, a direct member of the first project) sees exactly 50 sessions. Everything
 * is seeded in SQL as the migrator; every timed call goes through the real API (the median of three, warm). Each
 * reader has an explicit budget; the measured medians and the list's EXPLAIN ANALYZE are printed for the SUMMARY.
 */

const SESSIONS = 5_000;
const DEVICES = 20;
const PROJECTS = 10;
const EXTRA_MEMBERS = 199;
const DANA_SEES = 50;
/** Live sessions a Work Zone policy change re-checks (07.9 fan-out, WINDOWS #311). */
const ORG_SWEEP = 2_000;

/**
 * Budgets in ms (the median of three on the testcontainer; `deviceSweep` is one run). About four times the local
 * measurement (07.9-12 SUMMARY; `deviceSweep` about twice), so a slower CI runner passes and a per-row regression does
 * not. Never raised to make a run pass: a miss is fixed at its source.
 */
const BUDGET = {
  /** The plan's budget (Pitfall 8). */
  listDana: 3_000,
  listAdmin: 5_000,
  whoCanSee: 1_000,
  projectsIndex: 1_000,
  projectDetail: 500,
  draftPreview: 1_000,
  draftPeoplePersonal: 1_000,
  /** PUT visibility; its delivery to every reader is queued after commit (07.9 fan-out, WINDOWS #311). */
  audienceChange: 1_500,
  /**
   * 07.9 fan-out (#311): what the request that changed a device's access waits for after its commit (the invalidation
   * and queueing the sweep): 1 ms locally. It waited for the whole sweep and its delivery before: 6.3 s (07.9-12),
   * 7.9 s measured on the same run as this budget.
   */
  deviceSweepRequest: 500,
  /**
   * The background sweep that stops 250 sessions and delivers each to its readers (#311): 32 s before 07.9-12's fan-out
   * fix (the reasons enumerator per session, one publish at a time), about 7 s now locally. One run.
   */
  deviceSweep: 20_000,
  /** PUT /work-zone-policy with 2,000 live sessions: 8 ms locally after its commit (63 s when it swept inline). */
  orgSweepRequest: 500,
  /** Background: every one of the 2,000 sessions re-checked (stopped): 12.7 s locally. One run. */
  orgSweep: 50_000,
  /** Background: the sweep and the delivery of the 2,000 stopped sessions to their readers: 49.5 s locally. One run. */
  orgSweepDelivered: 200_000,
} as const;

let stack: TestStack;
let migrator: pg.Client;
let victor: TestClient;
let dana: TestClient;
let org = "";
let danaId = "";
const members: string[] = [];
const devices: string[] = [];
const repos: string[] = [];
const projects: string[] = [];
let personalRepo = "";
let danaSees: string[] = [];
let firstProjectSession = "";

async function ok(res: Promise<{ status: number; body: Record<string, unknown> | null }>) {
  const r = await res;
  if (r.status !== 200) throw new Error(`expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
  // biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
  return r.body as Record<string, any>;
}

/** Runs `fn` three times; returns the median duration (ms) and the last result. */
async function median<T>(fn: () => Promise<T>): Promise<{ ms: number; last: T }> {
  const times: number[] = [];
  let last: T | undefined;
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now();
    last = await fn();
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  return { ms: Math.round(times[1]!), last: last as T };
}

const measured: Record<string, number> = {};
function report(name: keyof typeof BUDGET, ms: number) {
  measured[name] = ms;
  console.log(`[perf] ${name}: median ${ms} ms (budget ${BUDGET[name]} ms)`);
  expect(ms, `${name} median ${ms} ms over its ${BUDGET[name]} ms budget`).toBeLessThan(BUDGET[name]);
}

/** The stack's work-session service (its background queue). */
function service(): WorkSessionService {
  const handler = stack.built.deviceHub.sessionHandler;
  if (!(handler instanceof WorkSessionService)) throw new Error("no work-session service");
  return handler;
}

async function seed(): Promise<void> {
  const q = (text: string, values: unknown[] = []) => migrator.query(text, values);
  for (let i = 0; i < EXTRA_MEMBERS; i++) members.push(randomUUID());
  await q(
    "insert into auth.user (id, name, email) select id, 'M', id::text || '@perf.test' from unnest($1::uuid[]) id",
    [members],
  );
  await q(
    "insert into app.org_members (organization_id, user_id, display_name, role) select $1, id, 'Member ' || left(id::text, 8), 'developer' from unnest($2::uuid[]) id",
    [org, members],
  );

  const dept = randomUUID();
  const team = randomUUID();
  await q(
    "insert into app.org_units (id, organization_id, parent_id, kind, name, path) values ($1, $2, null, 'department', 'Perf', ARRAY[$1]::uuid[])",
    [dept, org],
  );
  await q(
    "insert into app.org_units (id, organization_id, parent_id, kind, name, path) values ($1, $2, $3, 'team', 'Perf team', ARRAY[$3, $1]::uuid[])",
    [team, org, dept],
  );
  // The assigned team: the last 100 members.
  await q(
    "insert into app.unit_memberships (organization_id, unit_id, user_id, role) select $1, $2, id, 'member' from unnest($3::uuid[]) id",
    [org, team, members.slice(99)],
  );
  for (let k = 0; k < PROJECTS; k++) {
    const p = randomUUID();
    projects.push(p);
    await q(
      "insert into app.org_units (id, organization_id, parent_id, kind, name, path) values ($1, $2, $3, 'project', $4, ARRAY[$3, $1]::uuid[])",
      [p, org, dept, `Perf project ${k}`],
    );
    await q(
      "insert into app.unit_memberships (organization_id, unit_id, user_id, role) select $1, $2, id, 'member' from unnest($3::uuid[]) id",
      [org, p, members.slice(20 + k * 15, 35 + k * 15)],
    );
    await q(
      "insert into app.work_project_teams (organization_id, project_unit_id, team_unit_id, assigned_by) values ($1, $2, $3, $4)",
      [org, p, team, members[0]],
    );
  }
  await q(
    "insert into app.unit_memberships (organization_id, unit_id, user_id, role) values ($1, $2, $3, 'member')",
    [org, projects[0], danaId],
  );

  // 20 devices owned by the first 20 members, one repository each, repository i linked to project i % 10; plus one
  // shared device whose repository no team project links (the personal draft path).
  for (let i = 0; i <= DEVICES; i++) {
    const d = randomUUID();
    const r = randomUUID();
    await q(
      "insert into app.devices (id, organization_id, owner_user_id, name, platform, token_hash, shared) values ($1, $2, $3, $4, 'darwin', $5, $6)",
      // Shared: device 0 (so the admin may start on the first project's repository: the draft preview) and the
      // personal one. Sharing never widens a team project's audience (its repositories follow the project).
      [d, org, members[i % 20], `Perf device ${i}`, `perf-${d}`, i === 0 || i === DEVICES],
    );
    await q(
      "insert into app.projects (id, organization_id, device_id, local_id, name) values ($1, $2, $3, $4, $5)",
      [r, org, d, `perf-${i}`, `perf-repo-${i}`],
    );
    if (i === DEVICES) {
      personalRepo = r;
      continue;
    }
    devices.push(d);
    repos.push(r);
    await q(
      "insert into app.work_project_repos (organization_id, project_id, device_id, unit_id, linked_by) values ($1, $2, $3, $4, $5)",
      [org, r, d, projects[i % PROJECTS], members[0]],
    );
  }

  // 5,000 sessions, round-robin over the 20 repositories. On the first project's repositories (0 and 10), the first 50
  // are `project` (Dana sees them) and the other 450 `owner` (she does not); every other session is `project`.
  const ids: string[] = [];
  const convs: string[] = [];
  const repoOf: string[] = [];
  const devOf: string[] = [];
  const creators: string[] = [];
  const visibility: string[] = [];
  const updated: string[] = [];
  let firstProjectCount = 0;
  const base = Date.now();
  for (let i = 0; i < SESSIONS; i++) {
    const slot = i % DEVICES;
    const id = randomUUID();
    ids.push(id);
    convs.push(randomUUID());
    repoOf.push(repos[slot]!);
    devOf.push(devices[slot]!);
    creators.push(members[20 + (i % 150)]!);
    let vis = "project";
    if (slot % PROJECTS === 0) {
      vis = firstProjectCount < DANA_SEES ? "project" : "owner";
      if (vis === "project") danaSees.push(id);
      firstProjectCount++;
    }
    visibility.push(vis);
    updated.push(new Date(base - i * 60_000).toISOString());
  }
  firstProjectSession = danaSees[0]!;
  await q(
    "insert into app.conversations (id, organization_id, kind, name) select id, $1, 'work_session', 'ws' from unnest($2::uuid[]) id",
    [org, convs],
  );
  await q(
    `insert into app.work_sessions (id, organization_id, conversation_id, project_id, device_id, title, created_by,
       visibility, status, updated_at)
     select s.id, $1, s.conv, s.repo, s.dev, 'Perf session', s.creator, s.vis, 'idle', s.upd
       from unnest($2::uuid[], $3::uuid[], $4::uuid[], $5::uuid[], $6::uuid[], $7::text[], $8::timestamptz[])
         as s(id, conv, repo, dev, creator, vis, upd)`,
    [org, ids, convs, repoOf, devOf, creators, visibility, updated],
  );
  await q("analyze");
  danaSees = [...danaSees].sort();
}

beforeAll(async () => {
  stack = await startTestStack();
  migrator = new pg.Client({ connectionString: stack.db.migratorUrl });
  await migrator.connect();
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
  org = setup.organization.id;
  ({ client: dana, userId: danaId } = await invite(
    stack,
    victor,
    "dana@example.test",
    "Dana Dev",
    "developer",
  ));
  await seed();
}, 300_000);

afterAll(async () => {
  console.log(`[perf] summary ${JSON.stringify(measured)}`);
  await migrator?.end();
  await stack?.stop();
});

describe(`the audience rule at ${SESSIONS} sessions (Pitfall 8)`, () => {
  it(`a member who sees ${DANA_SEES} of ${SESSIONS} sessions lists exactly those, within budget`, async () => {
    const { ms, last } = await median(() => ok(dana.request("GET", "/api/v1/work-sessions")));
    const listed = (last.sessions as Array<{ id: string }>).map((s) => s.id).sort();
    expect(listed).toEqual(danaSees);
    report("listDana", ms);
  });

  it("the list query's plan (EXPLAIN ANALYZE as Dana, with the backstop)", async () => {
    const app = new pg.Client({ connectionString: stack.db.appUrl });
    await app.connect();
    try {
      await app.query("begin");
      await app.query(
        "select set_config('app.organization_id', $1, true), set_config('app.user_id', $2, true)",
        [org, danaId],
      );
      const plan = await app.query(
        `explain (analyze, buffers, format text)
         select ws.id, p.name, d.name, ou.path, app.work_session_access(ws.id, $1::uuid) as access
           from app.work_sessions ws
           join app.projects p on p.id = ws.project_id
           join app.devices d on d.id = ws.device_id
           left join app.work_project_repos r on r.project_id = ws.project_id
           left join app.org_units ou on ou.id = r.unit_id
          where ws.status <> 'archived'
          order by ws.updated_at desc`,
        [danaId],
      );
      await app.query("rollback");
      const text = plan.rows.map((r) => r["QUERY PLAN"] as string).join("\n");
      console.log(`[perf] EXPLAIN ANALYZE (Dana's list)\n${text}`);
      expect(text).toContain("Execution Time");
    } finally {
      await app.end();
    }
  });

  it("an admin lists all of them within budget", async () => {
    const { ms, last } = await median(() => ok(victor.request("GET", "/api/v1/work-sessions")));
    expect((last.sessions as unknown[]).length).toBe(SESSIONS);
    report("listAdmin", ms);
  });

  it("who can see one session (every member judged by the rule) within budget (WINDOWS #306)", async () => {
    const { ms, last } = await median(() =>
      ok(victor.request("GET", `/api/v1/work-sessions/${firstProjectSession}/visibility`)),
    );
    // Direct members (15 + Dana), the assigned team (100), the creator and the device owner.
    expect(last.viewers.count as number).toBeGreaterThan(100);
    report("whoCanSee", ms);
  });

  it("the projects index (people per project) and one project's page within budget", async () => {
    const index = await median(() => ok(victor.request("GET", "/api/v1/work-projects")));
    expect((index.last.teamProjects as unknown[]).length).toBe(PROJECTS);
    report("projectsIndex", index.ms);
    const detail = await median(() => ok(victor.request("GET", `/api/v1/work-projects/${projects[0]}`)));
    expect(detail.last.access.count as number).toBeGreaterThan(100);
    report("projectDetail", detail.ms);
  });

  it("the savepoint-draft readers (preview on a team repo, people on a shared personal repo) within budget (WINDOWS #314)", async () => {
    const preview = await median(() =>
      ok(victor.request("GET", `/api/v1/projects/${repos[0]}/audience/preview?kind=project`)),
    );
    expect(preview.last.count as number).toBeGreaterThan(100);
    report("draftPreview", preview.ms);
    const people = await median(() =>
      ok(victor.request("GET", `/api/v1/projects/${personalRepo}/audience/people`)),
    );
    expect((people.last.people as unknown[]).length).toBeGreaterThan(0);
    report("draftPeoplePersonal", people.ms);
  });

  it("an audience change, with its after-commit delivery to every reader, within budget (WINDOWS #311)", async () => {
    let kind: "owner" | "project" = "project";
    const change = await median(async () => {
      kind = kind === "project" ? "owner" : "project";
      return ok(victor.request("PUT", `/api/v1/work-sessions/${firstProjectSession}/visibility`, { kind }));
    });
    expect(change.last.visibility.kind).toBe(kind);
    report("audienceChange", change.ms);
  });

  it("a device access change returns at once; the background sweep stops every session on the device and delivers each (WINDOWS #311)", async () => {
    // Device 1's 250 sessions were started by members who may not use it: the re-check stops and emits every one, and
    // the delivery of each to its readers follows in the background queue. Run late: it fails those sessions.
    const handler = stack.built.deviceHub.sessionHandler;
    if (!handler) throw new Error("no session handler");
    const t0 = performance.now();
    await handler.onAccessChanged({ deviceId: devices[1]!, organizationId: org }, "access_changed");
    report("deviceSweepRequest", Math.round(performance.now() - t0));
    await service().settled(org);
    const ms = Math.round(performance.now() - t0);
    const failed = await migrator.query(
      "select count(*)::int as n from app.work_sessions where device_id = $1 and status = 'failed'",
      [devices[1]],
    );
    expect(failed.rows[0].n).toBe(SESSIONS / DEVICES);
    report("deviceSweep", ms);
  });

  it(`a Work Zone policy change returns at once; ${ORG_SWEEP} live sessions are re-checked and delivered in the background (WINDOWS #311)`, async () => {
    // Exactly ORG_SWEEP live sessions, none on devices 0 (shared) and 1: every creator may not use the device, so the
    // re-check stops each one. Run last: it fails them.
    await migrator.query(
      "update app.work_sessions set status = 'completed' where organization_id = $1 and status <> 'failed'",
      [org],
    );
    const live = (
      await migrator.query(
        `update app.work_sessions set status = 'idle' where id in (
           select id from app.work_sessions where organization_id = $1 and device_id <> all($2::uuid[]) order by id limit $3)
         returning id`,
        [org, [devices[0], devices[1]], ORG_SWEEP],
      )
    ).rows.map((r) => r.id as string);
    expect(live).toHaveLength(ORG_SWEEP);
    const stopped = async () =>
      Number(
        (
          await migrator.query(
            "select count(*)::int as n from app.work_sessions where id = any($1::uuid[]) and status = 'failed'",
            [live],
          )
        ).rows[0].n,
      );

    const t0 = performance.now();
    await ok(victor.request("PUT", "/api/v1/work-zone-policy", { allowFastMode: true }));
    report("orgSweepRequest", Math.round(performance.now() - t0));
    const delivered = service()
      .settled(org)
      .then(() => performance.now());
    for (;;) {
      if ((await stopped()) === ORG_SWEEP) break;
      if (performance.now() - t0 > BUDGET.orgSweepDelivered) throw new Error("the sweep did not finish");
      await new Promise((r) => setTimeout(r, 100));
    }
    report("orgSweep", Math.round(performance.now() - t0));
    report("orgSweepDelivered", Math.round((await delivered) - t0));
  }, 600_000);
});
