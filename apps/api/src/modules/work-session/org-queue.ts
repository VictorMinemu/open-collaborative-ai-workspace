import type { FastifyBaseLogger } from "fastify";

/**
 * One unit of background work for an organization, run after the commit that caused it (Phase 07.9 fan-out, WINDOWS
 * #311): the per-user session delivery and the live re-authorization sweeps no longer hold the request that committed
 * the change.
 */
export interface OrgTask {
  /** A fixed label for logs (`deliver`, `removed`, `snapshot`, `sweep`). */
  readonly kind: string;
  /** Ids only, for logs (sessions, a device): never a name, a path or content. */
  ids(): readonly string[];
  run(): Promise<void>;
  /**
   * A task waiting with the same key absorbs a new one wherever it waits in the organization's queue: it reads the
   * state when it runs, after the commit that queued the new one. A running task never absorbs (its read may predate
   * that commit). Absent: never coalesced by key.
   */
  readonly key?: string;
  /**
   * Coalescing at the tail only: the organization's last waiting task may absorb the new one (true when it did), so the
   * order with every task queued before it is kept.
   */
  absorb?(next: OrgTask): boolean;
}

export interface OrgQueueOptions {
  log: Pick<FastifyBaseLogger, "warn" | "error">;
  /** Organizations worked on at once; one organization's tasks always run one at a time, in order. Default 2. */
  concurrency?: number;
  /** Runs of a failing task, the first included, before it is abandoned. Default 3. */
  maxAttempts?: number;
  /** Wait before each retry (the last value repeats). Default 100 ms, then 500 ms. */
  retryDelaysMs?: readonly number[];
}

/** What `close` did: every task ran (`drained`), or the ones still waiting at the deadline were dropped. */
export interface OrgQueueClosed {
  drained: boolean;
  abandoned: number;
}

interface OrgState {
  waiting: OrgTask[];
  running: boolean;
}

/** At most this many ids of a task are logged (with the total). */
const LOGGED_IDS = 20;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms).unref();
  });

/** Ids-only log fields of a task: the first ids and how many there are. */
function idsOf(task: OrgTask): { ids: string[]; count: number } {
  const ids = task.ids();
  return { ids: ids.slice(0, LOGGED_IDS), count: ids.length };
}

/** The error's code (a PostgreSQL SQLSTATE, a Node code) or its class name: never its message, which may hold data. */
function errorCode(err: unknown): string {
  if (typeof err === "object" && err !== null) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string" || typeof code === "number") return String(code);
    if (err instanceof Error) return err.name;
  }
  return typeof err;
}

/**
 * An ordered, per-organization background queue in the API process (07.9 fan-out). Each organization's tasks run one at
 * a time in the order they were queued (so the per-session order of deliveries, removals and sweeps is the commit
 * order on this instance); different organizations run concurrently, at most `concurrency` at once. Repeated work
 * coalesces (`key`, `absorb`). A failing task is retried in place a bounded number of times (the organization's next
 * task waits), then abandoned; logs carry ids and an error code only. In memory: a crash loses what waits, which the
 * read paths recover (see `close`).
 */
export class OrgQueue {
  private readonly orgs = new Map<string, OrgState>();
  private readonly ready: string[] = [];
  private readonly idleWaiters = new Map<string | null, Array<() => void>>();
  private active = 0;
  /** Set once `close` gave up waiting: nothing new starts, nothing more is accepted. */
  private stopped = false;
  private readonly concurrency: number;
  private readonly maxAttempts: number;
  private readonly retryDelaysMs: readonly number[];

  constructor(private readonly opts: OrgQueueOptions) {
    this.concurrency = Math.max(1, opts.concurrency ?? 2);
    this.maxAttempts = Math.max(1, opts.maxAttempts ?? 3);
    this.retryDelaysMs = opts.retryDelaysMs?.length ? opts.retryDelaysMs : [100, 500];
  }

