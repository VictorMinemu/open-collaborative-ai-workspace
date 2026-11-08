import { randomUUID } from "node:crypto";
import type { WorkSession } from "@ocw/contracts";
import { createTenantDb, orgMembers, type TenantDb } from "@ocw/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, type MockInstance, vi } from "vitest";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";
import { createPermissionService, type ResourceFacts } from "../organization";
import type { RealtimeService } from "../realtime";
import { sessionFactsForUsers } from "./facts";
import { DELIVER_CONCURRENCY, WorkSessionService } from "./service";

/**
 * 07.9 fan-out (WINDOWS #311): the per-user delivery of many sessions scales by batch, not by session. Every
 * `deliverNow` batch reads its sessions, every member's audience facts on all of them (one query of the SQL rule), every
 * member's resolver facts and the rules (once) and the per-viewer fields in a FIXED number of round trips, whatever the
 * number of sessions in it; batches run at most DELIVER_CONCURRENCY at once. Who receives what is unchanged: exactly
 * the people the visibility panel names (`app.work_session_viewers`, decided by `work_session.read`) and the active
 * admins, one frame each, never a deactivated member. Pinned by counting the delivery's queries on its own pool, so a
 * per-session regression fails here without a wall-clock budget (list-perf.int.test.ts keeps those). Real PostgreSQL.
 */

const MEMBERS = 40;
const SESSIONS = 120;
/** The delivery's batch size in service.ts (DELIVER_BATCH): 120 sessions are three batches. */
const BATCH = 50;

let stack: TestStack;
let migrator: pg.Client;
let counted: TenantDb;
let svc: WorkSessionService;
let org = "";
const members: string[] = [];
let gone = "";
const projects: string[] = [];
const sessions: Array<{
  id: string;
  slot: number;
  deviceId: string;
  unit: string | null;
  visibility: string;
  createdBy: string;
}> = [];

/** Every query a client of the counted pool sent, and the most connections the delivery held at once. */
const spies: Array<MockInstance> = [];
let held = 0;
let mostHeld = 0;
const sent = () => spies.reduce((n, s) => n + s.mock.calls.length, 0);

/** What the delivery published, by session then recipient (one `user:` frame each). */
const frames: Array<{ userId: string; dto: WorkSession }> = [];

