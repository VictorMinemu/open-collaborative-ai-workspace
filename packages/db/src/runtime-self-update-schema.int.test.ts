import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDatabase, type TestDatabase } from "./testing";

/**
 * Phase 07.17.1 (D-02, D-07, PD-14, PD-22; ADR-0040): the 07.11 update history accepts the OCW runtime as a maintenance
 * target and records the builds of a run. PostgreSQL itself refuses any other target and any build that is not 12
 * lowercase hex (each through a NAMED constraint, asserted on the error's `constraint`); the 07.11 row shapes (no
 * builds) still fit; the one-pending-request index covers the new target per device. Seeded and checked as
 * ocw_migrator on a fresh database with every migration applied; tenant isolation is re-asserted as ocw_app.
 */

let tdb: TestDatabase;
let db: pg.Client;
let app: pg.Client;

interface Org {
  id: string;
  owner: string;
  device: string;
}

async function seedOrg(): Promise<Org> {
  const id = randomUUID();
  const owner = randomUUID();
  const device = randomUUID();
  await db.query("insert into auth.organization (id, name, slug) values ($1, 'O', $2)", [id, `o-${id}`]);
  await db.query("insert into auth.user (id, name, email) values ($1, 'P', $2)", [
    owner,
    `${owner}@rsu.test`,
  ]);
  await db.query(
    "insert into app.org_members (organization_id, user_id, display_name, role) values ($1, $2, 'P', 'standard')",
    [id, owner],
  );
  await db.query(
    "insert into app.devices (id, organization_id, owner_user_id, name, platform, token_hash) values ($1, $2, $3, 'build server', 'linux', $4)",
    [device, id, owner, `tok-${device}`],
  );
  return { id, owner, device };
}

interface Row {
  runtime: string;
  state: string;
  fromBuild: string | null;
  toBuild: string | null;
}

const OCW_REQUEST: Row = {
  runtime: "ocw-runtime",
  state: "requested",
  fromBuild: "1a2b3c4d5e6f",
  toBuild: "abcdef012345",
};

function insert(o: Org, patch: Partial<Row> = {}, q: pg.Client = db) {
  const r = { ...OCW_REQUEST, ...patch };
  return q.query(
    `insert into app.device_runtime_updates
       (organization_id, device_id, runtime, trigger, requested_by, state, from_build, to_build, candidate, method, requested_at)
     values ($1, $2, $3, 'manual', $4, $5, $6, $7, '0.3.2', 'ocw_bundle', now()) returning id`,
    [o.id, o.device, r.runtime, o.owner, r.state, r.fromBuild, r.toBuild],
  );
}

/** Runs `fn` in a migrator transaction that is rolled back, so every case starts from the same seeds. */
async function rolledBack<T>(fn: () => Promise<T>): Promise<T> {
  await db.query("begin");
  try {
    return await fn();
  } finally {
    await db.query("rollback");
  }
}

async function refused(p: Promise<unknown>, constraint: string): Promise<void> {
  await expect(p, constraint).rejects.toMatchObject({ constraint });
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

describe("runtime self-update history schema (07.17.1, D-02, D-07, PD-22)", () => {
  it("stores an ocw-runtime request with its builds", async () => {
    const row = await rolledBack(async () => {
      const id = (await insert(A)).rows[0].id as string;
      return (
        await db.query(
          "select runtime, from_build, to_build, candidate, method from app.device_runtime_updates where id = $1",
          [id],
        )
      ).rows[0];
    });
    expect(row).toEqual({
      runtime: "ocw-runtime",
      from_build: "1a2b3c4d5e6f",
      to_build: "abcdef012345",
      candidate: "0.3.2",
      method: "ocw_bundle",
    });
  });

  it("refuses any other target through device_runtime_updates_runtime_ck", async () => {
    await refused(
      rolledBack(() => insert(A, { runtime: "ocw" })),
      "device_runtime_updates_runtime_ck",
    );
  });

  it("refuses a build that is not 12 lowercase hex through device_runtime_updates_build_ck", async () => {
    for (const patch of [
      { fromBuild: "ABCDEF012345" },
      { toBuild: "abc" },
      { toBuild: "1a2b3c4d5e6f0" },
      { fromBuild: "1a2b3c4d5e6" },
    ]) {
      await refused(
        rolledBack(() => insert(A, patch)),
        "device_runtime_updates_build_ck",
      );
    }
  });

  it("keeps every 07.11 row shape: both builds null, for the CLIs and the OCW runtime alike", async () => {
    const n = await rolledBack(async () => {
      await insert(A, { runtime: "claude-code", fromBuild: null, toBuild: null });
      await insert(A, { runtime: "codex", fromBuild: null, toBuild: null });
      await insert(A, { fromBuild: null, toBuild: null });
      return (
        await db.query(
          "select count(*)::int as n from app.device_runtime_updates where device_id = $1 and from_build is null and to_build is null",
          [A.device],
        )
      ).rows[0].n as number;
    });
    expect(n).toBe(3);
  });

  it("allows one requested ocw-runtime row per device, beside a requested CLI row", async () => {
    await refused(
      rolledBack(async () => {
        await insert(A);
        return insert(A);
      }),
      "device_runtime_updates_requested_uq",
    );
    const beside = await rolledBack(async () => {
      await insert(A);
      await insert(A, { runtime: "claude-code", fromBuild: null, toBuild: null });
      await insert(B);
      return (
        await db.query("select count(*)::int as n from app.device_runtime_updates where state = 'requested'")
      ).rows[0].n as number;
    });
    expect(beside).toBe(3);
  });

  it("as ocw_app, organization B reads none of organization A's ocw-runtime rows and cannot write one for A", async () => {
    await insert(A);
    const visible = async (org: string) => {
      await app.query("begin");
      try {
        await app.query(
          "select set_config('app.organization_id', $1, true), set_config('app.user_id', '', true)",
          [org],
        );
        return (
          await app.query(
            "select count(*)::int as n from app.device_runtime_updates where device_id = $1 and runtime = 'ocw-runtime'",
            [A.device],
          )
        ).rows[0].n as number;
      } finally {
        await app.query("rollback");
      }
    };
    expect(await visible(A.id)).toBe(1);
    expect(await visible(B.id)).toBe(0);

    await app.query("begin");
    try {
      await app.query(
        "select set_config('app.organization_id', $1, true), set_config('app.user_id', '', true)",
        [B.id],
      );
      await expect(insert(A, {}, app)).rejects.toThrow(/row-level security/);
    } finally {
      await app.query("rollback");
    }
  });
});
