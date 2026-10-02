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
}

export type AfterCommit = (cb: () => Promise<void> | void) => void;

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

export function createTenantDb(connectionString: string, opts: { max?: number } = {}): TenantDb {
  const pool = new pg.Pool({ connectionString, max: opts.max ?? 10 });
  const db = drizzle({ client: pool });

  async function withTenant<T>(ctx: TenantCtx, fn: (tx: Tx, afterCommit: AfterCommit) => Promise<T>) {
    if (!ctx.organizationId) throw new Error("withTenant requires an organizationId");
    const after: Array<() => Promise<void> | void> = [];
    const result = await db.transaction(async (tx) => {
      await tx.execute(
        sql`select set_config('app.organization_id', ${ctx.organizationId}, true), set_config('app.user_id', ${ctx.userId ?? ""}, true)`,
      );
      return fn(tx, (cb) => {
        after.push(cb);
      });
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
