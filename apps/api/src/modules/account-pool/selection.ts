import type { PoolPolicy, PoolProvider, PoolScope } from "@ocw/contracts";
import { accountPoolAccounts, accountPoolPolicies, type Tx, tenantOf } from "@ocw/db";
import { and, eq, isNull } from "drizzle-orm";
import type { Core } from "../../core";
import { earliestReset, isCooling, type PoolCandidate, pickAccount } from "./select";
import { listPoolAccounts, loadPoolPolicy, type PoolAccountRow } from "./store";
import { openPoolToken } from "./tokens";

/**
 * Which pool account a consumer gets (Phase 07.18, D-04, D-05, D-06, PD-06, PD-07, PD-16, PD-18). Every function runs
 * in the caller's tenant transaction, so another organization's accounts are never candidates (RLS). `selectAccount`
 * is the only writer of `last_used_at` and `wrr_current` and serializes on the provider's policy row.
 */

/** Who an account serves: a Work Zone session or the organization's bots (the cell). */
export type PoolConsumer = "work_zone" | "bots";

export interface UsableContext {
  /** The Work Zone session's device (a ChatGPT slot serves only its own device); null for bots. */
  deviceId: string | null;
  consumer: PoolConsumer;
  /** The provider policy's scope (PD-18): which consumers Claude token accounts serve. */
  scope: PoolScope;
  now: Date;
}

const cooldownOf = (row: Pick<PoolAccountRow, "cooldownUntil">) =>
  row.cooldownUntil === null ? null : new Date(row.cooldownUntil);

/**
 * Whether the account could ever serve this consumer, cooling aside: live (not removed), enabled, a credential that
 * needs no new sign-in, and the kind of the consumer (PD-18): a Claude token whose scope covers it, a ChatGPT slot of
 * this very device for the Work Zone, a cell profile for bots.
 */
export function servesConsumer(row: PoolAccountRow, ctx: Omit<UsableContext, "now">): boolean {
  if (row.removedAt !== null || !row.enabled || row.credentialState !== "ok") return false;
  switch (row.kind) {
    case "token":
      return row.provider === "claude" && (ctx.scope === "all" || ctx.scope === ctx.consumer);
    case "device_slot":
      return ctx.consumer === "work_zone" && ctx.deviceId !== null && row.deviceId === ctx.deviceId;
    case "cell_profile":
      return ctx.consumer === "bots";
  }
}

/** Whether the account may serve this consumer now: `servesConsumer` and not cooling (D-06). */
export function usableFor(row: PoolAccountRow, ctx: UsableContext): boolean {
  return servesConsumer(row, ctx) && !isCooling(cooldownOf(row), ctx.now);
}

export interface SelectAccountInput {
  provider: PoolProvider;
  deviceId: string | null;
  consumer: PoolConsumer;
  now: Date;
  /** Accounts that may not be chosen (the one being replaced). */
  exclude?: readonly string[];
}

export type SelectAccountResult =
  | { row: PoolAccountRow; policy: PoolPolicy }
  | {
      none: true;
      policy: PoolPolicy;
      /** The soonest cooldown end among the accounts that would serve this consumer, or null (none cools). */
      earliestReset: Date | null;
      /** Whether the provider has any live account at all (an empty pool keeps today's device-login path). */
      poolEmpty: boolean;
    };

const toPolicy = (row: typeof accountPoolPolicies.$inferSelect): PoolPolicy => ({
  provider: row.provider,
  strategy: row.strategy,
  scope: row.scope,
  fallbackToDeviceLogin: row.fallbackToDeviceLogin,
  updatedAt: new Date(row.updatedAt).toISOString(),
});

/**
 * The provider's policy row, created with the defaults when missing, LOCKED `FOR UPDATE` (PD-07): two starts of one
 * organization pick one after the other, the second seeing the first one's `last_used_at` and `wrr_current`.
 */
async function lockPolicy(tx: Tx, provider: PoolProvider): Promise<PoolPolicy> {
  await tx
    .insert(accountPoolPolicies)
    .values({ organizationId: tenantOf(tx).organizationId, provider })
    .onConflictDoNothing();
  const [row] = await tx
    .select()
    .from(accountPoolPolicies)
    .where(eq(accountPoolPolicies.provider, provider))
    .for("update");
  if (!row) throw new Error("pool policy row missing after upsert");
  return toPolicy(row);
}

