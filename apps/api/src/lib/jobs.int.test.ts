import { randomUUID } from "node:crypto";
import { createTenantDb, type TenantDb } from "@ocw/db";
import { installJobSchema, JOB_QUEUE_NAMES } from "@ocw/db/migrate";
import { startTestDatabase, type TestDatabase } from "@ocw/db/testing";
import type { FastifyBaseLogger } from "fastify";
import pg from "pg";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createJobs, type Jobs, JobsSchemaError } from "./jobs";

/**
 * 07.6-03 (AUTO-01, D-01, D-07, Pitfalls 7 and 10): the job runtime. pg-boss's `pgboss` schema is installed by
 * `ocw_migrator` in `runMigrations`; the API runs it as `ocw_app` with no DDL at all, enqueues inside the tenant
 * transaction, carries ids only, and is safe across replicas, restarts and shutdown.
 */

interface LogLine {
  level: number;
  msg?: string;
  err?: { message?: string };
}

/** A real pino logger whose warnings and errors the test can read. */
function captureLog(): { log: FastifyBaseLogger; lines: LogLine[] } {
  const lines: LogLine[] = [];
  const log = pino(
    { level: "warn" },
    {
      write(msg: string) {
        lines.push(JSON.parse(msg) as LogLine);
      },
    },
  ) as unknown as FastifyBaseLogger;
  return { log, lines };
}

async function query<R extends pg.QueryResultRow>(url: string, text: string, values: unknown[] = []) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return (await c.query<R>(text, values)).rows;
  } finally {
    await c.end();
  }
}

const errorsOf = (lines: LogLine[]) => lines.filter((l) => l.level >= 50);