async function seed(): Promise<void> {
  const q = (text: string, values: unknown[] = []) => migrator.query(text, values);
  for (let i = 0; i < MEMBERS; i++) members.push(randomUUID());
  gone = members[MEMBERS - 1]!;
  await q(
    "insert into auth.user (id, name, email) select id, 'M', id::text || '@batch.test' from unnest($1::uuid[]) id",
    [members],
  );
  await q(
    "insert into app.org_members (organization_id, user_id, display_name, role) select $1, id, 'Member ' || left(id::text, 8), 'developer' from unnest($2::uuid[]) id",
    [org, members],
  );
  // The last member left: on the team, so the rule's own `{}` for non-members is what keeps them out.
  await q("update app.org_members set deactivated_at = now() where organization_id = $1 and user_id = $2", [
    org,
    gone,
  ]);
  const dept = randomUUID();
  const team = randomUUID();
  await q(
    "insert into app.org_units (id, organization_id, parent_id, kind, name, path) values ($1, $2, null, 'department', 'Batch', ARRAY[$1]::uuid[])",
    [dept, org],
  );
  await q(
    "insert into app.org_units (id, organization_id, parent_id, kind, name, path) values ($1, $2, $3, 'team', 'Batch team', ARRAY[$3, $1]::uuid[])",
    [team, org, dept],
  );
  // The team: members 20..39 (the deactivated one included).
  await q(
    "insert into app.unit_memberships (organization_id, unit_id, user_id, role) select $1, $2, id, 'member' from unnest($3::uuid[]) id",
    [org, team, members.slice(20)],
  );
  for (let k = 0; k < 2; k++) {
    const p = randomUUID();
    projects.push(p);
    await q(
      "insert into app.org_units (id, organization_id, parent_id, kind, name, path) values ($1, $2, $3, 'project', $4, ARRAY[$3, $1]::uuid[])",
      [p, org, dept, `Batch project ${k}`],
    );
    // Direct members: 4..8 on the first project, 9..13 on the second.
    await q(
      "insert into app.unit_memberships (organization_id, unit_id, user_id, role) select $1, $2, id, 'member' from unnest($3::uuid[]) id",
      [org, p, members.slice(4 + k * 5, 9 + k * 5)],
    );
    // Only the first project has the team assigned.
    if (k === 0) {
      await q(
        "insert into app.work_project_teams (organization_id, project_unit_id, team_unit_id, assigned_by) values ($1, $2, $3, $4)",
        [org, p, team, members[0]],
      );
    }
  }
  // Four devices owned by members 0..3 (in no project and no team: they read only as device owners, project hidden).
  // Repositories 0 and 1 belong to the first project, 2 to the second, 3 is personal.
  const repoUnit = [projects[0]!, projects[0]!, projects[1]!, null];
  const repos: string[] = [];
  const devices: string[] = [];
  for (let i = 0; i < 4; i++) {
    const d = randomUUID();
    const r = randomUUID();
    devices.push(d);
    repos.push(r);
    await q(
      "insert into app.devices (id, organization_id, owner_user_id, name, platform, token_hash, shared) values ($1, $2, $3, $4, 'darwin', $5, false)",
      [d, org, members[i], `Batch device ${i}`, `batch-${d}`],
    );
    await q(
      "insert into app.projects (id, organization_id, device_id, local_id, name) values ($1, $2, $3, $4, $5)",
      [r, org, d, `batch-${i}`, `batch-repo-${i}`],
    );
    const unit = repoUnit[i];
    if (unit) {
      await q(
        "insert into app.work_project_repos (organization_id, project_id, device_id, unit_id, linked_by) values ($1, $2, $3, $4, $5)",
        [org, r, d, unit, members[0]],
      );
    }
  }
  // Round-robin over the four repositories; every third session `owner`, the rest `project`. Creators: the project's
  // direct members on team repositories, a team member now and then, the device owner on the personal one.
  for (let i = 0; i < SESSIONS; i++) {
    const slot = i % 4;
    const unit = repoUnit[slot] ?? null;
    const createdBy =
      slot === 3
        ? members[3]!
        : slot === 2
          ? members[9 + (i % 5)]!
          : i % 7 === 0
            ? members[20 + (i % 10)]!
            : members[4 + (i % 5)]!;
    sessions.push({
      id: randomUUID(),
      slot,
      deviceId: devices[slot]!,
      unit,
      visibility: i % 3 === 0 ? "owner" : "project",
      createdBy,
    });
  }
  const convs = sessions.map(() => randomUUID());
  await q(
    "insert into app.conversations (id, organization_id, kind, name) select id, $1, 'work_session', 'ws' from unnest($2::uuid[]) id",
    [org, convs],
  );
  await q(
    `insert into app.work_sessions (id, organization_id, conversation_id, project_id, device_id, title, created_by,
       visibility, status)
     select s.id, $1, s.conv, s.repo, s.dev, 'Batch session', s.creator, s.vis, 'idle'
       from unnest($2::uuid[], $3::uuid[], $4::uuid[], $5::uuid[], $6::uuid[], $7::text[])
         as s(id, conv, repo, dev, creator, vis)`,
    [
      org,
      sessions.map((s) => s.id),
      convs,
      sessions.map((_, i) => repos[i % 4]),
      sessions.map((_, i) => devices[i % 4]),
      sessions.map((s) => s.createdBy),
      sessions.map((s) => s.visibility),
    ],
  );
  await q("analyze");
}

beforeAll(async () => {
  stack = await startTestStack();
  migrator = new pg.Client({ connectionString: stack.db.migratorUrl });
  await migrator.connect();
  const victor = new TestClient(stack.baseUrl);
  const setup = await victor.request("POST", "/api/v1/setup", {
    token: TEST_SETUP_TOKEN,
    name: "Víctor Ruiz",
    email: "victor@example.test",
    password: "correct-horse-battery",
    orgName: "Autofy Labs",
  });
  expect(setup.status).toBe(200);
  org = (setup.body as { organization: { id: string } }).organization.id;
  await seed();

  // A delivery of its own, on a pool whose every client is counted; the published frames are recorded.
  counted = createTenantDb(stack.db.appUrl);
  counted.pool.on("connect", (client) => {
    spies.push(vi.spyOn(client, "query"));
  });
  counted.pool.on("acquire", () => {
    held++;
    mostHeld = Math.max(mostHeld, held);
  });
  counted.pool.on("release", () => {
    held--;
  });
  const core = stack.built.core;
  const realtime: RealtimeService = {
    ...core.realtime,
    // The `ws:` snapshot is not under test: only the per-user delivery that follows the commit.
    appendEvent: async () => 0,
    publishEphemeral: async (topic, type, data) => {
      if (type !== "work_session.updated") throw new Error(`unexpected ${type}`);
      frames.push({ userId: topic.replace(/^user:/, ""), dto: data as WorkSession });
    },
  };
  svc = new WorkSessionService({
    db: counted,
    realtime,
    audit: core.audit,
    hub: stack.built.deviceHub,
    log: core.log,
    perms: createPermissionService(core),
  });
}, 300_000);

afterAll(async () => {
  await counted?.close();
  await migrator?.end();
  await stack?.stop();
});

