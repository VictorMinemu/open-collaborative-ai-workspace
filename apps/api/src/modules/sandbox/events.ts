import { SandboxdEvent, SandboxdEventsResponse } from "@ocw/contracts";
import { agents, auditEvents, botSandboxes, sandboxEventCursor, sandboxUsageDaily, type Tx } from "@ocw/db";
import { and, eq, gte, sql } from "drizzle-orm";
import type pg from "pg";
import { z } from "zod";
import type { Core } from "../../core";
import { type SandboxdClient, SandboxdUnavailableError } from "./client";
import { markState, retryPendingPurges, utcDay } from "./service";
import { pushPolicy } from "./settings";

/**
 * The API's reader of sandboxd's event feed (07.8-11; D-01, D-09; T-07.8-11-05). sandboxd never calls the API; one API
 * process at a time long-polls `GET /v1/events` while it holds a session advisory lock on a dedicated connection, and
 * every other process waits as a standby.
 *
 * Exactly once per organization, whatever restarts: each event is applied in its organization's transaction only if its
 * `(bootId, seq)` is newer than that organization's `sandbox_event_cursor` row, which the same transaction locks and
 * advances. The in-memory position only decides where the next poll starts and may be lost (an API restart, a lock
 * hand-over): the replay that follows is skipped by the durable cursor, so CPU is never counted twice and no audit is
 * repeated.
 *
 * What an event does: `state` mirrors a container into `bot_sandboxes` (and audits sandboxd's own stops: idle, disk full,
 * a crash); `usage` adds CPU to today's `sandbox_usage_daily` and updates the disk mirror; `egress` audits the host once
 * per (bot, host, allowed) per hour; `browser` goes to the handlers other modules register (`onEvent`, 07.8-14), and
 * so does `process` (a background command ended: the long task waiting on it wakes, 07.17.1.1.2-11). Each event is
 * parsed on its own: one of a type this API does not know (a newer sandboxd) is skipped and the feed moves past it.
 *
 * A new boot id (sandboxd restarted, or the first poll of this process) means sandboxd may hold no policy at all, and it
 * has no default: it refuses to start anything (`policy_missing`) until told. The consumer then pushes the current
 * policy of every organization that has sandboxes (`app.sandbox_organizations`, ids only), whether or not it sends
 * events, and retries their pending purges. Until every push succeeded it tries again on the next pass. The client's
 * own re-push on `policy_missing` covers the calls in between.
 */

/** Any constant shared by every API process; only one of them consumes at a time. */
export const SANDBOX_EVENTS_LOCK_KEY = 0x0c3a_0711;
const DEFAULT_WAIT_MS = 20_000;
const STANDBY_RETRY_MS = 15_000;
const ERROR_BACKOFF_MS = 5_000;
/** A poison event (it fails its transaction every time) is skipped after this many passes, logged with ids. */
const MAX_EVENT_ATTEMPTS = 3;
const EGRESS_AUDIT_WINDOW = "1 hour";
/** Organizations read per page from `app.sandbox_organizations` when a new boot needs every policy again. */
const ORGANIZATIONS_PAGE = 500;

export type SandboxEventType = SandboxdEvent["type"];
export type SandboxEventOf<T extends SandboxEventType> = Extract<SandboxdEvent, { type: T }>;
/** A handler runs inside the event's organization transaction, after the cursor check (never for a replay). */
export type SandboxEventHandler<T extends SandboxEventType> = (
  tx: Tx,
  event: SandboxEventOf<T>,
) => Promise<void>;

export interface PassResult {
  /** false: another process holds the lock (this one is a standby). */
  locked: boolean;
  /** Events applied to an organization (replays and skipped events excluded). */
  applied: number;
  /** Events already applied earlier (the durable cursor said so). */
  skipped: number;
}

