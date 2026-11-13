import { Id } from "@ocw/contracts";
import type { Tx } from "@ocw/db";
import { JOB_QUEUE_NAMES, JOB_SCHEMA, type JobQueueName } from "@ocw/db/migrate";
import { sql } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { fromDrizzle, PgBoss, type TestClock } from "pg-boss";
import { z } from "zod";

/**
 * Phase 07.6 (AUTO-01, D-01, D-07, ADR-0028): the job runtime, pg-boss on PostgreSQL.
 *
 * - The `pgboss` schema is installed by `ocw_migrator` (`installJobSchema` in `runMigrations`). The API runs as
 *   `ocw_app` with `migrate: false`, `createSchema: false` and `reindex: false`: it runs no DDL, and refuses to start
 *   when the schema or a catalog queue is missing or the schema version differs (`JobsSchemaError`).
 * - Job tables live outside RLS, so a job carries ids only: each queue has a strict Zod schema of uuids and closed
 *   enums, enforced on send and again before a handler runs. Handlers re-open `withTenant(data.organizationId)` and
 *   re-read by id, so a forged cross-tenant id finds nothing (Pitfall 7).
 * - `sendInTx` enqueues inside the caller's tenant transaction: the job exists only if that transaction commits.
 * - Handlers and global cron ticks run only when `workers` is on (`OCW_JOBS_WORKER`). pg-boss fetches with SKIP
 *   LOCKED and evaluates a cron once per interval across every instance, so replicas never run a job twice.
 */

const Empty = z.object({}).strict();

export const JOB_QUEUES = {
  "automation.tick": Empty,
  "automation.fire": z.object({ organizationId: Id, runId: Id }).strict(),
  "automation.inbound": z.object({ organizationId: Id, eventId: Id }).strict(),
  "mailbox.tick": Empty,
  "mailbox.poll": z.object({ organizationId: Id, mailboxId: Id }).strict(),
  "watched.tick": Empty,
  // A literal enum here: the contracts' watched-record source (07.6-01) lands in the same wave.
  "watched.check": z
    .object({
      organizationId: Id,
      watchedRecordId: Id,
      source: z.enum(["access", "schedule", "write", "manual"]),
    })
    .strict(),
  "work_session.summarize": z
    .object({ organizationId: Id, workSessionId: Id, mode: z.enum(["auto", "manual"]) })
    .strict(),
  "maintenance.daily": Empty,
  // Phase 07.7 (D-11, ADR-0027): the hop timeouts' tick; it reads `app.expired_agent_chain_hops` (ids only).
  "consult.tick": Empty,
  // Phase 07.16 (D-09, PD-16): a bot session's state changed; the handler refreshes its card and decides a wake (ids
  // only; the worker is registered by 07.16-20).
  "work_session.bot_sync": z.object({ organizationId: Id, workSessionId: Id }).strict(),
  // Phase 07.17 (D-04, PD-09): one opened item's own bot turn (ids only; the worker is registered by 07.17-17).
  "automation.item": z.object({ organizationId: Id, itemId: Id }).strict(),
  // Phase 07.17.1.1.2 (D-02, D-03, PD-06): a long task's next turn (ids only; the handler decides under the task's row
  // lock, so an extra or stale job delivers nothing) and the minute tick reading `app.due_bot_tasks` (the workers and
  // the schedule are registered by 07.17.1.1.2-09).
  "bot_task.continue": z.object({ organizationId: Id, taskId: Id }).strict(),
  "bot_task.tick": Empty,
} as const satisfies Record<JobQueueName, z.ZodType>;

export type QueueName = keyof typeof JOB_QUEUES;

/**
 * Per-queue retry options set on every job of the queue at send (pg-boss's defaults otherwise: 2 retries, no delay).
 * 07.17.1.1.2 code review WR-03: a long task's continuation retries twice with backoff (about 15 s, then 30 s); its
 * last attempt stops the task as `error` (`runTaskContinuation`).
 */
const QUEUE_RETRY: Partial<
  Record<QueueName, { retryLimit: number; retryDelay: number; retryBackoff: boolean }>
> = {
  "bot_task.continue": { retryLimit: 2, retryDelay: 15, retryBackoff: true },
};
export type JobData<Q extends QueueName> = z.infer<(typeof JOB_QUEUES)[Q]>;

