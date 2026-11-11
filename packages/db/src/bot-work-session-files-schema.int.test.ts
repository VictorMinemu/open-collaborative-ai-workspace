import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDatabase, type TestDatabase } from "./testing";

/**
 * Phase 07.17.1.1 (D-05, D-06, D-07, PD-05, PD-12, PD-16, PD-22): the storage of a bot's file moves with its Work Zone
 * sessions. The two limit columns (the organization's and the bot's largest file) and the transfer ledger refuse every
 * shape a bug in the API must never store, each through a NAMED constraint (asserted on the error's `constraint`). The
 * ledger holds ids, sizes, a digest and a path LENGTH only: never a path, a file name or content (P1). Deleting the
 * session deletes its rows. Seeded and checked as ocw_migrator on a fresh database with every migration applied; the
 * tenant isolation is proven as ocw_app in the second block.
 */

let tdb: TestDatabase;
let db: pg.Client;
let app: pg.Client;

type Q = pg.Client["query"];

interface Org {
  id: string;
  user: string;
  agent: string;
  device: string;
  project: string;
  channel: string;
  session: string;
}

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const SHA = "0123456789abcdef".repeat(4);

async function bot(org: string, name = "builder"): Promise<string> {
  const id = randomUUID();
  await db.query(
    "insert into app.agents (id, organization_id, name, username, instructions, model_provider, model_id) values ($1, $2, $3, $4, 'x', 'mock', 'mock-1')",
    [id, org, name, `${name}-${id.slice(0, 8)}`],
  );
  return id;
}

async function workSession(o: Org): Promise<string> {
  const conv = randomUUID();
  const id = randomUUID();
  await db.query(
    "insert into app.conversations (id, organization_id, kind, name) values ($1, $2, 'work_session', 'ws')",
    [conv, o.id],
  );
  await db.query(
    "insert into app.work_sessions (id, organization_id, conversation_id, project_id, device_id, title, created_by, started_by_agent_id) values ($1, $2, $3, $4, $5, 'T', $6, $7)",
    [id, o.id, conv, o.project, o.device, o.user, o.agent],
  );
  return id;
}

async function seedOrg(): Promise<Org> {
  const id = randomUUID();
  await db.query("insert into auth.organization (id, name, slug) values ($1, 'O', $2)", [id, `o-${id}`]);
  const user = randomUUID();
  await db.query("insert into auth.user (id, name, email) values ($1, 'P', $2)", [user, `${user}@bwf.test`]);
  await db.query(
    "insert into app.org_members (organization_id, user_id, display_name, role) values ($1, $2, 'P', 'standard')",
    [id, user],
  );
  const agent = await bot(id);
  const device = randomUUID();
  await db.query(
    "insert into app.devices (id, organization_id, owner_user_id, name, platform, token_hash) values ($1, $2, $3, 'build server', 'linux', $4)",
    [device, id, user, `tok-${device}`],
  );
  const project = randomUUID();
  await db.query(
    "insert into app.projects (id, organization_id, device_id, local_id, name) values ($1, $2, $3, $4, 'repo')",
    [project, id, device, `l-${project}`],
  );
  const channel = randomUUID();
  await db.query(
    "insert into app.conversations (id, organization_id, kind, name, slug) values ($1, $2, 'channel', 'general', $3)",
    [channel, id, `general-${channel}`],
  );
  const o: Org = { id, user, agent, device, project, channel, session: "" };
  o.session = await workSession(o);
  return o;
}

/** One ledger row for `o`'s session (every column set unless overridden), as `q` (the migrator by default). */
async function transfer(
  o: Org,
  cols: Record<string, unknown> = {},
  q: Q = db.query.bind(db) as Q,
): Promise<string> {
  const base: Record<string, unknown> = {
    id: randomUUID(),
    organization_id: o.id,
    work_session_id: o.session,
    agent_id: o.agent,
    event_id: randomUUID(),
    device_id: o.device,
    conversation_id: o.channel,
    direction: "to_device",
    attachment_id: randomUUID(),
    max_bytes: 25 * MIB,
    limit_source: "organization",
    size_bytes: 1536,
    sha256: SHA,
    path_length: 12,
    status: "done",
    failure: null,
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    completed_at: new Date().toISOString(),
    ...cols,
  };
  // An `undefined` override leaves the column to its default.
  const set = Object.entries(base).filter(([, v]) => v !== undefined);
  const res = await q(
    `insert into app.bot_work_session_files (${set.map(([k]) => k).join(", ")}) values (${set.map((_, i) => `$${i + 1}`).join(", ")}) returning id`,
    set.map(([, v]) => v),
  );
  return res.rows[0].id as string;
}