/** Delivers `ids` (one emitting transaction) and returns the queries the delivery sent and the most pool clients it held. */
async function deliver(ids: readonly string[]): Promise<{ queries: number; connections: number }> {
  frames.length = 0;
  // Hold the queue, so the delivery the commit queues waits until the count starts.
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  svc.background.push(org, { kind: "test-gate", ids: () => [], run: () => gate });
  await counted.withTenant({ organizationId: org, userId: null }, async (tx) => {
    for (const id of ids) await svc.emitSession(tx, id);
  });
  const before = sent();
  mostHeld = held;
  open();
  await svc.settled(org);
  return { queries: sent() - before, connections: mostHeld };
}

/**
 * The reference audience, decided independently of the delivery: the visibility panel's readers
 * (`app.work_session_viewers`, the rule's one enumerator) and the active admins, each kept by `work_session.read` on
 * their own facts.
 */
async function expectedReaders(ids: readonly string[]): Promise<Map<string, string[]>> {
  const perms = createPermissionService(stack.built.core);
  return stack.built.core.db.withTenant({ organizationId: org, userId: null }, async (tx) => {
    const admins = (
      await tx
        .select({ userId: orgMembers.userId })
        .from(orgMembers)
        .where(and(eq(orgMembers.role, "admin"), isNull(orgMembers.deactivatedAt)))
    ).map((r) => r.userId);
    const out = new Map<string, string[]>();
    for (const id of ids) {
      const viewers = (
        await tx.execute(sql`select v.user_id::text as user_id from app.work_session_viewers(${id}::uuid) v`)
      ).rows.map((r) => (r as { user_id: string }).user_id);
      const s = sessions.find((x) => x.id === id)!;
      const ref = { id, createdBy: s.createdBy, deviceId: s.deviceId };
      const candidates = [...new Set([...viewers, ...admins])];
      const facts = await sessionFactsForUsers(tx, ref, candidates);
      out.set(
        id,
        await perms.usersAllowed(tx, {
          candidates,
          permission: "work_session.read",
          resourceFor: (u) => facts.get(u) as ResourceFacts,
        }),
      );
    }
    return out;
  });
}

const recipientsOf = (id: string) =>
  frames
    .filter((f) => f.dto.id === id)
    .map((f) => f.userId)
    .sort();

describe("the per-user session delivery scales by batch (07.9 fan-out, WINDOWS #311)", () => {
  it("every session goes to exactly its readers and the admins, one frame each; never to a member who left", async () => {
    const ids = sessions.map((s) => s.id);
    await deliver(ids);
    const expected = await expectedReaders(ids);
    let total = 0;
    for (const id of ids) {
      const want = expected.get(id)!;
      expect(recipientsOf(id), `recipients of ${id}`).toEqual(want);
      total += want.length;
    }
    expect(frames, "one publish per (session, recipient), never per member").toHaveLength(total);
    expect(frames.some((f) => f.userId === gone)).toBe(false);
    // The audience narrows: an `owner` session reaches fewer people than a `project` one on the same repository.
    const owner = sessions.find((s) => s.slot === 0 && s.visibility === "owner")!;
    const open = sessions.find((s) => s.slot === 0 && s.visibility === "project")!;
    expect(recipientsOf(owner.id).length).toBeLessThan(recipientsOf(open.id).length);
    // Each frame is shaped for its recipient: the owner of device 0, outside the project, reads it hidden; a team
    // member reads it named.
    const ofOpen = (u: string) => frames.find((f) => f.dto.id === open.id && f.userId === u)?.dto;
    expect(ofOpen(members[0]!)?.teamProject).toBeNull();
    expect(ofOpen(members[0]!)?.teamProjectHidden).toBe(true);
    expect(ofOpen(members[25]!)?.teamProject?.id).toBe(projects[0]);
  });

  it("a batch costs a fixed number of round trips, whatever its size; batches run at most DELIVER_CONCURRENCY at once", async () => {
    const ids = sessions.map((s) => s.id);
    const small = await deliver(ids.slice(0, 10));
    const full = await deliver(ids.slice(0, BATCH));
    const three = await deliver(ids);
    console.log(
      `[batching] queries: 10 sessions ${small.queries}, ${BATCH} sessions ${full.queries}, ${SESSIONS} sessions ${three.queries}; connections at once ${three.connections}`,
    );
    // Before 07.9 fan-out batching: about four queries per session (its facts, two principal loads, the rules).
    expect(small.queries, "one batch: its queries are a fixed set").toBeLessThanOrEqual(20);
    expect(full.queries, "a full batch costs what a small one does").toBe(small.queries);
    expect(three.queries, "three batches cost three times one").toBe(3 * small.queries);
    expect(three.connections).toBeGreaterThan(1);
    expect(three.connections).toBeLessThanOrEqual(DELIVER_CONCURRENCY);
  });
});
