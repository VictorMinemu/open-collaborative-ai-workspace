import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmdirSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { UNIT_HANDLE_RE, unitHandle } from "@ocw/contracts";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootstrapRoles, MIGRATIONS_DIR, runMigrations } from "./migrate";

/**
 * Phase 07.17 (D-02, D-03, D-07, D-08, D-10, D-11, D-14, PD-04, PD-05, PD-12): the fan-out storage. The shapes a bug in
 * the API must never store are refused by PostgreSQL through NAMED constraints (asserted on the error's `constraint`):
 * one opened conversation per (automation, external key hash), the key only as a sha256 hex, fan-out only on agent-turn
 * schedules to a channel or a board, the per-run / per-day / escalation bounds, one unit handle per organization in the
 * handle grammar. Deleting an opened root or the run log root clears only that link (never `conversation_id` or
 * `organization_id`); deleting the automation or the run removes its opened rows; deleting a unit unlinks its
 * notifications.
 *
 * The harness migrates in two steps so the backfill is proven on rows that existed BEFORE the migration: every
 * migration except `*_automation_fan_out` is applied, units, bots, an automation, notifications and two bot policies
 * are written in the N-1 shape, then `runMigrations` applies the fan-out migration, post-migrate and the job schema
 * (exactly what `ocw upgrade` runs). Seeded and checked as ocw_migrator (no RLS in the way); tenant isolation and the
 * TRUNCATE revoke are proven as ocw_app.
 */

const PW = { migrator: "fan-out-migrator-pw", app: "fan-out-app-pw", auth: "fan-out-auth-pw" };
const FAN_OUT_SUFFIX = "_automation_fan_out";

let container: StartedPostgreSqlContainer;
let db: pg.Client;
let app: pg.Client;

type Q = (text: string, values?: unknown[]) => Promise<pg.QueryResult>;
const mq: Q = (text, values) => db.query(text, values);

interface Org {
  id: string;
  ana: string;
  ben: string;
  agent: string;
  channel: string;
  board: string;
  column: string;
  msg: string;
}

let seq = 0;
const at = () => new Date(Date.UTC(2026, 9, 1, 8, 0, ++seq)).toISOString();
const hash = (c: string) => c.repeat(64);

async function person(q: Q, org: string, id: string): Promise<void> {
  await q("insert into auth.user (id, name, email) values ($1, 'P', $2)", [id, `${id}@afo.test`]);
  await q(
    "insert into app.org_members (organization_id, user_id, display_name, role) values ($1, $2, 'P', 'standard')",
    [org, id],
  );
}

async function bot(q: Q, org: string, username: string, deleted = false): Promise<string> {
  const id = randomUUID();
  await q(
    "insert into app.agents (id, organization_id, name, username, instructions, model_provider, model_id, deleted_at) values ($1, $2, $3, $3, 'x', 'mock', 'mock-1', $4)",
    [id, org, username, deleted ? new Date().toISOString() : null],
  );
  return id;
}

async function message(q: Q, o: Org, conversation: string, body = "hi"): Promise<string> {
  const id = randomUUID();
  await q(
    "insert into app.messages (id, organization_id, conversation_id, seq, author_kind, author_id, body) values ($1, $2, $3, 1, 'user', $4, $5)",
    [id, o.id, conversation, o.ana, body],
  );
  return id;
}