export interface SandboxEventsConsumer {
  /** One poll and its events; `waitMs` 0 returns at once (tests). */
  runOnce(opts?: { waitMs?: number }): Promise<PassResult>;
  start(): void;
  /** Ends the loop, aborts the long poll and releases the lock. */
  stop(): Promise<void>;
  onEvent<T extends SandboxEventType>(type: T, handler: SandboxEventHandler<T>): void;
  /** Whether this process holds the lock now. */
  holdsLock(): boolean;
}

type Outcome = "applied" | "skipped";

/** The feed's envelope with its events unparsed: each is parsed on its own (`itemOf`). */
const FeedEnvelope = SandboxdEventsResponse.extend({ events: z.array(z.unknown()).max(500) });
const UnknownEvent = z.object({ seq: z.number().int().positive(), type: z.unknown() });
/** An event type is logged only when it looks like one (a newer sandboxd's name), never arbitrary text. */
const EVENT_TYPE_NAME = /^[a-z][a-z0-9_.]{0,39}$/u;

/** One feed entry: a known event, or the seq and type of one this API cannot read (skipped, cursor advanced). */
type FeedItem = { seq: number; event: SandboxdEvent } | { seq: number; event: null; type: string };
interface FeedPage {
  bootId: string;
  items: FeedItem[];
}

function itemOf(raw: unknown): FeedItem {
  const known = SandboxdEvent.safeParse(raw);
  if (known.success) return { seq: known.data.seq, event: known.data };
  const base = UnknownEvent.safeParse(raw);
  const type = base.success && typeof base.data.type === "string" ? base.data.type : "";
  // Without a seq the entry cannot be placed: seq 0 is behind every cursor, so it is passed over.
  return {
    seq: base.success ? base.data.seq : 0,
    event: null,
    type: EVENT_TYPE_NAME.test(type) ? type : "invalid",
  };
}

