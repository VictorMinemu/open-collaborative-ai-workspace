import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";

export type AppDb = NodePgDatabase;
/** Transaction handle passed to every domain query. */
export type Tx = Parameters<Parameters<AppDb["transaction"]>[0]>[0];

export interface TenantCtx {
  organizationId: string;
  /** Acting user (for policies/audit context); null for system/agent/device actions. */
  userId?: string | null;
  /** Session of the acting user's request; audit rows default to it (ORG-05, AUTH-05). */
  sessionId?: string | null;
  /** Client kind of that session (web, desktop, mobile); audit rows default to it. */
  clientKind?: string | null;
}

export type AfterCommit = (cb: () => Promise<void> | void) => void;

interface TxContext extends TenantCtx {
  afterCommit: AfterCommit;
}
const txContexts = new WeakMap<object, TxContext>();

/**
 * Tenant context + after-commit registrar of a transaction opened by withTenant(). Lets helpers such as
 * `audit.record(tx, …)` and `realtime.appendEvent(tx, …)` take only `tx`. Throws for foreign transactions.
 */
export function tenantOf(tx: Tx): TxContext {
  const ctx = txContexts.get(tx);
  if (!ctx) throw new Error("transaction was not opened by withTenant()");
  return ctx;
}

/** Thrown inside a savepoint to roll it back while handing its result to the caller. */
class DiscardSavepoint<T> extends Error {
  constructor(readonly result: T) {
    super("savepoint discarded");
  }
}

/**
 * Runs `fn` in a savepoint of `tx` (a nested transaction with the same tenant context, so `tenantOf`, audit and realtime
 * work inside it). When `keep(result)` is false the savepoint is rolled back, every write of `fn` disappears and the
 * after-commit hooks `fn` registered are dropped (a rolled-back realtime event is never published); the result is
 * returned either way. A throw rolls the savepoint back and propagates.
 */
export async function withSavepoint<T>(
  tx: Tx,
  fn: (sp: Tx) => Promise<T>,
  keep: (result: T) => boolean,
): Promise<T> {
  const parent = tenantOf(tx);
  const buffered: Array<() => Promise<void> | void> = [];
  try {
    const result = await tx.transaction(async (sp) => {
      txContexts.set(sp, { ...parent, afterCommit: (cb) => void buffered.push(cb) });
      const out = await fn(sp);
      if (!keep(out)) throw new DiscardSavepoint(out);
      return out;
    });
    for (const cb of buffered) parent.afterCommit(cb);
    return result;
  } catch (err) {
    if (err instanceof DiscardSavepoint) return err.result as T;
    throw err;
  }
}

export interface TenantDb {
  /**
   * The ONLY entrypoint for domain (schema `app`) queries. Opens a transaction, sets the tenant context with
   * transaction-scoped set_config (RLS reads it), runs `fn`, commits, then runs after-commit callbacks
   * (e.g. Redis publish) — never publish inside the transaction.
   */
  withTenant<T>(ctx: TenantCtx, fn: (tx: Tx, afterCommit: AfterCommit) => Promise<T>): Promise<T>;
  /** Pre-tenant lookups via narrow SECURITY DEFINER functions (bearer tokens, pairing codes). */
  lookups: {
    deviceByTokenHash(
      tokenHash: string,
    ): Promise<{ deviceId: string; organizationId: string; ownerUserId: string } | null>;
    agentCredentialByTokenHash(
      tokenHash: string,
    ): Promise<{ credentialId: string; organizationId: string; agentId: string | null } | null>;
    deviceEnrollmentByCodeHash(codeHash: string): Promise<{
      organizationId: string;
      userId: string;
      expiresAt: string;
      consumedAt: string | null;
    } | null>;
  };
  /** Health probe. */
  ping(): Promise<void>;
  close(): Promise<void>;
  pool: pg.Pool;
}

export function createTenantDb(
  connectionString: string,
  opts: { max?: number; onIdleError?: (error: Error) => void } = {},
): TenantDb {
  const pool = new pg.Pool({ connectionString, max: opts.max ?? 10 });
  // An idle client whose connection drops (Postgres restart, admin termination) emits `error` on the
  // pool; unhandled, that crashes the process. The client is discarded and the next query reconnects.
  pool.on("error", (error) => opts.onIdleError?.(error));
  // A checked-out client whose connection drops (e.g. mid-transaction during a Postgres restart) emits
  // `error` on the client itself, where the pool's idle listener is not attached: without this listener
  // the process crashes. The in-flight query still rejects normally; the pool discards the dead client.
  pool.on("connect", (client) => {
    client.on("error", (error) => opts.onIdleError?.(error));
  });
  const db = drizzle({ client: pool });

  async function withTenant<T>(ctx: TenantCtx, fn: (tx: Tx, afterCommit: AfterCommit) => Promise<T>) {
    if (!ctx.organizationId) throw new Error("withTenant requires an organizationId");
    const after: Array<() => Promise<void> | void> = [];
    const result = await db.transaction(async (tx) => {
      await tx.execute(
        sql`select set_config('app.organization_id', ${ctx.organizationId}, true), set_config('app.user_id', ${ctx.userId ?? ""}, true)`,
      );
      const afterCommit: AfterCommit = (cb) => {
        after.push(cb);
      };
      txContexts.set(tx, {
        organizationId: ctx.organizationId,
        userId: ctx.userId ?? null,
        sessionId: ctx.sessionId ?? null,
        clientKind: ctx.clientKind ?? null,
        afterCommit,
      });
      return fn(tx, afterCommit);
    });
    for (const cb of after) {
      try {
        await cb();
      } catch (err) {
        // After-commit hooks are hints (e.g. Redis publish); clients recover gaps via seq replay.
        console.error("after-commit callback failed", err);
      }
    }
    return result;
  }

  async function one<R>(text: string, value: string): Promise<R | null> {
    const res = await pool.query(text, [value]);
    return (res.rows[0] as R | undefined) ?? null;
  }

  return {
    withTenant,
    pool,
    lookups: {
      deviceByTokenHash: (h) =>
        one(
          'select device_id as "deviceId", organization_id as "organizationId", owner_user_id as "ownerUserId" from app.lookup_device_token($1)',
          h,
        ),
      agentCredentialByTokenHash: (h) =>
        one(
          'select credential_id as "credentialId", organization_id as "organizationId", agent_id as "agentId" from app.lookup_agent_credential($1)',
          h,
        ),
      deviceEnrollmentByCodeHash: (h) =>
        one(
          'select organization_id as "organizationId", user_id as "userId", expires_at::text as "expiresAt", consumed_at::text as "consumedAt" from app.lookup_device_enrollment($1)',
          h,
        ),
    },
    async ping() {
      await pool.query("select 1");
    },
    async close() {
      await pool.end();
    },
  };
}