/** An organization with two people, a bot, a channel with one message and a board with one column. */
async function seedOrg(q: Q, botName = `bot-${randomUUID().slice(0, 8)}`): Promise<Org> {
  const o: Org = {
    id: randomUUID(),
    ana: randomUUID(),
    ben: randomUUID(),
    agent: "",
    channel: randomUUID(),
    board: randomUUID(),
    column: randomUUID(),
    msg: "",
  };
  await q("insert into auth.organization (id, name, slug) values ($1, 'O', $2)", [o.id, `o-${o.id}`]);
  await person(q, o.id, o.ana);
  await person(q, o.id, o.ben);
  o.agent = await bot(q, o.id, botName);
  await q(
    "insert into app.conversations (id, organization_id, kind, name, slug) values ($1, $2, 'channel', 'general', $3)",
    [o.channel, o.id, `general-${o.channel}`],
  );
  await q(
    "insert into app.conversations (id, organization_id, kind, name, slug, layout) values ($1, $2, 'channel', 'orders', $3, 'board')",
    [o.board, o.id, `orders-${o.board}`],
  );
  await q("insert into app.boards (conversation_id, organization_id) values ($1, $2)", [o.board, o.id]);
  await q(
    "insert into app.board_columns (id, organization_id, conversation_id, name, rank, category) values ($1, $2, $3, 'Backlog', 'a0', 'backlog')",
    [o.column, o.id, o.board],
  );
  o.msg = await message(q, o, o.channel);
  return o;
}

/** A unit written in the given shape (no handle column before the migration), created at a strictly later instant. */
async function unit(
  q: Q,
  org: string,
  name: string,
  r: { parent?: string | null; parentPath?: string[]; kind?: string; handle?: string } = {},
): Promise<string> {
  const id = randomUUID();
  const cols = ["id", "organization_id", "parent_id", "kind", "name", "path", "created_at"];
  const values: unknown[] = [
    id,
    org,
    r.parent ?? null,
    r.kind ?? "team",
    name,
    [...(r.parentPath ?? []), id],
    at(),
  ];
  if (r.handle !== undefined) {
    cols.push("handle");
    values.push(r.handle);
  }
  await q(
    `insert into app.org_units (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")})`,
    values,
  );
  return id;
}

/** Inserts a scheduled channel automation (overridable) and returns its id. */
async function automation(q: Q, o: Org, cols: Record<string, unknown> = {}): Promise<string> {
  const row: Record<string, unknown> = {
    id: randomUUID(),
    organization_id: o.id,
    name: "Open new orders",
    agent_id: o.agent,
    run_as_user_id: o.ana,
    created_by: o.ana,
    trigger_kind: "schedule",
    schedule_cron: "*/10 * * * *",
    time_zone: "Europe/Madrid",
    target_kind: "channel",
    conversation_id: o.channel,
    ...cols,
  };
  const keys = Object.keys(row);
  await q(
    `insert into app.automations (${keys.join(", ")}) values (${keys.map((_, i) => `$${i + 1}`).join(", ")})`,
    keys.map((k) => row[k]),
  );
  return row.id as string;
}

async function run(q: Q, o: Org, automationId: string): Promise<string> {
  const id = randomUUID();
  await q(
    "insert into app.automation_runs (id, organization_id, automation_id, trigger) values ($1, $2, $3, 'manual')",
    [id, o.id, automationId],
  );
  return id;
}

/** One opened conversation row (defaults unless overridden); returns its id. */
async function opened(
  q: Q,
  o: Org,
  p: { automation: string; run: string; hash?: string; root?: string | null; conversation?: string },
  cols: Record<string, unknown> = {},
): Promise<string> {
  const row: Record<string, unknown> = {
    organization_id: o.id,
    automation_id: p.automation,
    run_id: p.run,
    external_key_hash: p.hash ?? hash("a"),
    conversation_id: p.conversation ?? o.channel,
    root_message_id: p.root ?? null,
    ...cols,
  };
  const keys = Object.keys(row);
  const res = await q(
    `insert into app.automation_conversations (${keys.join(", ")}) values (${keys.map((_, i) => `$${i + 1}`).join(", ")}) returning id`,
    keys.map((k) => row[k]),
  );
  return res.rows[0].id as string;
}

async function refused(p: Promise<unknown>, named: { constraint: string }): Promise<void> {
  await expect(p, named.constraint).rejects.toMatchObject(named);
}