export function createSandboxEventsConsumer(
  core: Core,
  deps: {
    client: SandboxdClient;
    lockKey?: number;
    waitMs?: number;
    /** Organizations with a purge that failed in this process (the bot deletion's after-commit). */
    pendingPurges?: Set<string>;
  },
): SandboxEventsConsumer {
  const lockKey = deps.lockKey ?? SANDBOX_EVENTS_LOCK_KEY;
  /** Handlers per event type; each is only ever called with an event of its own type (see `apply`). */
  const handlers = new Map<SandboxEventType, Array<(tx: Tx, e: SandboxdEvent) => Promise<void>>>();
  let lockClient: pg.PoolClient | null = null;
  /** Where the next poll starts (in memory only). */
  let position: { bootId: string | null; seq: number } = { bootId: null, seq: 0 };
  /** Boots this process saw replaced: never applied again, whatever a feed would send. */
  const retired = new Set<string>();
  const attempts = new Map<string, number>();
  let running = false;
  let loop: Promise<void> | null = null;
  let abort: AbortController | null = null;
  let pass: Promise<PassResult> | null = null;
  /** The boot every organization's policy was pushed to (null: none yet in this process). */
  let pushedBoot: string | null = null;

  /** Every organization with a sandbox row (ids only, across organizations: a narrow SECURITY DEFINER lister). */
  async function sandboxOrganizations(): Promise<string[]> {
    const out: string[] = [];
    let after: string | null = null;
    for (;;) {
      const page: { rows: Array<{ organization_id: string }> } = await core.db.pool.query<{
        organization_id: string;
      }>("select organization_id from app.sandbox_organizations($1, $2)", [after, ORGANIZATIONS_PAGE]);
      const rows = page.rows;
      out.push(...rows.map((r) => r.organization_id));
      const last: { organization_id: string } | undefined = rows.at(-1);
      if (rows.length < ORGANIZATIONS_PAGE || !last) return out;
      after = last.organization_id;
    }
  }

  /** On a boot not yet served: every organization's policy again (sandboxd has none), and its pending purges. */
  async function pushEveryPolicy(bootId: string): Promise<Set<string>> {
    const orgs = new Set<string>();
    if (pushedBoot === bootId) return orgs;
    let all = true;
    for (const orgId of await sandboxOrganizations()) {
      orgs.add(orgId);
      if (!(await pushPolicy(core, deps.client, orgId))) all = false;
    }
    if (all) pushedBoot = bootId;
    return orgs;
  }

  async function acquire(): Promise<boolean> {
    if (lockClient) return true;
    const client = await core.db.pool.connect();
    try {
      const res = await client.query<{ ok: boolean }>("select pg_try_advisory_lock($1) as ok", [lockKey]);
      if (res.rows[0]?.ok) {
        lockClient = client;
        return true;
      }
    } catch (err) {
      client.release();
      throw err;
    }
    client.release();
    return false;
  }

  async function release(): Promise<void> {
    const client = lockClient;
    lockClient = null;
    if (!client) return;
    try {
      await client.query("select pg_advisory_unlock($1)", [lockKey]);
      client.release();
    } catch {
      // A dead connection drops its session locks with it.
      client.release(true);
    }
  }

  /**
   * One poll of the feed. The envelope is the contract's; each event is parsed on its own (Pitfall 11, E25): an event
   * of a type this API does not know (a newer sandboxd) is kept as its seq and type only, so the pass skips it and
   * moves on instead of failing the whole page (the client's own parse of the contract would refuse it).
   */
  async function poll(waitMs: number): Promise<FeedPage> {
    abort = new AbortController();
    try {
      const after = position.bootId ? position.seq : 0;
      const body = await deps.client.stream(
        "events",
        { after, waitMs },
        { timeoutMs: waitMs + 10_000, signal: abort.signal },
      );
      let json: unknown;
      try {
        json = await new Response(body).json();
      } catch {
        throw new SandboxdUnavailableError("events", null);
      }
      const page = FeedEnvelope.safeParse(json);
      if (!page.success) throw new SandboxdUnavailableError("events", null);
      return { bootId: page.data.bootId, items: page.data.events.map(itemOf) };
    } finally {
      abort = null;
    }
  }

  /** The agent of the event, inside its organization (RLS); deleted bots still count their usage. */
  async function agentOf(tx: Tx, agentId: string): Promise<{ id: string; deleted: boolean } | null> {
    const [row] = await tx
      .select({ id: agents.id, deletedAt: agents.deletedAt })
      .from(agents)
      .where(eq(agents.id, agentId))
      .limit(1);
    return row ? { id: row.id, deleted: row.deletedAt !== null } : null;
  }

  async function applyState(tx: Tx, e: SandboxEventOf<"state">): Promise<void> {
    if (e.kind !== "sbx" && e.kind !== "brw") return;
    const agent = await agentOf(tx, e.target.agentId);
    // A deleted bot keeps its pending-purge marker (state absent); its containers' news no longer matter.
    if (!agent || agent.deleted) return;
    await markState(tx, { agentId: agent.id, kind: e.kind, state: e.state, stopReason: e.reason });
    const stopped = e.state === "stopped" || e.state === "unavailable" || e.state === "disk_full";
    // sandboxd's own stops: idle, disk full, or a crash (stopped with no reason). The API already audited the person's
    // stop (`user`) and the kill switch (`sandbox.killed`).
    const reason = e.reason ?? (stopped ? "crashed" : null);
    if (!stopped || reason === null || reason === "user" || reason === "kill_switch") return;
    await core.audit.record(tx, {
      action: "sandbox.stopped",
      resourceType: "agent",
      resourceId: agent.id,
      actorKind: "system",
      agentId: agent.id,
      userId: null,
      metadata: { kind: e.kind, reason },
    });
  }

  async function applyUsage(tx: Tx, e: SandboxEventOf<"usage">, orgId: string): Promise<void> {
    const agent = await agentOf(tx, e.target.agentId);
    if (!agent) return;
    if (e.cpuMs > 0) {
      await tx
        .insert(sandboxUsageDaily)
        .values({ organizationId: orgId, agentId: agent.id, day: utcDay(new Date(e.at)), cpuMs: e.cpuMs })
        .onConflictDoUpdate({
          target: [sandboxUsageDaily.organizationId, sandboxUsageDaily.agentId, sandboxUsageDaily.day],
          set: { cpuMs: sql`${sandboxUsageDaily.cpuMs} + ${e.cpuMs}` },
        });
    }
    const now = new Date().toISOString();
    // The disk mirror; a sample for a bot the API never recorded takes no cap slot (`stopped`).
    await tx
      .insert(botSandboxes)
      .values({
        organizationId: orgId,
        agentId: agent.id,
        kind: "sbx",
        state: "stopped",
        diskBytes: e.diskBytes,
      })
      .onConflictDoUpdate({
        target: [botSandboxes.organizationId, botSandboxes.agentId, botSandboxes.kind],
        set: { diskBytes: e.diskBytes, updatedAt: now },
      });
  }

  async function applyEgress(tx: Tx, e: SandboxEventOf<"egress">): Promise<void> {
    const agent = await agentOf(tx, e.target.agentId);
    if (!agent) return;
    const [seen] = await tx
      .select({ id: auditEvents.id })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.action, "sandbox.egress"),
          eq(auditEvents.agentId, agent.id),
          sql`${auditEvents.metadata}->>'host' = ${e.host}`,
          sql`(${auditEvents.metadata}->>'allowed')::boolean = ${e.allowed}`,
          gte(auditEvents.occurredAt, sql`now() - interval '${sql.raw(EGRESS_AUDIT_WINDOW)}'`),
        ),
      )
      .limit(1);
    if (seen) return;
    await core.audit.record(tx, {
      action: "sandbox.egress",
      resourceType: "agent",
      resourceId: agent.id,
      actorKind: "agent",
      actorId: agent.id,
      agentId: agent.id,
      userId: null,
      result: e.allowed ? "success" : "denied",
      metadata: { kind: e.kind, host: e.host, allowed: e.allowed },
    });
  }

  /** One event in its organization's transaction, guarded by the durable cursor. */
  async function apply(bootId: string, e: SandboxdEvent): Promise<{ outcome: Outcome; newBoot: boolean }> {
    const orgId = e.target.orgId;
    return core.db.withTenant({ organizationId: orgId, userId: null }, async (tx) => {
      await tx
        .insert(sandboxEventCursor)
        .values({ organizationId: orgId, bootId, seq: 0 })
        .onConflictDoNothing();
      const [cursor] = await tx
        .select({ bootId: sandboxEventCursor.bootId, seq: sandboxEventCursor.seq })
        .from(sandboxEventCursor)
        .for("update")
        .limit(1);
      const newBoot = cursor !== undefined && cursor.bootId !== bootId;
      const newer = cursor === undefined || newBoot || e.seq > cursor.seq;
      if (!newer) return { outcome: "skipped" as const, newBoot: false };
      switch (e.type) {
        case "state":
          await applyState(tx, e);
          break;
        case "usage":
          await applyUsage(tx, e, orgId);
          break;
        case "egress":
          await applyEgress(tx, e);
          break;
        default:
          break;
      }
      for (const h of handlers.get(e.type) ?? []) await h(tx, e);
      await tx
        .update(sandboxEventCursor)
        .set({ bootId, seq: e.seq, updatedAt: new Date().toISOString() })
        .where(eq(sandboxEventCursor.organizationId, orgId));
      return { outcome: "applied" as const, newBoot };
    });
  }

  async function runPass(waitMs: number): Promise<PassResult> {
    if (!(await acquire())) return { locked: false, applied: 0, skipped: 0 };
    let res = await poll(waitMs);
    if (retired.has(res.bootId)) return { locked: true, applied: 0, skipped: 0 };
    if (position.bootId !== null && res.bootId !== position.bootId) {
      // sandboxd restarted: its feed starts again at 1, so read the new boot from its start.
      retired.add(position.bootId);
      position = { bootId: res.bootId, seq: 0 };
      // The poll asked past the old boot's position: read the new boot from its start now (no wait).
      if (res.items[0]?.seq !== 1) res = await poll(0);
    }
    position.bootId = res.bootId;
    // Before any event: sandboxd refuses every start until it has the organizations' policies again.
    const pushed = await pushEveryPolicy(res.bootId);
    let applied = 0;
    let skipped = 0;
    const orgs = new Set<string>();
    const repush = new Set<string>();
    for (const item of res.items) {
      if (item.seq <= position.seq) continue;
      const e = item.event;
      if (!e) {
        // E25: an event type this API does not know is skipped, its seq and type only in the log; the feed goes on.
        core.log.warn({ seq: item.seq, type: item.type }, "skipped a sandbox event of an unknown type");
        position.seq = item.seq;
        skipped++;
        continue;
      }
      const key = `${res.bootId}:${e.seq}`;
      try {
        const r = await apply(res.bootId, e);
        if (r.outcome === "applied") applied++;
        else skipped++;
        if (r.newBoot) repush.add(e.target.orgId);
        orgs.add(e.target.orgId);
        attempts.delete(key);
      } catch (err) {
        const n = (attempts.get(key) ?? 0) + 1;
        attempts.set(key, n);
        core.log.warn(
          {
            organizationId: e.target.orgId,
            seq: e.seq,
            type: e.type,
            attempt: n,
            error: (err as Error)?.name,
          },
          "could not apply a sandbox event",
        );
        // Retry from this event on the next pass, unless it keeps failing.
        if (n < MAX_EVENT_ATTEMPTS) break;
        attempts.delete(key);
      }
      position.seq = e.seq;
    }
    // sandboxd forgot its policies when it restarted; pending purges of deleted bots get another try.
    for (const orgId of repush) if (!pushed.has(orgId)) await pushPolicy(core, deps.client, orgId);
    for (const orgId of new Set([...orgs, ...pushed, ...(deps.pendingPurges ?? [])])) {
      const left = await retryPendingPurges(core, deps.client, orgId);
      if (left === 0) deps.pendingPurges?.delete(orgId);
    }
    return { locked: true, applied, skipped };
  }

  function runOnce(opts: { waitMs?: number } = {}): Promise<PassResult> {
    pass ??= runPass(opts.waitMs ?? deps.waitMs ?? DEFAULT_WAIT_MS).finally(() => {
      pass = null;
    });
    return pass;
  }

  /** A pause `stop()` can end at once. */
  let wake: (() => void) | null = null;
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        wake = null;
        resolve();
      }, ms);
      t.unref();
      wake = () => {
        clearTimeout(t);
        wake = null;
        resolve();
      };
    });

  async function run(): Promise<void> {
    while (running) {
      try {
        const r = await runOnce();
        if (!r.locked) await sleep(STANDBY_RETRY_MS);
      } catch (err) {
        if (!running) break;
        core.log.warn({ error: (err as Error)?.name }, "sandbox events pass failed");
        await sleep(ERROR_BACKOFF_MS);
      }
    }
  }

  return {
    runOnce,
    holdsLock: () => lockClient !== null,
    onEvent(type, handler) {
      const list = handlers.get(type) ?? [];
      // Keyed by `type`, so the handler only ever receives its own event type.
      list.push(handler as unknown as (tx: Tx, e: SandboxdEvent) => Promise<void>);
      handlers.set(type, list);
    },
    start() {
      if (running) return;
      running = true;
      loop = run();
    },
    async stop() {
      running = false;
      abort?.abort();
      wake?.();
      await pass?.catch(() => undefined);
      await loop;
      loop = null;
      await release();
    },
  };
}
