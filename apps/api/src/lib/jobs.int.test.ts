import { randomUUID } from "node:crypto";
import { createTenantDb, type TenantDb } from "@ocw/db";
import { installJobSchema, JOB_QUEUE_NAMES } from "@ocw/db/migrate";
import { startTestDatabase, type TestDatabase } from "@ocw/db/testing";
import type { FastifyBaseLogger } from "fastify";
import pg from "pg";
import { TestClock } from "pg-boss";
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

  describe("replicas, restarts and shutdown (AUTO-01)", () => {
    it("two instances on one database run each of 20 jobs exactly once", async () => {
      const a = jobsFor(tdb.appUrl, true).jobs;
      const b = jobsFor(tdb.appUrl, true).jobs;
      const runs: { by: string; jobId: string; runId: string }[] = [];
      for (const [by, jobs] of [
        ["a", a],
        ["b", b],
      ] as const) {
        jobs.work("automation.fire", async (data, ctx) => {
          runs.push({ by, jobId: ctx.jobId, runId: data.runId });
          await new Promise((r) => setTimeout(r, 20));
        });
      }
      await Promise.all([a.start(), b.start()]);
      const organizationId = randomUUID();
      const runIds = Array.from({ length: 20 }, () => randomUUID());
      await db.withTenant({ organizationId }, async (tx) => {
        for (const runId of runIds) await a.sendInTx(tx, "automation.fire", { organizationId, runId });
      });
      await vi.waitFor(() => expect(new Set(runs.map((r) => r.runId)).size).toBe(20), {
        timeout: 30_000,
        interval: 100,
      });
      // A late duplicate would land within a polling interval or two.
      await new Promise((r) => setTimeout(r, 2_500));
      expect(runs).toHaveLength(20);
      expect(new Set(runs.map((r) => r.jobId)).size).toBe(20);
      expect([...new Set(runs.map((r) => r.runId))].sort()).toEqual([...runIds].sort());
      await Promise.all([a.stop(), b.stop()]);
    });

    it("localConcurrency runs that many jobs of one queue at once in one instance (07.6 review A HI-01, MD-06)", async () => {
      const { jobs } = jobsFor(tdb.appUrl, true);
      let active = 0;
      let peak = 0;
      let release: () => void = () => {};
      const gate = new Promise<void>((r) => {
        release = r;
      });
      const done: string[] = [];
      jobs.work(
        "mailbox.poll",
        async (data) => {
          active++;
          peak = Math.max(peak, active);
          if (active === 3) release();
          // A slow server: held until three run side by side (or 10 s, and then the peak says why).
          await Promise.race([gate, new Promise((r) => setTimeout(r, 10_000))]);
          active--;
          done.push(data.mailboxId);
        },
        { localConcurrency: 3 },
      );
      await jobs.start();
      const organizationId = randomUUID();
      await db.withTenant({ organizationId }, async (tx) => {
        for (let i = 0; i < 3; i++)
          await jobs.sendInTx(tx, "mailbox.poll", { organizationId, mailboxId: randomUUID() });
      });
      await vi.waitFor(() => expect(done).toHaveLength(3), { timeout: 20_000, interval: 100 });
      expect(peak).toBe(3);
      await jobs.stop();
    });

    it("a global cron registered by two instances ticks once per interval (pg-boss TestClock)", async () => {
      // TestClock attaches to the schema with DDL (its own clock table and job_now override), which ocw_app can never
      // run: these two instances connect as the schema's owner. Cron coordination does not depend on the role.
      const clock = new TestClock("2026-01-05T10:00:30Z");
      const ticks: string[] = [];
      const make = (by: string) => {
        const { log } = captureLog();
        const jobs = createJobs({ connectionString: tdb.migratorUrl, workers: true, log, clock });
        started.push(jobs);
        jobs.work("automation.tick", async (_data, ctx) => {
          ticks.push(`${by}:${ctx.jobId}`);
        });
        jobs.schedule("automation.tick", "* * * * *");
        return jobs;
      };
      // An earlier test's real-time schedule (its row and the ticks it queued) is not this test's, and its real-time
      // cron claim (pgboss.version.cron_on, later than this clock) would keep the fake clock from claiming a pass.
      const resetCron =
        "delete from pgboss.job where name = 'automation.tick'; delete from pgboss.schedule where name = 'automation.tick'; update pgboss.version set cron_on = null";
      await query(tdb.superuserUrl, resetCron);
      const a = make("a");
      const b = make("b");
      try {
        await a.start();
        await b.start();
        // Three minute boundaries: 10:01, 10:02 and 10:03.
        for (let s = 0; s < 3 * 60 + 15; s += 5) await clock.tick(5_000);
        await a.drain("automation.tick");
        const [made] = await query<{ n: number }>(
          tdb.superuserUrl,
          "select count(*)::int as n from pgboss.job where name = 'automation.tick'",
        );
        expect(made?.n).toBe(3);
        await vi.waitFor(() => expect(ticks).toHaveLength(3), { timeout: 10_000 });
        expect(new Set(ticks.map((t) => t.split(":")[1])).size).toBe(3);
      } finally {
        // Detaches the clock (restores job_now) even when an assertion failed, so later tests read real time.
        await a.stop();
        await b.stop();
        await query(tdb.superuserUrl, resetCron);
      }
    });

    it("jobs queued before a restart run after it", async () => {
      const first = jobsFor(tdb.appUrl, false).jobs;
      first.work("watched.check", async () => {
        throw new Error("workers are off: never called");
      });
      await first.start();
      const organizationId = randomUUID();
      const ids = Array.from({ length: 5 }, () => randomUUID());
      await db.withTenant({ organizationId }, async (tx) => {
        for (const watchedRecordId of ids)
          await first.sendInTx(tx, "watched.check", { organizationId, watchedRecordId, source: "schedule" });
      });
      await first.stop();

      const second = jobsFor(tdb.appUrl, true).jobs;
      const seen: string[] = [];
      second.work("watched.check", async (data) => {
        seen.push(data.watchedRecordId);
      });
      await second.start();
      await vi.waitFor(() => expect(seen.sort()).toEqual([...ids].sort()), {
        timeout: 20_000,
        interval: 100,
      });
      await second.stop();
    });

    it("stop() lets an in-flight handler finish before the pool closes; a queued job waits for the next start", async () => {
      const jobs = jobsFor(tdb.appUrl, true).jobs;
      const events: string[] = [];
      let entered!: () => void;
      const inFlight = new Promise<void>((r) => {
        entered = r;
      });
      jobs.work("work_session.summarize", async (data) => {
        events.push(`start:${data.workSessionId}`);
        entered();
        await new Promise((r) => setTimeout(r, 500));
        events.push(`end:${data.workSessionId}`);
      });
      await jobs.start();
      const organizationId = randomUUID();
      const [s1, s2] = [randomUUID(), randomUUID()];
      const id1 = await db.withTenant({ organizationId }, (tx) =>
        jobs.sendInTx(tx, "work_session.summarize", { organizationId, workSessionId: s1, mode: "manual" }),
      );
      await inFlight;
      const id2 = await db.withTenant({ organizationId }, (tx) =>
        jobs.sendInTx(tx, "work_session.summarize", { organizationId, workSessionId: s2, mode: "auto" }),
      );
      await jobs.stop();
      expect(events).toEqual([`start:${s1}`, `end:${s1}`]);
      expect(await stateOf(id1)).toBe("completed");
      expect(await stateOf(id2)).toBe("created");

      const next = jobsFor(tdb.appUrl, true).jobs;
      next.work("work_session.summarize", async (data) => {
        events.push(`next:${data.workSessionId}`);
      });
      await next.start();
      await vi.waitFor(() => expect(events).toContain(`next:${s2}`), { timeout: 20_000, interval: 100 });
      await next.stop();
      expect(await stateOf(id2)).toBe("completed");
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