/** The SQLSTATE of a statement that must fail, or null when it succeeded. */
async function errorCode(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (err) {
    return (err as { code?: string }).code ?? "unknown";
  }
}

/** Runs `fn` as ocw_app in `org`'s tenant transaction, always rolled back. */
async function asApp<T>(org: string, fn: (q: Q) => Promise<T>): Promise<T> {
  await app.query("begin");
  try {
    await app.query("select set_config('app.organization_id', $1, true)", [org]);
    return await fn((text, values) => app.query(text, values));
  } finally {
    await app.query("rollback");
  }
}

/** Names of the N-1 rows the backfill must give handles to (org A unless stated). */
const LONG = "Operations and Logistics for the Northern Region";
const PARITY_NAMES = [
  "Logística Norte",
  "R&D / Labs",
  "  Sales   Team  ",
  "Ünïcödé Çafé",
  "***",
  "Customer_Success.EU",
  "Ñandú",
  "here",
  "Channel",
  "x--y__z",
  "Équipe Été 2026",
  "--Dash--Ends--",
] as const;

let A: Org;
let B: Org;
let P: Org;
const units: Record<string, string> = {};
let preAutomation: string;
let preNotification: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:18")
    .withDatabase("ocw")
    .withUsername("postgres")
    .withPassword("postgres")
    .start();
  const url = (u: string, p: string) =>
    `postgres://${u}:${p}@${container.getHost()}:${container.getPort()}/ocw`;
  const superuserUrl = url("postgres", "postgres");
  const migratorUrl = url("ocw_migrator", PW.migrator);
  await bootstrapRoles(superuserUrl, PW);

  // Step 1: every migration before this phase's (the N-1 schema), from a folder of links to the shipped ones.
  const folders = readdirSync(MIGRATIONS_DIR).filter((d) => /^\d{14}_/.test(d));
  expect(
    folders.filter((d) => d.endsWith(FAN_OUT_SUFFIX)),
    "exactly one fan-out migration",
  ).toHaveLength(1);
  const before = mkdtempSync(join(tmpdir(), "ocw-afo-"));
  // Every migration older than the fan-out one: later ones (07.17 code review WR-02's) build on it and run in step 3.
  const fanOut = folders.find((d) => d.endsWith(FAN_OUT_SUFFIX)) as string;
  const links = folders.filter((d) => d < fanOut).map((d) => join(before, d));
  try {
    for (const link of links) symlinkSync(join(MIGRATIONS_DIR, basename(link)), link);
    const pool = new pg.Pool({ connectionString: migratorUrl, max: 1 });
    try {
      await migrate(drizzle({ client: pool }), { migrationsFolder: before });
    } finally {
      await pool.end();
    }
  } finally {
    // Unlink the links one by one (never a recursive delete through them), then the empty folder.
    for (const link of links) if (existsSync(link)) unlinkSync(link);
    rmdirSync(before);
  }

  db = new pg.Client({ connectionString: migratorUrl });
  await db.connect();

  // Step 2: rows in the N-1 shape. Org A: a live bot `scout`, a deleted bot `ghost`, units in a known creation order.
  A = await seedOrg(mq);
  B = await seedOrg(mq);
  P = await seedOrg(mq);
  await bot(mq, A.id, "scout");
  await bot(mq, A.id, "ghost", true);
  units.north = await unit(mq, A.id, "North", { kind: "department" });
  units.south = await unit(mq, A.id, "South", { kind: "department" });
  units.ops = await unit(mq, A.id, "Ops", { parent: units.north, parentPath: [units.north] });
  units.ops2 = await unit(mq, A.id, "Ops", { parent: units.south, parentPath: [units.south] });
  units.logistica = await unit(mq, A.id, "Logística Norte", { kind: "department" });
  units.scout = await unit(mq, A.id, "Scout");
  units.here = await unit(mq, A.id, "here");
  units.ghost = await unit(mq, A.id, "Ghost");
  units.long = await unit(mq, A.id, LONG, { parent: units.north, parentPath: [units.north] });
  units.long2 = await unit(mq, A.id, LONG, { parent: units.south, parentPath: [units.south] });
  units.bOps = await unit(mq, B.id, "Ops");
  for (const [i, name] of PARITY_NAMES.entries()) units[`p${i}`] = await unit(mq, P.id, name);
  preAutomation = await automation(mq, A);
  preNotification = randomUUID();
  await mq(
    "insert into app.notifications (id, organization_id, user_id, kind, conversation_id, message_id, actor_kind, actor_id) values ($1, $2, $3, 'mention', $4, $5, 'user', $6)",
    [preNotification, A.id, A.ben, A.channel, A.msg, A.ana],
  );
  // Org A's policy still holds the 07.6 defaults (15 / 96); org B's admin chose 30 / 200.
  await mq("insert into app.bot_policies (organization_id) values ($1)", [A.id]);
  await mq(
    "insert into app.bot_policies (organization_id, min_schedule_minutes, max_runs_per_day_cap) values ($1, 30, 200)",
    [B.id],
  );

  // Step 3: the upgrade itself (the fan-out migration, post-migrate, the job schema).
  await runMigrations({ superuserUrl, migratorUrl, passwords: PW, log: () => {} });
  app = new pg.Client({ connectionString: url("ocw_app", PW.app) });
  await app.connect();
});

