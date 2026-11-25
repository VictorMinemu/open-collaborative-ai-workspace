import { randomUUID } from "node:crypto";
import {
  type AccountPoolView,
  AccountUsageSnapshot,
  type AddClaudeTokenRequest,
  normalizeStrategy,
  POOL_LIMITS,
  type PoolAccount,
  type PoolAccountKind,
  type PoolAccountOrigin,
  type PoolAccountStatus,
  type PoolPolicy,
  PoolProvider,
  type UpdatePoolAccountRequest,
  type UpdatePoolPolicyRequest,
} from "@ocw/contracts";
import { accountPoolAccounts, accountPoolPolicies, devices, type Tx, tenantOf } from "@ocw/db";
import { and, asc, count, eq, inArray, isNull, max, sql } from "drizzle-orm";
import { badRequest, conflict, notFound } from "../../lib/errors";
import type { AuditService } from "../audit";
import type { SecretsService } from "../secrets";
import { replacePoolToken, sealPoolToken } from "./tokens";

/**
 * The account pool's rows (Phase 07.18, D-01, D-10, ADR-0044): reads, the status every surface shows, the admin DTO,
 * the one insert and the admin writes. Every query runs in the caller's tenant transaction (RLS: another organization's rows are not
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

// ---------------------------------------------------------------- admin writes (PD-19, PD-20, PD-25)

/** What the writes need; `onChange` is called once per successful write, inside its transaction. */
export interface PoolPorts {
  audit: AuditService;
  secrets: SecretsService;
  onChange?: ((tx: Tx, change: PoolChange) => Promise<void>) | undefined;
}

const accountNotFound = () => notFound("This account is not in the pool.", "account_not_found");

/** The live account, locked for the write; another organization's or a removed one is not found (404). */
async function lockLiveAccount(tx: Tx, id: string): Promise<PoolAccountRow> {
  const [row] = await tx
    .select()
    .from(accountPoolAccounts)
    .where(and(eq(accountPoolAccounts.id, id), isNull(accountPoolAccounts.removedAt)))
    .for("update");
  if (!row) throw accountNotFound();
  return row;
}

const policyAudit = (p: Pick<PoolPolicy, "strategy" | "scope" | "fallbackToDeviceLogin">) => ({
  strategy: p.strategy,
  scope: p.scope,
  fallbackToDeviceLogin: p.fallbackToDeviceLogin,
});

/** A Claude setup-token, sealed to a new account at the end of the order (D-02, PD-21). */
export async function addClaudeToken(
  tx: Tx,
  ports: PoolPorts,
  body: AddClaudeTokenRequest,
  now = new Date(),
): Promise<PoolAccount> {
  // The id exists before the token is sealed, so the AAD binds the ciphertext to this one account.
  const id = randomUUID();
  const secretId = await sealPoolToken(tx, ports.secrets, id, body.token);
  const row = await insertPoolAccount(tx, ports.audit, {
    id,
    provider: "claude",
    kind: "token",
    label: body.label,
    secretId,
  });
  await ports.onChange?.(tx, { provider: row.provider, reason: "added", account: row });
  return toPoolAccount(row, new Map(), now);
}

/**
 * Label, enabled, weight, or a token account's new token (re-sealed in the same secret row; the credential is `ok`
 * again). A token for a slot or a cell profile is 409 `wrong_kind`. Audited `account_pool.account_updated` with the
 * changed keys (`tokenReplaced: true`, never the value); nothing changed writes nothing.
 */
export async function updatePoolAccount(
  tx: Tx,
  ports: PoolPorts,
  id: string,
  body: UpdatePoolAccountRequest,
  now = new Date(),
): Promise<PoolAccount> {
  const row = await lockLiveAccount(tx, id);
  if (body.token !== undefined && row.kind !== "token") {
    throw conflict("Only a Claude token account has a token to replace.", "wrong_kind");
  }
  const patch: Partial<typeof accountPoolAccounts.$inferInsert> = {};
  const changed: string[] = [];
  if (body.label !== undefined && body.label !== row.label) {
    patch.label = body.label;
    changed.push("label");
  }
  if (body.enabled !== undefined && body.enabled !== row.enabled) {
    patch.enabled = body.enabled;
    changed.push("enabled");
  }
  if (body.weight !== undefined && body.weight !== row.weight) {
    patch.weight = body.weight;
    changed.push("weight");
  }
  if (body.token !== undefined) {
    if (row.secretId) await replacePoolToken(tx, ports.secrets, row.secretId, row.id, body.token);
    else patch.secretId = await sealPoolToken(tx, ports.secrets, row.id, body.token);
    patch.credentialState = "ok";
    changed.push("token");
  }
  if (changed.length === 0) return toPoolAccount(row, await poolDevices(tx, [row]), now);
  const [updated] = await tx
    .update(accountPoolAccounts)
    .set({ ...patch, updatedAt: now.toISOString() })
    .where(eq(accountPoolAccounts.id, row.id))
    .returning();
  if (!updated) throw accountNotFound();
  await ports.audit.record(tx, {
    action: "account_pool.account_updated",
    resourceType: "account_pool_account",
    resourceId: updated.id,
    metadata: {
      provider: updated.provider,
      kind: updated.kind,
      label: updated.label,
      changed,
      ...(body.token !== undefined ? { tokenReplaced: true } : {}),
    },
  });
  await ports.onChange?.(tx, { provider: updated.provider, reason: "updated", account: updated });
  return toPoolAccount(updated, await poolDevices(tx, [updated]), now);
}

/**
 * The provider's new order: exactly its live accounts, each once (priority = index). An id of another provider or
 * organization, a removed id (400 `account_not_found`) or a missing live id (400) changes nothing. Audited
 * `account_pool.reordered` with the ids.
 */