describe("job runtime (pg-boss, 07.6-03)", () => {
  let tdb: TestDatabase;
  let db: TenantDb;
  const started: Jobs[] = [];

  /** Every instance a test creates is stopped in afterAll even when the test fails half-way. */
  function jobsFor(url: string, workers: boolean) {
    const { log, lines } = captureLog();
    const jobs = createJobs({ connectionString: url, workers, log });
    started.push(jobs);
    return { jobs, lines };
  }

  const appDdl = async () =>
    query<{ role: string; tag: string }>(
      tdb.superuserUrl,
      "select role, tag from public.ocw_test_ddl_log where role = 'ocw_app' order by id",
    );

  const stateOf = async (id: string | null) =>
    (await query<{ state: string }>(tdb.superuserUrl, "select state from pgboss.job where id = $1", [id]))[0]
      ?.state;

  beforeAll(async () => {
    tdb = await startTestDatabase();
    db = createTenantDb(tdb.appUrl, { max: 4 });
    // Every DDL statement from here on is recorded with the login role that ran it (session_user: the function is
    // SECURITY DEFINER, so current_user would be its owner). ocw_app must never appear (T-07.6-03-02).
    await query(
      tdb.superuserUrl,
      `create table public.ocw_test_ddl_log (id bigserial primary key, role text not null, tag text not null);
       create function public.ocw_test_log_ddl() returns event_trigger language plpgsql security definer as $$
       begin
         insert into public.ocw_test_ddl_log (role, tag) values (session_user, tg_tag);
       end $$;
       create event trigger ocw_test_ddl on ddl_command_start execute function public.ocw_test_log_ddl();`,
    );
  });

  afterAll(async () => {
    await Promise.allSettled(started.map((j) => j.stop()));
    await db?.close();
    await tdb?.stop();
  });

  describe("installed by the migrator", () => {
    it("creates the pgboss schema, owned by ocw_migrator, with every catalog queue (never partitioned)", async () => {
      const [owner] = await query<{ owner: string }>(
        tdb.superuserUrl,
        "select nspowner::regrole::text as owner from pg_namespace where nspname = 'pgboss'",
      );
      expect(owner?.owner).toBe("ocw_migrator");
      const queues = await query<{ name: string; partition: boolean }>(
        tdb.superuserUrl,
        "select name, partition from pgboss.queue where name not like '\\_\\_pgboss%' order by name",
      );
      expect(queues.map((q) => q.name)).toEqual([...JOB_QUEUE_NAMES].sort());
      expect(queues.every((q) => q.partition === false)).toBe(true);
    });

    it("grants ocw_app DML, usage and execute only: no CREATE on pgboss, no ownership", async () => {
      const [p] = await query<{ create: boolean; usage: boolean; owns: number }>(
        tdb.superuserUrl,
        `select has_schema_privilege('ocw_app', 'pgboss', 'CREATE') as create,
                has_schema_privilege('ocw_app', 'pgboss', 'USAGE') as usage,
                (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
                  where n.nspname = 'pgboss' and c.relowner = 'ocw_app'::regrole) as owns`,
      );
      expect(p).toEqual({ create: false, usage: true, owns: 0 });
      const [job] = await query<{ ins: boolean; trunc: boolean }>(
        tdb.superuserUrl,
        `select has_table_privilege('ocw_app', 'pgboss.job', 'INSERT') as ins,
                has_table_privilege('ocw_app', 'pgboss.job', 'TRUNCATE') as trunc`,
      );
      expect(job).toEqual({ ins: true, trunc: false });
    });

    it("is idempotent: a second run keeps every queue", async () => {
      await installJobSchema(tdb.migratorUrl, () => {});
      const [q] = await query<{ n: number }>(
        tdb.superuserUrl,
        "select count(*)::int as n from pgboss.queue where name not like '\\_\\_pgboss%'",
      );
      expect(q?.n).toBe(JOB_QUEUE_NAMES.length);
    });
  });

  describe("run as ocw_app", () => {
    it("starts with migrate:false, enqueues inside a committed tenant transaction and runs the job once", async () => {
      const { jobs, lines } = jobsFor(tdb.appUrl, true);
      const received: unknown[] = [];
      const ctxs: { jobId: string; signal: AbortSignal }[] = [];
      jobs.work("automation.fire", async (data, ctx) => {
        received.push(data);
        ctxs.push(ctx);
      });
      jobs.schedule("automation.tick", "* * * * *");
      await jobs.start();

      const organizationId = randomUUID();
      const runId = randomUUID();
      const id = await db.withTenant({ organizationId }, (tx) =>
        jobs.sendInTx(tx, "automation.fire", { organizationId, runId }),
      );
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
      await vi.waitFor(() => expect(received).toEqual([{ organizationId, runId }]), {
        timeout: 15_000,
        interval: 100,
      });
      expect(ctxs[0]?.jobId).toBe(id);
      expect(ctxs[0]?.signal).toBeInstanceOf(AbortSignal);
      await vi.waitFor(async () => expect(await stateOf(id)).toBe("completed"), { timeout: 10_000 });
      await jobs.stop();
      expect(errorsOf(lines)).toEqual([]);
    });

    it("writes no job when the tenant transaction rolls back (transactional enqueue)", async () => {
      const { jobs } = jobsFor(tdb.appUrl, false);
      await jobs.start();
      const organizationId = randomUUID();
      const runId = randomUUID();
      await expect(
        db.withTenant({ organizationId }, async (tx) => {
          await jobs.sendInTx(tx, "automation.fire", { organizationId, runId });
          throw new Error("rollback");
        }),
      ).rejects.toThrow("rollback");
      const rows = await query(tdb.superuserUrl, "select 1 from pgboss.job where data->>'runId' = $1", [
        runId,
      ]);
      expect(rows).toEqual([]);
      await jobs.stop();
    });

    it("refuses any payload that is not the queue's ids-only schema, before anything is written", async () => {
      const { jobs } = jobsFor(tdb.appUrl, false);
      await jobs.start();
      const organizationId = randomUUID();
      const runId = randomUUID();
      await db.withTenant({ organizationId }, async (tx) => {
        await expect(
          // @ts-expect-error: content in a job payload is refused at compile time too
          jobs.sendInTx(tx, "automation.fire", { organizationId, runId, body: "x" }),
        ).rejects.toThrow();
        await expect(
          jobs.sendInTx(tx, "automation.fire", { organizationId: "not-a-uuid", runId }),
        ).rejects.toThrow();
        await expect(
          jobs.sendInTx(tx, "watched.check", {
            organizationId,
            watchedRecordId: runId,
            // @ts-expect-error: a closed enum
            source: "elsewhere",
          }),
        ).rejects.toThrow();
        await expect(
          // @ts-expect-error: an unknown queue
          jobs.sendInTx(tx, "automation.nope", { organizationId }),
        ).rejects.toThrow(/unknown job queue/);
      });
      const rows = await query(
        tdb.superuserUrl,
        "select 1 from pgboss.job where data->>'runId' = $1 or data->>'organizationId' = $2",
        [runId, organizationId],
      );
      expect(rows).toEqual([]);
      await jobs.stop();
    });

    it("drain runs every available job in-process with the registered handler, so tests never sleep", async () => {
      const { jobs } = jobsFor(tdb.appUrl, false);
      const seen: string[] = [];
      jobs.work("mailbox.poll", async (data) => {
        seen.push(data.mailboxId);
      });
      await jobs.start();
      const organizationId = randomUUID();
      const ids = [randomUUID(), randomUUID(), randomUUID()];
      await db.withTenant({ organizationId }, async (tx) => {
        for (const mailboxId of ids) await jobs.sendInTx(tx, "mailbox.poll", { organizationId, mailboxId });
      });
      expect(await jobs.drain("mailbox.poll")).toBe(3);
      expect(seen.sort()).toEqual([...ids].sort());
      expect(await jobs.drain("mailbox.poll")).toBe(0);
      await jobs.stop();
    });

    it("ran no DDL as ocw_app across start, send, work, schedule, drain and stop", async () => {
      const { jobs, lines } = jobsFor(tdb.appUrl, true);
      let handled = 0;
      jobs.work("maintenance.daily", async () => {
        handled++;
      });
      jobs.schedule("maintenance.daily", "0 3 * * *");
      await jobs.start();
      await db.withTenant({ organizationId: randomUUID() }, (tx) =>
        jobs.sendInTx(tx, "maintenance.daily", {}),
      );
      await vi.waitFor(() => expect(handled).toBe(1), { timeout: 15_000, interval: 100 });
      expect(await jobs.drain("maintenance.daily")).toBe(0);
      await jobs.stop();
      expect(await appDdl()).toEqual([]);
      expect(errorsOf(lines)).toEqual([]);
      // Global ticks are stored in UTC.
      const [s] = await query<{ cron: string; timezone: string }>(
        tdb.superuserUrl,
        "select cron, timezone from pgboss.schedule where name = 'maintenance.daily'",
      );
      expect(s).toEqual({ cron: "0 3 * * *", timezone: "UTC" });
    });
  });

  describe("boot check (Pitfall 10)", () => {
    it("refuses to start against an outdated pgboss schema, naming the migrate service", async () => {
      await query(tdb.superuserUrl, "update pgboss.version set version = version - 1");
      try {
        const { jobs } = jobsFor(tdb.appUrl, true);
        const err = await jobs.start().catch((e: unknown) => e);
        expect(err).toBeInstanceOf(JobsSchemaError);
        expect((err as Error).message).toMatch(/docker compose run --rm migrate/);
      } finally {
        await query(tdb.superuserUrl, "update pgboss.version set version = version + 1");
      }
    });

    it("refuses to start when a catalog queue is missing", async () => {
      await query(
        tdb.superuserUrl,
        "delete from pgboss.job where name = 'watched.tick'; delete from pgboss.queue where name = 'watched.tick'",
      );
      try {
        const { jobs } = jobsFor(tdb.appUrl, false);
        const err = await jobs.start().catch((e: unknown) => e);
        expect(err).toBeInstanceOf(JobsSchemaError);
        expect((err as Error).message).toMatch(/missing job queues: watched\.tick/);
      } finally {
        await installJobSchema(tdb.migratorUrl, () => {});
      }
    });

    it("refuses to start when the pgboss schema is missing, and the next migrate reinstalls it", async () => {
      await query(tdb.superuserUrl, "drop schema pgboss cascade");
      const { jobs } = jobsFor(tdb.appUrl, true);
      const err = await jobs.start().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(JobsSchemaError);
      expect((err as Error).message).toMatch(/docker compose run --rm migrate/);

      await installJobSchema(tdb.migratorUrl, () => {});
      const again = jobsFor(tdb.appUrl, false).jobs;
      await again.start();
      await again.stop();
      expect(await appDdl()).toEqual([]);
      // The trigger does see DDL: the migrator's reinstall is recorded.
      const migrator = await query(
        tdb.superuserUrl,
        "select 1 from public.ocw_test_ddl_log where role = 'ocw_migrator'",
      );
      expect(migrator.length).toBeGreaterThan(0);
    });
  });
});