afterAll(async () => {
  await db?.end();
  await app?.end();
  await container?.stop();
});

describe("the upgrade of N-1 rows (07.17, D-11, D-14, PD-04, PD-12)", () => {
  const handleOf = async (id: string | undefined) =>
    (await mq("select handle from app.org_units where id = $1", [id])).rows[0]?.handle as string;

  it("gives every existing unit its name's handle, suffixed -2, -3 in creation order, never a live bot's username", async () => {
    expect(await handleOf(units.north)).toBe("north");
    expect(await handleOf(units.south)).toBe("south");
    expect(await handleOf(units.ops)).toBe("ops");
    expect(await handleOf(units.ops2)).toBe("ops-2");
    expect(await handleOf(units.logistica)).toBe("logistica-norte");
    expect(await handleOf(units.scout)).toBe("scout-2");
    expect(await handleOf(units.here)).toBe("here-1");
    // A deleted bot's username is free again (the agents rule: "the username becomes reusable").
    expect(await handleOf(units.ghost)).toBe("ghost");
    // Handles are unique per organization only.
    expect(await handleOf(units.bOps)).toBe("ops");
  });

  it("keeps every handle typable as a mention: the base is trimmed before the suffix (40 characters at most)", async () => {
    expect(await handleOf(units.long)).toBe("operations-and-logistics-for-the-norther");
    expect(await handleOf(units.long2)).toBe("operations-and-logistics-for-the-north-2");
    const all = await mq("select handle from app.org_units");
    for (const { handle } of all.rows) {
      expect(handle, handle).toMatch(UNIT_HANDLE_RE);
      expect(handle.length, handle).toBeLessThanOrEqual(40);
    }
  });

  it("matches the contracts' unitHandle on the fixture names (the SQL on app.unaccent is its equivalent)", async () => {
    for (const [i, name] of PARITY_NAMES.entries()) {
      expect(await handleOf(units[`p${i}`]), JSON.stringify(name)).toBe(unitHandle(name));
    }
  });

  it("an existing automation reads fan-out off, 10 / 100, no escalation and no run log; its notification no unit", async () => {
    const a = await mq(
      "select fan_out_enabled, fan_out_per_run, fan_out_per_day, escalation_targets, run_log_message_id from app.automations where id = $1",
      [preAutomation],
    );
    expect(a.rows[0]).toEqual({
      fan_out_enabled: false,
      fan_out_per_run: 10,
      fan_out_per_day: 100,
      escalation_targets: [],
      run_log_message_id: null,
    });
    const n = await mq("select kind, unit_id from app.notifications where id = $1", [preNotification]);
    expect(n.rows[0]).toEqual({ kind: "mention", unit_id: null });
  });

  it("moves default-valued policies to 5 / 288 and keeps an admin's own values", async () => {
    const p = await mq(
      "select organization_id, min_schedule_minutes, max_runs_per_day_cap from app.bot_policies where organization_id = any($1::uuid[]) order by min_schedule_minutes",
      [[A.id, B.id]],
    );
    expect(p.rows).toEqual([
      { organization_id: A.id, min_schedule_minutes: 5, max_runs_per_day_cap: 288 },
      { organization_id: B.id, min_schedule_minutes: 30, max_runs_per_day_cap: 200 },
    ]);
    const fresh = await seedOrg(mq);
    const d = await mq(
      "insert into app.bot_policies (organization_id) values ($1) returning min_schedule_minutes, max_runs_per_day_cap",
      [fresh.id],
    );
    expect(d.rows[0]).toEqual({ min_schedule_minutes: 5, max_runs_per_day_cap: 288 });
  });
});