export async function reorderPool(
  tx: Tx,
  ports: PoolPorts,
  provider: PoolProvider,
  accountIds: readonly string[],
  now = new Date(),
): Promise<AccountPoolView> {
  await lockPool(tx, provider);
  const live = await tx
    .select({ id: accountPoolAccounts.id, priority: accountPoolAccounts.priority })
    .from(accountPoolAccounts)
    .where(and(eq(accountPoolAccounts.provider, provider), isNull(accountPoolAccounts.removedAt)))
    .for("update");
  const priorityOf = new Map(live.map((r) => [r.id, r.priority]));
  if (accountIds.some((id) => !priorityOf.has(id))) {
    throw badRequest("One of these accounts is not in this pool.", "account_not_found");
  }
  if (new Set(accountIds).size !== accountIds.length || accountIds.length !== live.length) {
    throw badRequest("List every account of this pool once.");
  }
  for (const [priority, id] of accountIds.entries()) {
    if (priorityOf.get(id) === priority) continue;
    await tx
      .update(accountPoolAccounts)
      .set({ priority, updatedAt: now.toISOString() })
      .where(eq(accountPoolAccounts.id, id));
  }
  await ports.audit.record(tx, {
    action: "account_pool.reordered",
    resourceType: "account_pool",
    metadata: { provider, accountIds: [...accountIds] },
  });
  await ports.onChange?.(tx, { provider, reason: "reordered", account: null });
  return loadPoolView(tx, now);
}

/**
 * The provider's strategy, scope and fallback (D-04, D-06): upserts its policy row (`fill_first` is stored as
 * `failover`). Audited `account_pool.policy_changed` with before and after.
 */
export async function updatePoolPolicy(
  tx: Tx,
  ports: PoolPorts,
  provider: PoolProvider,
  body: UpdatePoolPolicyRequest,
  now = new Date(),
): Promise<PoolPolicy> {
  await lockPool(tx, provider);
  const before = await loadPoolPolicy(tx, provider);
  const after = {
    strategy: body.strategy === undefined ? before.strategy : normalizeStrategy(body.strategy),
    scope: body.scope ?? before.scope,
    fallbackToDeviceLogin: body.fallbackToDeviceLogin ?? before.fallbackToDeviceLogin,
  };
  const values = { ...after, updatedBy: tenantOf(tx).userId ?? null, updatedAt: now.toISOString() };
  const [row] = await tx
    .insert(accountPoolPolicies)
    .values({ organizationId: tenantOf(tx).organizationId, provider, ...values })
    .onConflictDoUpdate({
      target: [accountPoolPolicies.organizationId, accountPoolPolicies.provider],
      set: values,
    })
    .returning();
  if (!row) throw new Error("pool policy upsert failed");
  await ports.audit.record(tx, {
    action: "account_pool.policy_changed",
    resourceType: "account_pool",
    metadata: { provider, before: policyAudit(before), after: policyAudit(after) },
  });
  await ports.onChange?.(tx, { provider, reason: "policy", account: null });
  return toPolicy(row);
}

/**
 * Soft removal (PD-25): the row keeps its id for the sessions that used it, gets `removed_at`, leaves the pool, and a
 * token's secret is deleted. A slot or a cell profile is only marked here; signing it out on its device or in the cell
 * follows from `onChange` reason `removed` (plans 13, 14). Audited `account_pool.account_removed`.
 */
export async function removePoolAccount(
  tx: Tx,
  ports: PoolPorts,
  id: string,
  now = new Date(),
): Promise<void> {
  const row = await lockLiveAccount(tx, id);
  const at = now.toISOString();
  const [updated] = await tx
    .update(accountPoolAccounts)
    .set({ removedAt: at, secretId: null, updatedAt: at })
    .where(eq(accountPoolAccounts.id, row.id))
    .returning();
  if (!updated) throw accountNotFound();
  if (row.secretId) await ports.secrets.remove(tx, row.secretId);
  await ports.audit.record(tx, {
    action: "account_pool.account_removed",
    resourceType: "account_pool_account",
    resourceId: row.id,
    ...(row.deviceId ? { deviceId: row.deviceId } : {}),
    metadata: { provider: row.provider, kind: row.kind, origin: row.origin, label: row.label },
  });
  await ports.onChange?.(tx, { provider: updated.provider, reason: "removed", account: updated });
}

/**
 * 07.18 gap: the provider's sign-in in the cell was disconnected (Settings › Models), so the cell holds none of its
 * profiles any more. Every live `cell_profile` row of the pool is marked removed in the caller's transaction (the one
 * that deletes the provider row) and audited `account_pool.account_removed` with reason `provider_disconnected`; device
 * slots and Claude tokens are not the cell's sign-in and stay. The disconnect itself signs the cell out and tells it to
 * re-read its config, so no per-account `onChange` runs. Returns the removed ids.
 */
export async function removeCellProfiles(
  tx: Tx,
  audit: AuditService,
  provider: PoolProvider,
  now = new Date(),
): Promise<string[]> {
  const at = now.toISOString();
  const removed = await tx
    .update(accountPoolAccounts)
    .set({ removedAt: at, updatedAt: at })
    .where(
      and(
        eq(accountPoolAccounts.provider, provider),
        eq(accountPoolAccounts.kind, "cell_profile"),
        isNull(accountPoolAccounts.removedAt),
      ),
    )
    .returning();
  for (const row of removed) {
    await audit.record(tx, {
      action: "account_pool.account_removed",
      resourceType: "account_pool_account",
      resourceId: row.id,
      metadata: {
        provider: row.provider,
        kind: row.kind,
        origin: row.origin,
        label: row.label,
        reason: "provider_disconnected",
      },
    });
  }
  return removed.map((r) => r.id);
}
