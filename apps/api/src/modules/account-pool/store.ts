import {
  type AccountPoolView,
  AccountUsageSnapshot,
  POOL_LIMITS,
  type PoolAccount,
  type PoolAccountKind,
  type PoolAccountOrigin,
  type PoolAccountStatus,
  type PoolPolicy,
  PoolProvider,
} from "@ocw/contracts";
import { accountPoolAccounts, accountPoolPolicies, devices, type Tx, tenantOf } from "@ocw/db";
import { and, asc, count, eq, inArray, isNull, max, sql } from "drizzle-orm";
import { conflict } from "../../lib/errors";
import type { AuditService } from "../audit";

/**
 * The account pool's rows (Phase 07.18, D-01, D-10, ADR-0044): reads, the status every surface shows, the admin DTO
 * and the one insert. Every query runs in the caller's tenant transaction (RLS: another organization's rows are not
 * there). No DTO, audit row or log line carries a token, a secret id, a slot id or a profile id (P1).
 */

export type PoolAccountRow = typeof accountPoolAccounts.$inferSelect;
type PolicyRow = typeof accountPoolPolicies.$inferSelect;

/** What a pool write tells the module's listeners (plans 13 and 14 sign slots and cell profiles in and out). */
export interface PoolChange {
  provider: PoolProvider;
  reason: "added" | "updated" | "removed" | "reordered" | "policy";
  /** The written account; null for a reorder or a policy change. */
  account: PoolAccountRow | null;
}

/** A slot's device as the admin list shows it. */
export interface PoolDevice {
  name: string;
  online: boolean;
}

const iso = (v: string) => new Date(v).toISOString();
const isoOrNull = (v: string | null) => (v === null ? null : iso(v));

/**
 * The status every surface shows (D-10): disabled wins, then a credential that needs a new sign-in, then a cooldown
 * still in the future, else ready.
 */
export function poolAccountStatus(
  row: Pick<PoolAccountRow, "enabled" | "credentialState" | "cooldownUntil">,
  now: Date,
): PoolAccountStatus {
  if (!row.enabled) return "disabled";
  if (row.credentialState === "needs_sign_in") return "needs_sign_in";
  if (row.cooldownUntil !== null && new Date(row.cooldownUntil).getTime() > now.getTime()) return "cooling";
  return "ready";
}

/** The admin DTO: no token, no secret id, no slot id, no profile id (P1); a slot carries its device. */
export function toPoolAccount(
  row: PoolAccountRow,
  deviceById: ReadonlyMap<string, PoolDevice>,
  now: Date,
): PoolAccount {
  const usage = row.usage === null ? null : AccountUsageSnapshot.safeParse(row.usage);
  let device: PoolAccount["device"] = null;
  if (row.kind === "device_slot" && row.deviceId !== null) {
    const d = deviceById.get(row.deviceId);
    device = {
      id: row.deviceId,
      name: (d?.name ?? "Unknown device").slice(0, 200),
      online: d?.online ?? false,
    };
  }
  return {
    id: row.id,
    provider: row.provider,
    kind: row.kind,
    label: row.label,
    enabled: row.enabled,
    priority: row.priority,
    weight: row.weight,
    status: poolAccountStatus(row, now),
    cooldownUntil: isoOrNull(row.cooldownUntil),
    limitReason: row.limitReason,
    lastUsedAt: isoOrNull(row.lastUsedAt),
    usage: usage?.success ? usage.data : null,
    planType: row.planType,
    origin: row.origin,
    device,
    createdAt: iso(row.createdAt),
  };
}

/** Live accounts (not removed), in the admin's order: priority, then created_at, then id (PD-07). */
export async function listPoolAccounts(tx: Tx, provider?: PoolProvider): Promise<PoolAccountRow[]> {
  return tx
    .select()
    .from(accountPoolAccounts)
    .where(
      and(
        isNull(accountPoolAccounts.removedAt),
        provider ? eq(accountPoolAccounts.provider, provider) : undefined,
      ),
    )
    .orderBy(
      asc(accountPoolAccounts.priority),
      asc(accountPoolAccounts.createdAt),
      asc(accountPoolAccounts.id),
    );
}

const defaultPolicy = (provider: PoolProvider): PoolPolicy => ({
  provider,
  strategy: "failover",
  scope: "all",
  fallbackToDeviceLogin: true,
  updatedAt: null,
});

const toPolicy = (row: PolicyRow): PoolPolicy => ({
  provider: row.provider,
  strategy: row.strategy,
  scope: row.scope,
  fallbackToDeviceLogin: row.fallbackToDeviceLogin,
  updatedAt: iso(row.updatedAt),
});