/** The API's queues are exactly the migrator's catalog (a mismatch fails the build). */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const queuesMatchCatalog: Exact<QueueName, JobQueueName> = true;
void queuesMatchCatalog;

/** The queues a global cron tick may target (UTC, registered at `start()` when workers are on). */
export type TickQueue =
  | "automation.tick"
  | "mailbox.tick"
  | "watched.tick"
  | "maintenance.daily"
  | "consult.tick"
  | "bot_task.tick";

export interface JobContext {
  /** Aborted when pg-boss gives up on the job (expiry or shutdown past the grace period). */
  signal: AbortSignal;
  jobId: string;
  /** This attempt (0 for the first). A handler that throws is retried while `retryCount < retryLimit`. */
  retryCount: number;
  /** The queue's retries after the first attempt (pg-boss's `retryLimit`, 2 by default). */
  retryLimit: number;
}

/** True on a job's last attempt: a handler that throws now is not retried (07.6 review A MD-02). */
export const lastAttempt = (ctx: Pick<JobContext, "retryCount" | "retryLimit"> | undefined): boolean =>
  !ctx || ctx.retryCount >= ctx.retryLimit;

export type JobHandler<Q extends QueueName> = (data: JobData<Q>, ctx: JobContext) => Promise<void>;

export interface SendOptions {
  singletonKey?: string;
  singletonSeconds?: number;
  startAfter?: Date;
}

export interface Jobs {
  /** Enqueues in `tx` (a `withTenant` transaction): the job exists only if it commits. Refuses non-ids payloads. */
  sendInTx<Q extends QueueName>(
    tx: Tx,
    queue: Q,
    data: JobData<Q>,
    opts?: SendOptions,
  ): Promise<string | null>;
  /**
   * Registers the queue's handler (call during module registration); it runs only when workers are on.
   * `localConcurrency` is how many jobs of this queue one instance runs at once (default 1): a queue whose jobs wait on
   * the network (a mail server, a model) needs more than one, so one slow job never holds every tenant's.
   */
  work<Q extends QueueName>(
    queue: Q,
    handler: JobHandler<Q>,
    opts?: { batchSize?: number; localConcurrency?: number },
  ): void;
  /** A global tick in UTC, applied at `start()` when workers are on. Per-automation schedules live in `app`. */
  schedule(queue: TickQueue, cron: string): void;
  /** Test helper: fetches and runs every available job of `queue` in-process, completing or failing each. */
  drain(queue: QueueName, opts?: { max?: number }): Promise<number>;
  start(): Promise<void>;
  /** Graceful: in-flight handlers finish (up to 8 s) before the pool closes; queued jobs stay for the next start. */
  stop(): Promise<void>;
}

export class JobsSchemaError extends Error {
  constructor(detail: string) {
    super(
      `pg-boss schema missing or outdated: run the migrate service (docker compose run --rm migrate). ${detail}`,
    );
    this.name = "JobsSchemaError";
  }
}

const STOP_TIMEOUT_MS = 8_000;

