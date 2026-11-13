import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDatabase, type TestDatabase } from "./testing";

/**
 * Phase 07.17.1.1.2 (D-01, D-03, D-04, PD-05, PD-23; ADR-0042): the storage of a bot's long task. At most one active
 * (`running` or `waiting`) task per bot and thread (`bot_tasks_one_active_idx`; a DM task has no thread and is unique per
 * conversation), the background processes a task waits for (`bot_task_processes`), the two `task_id` links and the
 * `task` card kind. Seeded and checked as ocw_migrator on a fresh database with every migration applied; the tenant
 * isolation, the TRUNCATE revoke and the concurrent start are proven as ocw_app.
 */

let tdb: TestDatabase;
let db: pg.Client;
let app: pg.Client;

type Q = pg.Client["query"];

interface Org {
  id: string;
  user: string;
  agent: string;
  channel: string;
  dm: string;
  message: string;
}

const HOUR = 3_600_000;

async function bot(org: string, name = "researcher"): Promise<string> {
  const id = randomUUID();
  await db.query(
    "insert into app.agents (id, organization_id, name, username, instructions, model_provider, model_id) values ($1, $2, $3, $4, 'x', 'mock', 'mock-1')",
    [id, org, name, `${name}-${id.slice(0, 8)}`],
  );
  return id;
}

async function seedOrg(): Promise<Org> {
  const id = randomUUID();
  await db.query("insert into auth.organization (id, name, slug) values ($1, 'O', $2)", [id, `o-${id}`]);
  const user = randomUUID();
  await db.query("insert into auth.user (id, name, email) values ($1, 'P', $2)", [
    user,
    `${user}@btask.test`,
  ]);
  await db.query(
    "insert into app.org_members (organization_id, user_id, display_name, role) values ($1, $2, 'P', 'standard')",
    [id, user],
  );
  const agent = await bot(id);
  const channel = randomUUID();
  await db.query(
    "insert into app.conversations (id, organization_id, kind, name, slug) values ($1, $2, 'channel', 'general', $3)",
    [channel, id, `general-${channel}`],
  );
  const dm = randomUUID();
  await db.query(
    "insert into app.conversations (id, organization_id, kind, visibility, dm_key) values ($1, $2, 'dm', 'private', $3)",
    [dm, id, `dm-${dm}`],
  );
  const message = randomUUID();
  await db.query(
    "insert into app.messages (id, organization_id, conversation_id, seq, author_kind, author_id, body) values ($1, $2, $3, 1, 'user', $4, 'read the pack')",
    [message, id, channel, user],
  );
  return { id, user, agent, channel, dm, message };
}

/** One task of `o`'s bot (every required column set unless overridden), as `q` (the migrator by default). */
async function task(
  o: Org,
  cols: Record<string, unknown> = {},
  q: Q = db.query.bind(db) as Q,
): Promise<string> {
  const event = randomUUID();
  const base: Record<string, unknown> = {
    id: randomUUID(),
    organization_id: o.id,
    agent_id: o.agent,
    conversation_id: o.channel,
    thread_root_id: randomUUID(),
    requester_user_id: o.user,
    started_event_id: event,
    current_event_id: event,
    goal: "Read the knowledge pack and summarise it",
    max_turns: 40,
    deadline_at: new Date(Date.now() + 8 * HOUR).toISOString(),
    ...cols,
  };
  // An `undefined` override leaves the column to its default.
  const set = Object.entries(base).filter(([, v]) => v !== undefined);
  const res = await q(
    `insert into app.bot_tasks (${set.map(([k]) => k).join(", ")}) values (${set.map((_, i) => `$${i + 1}`).join(", ")}) returning id`,
    set.map(([, v]) => v),
  );
  return res.rows[0].id as string;
}

/** One background process row of `taskId` (every required column set unless overridden). */
async function processRow(
  o: Org,
  taskId: string,
  cols: Record<string, unknown> = {},
  q: Q = db.query.bind(db) as Q,
): Promise<string> {
  const base: Record<string, unknown> = {
    organization_id: o.id,
    task_id: taskId,
    agent_id: o.agent,
    process_id: `p-${randomUUID().slice(0, 8)}`,
    event_id: randomUUID(),
    deadline_at: new Date(Date.now() + 10 * 60_000).toISOString(),
    ...cols,
  };
  const set = Object.entries(base).filter(([, v]) => v !== undefined);
  const res = await q(
    `insert into app.bot_task_processes (${set.map(([k]) => k).join(", ")}) values (${set.map((_, i) => `$${i + 1}`).join(", ")}) returning id`,
    set.map(([, v]) => v),
  );
  return res.rows[0].id as string;
}