const candidateOf = (row: PoolAccountRow): PoolCandidate => ({
  id: row.id,
  priority: row.priority,
  weight: row.weight,
  lastUsedAt: row.lastUsedAt === null ? null : new Date(row.lastUsedAt).getTime(),
  wrrCurrent: row.wrrCurrent,
  createdAt: new Date(row.createdAt).getTime(),
});

/**
 * Chooses the account a consumer starts on (or must change to): locks the policy, filters the live rows with
 * `usableFor`, picks with the strategy, and writes `last_used_at` (every strategy) and each candidate's `wrr_current`
 * (weighted) in the same transaction (PD-07).
 */
export async function selectAccount(tx: Tx, input: SelectAccountInput): Promise<SelectAccountResult> {
  const policy = await lockPolicy(tx, input.provider);
  const live = await listPoolAccounts(tx, input.provider);
  const ctx = { deviceId: input.deviceId, consumer: input.consumer, scope: policy.scope, now: input.now };
  const exclude = new Set(input.exclude ?? []);
  const candidates = live.filter((r) => !exclude.has(r.id) && usableFor(r, ctx));
  const pick = pickAccount(policy.strategy, candidates.map(candidateOf));
  if (!pick) {
    return {
      none: true,
      policy,
      earliestReset: earliestReset(
        live.filter((r) => servesConsumer(r, ctx)).map((r) => ({ cooldownUntil: cooldownOf(r) })),
        input.now,
      ),
      poolEmpty: live.length === 0,
    };
  }
  if (policy.strategy === "weighted") {
    for (const c of candidates) {
      const next = pick.wrr.get(c.id);
      if (next !== undefined && next !== c.wrrCurrent) {
        await tx
          .update(accountPoolAccounts)
          .set({ wrrCurrent: next })
          .where(eq(accountPoolAccounts.id, c.id));
      }
    }
  }
  const [row] = await tx
    .update(accountPoolAccounts)
    .set({ lastUsedAt: input.now.toISOString() })
    .where(and(eq(accountPoolAccounts.id, pick.id), isNull(accountPoolAccounts.removedAt)))
    .returning();
  if (!row) throw new Error("selected pool account vanished");
  return { row, policy };
}

/** One live or removed account of the organization, by id (RLS: never another organization's). */
export async function getPoolAccount(tx: Tx, id: string): Promise<PoolAccountRow | null> {
  const [row] = await tx.select().from(accountPoolAccounts).where(eq(accountPoolAccounts.id, id)).limit(1);
  return row ?? null;
}

/** The account as a stored command names it (PD-02): never the token. */
export type StoredSessionAccount =
  | { kind: "token"; accountId: string; label: string }
  | { kind: "device_slot"; accountId: string; label: string; slotId: string };

/** The stored form of an account for a `session.start` or `prompt` payload, or null for a kind sessions never use. */
export function storedSessionAccount(row: PoolAccountRow): StoredSessionAccount | null {
  if (row.kind === "token") return { kind: "token", accountId: row.id, label: row.label };
  if (row.kind === "device_slot" && row.slotId !== null) {
    return { kind: "device_slot", accountId: row.id, label: row.label, slotId: row.slotId };
  }
  return null;
}

/** PD-16: why a start (or a turn) has no account. The web formats the time; the API sends the ISO instant. */
export function noAccountSentence(resetsAt: Date | null): string {
  return resetsAt
    ? `No account in the pool is ready. The earliest resets at ${resetsAt.toISOString()}.`
    : "No account in the pool is ready. Add one in Settings › Account pool.";
}

/** What the Work Zone needs from the pool (a port, so services built without the module pass null). */
export interface AccountPoolPort {
  select(tx: Tx, input: SelectAccountInput): Promise<SelectAccountResult>;
  get(tx: Tx, id: string): Promise<PoolAccountRow | null>;
  /** The token of a token account, or null (removed, no secret, a seal that does not open). Server-side only. */
  open(tx: Tx, row: PoolAccountRow): Promise<string | null>;
  policy(tx: Tx, provider: PoolProvider): Promise<PoolPolicy>;
}

export function createAccountPoolPort(core: Pick<Core, "secrets">): AccountPoolPort {
  return {
    select: selectAccount,
    get: getPoolAccount,
    open: (tx, row) => openPoolToken(tx, core.secrets, row),
    policy: loadPoolPolicy,
  };
}