  /** Queues `task` behind the organization's earlier tasks (or coalesces it into one of them). */
  push(organizationId: string, task: OrgTask): void {
    if (this.stopped) {
      this.opts.log.warn(
        { organizationId, kind: task.kind, ...idsOf(task) },
        "background task refused: the queue was abandoned at shutdown",
      );
      return;
    }
    let org = this.orgs.get(organizationId);
    if (!org) {
      org = { waiting: [], running: false };
      this.orgs.set(organizationId, org);
    }
    if (task.key !== undefined && org.waiting.some((t) => t.key === task.key)) return;
    const tail = org.waiting.at(-1);
    if (tail?.absorb?.(task)) return;
    org.waiting.push(task);
    if (!org.running && !this.ready.includes(organizationId)) this.ready.push(organizationId);
    this.pump();
  }

  /** Resolves once the organization (or, without one, every organization) has nothing waiting or running. */
  whenIdle(organizationId?: string): Promise<void> {
    const key = organizationId ?? null;
    if (key === null ? this.orgs.size === 0 : !this.orgs.has(key)) return Promise.resolve();
    return new Promise((resolve) => {
      const list = this.idleWaiters.get(key) ?? [];
      list.push(resolve);
      this.idleWaiters.set(key, list);
    });
  }

  /**
   * Shutdown: lets every queued task (and what it queues) run for at most `timeoutMs`, then drops what still waits and
   * refuses new work. Nothing dropped weakens access: live subscriptions were already re-decided by the invalidation
   * published at commit, and the gateway's periodic re-check and every new subscribe re-decide again; a dropped session
   * delivery is covered by the list's refetch on reconnect; a dropped sweep leaves stored settings above a narrower
   * policy, but every turn is capped by the author's current access when it is dispatched (P-07).
   */
  async close(timeoutMs: number): Promise<OrgQueueClosed> {
    let timer: NodeJS.Timeout | undefined;
    const drained = await Promise.race([
      this.whenIdle().then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
        timer.unref();
      }),
    ]);
    clearTimeout(timer);
    if (drained) return { drained: true, abandoned: 0 };
    this.stopped = true;
    let abandoned = 0;
    for (const [organizationId, org] of this.orgs) {
      if (org.waiting.length === 0) continue;
      abandoned += org.waiting.length;
      this.opts.log.warn(
        { organizationId, kinds: [...new Set(org.waiting.map((t) => t.kind))], count: org.waiting.length },
        "background tasks abandoned at shutdown",
      );
      org.waiting = [];
      if (!org.running) this.settle(organizationId);
    }
    return { drained: false, abandoned };
  }

  private pump(): void {
    while (this.active < this.concurrency && this.ready.length > 0 && !this.stopped) {
      const organizationId = this.ready.shift() as string;
      const org = this.orgs.get(organizationId);
      if (!org || org.running || org.waiting.length === 0) continue;
      const task = org.waiting.shift() as OrgTask;
      org.running = true;
      this.active++;
      void this.attempt(organizationId, task).finally(() => {
        org.running = false;
        this.active--;
        if (org.waiting.length > 0 && !this.stopped) this.ready.push(organizationId);
        else this.settle(organizationId);
        this.pump();
      });
    }
  }

  /** The organization has nothing left: forget it and wake whoever waits for it (or for everything). */
  private settle(organizationId: string): void {
    this.orgs.delete(organizationId);
    for (const resolve of this.idleWaiters.get(organizationId) ?? []) resolve();
    this.idleWaiters.delete(organizationId);
    if (this.orgs.size === 0) {
      for (const resolve of this.idleWaiters.get(null) ?? []) resolve();
      this.idleWaiters.delete(null);
    }
  }

  private async attempt(organizationId: string, task: OrgTask): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        await task.run();
        return;
      } catch (err) {
        const fields = { organizationId, kind: task.kind, ...idsOf(task), attempt, error: errorCode(err) };
        if (attempt >= this.maxAttempts || this.stopped) {
          this.opts.log.error(fields, "background task failed; abandoned");
          return;
        }
        this.opts.log.warn(fields, "background task failed; retrying");
        await sleep(this.retryDelaysMs[Math.min(attempt - 1, this.retryDelaysMs.length - 1)] as number);
      }
    }
  }
}