export function createJobs(opts: {
  connectionString: string;
  workers: boolean;
  log: FastifyBaseLogger;
  /** Test hook: pg-boss's TestClock (it attaches to the schema with DDL, so only for a role that owns it). */
  clock?: TestClock;
}): Jobs {
  const { log, workers } = opts;
  const boss = new PgBoss({
    connectionString: opts.connectionString,
    schema: JOB_SCHEMA,
    migrate: false,
    createSchema: false,
    reindex: false,
    max: 4,
    supervise: true,
    schedule: workers,
    instanceName: workers ? "api-worker" : "api",
    ...(opts.clock ? { clock: opts.clock } : {}),
  });
  boss.on("error", (err) => log.error({ err }, "jobs: pg-boss error"));
  boss.on("warning", (w) => log.warn({ warning: w }, "jobs: pg-boss warning"));

  const handlers = new Map<
    QueueName,
    // biome-ignore lint/suspicious/noExplicitAny: one registry for every queue; each entry is typed at `work()`.
    { handler: JobHandler<any>; batchSize: number; localConcurrency: number }
  >();
  const ticks = new Map<TickQueue, string>();
  let started = false;

  function schemaOf(queue: QueueName) {
    const schema = (JOB_QUEUES as Record<string, z.ZodType>)[queue];
    if (!schema) throw new Error(`unknown job queue: ${String(queue)}`);
    return schema;
  }

  async function attach(queue: QueueName) {
    const entry = handlers.get(queue);
    if (!entry) return;
    const schema = schemaOf(queue);
    const opts = {
      batchSize: entry.batchSize,
      localConcurrency: entry.localConcurrency,
      // The retry count and limit, so a handler knows its last attempt (MD-02).
      includeMetadata: true as const,
    };
    await boss.work(queue, opts, async (batch) => {
      for (const job of batch) {
        await entry.handler(schema.parse(job.data), {
          signal: job.signal,
          jobId: job.id,
          retryCount: job.retryCount,
          retryLimit: job.retryLimit,
        });
      }
    });
  }

  return {
    async sendInTx(tx, queue, data, sendOpts = {}) {
      const parsed = schemaOf(queue).parse(data) as object;
      return boss.send(queue, parsed, {
        db: fromDrizzle(tx, sql),
        ...QUEUE_RETRY[queue],
        ...(sendOpts.singletonKey ? { singletonKey: sendOpts.singletonKey } : {}),
        ...(sendOpts.singletonSeconds ? { singletonSeconds: sendOpts.singletonSeconds } : {}),
        ...(sendOpts.startAfter ? { startAfter: sendOpts.startAfter } : {}),
      });
    },

    work(queue, handler, workOpts = {}) {
      schemaOf(queue);
      if (handlers.has(queue)) throw new Error(`job queue ${queue} already has a handler`);
      handlers.set(queue, {
        handler,
        batchSize: workOpts.batchSize ?? 1,
        localConcurrency: Math.max(1, workOpts.localConcurrency ?? 1),
      });
      if (started && workers)
        void attach(queue).catch((err) => log.error({ err, queue }, "jobs: work failed"));
    },

    schedule(queue, cron) {
      schemaOf(queue);
      ticks.set(queue, cron);
      if (started && workers)
        void boss
          .schedule(queue, cron, {}, { tz: "UTC" })
          .catch((err) => log.error({ err, queue }, "jobs: schedule failed"));
    },

    async drain(queue, drainOpts = {}) {
      const entry = handlers.get(queue);
      if (!entry) throw new Error(`job queue ${queue} has no handler`);
      const schema = schemaOf(queue);
      const max = drainOpts.max ?? 100;
      let ran = 0;
      while (ran < max) {
        const [job] = await boss.fetch<object>(queue, { batchSize: 1, includeMetadata: true });
        if (!job) break;
        ran++;
        try {
          await entry.handler(schema.parse(job.data), {
            signal: job.signal ?? new AbortController().signal,
            jobId: job.id,
            retryCount: job.retryCount,
            retryLimit: job.retryLimit,
          });
          await boss.complete(queue, job);
        } catch (err) {
          await boss.fail(queue, job, { message: err instanceof Error ? err.message : String(err) });
        }
      }
      return ran;
    },

    async start() {
      try {
        await boss.start();
      } catch (err) {
        await boss.stop({ graceful: false }).catch(() => {});
        const message = err instanceof Error ? err.message : String(err);
        if (/not installed|requires migrations/i.test(message)) throw new JobsSchemaError(message);
        throw err;
      }
      // The migrator created every queue; reading them back is the idempotent check (no write, no DDL).
      const present = new Set((await boss.getQueues([...JOB_QUEUE_NAMES])).map((q) => q.name));
      const missing = JOB_QUEUE_NAMES.filter((n) => !present.has(n));
      if (missing.length > 0) {
        await boss.stop({ graceful: false }).catch(() => {});
        throw new JobsSchemaError(`missing job queues: ${missing.join(", ")}`);
      }
      started = true;
      if (!workers) return;
      for (const [queue, cron] of ticks) await boss.schedule(queue, cron, {}, { tz: "UTC" });
      for (const queue of handlers.keys()) await attach(queue);
    },

    async stop() {
      if (!started) return;
      started = false;
      await boss.stop({ graceful: true, timeout: STOP_TIMEOUT_MS });
    },
  };
}