describe("unit handles and team mention notifications (07.17, D-07, D-14)", () => {
  it("a unit inserted without a handle gets the next free one (N-1 code and raw inserts keep working)", async () => {
    const id = await unit(mq, A.id, "Ops", { kind: "department" });
    expect((await mq("select handle from app.org_units where id = $1", [id])).rows[0].handle).toBe("ops-3");
    // As the app role inside its tenant too.
    const north = String(units.north);
    const viaApp = await asApp(A.id, async (q) => {
      const uid = await unit(q, A.id, "Logística Norte", { parent: north, parentPath: [north] });
      return (await q("select handle from app.org_units where id = $1", [uid])).rows[0].handle as string;
    });
    expect(viaApp).toBe("logistica-norte-2");
  });

  it("refuses a second unit with an existing handle and a handle outside the grammar", async () => {
    await refused(unit(mq, A.id, "Operations", { handle: "ops" }), { constraint: "org_units_handle_uq" });
    for (const bad of ["Bad Handle", "-ops", "ops-", "OPS", "a".repeat(49)]) {
      await refused(unit(mq, A.id, `Bad ${randomUUID()}`, { handle: bad }), {
        constraint: "org_units_handle_check",
      });
    }
  });

  it("accepts a team_mention naming its unit; deleting the unit keeps the notification and clears unit_id only", async () => {
    const leaf = await unit(mq, A.id, "Night shift");
    const id = randomUUID();
    await mq(
      "insert into app.notifications (id, organization_id, user_id, kind, conversation_id, message_id, actor_kind, actor_id, unit_id) values ($1, $2, $3, 'team_mention', $4, $5, 'user', $6, $7)",
      [id, A.id, A.ana, A.channel, A.msg, A.ben, leaf],
    );
    await mq("delete from app.org_units where id = $1", [leaf]);
    const n = await mq("select organization_id, kind, unit_id from app.notifications where id = $1", [id]);
    expect(n.rows[0]).toEqual({ organization_id: A.id, kind: "team_mention", unit_id: null });
    await refused(
      mq(
        "insert into app.notifications (organization_id, user_id, kind, conversation_id, message_id, actor_kind) values ($1, $2, 'team', $3, $4, 'user')",
        [A.id, A.ben, A.channel, await message(mq, A, A.channel)],
      ),
      { constraint: "notifications_kind_check" },
    );
  });
});

