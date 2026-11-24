import type { AccountUsageSnapshot, PoolLimitReason, PoolProvider } from "@ocw/contracts";
import { accountPoolAccounts, type Tx, workSessions } from "@ocw/db";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { AuditService } from "../audit";
import { cooldownUntil, earliestReset, isCooling } from "./select";
import { type PoolConsumer, servesConsumer } from "./selection";
import { listPoolAccounts, loadPoolPolicy, type PoolAccountRow } from "./store";

/**
 * What a runtime reports about a pool account (Phase 07.18, D-07, D-08, D-09, PD-08, PD-09, PD-20): a limit cools the
 * account until its reset, a failed sign-in marks it `needs_sign_in`, a usage reading is stored with its time. Every
 * function runs in the caller's tenant transaction (RLS: never another organization's account). Audit rows carry ids,
 * labels, reasons and times only, never a token.
 */

export interface LimitInput {
  account: PoolAccountRow;
  reason: PoolLimitReason;
  /** The reset the runtime reported, or null (unknown: 5 minutes, PD-08). */
  resetsAt: Date | null;
  now: Date;
  /** The device whose runtime reported it (audited). */
  deviceId: string;
  /** The session it happened in (audited), or null. */
  sessionId: string | null;
}

export interface LimitResult {
  /** The account's cooldown end after this report (null for `markNeedsSignIn`). */
  until: Date | null;
  /** Whether this report changed the account (false for a replay: nothing written, nothing audited). */
  changed: boolean;
}

const cooldownOf = (row: Pick<PoolAccountRow, "cooldownUntil">) =>
  row.cooldownUntil === null ? null : new Date(row.cooldownUntil);

/**
 * The account reached its limit (D-08, PD-08): it cools until `cooldownUntil(resetsAt, now)` (5 minutes without a
 * reset, at most 7 days), or keeps a later cooldown it already has. A report that would not move a cooling account's
 * end (a replay, or one without a reset while it already cools) writes and audits nothing. Audited
 * `account_pool.limited` with the device and session.
 */
export async function markLimited(tx: Tx, audit: AuditService, input: LimitInput): Promise<LimitResult> {
  const { account, now } = input;
  const current = cooldownOf(account);
  const cooling = isCooling(current, now);
  const proposed = cooldownUntil(input.resetsAt, now);
  if (cooling && (input.resetsAt === null || proposed.getTime() <= current!.getTime())) {
    return { until: current, changed: false };
  }
  const until = cooling && current!.getTime() > proposed.getTime() ? current! : proposed;
  const [row] = await tx
    .update(accountPoolAccounts)
    .set({ cooldownUntil: until.toISOString(), limitReason: input.reason, updatedAt: sql`now()` })
    .where(and(eq(accountPoolAccounts.id, account.id), isNull(accountPoolAccounts.removedAt)))
    .returning({ id: accountPoolAccounts.id });
  if (!row) return { until: current, changed: false };
  account.cooldownUntil = until.toISOString();
  account.limitReason = input.reason;
  await audit.record(tx, {
    action: "account_pool.limited",
    resourceType: "account_pool_account",
    resourceId: account.id,
    actorKind: "device",
    actorId: input.deviceId,
    deviceId: input.deviceId,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    metadata: {
      provider: account.provider,
      kind: account.kind,
      accountId: account.id,
      label: account.label,
      reason: input.reason,
      resetsAt: input.resetsAt?.toISOString() ?? null,
      cooldownUntil: until.toISOString(),
    },
  });
  return { until, changed: true };
}

/**
 * The account's credential was refused (`auth_failed`, D-07, PD-24): it needs a new sign-in (a new token, or a slot
 * signed in again) and is never chosen until then. No cooldown. Audited `account_pool.limited` with reason
 * `auth_failed`; an account already marked writes and audits nothing.
 */