async function refused(p: Promise<unknown>, named: { constraint: string }): Promise<void> {
  await expect(p, named.constraint).rejects.toMatchObject(named);
}

const count = async (sql: string, values: unknown[]) =>
  (await db.query(`select count(*)::int as n from ${sql}`, values)).rows[0].n as number;

/** Runs `fn` as ocw_app with withTenant()'s two settings (`null` user = a user-less system transaction); rolled back. */
async function as<T>(org: string, userId: string | null, fn: (q: Q) => Promise<T>): Promise<T> {
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

let A: Org;
let B: Org;

beforeAll(async () => {
  tdb = await startTestDatabase();
  db = new pg.Client({ connectionString: tdb.migratorUrl });
  app = new pg.Client({ connectionString: tdb.appUrl });
  await db.connect();
  await app.connect();
  A = await seedOrg();
  B = await seedOrg();
});

afterAll(async () => {
  await db?.end();
  await app?.end();
  await tdb?.stop();
});

describe("bot task storage (07.17.1.1.2, D-01, PD-05)", () => {
  it("stores a team bot's task as ocw_app in its own organization, with the start defaults", async () => {
    const id = await as(A.id, A.user, async (q) => {
      const created = await task(A, {}, q);
      const row = await q(
        "select status, outcome, turns_used, wait_seq, tainted, nudged, last_post_turn, finished_at, started_at is not null as started, updated_at is not null as stamped from app.bot_tasks where id = $1",
        [created],
      );
      expect(row.rows).toEqual([
        {
          status: "running",
          outcome: null,
          turns_used: 1,
          wait_seq: 0,
          tainted: false,
          nudged: false,
          last_post_turn: 1,
          finished_at: null,
          started: true,
          stamped: true,
        },
      ]);
      return created;
    });
    // Rolled back with the tenant transaction.
    expect(await count("app.bot_tasks where id = $1", [id])).toBe(0);
  });

  it("holds one active task per bot and thread: a finished task frees the thread, another thread is its own", async () => {
    const thread = randomUUID();
    const first = await task(A, { thread_root_id: thread });
    await refused(task(A, { thread_root_id: thread }), { constraint: "bot_tasks_one_active_idx" });
    await refused(task(A, { thread_root_id: thread, status: "waiting" }), {
      constraint: "bot_tasks_one_active_idx",
    });
    await db.query(
      "update app.bot_tasks set status = 'done', outcome = 'done', finished_at = now() where id = $1",
      [first],
    );
    await task(A, { thread_root_id: thread });
    await task(A, { thread_root_id: randomUUID() });
    // Another bot of the organization may work in the same thread.
    await task(A, { thread_root_id: thread, agent_id: await bot(A.id, "second") });
    expect(await count("app.bot_tasks where thread_root_id = $1", [thread])).toBe(3);
  });

  it("a DM task has no thread and is unique per conversation", async () => {
    await task(A, { conversation_id: A.dm, thread_root_id: null });
    await refused(task(A, { conversation_id: A.dm, thread_root_id: null }), {
      constraint: "bot_tasks_one_active_idx",
    });
  });

  it("two concurrent starts in one thread leave exactly one row", async () => {
    const thread = randomUUID();
    const clients = [
      new pg.Client({ connectionString: tdb.appUrl }),
      new pg.Client({ connectionString: tdb.appUrl }),
    ];
    await Promise.all(clients.map((c) => c.connect()));
    try {
      const start = async (c: pg.Client) => {
        await c.query("begin");
        try {
          await c.query(
            "select set_config('app.organization_id', $1, true), set_config('app.user_id', $2, true)",
            [A.id, A.user],
          );
          await task(A, { thread_root_id: thread }, c.query.bind(c) as Q);
          await c.query("commit");
        } catch (err) {
          await c.query("rollback");
          throw err;
        }
      };
      const results = await Promise.allSettled(clients.map(start));
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const lost = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
      expect(lost?.reason).toMatchObject({ code: "23505", constraint: "bot_tasks_one_active_idx" });
    } finally {
      await Promise.all(clients.map((c) => c.end()));
    }
    expect(await count("app.bot_tasks where thread_root_id = $1", [thread])).toBe(1);
  });

  it("deleting the bot deletes its tasks and their processes", async () => {
    const agent = await bot(A.id, "doomed");
    const o = { ...A, agent };
    const t1 = await task(o);
    const t2 = await task(o, {
      status: "stopped",
      outcome: "stopped_by_person",
      finished_at: new Date().toISOString(),
    });
    await processRow(o, t1);
    await processRow(o, t2, { status: "exited", exit_code: 0, duration_ms: 1200 });
    expect(await count("app.bot_task_processes where agent_id = $1", [agent])).toBe(2);
    await db.query("delete from app.agents where id = $1", [agent]);
    expect(await count("app.bot_tasks where agent_id = $1", [agent])).toBe(0);
    expect(await count("app.bot_task_processes where agent_id = $1", [agent])).toBe(0);
  });

  it("refuses a task naming another organization's bot or conversation, and a process of another organization's task", async () => {
    await refused(task(A, { agent_id: B.agent }), { constraint: "bot_tasks_agent_fk" });
    await refused(task(A, { conversation_id: B.channel }), { constraint: "bot_tasks_conversation_fk" });
    const own = await task(A);
    await refused(processRow(B, own), { constraint: "bot_task_processes_task_fk" });
  });

  it("one process row per bot and process id", async () => {
    const t = await task(A);
    await processRow(A, t, { process_id: "p-dup" });
    await refused(processRow(A, t, { process_id: "p-dup" }), { constraint: "bot_task_processes_process_uq" });
  });

  it("links turns and bot sessions to a task (nullable), and stores a task card", async () => {
    const t = await task(A);
    for (const taskId of [null, t]) {
      const eventId = randomUUID();
      await db.query(
        "insert into app.agent_turns (event_id, organization_id, agent_id, user_id, conversation_id, conversation_kind, message_id, task_id) values ($1, $2, $3, $4, $5, 'channel', $6, $7)",
        [eventId, A.id, A.agent, A.user, A.channel, A.message, taskId],
      );
      const row = await db.query("select task_id from app.agent_turns where event_id = $1", [eventId]);
      expect(row.rows).toEqual([{ task_id: taskId }]);
    }
    const cols = await db.query(
      `select table_name, is_nullable, data_type from information_schema.columns
        where table_schema = 'app' and column_name = 'task_id' and table_name in ('agent_turns', 'bot_work_sessions')
        order by table_name`,
    );
    expect(cols.rows).toEqual([
      { table_name: "agent_turns", is_nullable: "YES", data_type: "uuid" },
      { table_name: "bot_work_sessions", is_nullable: "YES", data_type: "uuid" },
    ]);
    const card = randomUUID();
    await db.query(
      "insert into app.messages (id, organization_id, conversation_id, seq, author_kind, author_id, body) values ($1, $2, $3, 2, 'agent', $4, 'Task: read the pack')",
      [card, A.id, A.channel, A.agent],
    );
    await db.query(
      "insert into app.message_cards (message_id, organization_id, conversation_id, agent_id, kind, title, status, platform_owned) values ($1, $2, $3, $4, 'task', 'Read the pack', 'running', true)",
      [card, A.id, A.channel, A.agent],
    );
    expect(await count("app.message_cards where message_id = $1 and kind = 'task'", [card])).toBe(1);
  });
});

describe("bot task isolation as ocw_app (07.17.1.1.2, D-01, E22)", () => {
  const TABLES = ["app.bot_tasks", "app.bot_task_processes"] as const;

  beforeAll(async () => {
    await processRow(A, await task(A));
  });

  it("organization B reads, updates and deletes none of A's tasks and processes, and cannot insert one naming A", async () => {
    for (const tbl of TABLES) {
      expect(await count(`${tbl} where organization_id = $1`, [A.id]), `${tbl} seeded`).toBeGreaterThan(0);
      const own = await as(A.id, null, (q) => q(`select count(*)::int as n from ${tbl}`));
      expect(own.rows[0].n, `${tbl} own`).toBe(await count(`${tbl} where organization_id = $1`, [A.id]));
      const cross = await as(B.id, null, (q) =>
        q(`select count(*)::int as n from ${tbl} where organization_id = $1`, [A.id]),
      );
      expect(cross.rows[0].n, `${tbl} cross-tenant select`).toBe(0);
      for (const stmt of [
        `update ${tbl} set status = 'stopped' where organization_id = $1`,
        `delete from ${tbl} where organization_id = $1`,
      ]) {
        const r = await as(B.id, null, (q) => q(stmt, [A.id]));
        expect(r.rowCount, stmt).toBe(0);
      }
      // Without a tenant the app role sees nothing.
      expect((await app.query(`select count(*)::int as n from ${tbl}`)).rows[0].n, `${tbl} no tenant`).toBe(
        0,
      );
    }
    await expect(
      as(B.id, null, (q) => task(A, {}, q)),
      "cross-tenant task insert",
    ).rejects.toThrow(/row-level security/);
    const own = await task(A);
    await expect(
      as(B.id, null, (q) => processRow(A, own, {}, q)),
      "cross-tenant process insert",
    ).rejects.toThrow(/row-level security/);
  });

  it("both tables are ENABLE + FORCE RLS with the tenant policy, and the app role may not TRUNCATE them", async () => {
    const rls = await db.query(
      `select c.relname, c.relrowsecurity as rls, c.relforcerowsecurity as force,
              (select count(*)::int from pg_policies p where p.schemaname = 'app' and p.tablename = c.relname and p.policyname = 'tenant_isolation') as policies
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'app' and c.relname in ('bot_tasks', 'bot_task_processes') order by c.relname`,
    );
    expect(rls.rows).toEqual([
      { relname: "bot_task_processes", rls: true, force: true, policies: 1 },
      { relname: "bot_tasks", rls: true, force: true, policies: 1 },
    ]);
    for (const tbl of TABLES) {
      await expect(
        as(A.id, null, (q) => q(`truncate ${tbl}`)),
        `truncate ${tbl}`,
      ).rejects.toMatchObject({
        code: "42501",
      });
      const priv = await db.query("select has_table_privilege('ocw_app', $1, 'TRUNCATE') as t", [tbl]);
      expect(priv.rows[0].t, tbl).toBe(false);
    }
  });
});

describe("bot task checks and the organization's limits (07.17.1.1.2, D-04, PD-05, PD-09)", () => {
  const done = () => ({ status: "done", outcome: "done", finished_at: new Date().toISOString() });

  it("refuses every malformed task, each by its named check", async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      // Shaped like a finished task, so only the status itself is wrong.
      [{ ...done(), status: "paused" }, "bot_tasks_status_ck"],
      [{ ...done(), outcome: "gave_up" }, "bot_tasks_outcome_ck"],
      // A finished task always has an outcome; an active one never has.
      [{ ...done(), outcome: null }, "bot_tasks_outcome_ck"],
      [{ outcome: "done" }, "bot_tasks_outcome_ck"],
      [{ wait_kind: "sleep" }, "bot_tasks_wait_kind_ck"],
      [{ goal: "g".repeat(201) }, "bot_tasks_goal_ck"],
      [{ goal: "" }, "bot_tasks_goal_ck"],
      [{ progress: "p".repeat(501) }, "bot_tasks_progress_ck"],
      [{ next_step: "n".repeat(501) }, "bot_tasks_next_step_ck"],
      [{ ...done(), summary: "s".repeat(1001) }, "bot_tasks_summary_ck"],
      [{ max_turns: 0 }, "bot_tasks_max_turns_ck"],
      [{ max_turns: 201 }, "bot_tasks_max_turns_ck"],
      [{ turns_used: -1 }, "bot_tasks_turns_used_ck"],
      [{ wait_seq: -1 }, "bot_tasks_wait_seq_ck"],
      [{ last_post_turn: -1 }, "bot_tasks_last_post_turn_ck"],
      [{ wait_ref: "r".repeat(65) }, "bot_tasks_wait_ref_ck"],
      [{ finished_at: new Date().toISOString() }, "bot_tasks_finished_at_ck"],
      [{ ...done(), finished_at: null }, "bot_tasks_finished_at_ck"],
    ];
    for (const [cols, constraint] of cases) {
      await refused(task(A, cols), { constraint });
    }
    // The bounds themselves are accepted.
    await task(A, {
      goal: "g".repeat(200),
      progress: "p".repeat(500),
      next_step: "n".repeat(500),
      max_turns: 200,
      wait_ref: "r".repeat(64),
      status: "waiting",
      wait_kind: "process",
      wake_at: new Date().toISOString(),
    });
    await task(A, { ...done(), summary: "s".repeat(1000), max_turns: 1 });
    for (const status of ["failed", "stopped"]) {
      await task(A, { status, outcome: "error", finished_at: new Date().toISOString() });
    }
    for (const wait_kind of ["turn", "timer", "process", "session", "nudge"]) {
      await task(A, { status: "waiting", wait_kind });
    }
  });

  it("refuses an unknown process status, an empty or long process id and a negative duration", async () => {
    const t = await task(A);
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ status: "zombie" }, "bot_task_processes_status_ck"],
      [{ process_id: "" }, "bot_task_processes_process_id_ck"],
      [{ process_id: "x".repeat(65) }, "bot_task_processes_process_id_ck"],
      [{ duration_ms: -1 }, "bot_task_processes_duration_ms_ck"],
      // Code review WR-02: an unlinked end has neither id and is never running.
      [{ task_id: null, event_id: null }, "bot_task_processes_link_ck"],
      [{ task_id: null, status: "exited" }, "bot_task_processes_link_ck"],
    ];
    for (const [cols, constraint] of cases) {
      await refused(processRow(A, t, cols), { constraint });
    }
    for (const status of ["running", "exited", "killed", "timed_out", "lost"]) {
      await processRow(A, t, { status });
    }
    await processRow(A, t, { task_id: null, event_id: null, status: "exited", exit_code: 0 });
    const fresh = await processRow(A, t);
    const row = await db.query(
      "select status, exit_code, duration_ms, ended_at, reported_at from app.bot_task_processes where id = $1",
      [fresh],
    );
    expect(row.rows).toEqual([
      { status: "running", exit_code: null, duration_ms: null, ended_at: null, reported_at: null },
    ]);
  });

  it("a fresh policy reads 40 turns, 8 hours and 10 running tasks; each limit holds its range by its named check", async () => {
    await db.query("insert into app.bot_policies (organization_id) values ($1)", [A.id]);
    const row = await db.query(
      "select task_max_turns, task_max_hours, max_running_tasks from app.bot_policies where organization_id = $1",
      [A.id],
    );
    expect(row.rows).toEqual([{ task_max_turns: 40, task_max_hours: 8, max_running_tasks: 10 }]);
    const set = (col: string, v: number) =>
      db.query(`update app.bot_policies set ${col} = $2 where organization_id = $1`, [A.id, v]);
    const bad: Array<[string, number, string]> = [
      ["task_max_turns", 0, "bot_policies_task_max_turns_check"],
      ["task_max_turns", 201, "bot_policies_task_max_turns_check"],
      ["task_max_hours", 0, "bot_policies_task_max_hours_check"],
      ["task_max_hours", 25, "bot_policies_task_max_hours_check"],
      ["max_running_tasks", -1, "bot_policies_max_running_tasks_check"],
      ["max_running_tasks", 101, "bot_policies_max_running_tasks_check"],
    ];
    for (const [col, v, constraint] of bad) {
      await refused(set(col, v), { constraint });
    }
    const good: Array<[string, number]> = [
      ["task_max_turns", 1],
      ["task_max_turns", 200],
      ["task_max_hours", 1],
      ["task_max_hours", 24],
      ["max_running_tasks", 0],
      ["max_running_tasks", 100],
    ];
    for (const [col, v] of good) {
      expect((await set(col, v)).rowCount, `${col} ${v}`).toBe(1);
    }
    await expect(
      db.query("update app.bot_policies set task_max_turns = null where organization_id = $1", [A.id]),
    ).rejects.toMatchObject({ code: "23502" });
  });
});

