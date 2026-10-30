import pg from "pg";
import { PgBoss } from "pg-boss";

/**
 * Phase 07.6 (AUTO-01, D-01, D-07, ADR-0028): the job runtime's schema. pg-boss lives in its own `pgboss` schema, outside
 * RLS, so job payloads carry ids only (the API enforces it per queue in `apps/api/src/lib/jobs.ts`).
 *
 * The schema is installed and migrated here, by `ocw_migrator`, on every `runMigrations` (the compose `migrate`
 * service, the test databases, the e2e harness). The API runs pg-boss as `ocw_app` with `migrate: false`, so the app
 * role never needs CREATE: it gets DML on the tables, USAGE on the schema and sequences and EXECUTE on the functions.
 */
export const JOB_SCHEMA = "pgboss";

/**
 * Every queue the API uses. The migrator creates each one; the API only checks they exist at start, so a new queue
 * name ships with the release that adds it and is created by that release's migrate step.
 */
export const JOB_QUEUE_NAMES = [
  "automation.tick",
  "automation.fire",
  "automation.inbound",
  "mailbox.tick",
  "mailbox.poll",
  "watched.tick",
  "watched.check",
  "work_session.summarize",
  "maintenance.daily",
] as const;
export type JobQueueName = (typeof JOB_QUEUE_NAMES)[number];

/**
 * Standard queues only: a partitioned queue's `create_queue` runs CREATE TABLE as the caller, which `ocw_app` cannot
 * (and must not) do. Completed jobs are kept two days, then deleted by pg-boss's maintenance.
 */
const QUEUE_RETENTION = { deleteAfterSeconds: 172_800 } as const;

/** Async migrations (BAM) a pg-boss upgrade may queue, e.g. concurrent index builds: waited for, bounded. */
const BAM_WAIT_MS = 5 * 60_000;

async function waitForAsyncMigrations(boss: PgBoss): Promise<void> {
  const until = Date.now() + BAM_WAIT_MS;
  for (;;) {
    const status = await boss.getBamStatus();
    const open = status.filter((s) => s.status === "pending" || s.status === "in_progress");
    if (open.every((s) => s.count === 0)) return;
    if (Date.now() > until) {
      throw new Error("pg-boss async migrations did not finish in 5 minutes; run the migrate service again");
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

/**
 * Installs or upgrades pg-boss in `pgboss`, creates every catalog queue and grants `ocw_app` what it needs. Idempotent:
 * it runs on every migrate, so a pg-boss upgrade's new objects are granted and a new queue name is created.
 */
export async function installJobSchema(
  migratorUrl: string,
  log: (msg: string) => void = (m) => console.log(m),
): Promise<void> {
  log("migrate: pg-boss schema and job queues");
  const boss = new PgBoss({
    connectionString: migratorUrl,
    schema: JOB_SCHEMA,
    migrate: true,
    supervise: false,
    schedule: false,
    registerInstance: false,
    max: 2,
  });
  const errors: unknown[] = [];
  boss.on("error", (err) => errors.push(err));
  await boss.start();
  try {
    await waitForAsyncMigrations(boss);
    for (const name of JOB_QUEUE_NAMES) {
      const queue = await boss.getQueue(name);
      if (!queue) {
        await boss.createQueue(name, { policy: "standard", ...QUEUE_RETENTION });
      } else if (queue.partition) {
        throw new Error(
          `job queue ${name} is partitioned; the API role cannot use it (drop and re-run migrate)`,
        );
      } else {
        await boss.updateQueue(name, QUEUE_RETENTION);
      }
    }
  } finally {
    await boss.stop({ graceful: false });
  }
  if (errors.length > 0) throw errors[0];

  const client = new pg.Client({ connectionString: migratorUrl });
  await client.connect();
  try {
    await client.query(`
      GRANT USAGE ON SCHEMA ${JOB_SCHEMA} TO ocw_app;
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${JOB_SCHEMA} TO ocw_app;
      GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${JOB_SCHEMA} TO ocw_app;
      GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${JOB_SCHEMA} TO ocw_app;
    `);
  } finally {
    await client.end();
  }
}