/** The provider's policy row, else the defaults (failover, all, fallback on) with `updatedAt` null (D-04, D-06). */
export async function loadPoolPolicy(tx: Tx, provider: PoolProvider): Promise<PoolPolicy> {
  const [row] = await tx
    .select()
    .from(accountPoolPolicies)
    .where(eq(accountPoolPolicies.provider, provider))
    .limit(1);
  return row ? toPolicy(row) : defaultPolicy(provider);
}

/** Name and online state of the devices the slot rows live on. */
export async function poolDevices(
  tx: Tx,
  rows: readonly Pick<PoolAccountRow, "deviceId">[],
): Promise<Map<string, PoolDevice>> {
  const ids = [...new Set(rows.map((r) => r.deviceId).filter((d): d is string => d !== null))];
  if (ids.length === 0) return new Map();
  const found = await tx
    .select({ id: devices.id, name: devices.name, status: devices.status })
    .from(devices)
    .where(inArray(devices.id, ids));
  return new Map(found.map((d) => [d.id, { name: d.name, online: d.status === "online" }]));
}

/** Settings › Account pool (D-10): both providers, each with its policy and its accounts in order. */
export async function loadPoolView(tx: Tx, now: Date): Promise<AccountPoolView> {
  const rows = await listPoolAccounts(tx);
  const deviceById = await poolDevices(tx, rows);
  const policies = await tx.select().from(accountPoolPolicies);
  const pool = (provider: PoolProvider) => {
    const policy = policies.find((p) => p.provider === provider);
    return {
      policy: policy ? toPolicy(policy) : defaultPolicy(provider),
      accounts: rows.filter((r) => r.provider === provider).map((r) => toPoolAccount(r, deviceById, now)),
    };
  };
  return { claude: pool("claude"), chatgpt: pool("chatgpt") };
}

/** Serializes the writes of one provider's pool in the organization (priority, the 20-account cap, the order). */
export async function lockPool(tx: Tx, provider: PoolProvider): Promise<void> {
  const key = `account_pool:${tenantOf(tx).organizationId}:${PoolProvider.parse(provider)}`;
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}

export interface NewPoolAccount {
  /** Set when the id must exist before the row (a token sealed to it). */
  id?: string;
  provider: PoolProvider;
  kind: PoolAccountKind;
  label: string;
  origin?: PoolAccountOrigin;
  /** Rows from an admin start enabled; a slot no admin started arrives disabled (PD-11). */
  enabled?: boolean;
  secretId?: string | null;
  deviceId?: string | null;
  slotId?: string | null;
  cellProfileId?: string | null;
  planType?: string | null;
}

/**
 * Adds an account at the end of its provider's order (priority = live max + 1), refused past
 * `POOL_LIMITS.accountsPerProvider` live accounts (409 `too_many_accounts`); audited `account_pool.account_added` with
 * the provider, kind, origin and label only.
 */
export async function insertPoolAccount(
  tx: Tx,
  audit: AuditService,
  input: NewPoolAccount,
): Promise<PoolAccountRow> {
  await lockPool(tx, input.provider);
  const [live] = await tx
    .select({ n: count(), top: max(accountPoolAccounts.priority) })
    .from(accountPoolAccounts)
    .where(and(eq(accountPoolAccounts.provider, input.provider), isNull(accountPoolAccounts.removedAt)));
  if ((live?.n ?? 0) >= POOL_LIMITS.accountsPerProvider) {
    throw conflict(
      `This pool already has ${POOL_LIMITS.accountsPerProvider} accounts. Remove one before adding another.`,
      "too_many_accounts",
    );
  }
  const origin = input.origin ?? "admin";
  const [row] = await tx
    .insert(accountPoolAccounts)
    .values({
      ...(input.id ? { id: input.id } : {}),
      organizationId: tenantOf(tx).organizationId,
      provider: input.provider,
      kind: input.kind,
      label: input.label,
      enabled: input.enabled ?? true,
      priority: live?.top === null || live?.top === undefined ? 0 : live.top + 1,
      secretId: input.secretId ?? null,
      deviceId: input.deviceId ?? null,
      slotId: input.slotId ?? null,
      cellProfileId: input.cellProfileId ?? null,
      origin,
      planType: input.planType ?? null,
      createdBy: tenantOf(tx).userId ?? null,
    })
    .returning();
  if (!row) throw new Error("pool account insert failed");
  await audit.record(tx, {
    action: "account_pool.account_added",
    resourceType: "account_pool_account",
    resourceId: row.id,
    ...(row.deviceId ? { deviceId: row.deviceId } : {}),
    metadata: { provider: row.provider, kind: row.kind, origin, label: row.label },
  });
  return row;
}