describe("the tick's lister app.due_bot_tasks (07.17.1.1.2, PD-06, PD-09)", () => {
  const MIN = 60_000;
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
  const due: Record<string, string> = {};
  const notDue: Record<string, string> = {};

  beforeAll(async () => {
    // Across both organizations, each condition alone.
    due.waitingPastWake = await task(A, { status: "waiting", wait_kind: "timer", wake_at: ago(2 * MIN) });
    due.runningLost = await task(B, { updated_at: ago(31 * MIN) });
    due.pastDeadline = await task(B, {
      status: "waiting",
      wait_kind: "turn",
      wake_at: ago(-10 * MIN),
      deadline_at: ago(MIN),
    });
    const disabled = await bot(A.id, "disabled");
    await db.query("update app.agents set status = 'disabled' where id = $1", [disabled]);
    due.disabledBot = await task({ ...A, agent: disabled });
    const archived = await bot(B.id, "archived");
    await db.query("update app.agents set deleted_at = now() where id = $1", [archived]);
    due.archivedBot = await task({ ...B, agent: archived }, { status: "waiting", wait_kind: "turn" });
    // Not yet due: a wake inside the 60 s grace, a turn still fresh; and no finished task, whatever its times or bot.
    notDue.waitingJustDue = await task(A, { status: "waiting", wait_kind: "timer", wake_at: ago(10_000) });
    notDue.runningFresh = await task(A, { updated_at: ago(5 * MIN) });
    const finished: Record<string, Record<string, unknown>> = {
      done: { status: "done", outcome: "done" },
      failed: { status: "failed", outcome: "error" },
      stopped: { status: "stopped", outcome: "stopped_by_person" },
    };
    for (const [name, cols] of Object.entries(finished)) {
      notDue[name] = await task(
        { ...A, agent: disabled },
        {
          ...cols,
          finished_at: ago(MIN),
          wake_at: ago(60 * MIN),
          updated_at: ago(60 * MIN),
          deadline_at: ago(MIN),
        },
      );
    }
  });

  it("lists, as ocw_app with no tenant, the due tasks of every organization by id and organization only", async () => {
    const res = await app.query("select * from app.due_bot_tasks($1, now())", [1000]);
    expect(res.fields.map((f) => f.name)).toEqual(["id", "organization_id"]);
    const listed = new Map(res.rows.map((r) => [r.id as string, r.organization_id as string]));
    for (const [name, id] of Object.entries(due)) expect(listed.has(id), `${name} listed`).toBe(true);
    for (const [name, id] of Object.entries(notDue)) expect(listed.has(id), `${name} not listed`).toBe(false);
    expect(listed.get(due.waitingPastWake ?? "")).toBe(A.id);
    expect(listed.get(due.runningLost ?? "")).toBe(B.id);
    // The app role still reads no task row itself without a tenant.
    expect((await app.query("select count(*)::int as n from app.bot_tasks")).rows[0].n).toBe(0);
  });

  it("honours the limit (at least one row)", async () => {
    expect((await app.query("select * from app.due_bot_tasks(1, now())")).rows).toHaveLength(1);
    expect((await app.query("select * from app.due_bot_tasks(0, now())")).rows).toHaveLength(1);
  });

  it("is SECURITY DEFINER with a fixed search_path, executable by ocw_app only", async () => {
    const fn = await db.query(
      "select p.prosecdef, p.proconfig from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app' and p.proname = 'due_bot_tasks'",
    );
    expect(fn.rows).toEqual([{ prosecdef: true, proconfig: ["search_path=pg_catalog, pg_temp"] }]);
    const priv = await db.query(
      "select has_function_privilege('ocw_app', 'app.due_bot_tasks(integer, timestamptz)', 'EXECUTE') as app, has_function_privilege('ocw_auth', 'app.due_bot_tasks(integer, timestamptz)', 'EXECUTE') as auth",
    );
    expect(priv.rows).toEqual([{ app: true, auth: false }]);
    const other = new pg.Client({ connectionString: tdb.authUrl });
    await other.connect();
    try {
      await expect(other.query("select * from app.due_bot_tasks(10, now())")).rejects.toMatchObject({
        code: "42501",
      });
    } finally {
      await other.end();
    }
  });
});