async function profile(o: Org, agent: string, cols: Record<string, unknown> = {}): Promise<string> {
  const base: Record<string, unknown> = {
    organization_id: o.id,
    agent_id: agent,
    sponsor_user_id: o.user,
    device_id: o.device,
    runtime: "claude-code",
    updated_by: o.user,
    ...cols,
  };
  const names = Object.keys(base);
  const res = await db.query(
    `insert into app.bot_work_zone_profiles (${names.join(", ")}) values (${names.map((_, i) => `$${i + 1}`).join(", ")}) returning id`,
    Object.values(base),
  );
  return res.rows[0].id as string;
}

async function refused(p: Promise<unknown>, named: { constraint: string }): Promise<void> {
  await expect(p, named.constraint).rejects.toMatchObject(named);
}

const count = async (sql: string, values: unknown[]) =>
  (await db.query(`select count(*)::int as n from ${sql}`, values)).rows[0].n as number;

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

describe("bot file exchange schema (07.17.1.1, D-05, D-07, PD-05, PD-16)", () => {
  it("the organization's limit defaults to 25 MiB and is NOT NULL; the bot's is null by default (the organization's)", async () => {
    await db.query("insert into app.work_zone_policies (organization_id) values ($1)", [A.id]);
    const policy = await db.query(
      "select bot_file_max_bytes::bigint::text as v from app.work_zone_policies where organization_id = $1",
      [A.id],
    );
    expect(policy.rows).toEqual([{ v: "26214400" }]);
    const id = await profile(A, await bot(A.id, "defaults"));
    const prof = await db.query("select file_max_bytes from app.bot_work_zone_profiles where id = $1", [id]);
    expect(prof.rows).toEqual([{ file_max_bytes: null }]);
    const cols = await db.query(
      `select table_name, column_name, data_type, is_nullable, column_default from information_schema.columns
        where table_schema = 'app' and ((table_name = 'work_zone_policies' and column_name = 'bot_file_max_bytes')
          or (table_name = 'bot_work_zone_profiles' and column_name = 'file_max_bytes')) order by table_name`,
    );
    expect(cols.rows).toEqual([
      {
        table_name: "bot_work_zone_profiles",
        column_name: "file_max_bytes",
        data_type: "bigint",
        is_nullable: "YES",
        column_default: null,
      },
      {
        table_name: "work_zone_policies",
        column_name: "bot_file_max_bytes",
        data_type: "bigint",
        is_nullable: "NO",
        column_default: "26214400",
      },
    ]);
    await expect(
      db.query("update app.work_zone_policies set bot_file_max_bytes = null where organization_id = $1", [
        A.id,
      ]),
    ).rejects.toMatchObject({ code: "23502" });
  });

  it("both limits accept 1 MiB … 1 GiB only (the profile also null), each by its named check", async () => {
    const setPolicy = (v: number) =>
      db.query("update app.work_zone_policies set bot_file_max_bytes = $2 where organization_id = $1", [
        A.id,
        v,
      ]);
    for (const bad of [MIB - 1, GIB + 1]) {
      await refused(setPolicy(bad), { constraint: "work_zone_policies_bot_file_max_bytes_ck" });
    }
    for (const ok of [MIB, GIB]) {
      expect((await setPolicy(ok)).rowCount, String(ok)).toBe(1);
    }
    for (const bad of [MIB - 1, GIB + 1]) {
      await refused(profile(A, await bot(A.id, "bad"), { file_max_bytes: bad }), {
        constraint: "bot_work_zone_profiles_file_max_bytes_ck",
      });
    }
    for (const ok of [MIB, GIB, null]) {
      const id = await profile(A, await bot(A.id, "ok"), { file_max_bytes: ok });
      const row = await db.query(
        "select file_max_bytes::text as v from app.bot_work_zone_profiles where id = $1",
        [id],
      );
      expect(row.rows[0].v, String(ok)).toBe(ok === null ? null : String(ok));
    }
  });

  it("a ledger row with every column set inserts; a new row starts pending with no outcome", async () => {
    const id = await transfer(A);
    expect(await count("app.bot_work_session_files where id = $1", [id])).toBe(1);
    const fresh = await transfer(A, {
      status: undefined,
      size_bytes: null,
      sha256: null,
      completed_at: null,
      direction: "from_device",
      limit_source: "bot",
    });
    const row = await db.query(
      "select status, size_bytes, sha256, failure, completed_at, created_at is not null as stamped from app.bot_work_session_files where id = $1",
      [fresh],
    );
    expect(row.rows).toEqual([
      { status: "pending", size_bytes: null, sha256: null, failure: null, completed_at: null, stamped: true },
    ]);
  });

  it("refuses an unknown direction, status or limit source, a malformed digest and out-of-range sizes, each by its named check", async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ direction: "sideways" }, "bot_work_session_files_direction_ck"],
      [{ status: "sent" }, "bot_work_session_files_status_ck"],
      [{ limit_source: "user" }, "bot_work_session_files_limit_source_ck"],
      [{ sha256: "ABC" }, "bot_work_session_files_sha256_ck"],
      [{ sha256: SHA.toUpperCase() }, "bot_work_session_files_sha256_ck"],
      [{ size_bytes: -1 }, "bot_work_session_files_sizes_ck"],
      [{ max_bytes: 0 }, "bot_work_session_files_sizes_ck"],
      [{ path_length: -1 }, "bot_work_session_files_sizes_ck"],
      [{ path_length: 0 }, "bot_work_session_files_sizes_ck"],
      [{ path_length: 1025 }, "bot_work_session_files_sizes_ck"],
    ];
    for (const [cols, constraint] of cases) {
      await refused(transfer(A, cols), { constraint });
    }
    for (const status of ["pending", "streaming", "streamed", "done", "failed"]) {
      await transfer(A, { status });
    }
    for (const limit_source of ["bot", "organization", "server"]) {
      await transfer(A, { limit_source });
    }
    await transfer(A, { path_length: 1024, size_bytes: 0 });
  });

  it("names no path, file name or content anywhere in the ledger (P1): only path_length", async () => {
    const cols = (
      await db.query(
        "select column_name from information_schema.columns where table_schema = 'app' and table_name = 'bot_work_session_files' order by ordinal_position",
      )
    ).rows.map((r) => r.column_name as string);
    expect(cols).toEqual([
      "id",
      "organization_id",
      "work_session_id",
      "agent_id",
      "event_id",
      "device_id",
      "conversation_id",
      "direction",
      "attachment_id",
      "max_bytes",
      "limit_source",
      "size_bytes",
      "sha256",
      "path_length",
      "status",
      "failure",
      "expires_at",
      "created_at",
      "completed_at",
    ]);
    expect(cols.filter((c) => c.includes("path"))).toEqual(["path_length"]);
    expect(cols.filter((c) => c.includes("name") || c.includes("content") || c.includes("body"))).toEqual([]);
  });

  it("the id is the command id (no default), and deleting the session deletes its rows", async () => {
    await expect(
      db.query(
        "insert into app.bot_work_session_files (organization_id, work_session_id, agent_id, event_id, device_id, conversation_id, direction, attachment_id, max_bytes, limit_source, path_length, expires_at) values ($1, $2, $3, $4, $5, $6, 'to_device', $7, 1, 'server', 1, now())",
        [A.id, A.session, A.agent, randomUUID(), A.device, A.channel, randomUUID()],
      ),
    ).rejects.toMatchObject({ code: "23502", column: "id" });
    const o = { ...A, session: await workSession(A) };
    await transfer(o);
    await transfer(o, { direction: "from_device" });
    expect(await count("app.bot_work_session_files where work_session_id = $1", [o.session])).toBe(2);
    await db.query("delete from app.work_sessions where id = $1", [o.session]);
    expect(await count("app.bot_work_session_files where work_session_id = $1", [o.session])).toBe(0);
  });

  it("refuses a row whose session is in another organization (the composite session key)", async () => {
    await refused(transfer(A, { work_session_id: B.session }), {
      constraint: "bot_work_session_files_session_fk",
    });
  });
});

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