describe("fan-out settings on automations (07.17, D-02, D-08, D-10, D-16)", () => {
  it("a new automation reads fan-out off, 10 / 100, no escalation, no run log", async () => {
    const id = await automation(mq, A);
    const a = await mq(
      "select fan_out_enabled, fan_out_per_run, fan_out_per_day, escalation_targets, run_log_message_id from app.automations where id = $1",
      [id],
    );
    expect(a.rows[0]).toEqual({
      fan_out_enabled: false,
      fan_out_per_run: 10,
      fan_out_per_day: 100,
      escalation_targets: [],
      run_log_message_id: null,
    });
  });

  it("allows fan-out only on agent-turn schedules to a channel or a board", async () => {
    const on = { fan_out_enabled: true };
    await automation(mq, A, on);
    await automation(mq, A, {
      ...on,
      target_kind: "board",
      conversation_id: A.board,
      board_column_id: A.column,
    });
    const check = { constraint: "automations_fan_out_check" };
    const inbound = { schedule_cron: null, time_zone: null, inbound_action: "post" };
    await refused(automation(mq, A, { ...on, ...inbound, trigger_kind: "webhook" }), check);
    await refused(automation(mq, A, { ...on, ...inbound, trigger_kind: "mail" }), check);
    await refused(
      automation(mq, A, {
        ...on,
        run_as_user_id: A.ben,
        created_by: A.ben,
        action_kind: "digest",
        target_kind: "dm",
        conversation_id: null,
      }),
      check,
    );
    await refused(automation(mq, A, { ...on, target_kind: "dm", conversation_id: null }), check);
    await refused(automation(mq, A, { ...on, target_kind: "thread", thread_root_message_id: A.msg }), check);
  });

  it("bounds the per-run and per-day limits and the escalation targets", async () => {
    await refused(automation(mq, A, { fan_out_per_run: 26 }), {
      constraint: "automations_fan_out_per_run_check",
    });
    await refused(automation(mq, A, { fan_out_per_run: 0 }), {
      constraint: "automations_fan_out_per_run_check",
    });
    await refused(automation(mq, A, { fan_out_per_day: 501 }), {
      constraint: "automations_fan_out_per_day_check",
    });
    await refused(automation(mq, A, { fan_out_per_run: 20, fan_out_per_day: 10 }), {
      constraint: "automations_fan_out_per_day_check",
    });
    await automation(mq, A, { fan_out_per_run: 25, fan_out_per_day: 500 });
    const target = { kind: "user", id: A.ana };
    await automation(mq, A, { escalation_targets: JSON.stringify(Array(5).fill(target)) });
    await refused(automation(mq, A, { escalation_targets: JSON.stringify(Array(6).fill(target)) }), {
      constraint: "automations_escalation_targets_check",
    });
    await refused(automation(mq, A, { escalation_targets: JSON.stringify(target) }), {
      constraint: "automations_escalation_targets_check",
    });
  });

  it("deleting the run log root clears run_log_message_id only", async () => {
    const root = await message(mq, A, A.channel, "Open new orders · Runs");
    const id = await automation(mq, A, { fan_out_enabled: true, run_log_message_id: root });
    // The root must be a message of the automation's own conversation.
    const elsewhere = await message(mq, A, A.board, "card");
    await refused(automation(mq, A, { run_log_message_id: elsewhere }), {
      constraint: "automations_run_log_fk",
    });
    await mq("delete from app.messages where id = $1", [root]);
    const a = await mq(
      "select organization_id, conversation_id, run_log_message_id from app.automations where id = $1",
      [id],
    );
    expect(a.rows[0]).toEqual({
      organization_id: A.id,
      conversation_id: A.channel,
      run_log_message_id: null,
    });
  });
});