export async function markNeedsSignIn(
  tx: Tx,
  audit: AuditService,
  input: Omit<LimitInput, "reason" | "resetsAt">,
): Promise<LimitResult> {
  const { account } = input;
  if (account.credentialState === "needs_sign_in") return { until: null, changed: false };
  const [row] = await tx
    .update(accountPoolAccounts)
    .set({ credentialState: "needs_sign_in", updatedAt: sql`now()` })
    .where(and(eq(accountPoolAccounts.id, account.id), isNull(accountPoolAccounts.removedAt)))
    .returning({ id: accountPoolAccounts.id });
  if (!row) return { until: null, changed: false };
  account.credentialState = "needs_sign_in";
  await audit.record(tx, {
    action: "account_pool.limited",
    resourceType: "account_pool_account",
    resourceId: account.id,
    actorKind: "device",
    actorId: input.deviceId,
    deviceId: input.deviceId,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    metadata: {
      provider: account.provider,
      kind: account.kind,
      accountId: account.id,
      label: account.label,
      reason: "auth_failed",
      resetsAt: null,
      cooldownUntil: null,
    },
  });
  return { until: null, changed: true };
}

/**
 * The soonest cooldown end among the live accounts that would serve this consumer (cooling aside), or null. Reads
 * only: no lock, no rotation state written (for a refusal sentence, never for a choice).
 */
export async function earliestPoolReset(
  tx: Tx,
  input: { provider: PoolProvider; deviceId: string | null; consumer: PoolConsumer; now: Date },
): Promise<Date | null> {
  const { scope } = await loadPoolPolicy(tx, input.provider);
  const rows = await listPoolAccounts(tx, input.provider);
  const ctx = { deviceId: input.deviceId, consumer: input.consumer, scope };
  return earliestReset(
    rows.filter((r) => servesConsumer(r, ctx)).map((r) => ({ cooldownUntil: cooldownOf(r) })),
    input.now,
  );
}

/** PD-15: the turn reached its last switch. The web formats the time; the API sends the ISO instant. */
export function everyAccountLimitedSentence(resetsAt: Date | null): string {
  const first = "Every pool account reached its limit for this turn.";
  return resetsAt ? `${first} The earliest resets at ${resetsAt.toISOString()}.` : first;
}

/**
 * The session states in which a device is running (or attaching) a session: the work-session module's `ACTIVE_STATES`,
 * repeated here because this module never imports the work-session module (which imports it).
 */
const LIVE_SESSION_STATES = ["provisioning", "idle", "running", "waiting_approval", "host_offline"] as const;

export interface RecordUsageInput {
  /** The device that sent the reading (from its link, never from the frame). */
  deviceId: string;
  /** A pool account (a token): only one a live session of this device uses. */
  accountId?: string | undefined;
  /** A Codex slot: only a live slot row of this very device. */
  slotId?: string | undefined;
  usage: AccountUsageSnapshot;
  now: Date;
}

/**
 * A usage reading the runtime reported (D-09, PD-09): stored as the account's last snapshot with the server's time.
 * A device may report only for an account one of its own live sessions uses, or for a slot of its own (E11); anything
 * else (another device's session or slot, an account no session uses, another organization's: RLS) stores nothing.
 * Returns whether it was stored. Never polled, never audited (usage numbers only).
 */
export async function recordUsage(tx: Tx, input: RecordUsageInput): Promise<boolean> {
  let accountId: string | null = null;
  if (input.accountId !== undefined) {
    const [used] = await tx
      .select({ id: workSessions.poolAccountId })
      .from(workSessions)
      .where(
        and(
          eq(workSessions.deviceId, input.deviceId),
          eq(workSessions.poolAccountId, input.accountId),
          inArray(workSessions.status, [...LIVE_SESSION_STATES]),
        ),
      )
      .limit(1);
    accountId = used?.id ?? null;
  } else if (input.slotId !== undefined) {
    const [slot] = await tx
      .select({ id: accountPoolAccounts.id })
      .from(accountPoolAccounts)
      .where(
        and(
          eq(accountPoolAccounts.kind, "device_slot"),
          eq(accountPoolAccounts.deviceId, input.deviceId),
          eq(accountPoolAccounts.slotId, input.slotId),
          isNull(accountPoolAccounts.removedAt),
        ),
      )
      .limit(1);
    accountId = slot?.id ?? null;
  }
  if (accountId === null) return false;
  const [row] = await tx
    .update(accountPoolAccounts)
    .set({ usage: input.usage, usageAt: input.now.toISOString() })
    .where(and(eq(accountPoolAccounts.id, accountId), isNull(accountPoolAccounts.removedAt)))
    .returning({ id: accountPoolAccounts.id });
  return row !== undefined;
}