describe("bot file exchange isolation as ocw_app (07.17.1.1, D-05)", () => {
  const tbl = "app.bot_work_session_files";

  beforeAll(async () => {
    await transfer(A);
  });

  it("organization B reads, updates and deletes none of organization A's ledger rows, and cannot insert one naming A", async () => {
    expect(await count(`${tbl} where organization_id = $1`, [A.id]), "seeded").toBeGreaterThan(0);
    const own = await as(A.id, null, (q) => q(`select count(*)::int as n from ${tbl}`));
    expect(own.rows[0].n, "own").toBe(await count(`${tbl} where organization_id = $1`, [A.id]));
    const cross = await as(B.id, null, (q) =>
      q(`select count(*)::int as n from ${tbl} where organization_id = $1`, [A.id]),
    );
    expect(cross.rows[0].n, "cross-tenant select").toBe(0);
    for (const stmt of [
      `update ${tbl} set status = 'failed' where organization_id = $1`,
      `delete from ${tbl} where organization_id = $1`,
    ]) {
      const r = await as(B.id, null, (q) => q(stmt, [A.id]));
      expect(r.rowCount, stmt).toBe(0);
    }
    await expect(
      as(B.id, null, (q) => transfer(A, {}, q)),
      "cross-tenant insert",
    ).rejects.toThrow(/row-level security/);
    // Without a tenant the app role sees nothing (nullif on reused connections).
    expect((await app.query(`select count(*)::int as n from ${tbl}`)).rows[0].n).toBe(0);
    // Its own organization may write one (the API's path).
    await expect(as(A.id, null, (q) => transfer(A, {}, q))).resolves.toEqual(expect.any(String));
  });
});