describe("opened conversations (07.17, D-03, P1)", () => {
  it("a row with defaults is queued, with no reason and no child turn", async () => {
    const a = await automation(mq, A, { fan_out_enabled: true });
    const id = await opened(mq, A, { automation: a, run: await run(mq, A, a), hash: hash("1") });
    const row = await mq(
      "select status, reason, agent_event_id, root_message_id, created_at is not null as created, updated_at is not null as updated from app.automation_conversations where id = $1",
      [id],
    );
    expect(row.rows[0]).toEqual({
      status: "queued",
      reason: null,
      agent_event_id: null,
      root_message_id: null,
      created: true,
      updated: true,
    });
  });

  it("refuses a second row for the same key, a key that is not a sha256 hex, an unknown status and a long reason", async () => {
    const a = await automation(mq, A, { fan_out_enabled: true });
    const r = await run(mq, A, a);
    await opened(mq, A, { automation: a, run: r, hash: hash("2") });
    await refused(opened(mq, A, { automation: a, run: await run(mq, A, a), hash: hash("2") }), {
      constraint: "automation_conversations_key_uq",
    });
    // The same key under another automation is a different item.
    const other = await automation(mq, A, { fan_out_enabled: true });
    await opened(mq, A, { automation: other, run: await run(mq, A, other), hash: hash("2") });
    for (const bad of ["ABC", "A".repeat(64), "a".repeat(63), "a".repeat(65), `${"a".repeat(63)}g`]) {
      await refused(opened(mq, A, { automation: a, run: r, hash: bad }), {
        constraint: "automation_conversations_hash_check",
      });
    }
    await refused(opened(mq, A, { automation: a, run: r, hash: hash("3") }, { status: "done" }), {
      constraint: "automation_conversations_status_check",
    });
    await refused(opened(mq, A, { automation: a, run: r, hash: hash("4") }, { reason: "x".repeat(65) }), {
      constraint: "automation_conversations_reason_len_check",
    });
  });

  it("holds ids and a key hash only (no clear key, title or body column)", async () => {
    const cols = await mq(
      "select column_name from information_schema.columns where table_schema = 'app' and table_name = 'automation_conversations' order by ordinal_position",
    );
    expect(cols.rows.map((c) => c.column_name)).toEqual([
      "id",
      "organization_id",
      "automation_id",
      "run_id",
      "external_key_hash",
      "conversation_id",
      "root_message_id",
      "status",
      "reason",
      "agent_event_id",
      "created_at",
      "updated_at",
      // 07.17 code review WR-02: the re-queue counter (20261110124940_automation_item_waiting).
      "attempt",
    ]);
  });

  it("deleting the root message keeps the row (the item never reopens) with its conversation and organization", async () => {
    const a = await automation(mq, A, { fan_out_enabled: true });
    const root = await message(mq, A, A.channel, "Order SO-1");
    const id = await opened(mq, A, { automation: a, run: await run(mq, A, a), hash: hash("5"), root });
    // The root must be a message of the row's own conversation.
    await refused(
      opened(mq, A, {
        automation: a,
        run: await run(mq, A, a),
        hash: hash("6"),
        root,
        conversation: A.board,
      }),
      { constraint: "automation_conversations_root_fk" },
    );
    await mq("delete from app.messages where id = $1", [root]);
    const row = await mq(
      "select organization_id, conversation_id, root_message_id from app.automation_conversations where id = $1",
      [id],
    );
    expect(row.rows[0]).toEqual({ organization_id: A.id, conversation_id: A.channel, root_message_id: null });
  });

  it("deleting the run, the automation or the opened conversation deletes its rows", async () => {
    const a = await automation(mq, A, { fan_out_enabled: true });
    const r1 = await run(mq, A, a);
    const r2 = await run(mq, A, a);
    const byRun = await opened(mq, A, { automation: a, run: r1, hash: hash("7") });
    const byAutomation = await opened(mq, A, { automation: a, run: r2, hash: hash("8") });
    const count = async (id: string) =>
      (await mq("select count(*)::int as n from app.automation_conversations where id = $1", [id])).rows[0]
        .n as number;
    await mq("delete from app.automation_runs where id = $1", [r1]);
    expect(await count(byRun)).toBe(0);
    expect(await count(byAutomation)).toBe(1);
    await mq("delete from app.automations where id = $1", [a]);
    expect(await count(byAutomation)).toBe(0);
    // A deleted opened conversation takes its row with it.
    const conv = randomUUID();
    await mq(
      "insert into app.conversations (id, organization_id, kind, name, slug) values ($1, $2, 'channel', 'orders-2', $3)",
      [conv, A.id, `orders-2-${conv}`],
    );
    const b = await automation(mq, A, { fan_out_enabled: true });
    const byConversation = await opened(mq, A, {
      automation: b,
      run: await run(mq, A, b),
      hash: hash("e"),
      conversation: conv,
    });
    await mq("delete from app.conversations where id = $1", [conv]);
    expect(await count(byConversation)).toBe(0);
  });

  it("refuses a run, an automation or a conversation of another organization (the keys carry the organization)", async () => {
    const a = await automation(mq, A, { fan_out_enabled: true });
    const r = await run(mq, A, a);
    const bAutomation = await automation(mq, B, { fan_out_enabled: true });
    const bRun = await run(mq, B, bAutomation);
    await refused(opened(mq, A, { automation: a, run: bRun, hash: hash("9") }), {
      constraint: "automation_conversations_run_fk",
    });
    await refused(opened(mq, A, { automation: bAutomation, run: r, hash: hash("9") }), {
      constraint: "automation_conversations_automation_fk",
    });
    await refused(opened(mq, A, { automation: a, run: r, hash: hash("9"), conversation: B.channel }), {
      constraint: "automation_conversations_conversation_fk",
    });
  });
});

describe("opened conversations as ocw_app (07.17, D-03, tenant isolation)", () => {
  let aRow: string;

  beforeAll(async () => {
    const a = await automation(mq, A, { fan_out_enabled: true });
    aRow = await opened(mq, A, { automation: a, run: await run(mq, A, a), hash: hash("c") });
  });

  it("organization B reads, updates and deletes none of organization A's rows, and cannot insert one naming A", async () => {
    const own = await asApp(A.id, (q) =>
      q("select count(*)::int as n from app.automation_conversations where id = $1", [aRow]),
    );
    expect(own.rows[0].n).toBe(1);
    const cross = await asApp(B.id, (q) =>
      q("select count(*)::int as n from app.automation_conversations where organization_id = $1", [A.id]),
    );
    expect(cross.rows[0].n).toBe(0);
    for (const stmt of [
      "update app.automation_conversations set status = 'failed' where organization_id = $1",
      "delete from app.automation_conversations where organization_id = $1",
    ]) {
      const r = await asApp(B.id, (q) => q(stmt, [A.id]));
      expect(r.rowCount, stmt).toBe(0);
    }
    const a = await automation(mq, A, { fan_out_enabled: true });
    const r = await run(mq, A, a);
    await expect(
      asApp(B.id, (q) => opened(q, A, { automation: a, run: r, hash: hash("d") })),
    ).rejects.toThrow(/row-level security/);
    // Inside its own tenant, A writes and reads its row.
    expect(
      await errorCode(() => asApp(A.id, (q) => opened(q, A, { automation: a, run: r, hash: hash("d") }))),
    ).toBeNull();
    const kept = await mq("select status from app.automation_conversations where id = $1", [aRow]);
    expect(kept.rows[0].status).toBe("queued");
  });

  it("is ENABLE + FORCE row level security with the tenant policy", async () => {
    const t = await mq(
      `select c.relrowsecurity as rls, c.relforcerowsecurity as force,
              (select array_agg(policyname::text) from pg_policies p where p.schemaname = 'app' and p.tablename = c.relname) as policies
         from pg_class c where c.oid = 'app.automation_conversations'::regclass`,
    );
    expect(t.rows[0]).toEqual({ rls: true, force: true, policies: ["tenant_isolation"] });
  });

  it("the app role cannot TRUNCATE the table (TRUNCATE ignores RLS)", async () => {
    expect(await errorCode(() => asApp(A.id, (q) => q("truncate app.automation_conversations")))).toBe(
      "42501",
    );
    expect(
      (await mq("select count(*)::int as n from app.automation_conversations where id = $1", [aRow])).rows[0]
        .n,
    ).toBe(1);
  });
});
