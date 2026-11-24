import type { AccountsSyncFrame, CodexSlotReport } from "@ocw/contracts";
import { accountPoolAccounts, type Tx } from "@ocw/db";
import { and, eq, isNull } from "drizzle-orm";
import { HttpError } from "../../lib/errors";
import type { AuditService } from "../audit";
import { insertPoolAccount, type PoolAccountRow } from "./store";

/**
 * The Codex slots a device reports (Phase 07.18, D-02, D-09, PD-10, PD-11, E11, E13). `accounts.sync` is the device's
 * whole list (latest wins), matched by (device, slot id) among the live `device_slot` rows of the reporting device
 * only (the device comes from its link, never from the frame; the organization from the tenant: RLS).
 */

export interface SlotsSyncOptions {
  /**
   * Slots of a device sign-in still running (starting or pending): never created from the sync, the sign-in creates
   * its own row (enabled, origin admin) when it completes.
   */
  signingIn?: ReadonlySet<string>;
  now?: Date;
}

export interface SlotsSyncResult {
  created: string[];
  updated: string[];
  removed: string[];
}

/**
 * Applies a device's `accounts.sync` to its slot rows (E11: only the reporting device's live rows are ever read or
 * written, so a sync naming another device's slot ids only creates the reporting device's own rows; another
 * organization's rows are not there, RLS). Writes and audits only what really changed, so the same sync twice writes
 * nothing.
 *   - A reported slot with a row: credential state, plan and usage follow the report (`updateSlot`).
 *   - A reported slot without a row, signed in and not the slot of a running sign-in: a new `device_slot` account,
 *     `enabled = false`, `origin: device_cli`, audited `account_pool.slot_reported` (PD-11, E13): only an admin makes
 *     it usable. A slot that is not signed in is not an account yet (a sign-in still running, or a failed one the
 *     device removes). The device's `origin` field is never trusted: the API knows which slots it started.
 *   - A live row whose slot is no longer reported: removed (`removed_at`), audited `account_pool.account_removed` with
 *     reason `device_reported`; a session on it moves at its next dispatch (PD-06).
 */
export async function applySlotsSync(
  tx: Tx,
  audit: AuditService,
  device: { deviceId: string },
  frame: AccountsSyncFrame,
  opts: SlotsSyncOptions = {},
): Promise<SlotsSyncResult> {
  const now = opts.now ?? new Date();
  const signingIn = opts.signingIn ?? new Set<string>();
  const rows = await tx
    .select()
    .from(accountPoolAccounts)
    .where(
      and(
        eq(accountPoolAccounts.kind, "device_slot"),
        eq(accountPoolAccounts.deviceId, device.deviceId),
        isNull(accountPoolAccounts.removedAt),
      ),
    )
    .for("update");
  const bySlot = new Map(rows.map((r) => [r.slotId, r]));
  const reported = new Map(frame.codexSlots.map((r) => [r.slotId, r]));
  const result: SlotsSyncResult = { created: [], updated: [], removed: [] };

  for (const report of reported.values()) {
    const row = bySlot.get(report.slotId);
    if (row) {
      if (await updateSlot(tx, audit, row, report, now)) result.updated.push(row.id);
      continue;
    }
    if (!report.signedIn || signingIn.has(report.slotId)) continue;
    const created = await reportSlot(tx, audit, device.deviceId, report, now);
    if (created) result.created.push(created);
  }

  for (const row of rows) {
    if (row.slotId !== null && reported.has(row.slotId)) continue;
    const at = now.toISOString();
    await tx
      .update(accountPoolAccounts)
      .set({ removedAt: at, updatedAt: at })
      .where(and(eq(accountPoolAccounts.id, row.id), isNull(accountPoolAccounts.removedAt)));
    await audit.record(tx, {
      action: "account_pool.account_removed",
      resourceType: "account_pool_account",
      resourceId: row.id,
      deviceId: device.deviceId,
      metadata: {
        provider: row.provider,
        kind: row.kind,
        origin: row.origin,
        label: row.label,
        reason: "device_reported",
      },
    });
    result.removed.push(row.id);
  }
  return result;
}

/** A signed-in slot no admin started: a disabled pool account of this device (PD-11). Null when the pool is full. */
async function reportSlot(
  tx: Tx,
  audit: AuditService,
  deviceId: string,
  report: CodexSlotReport,
  now: Date,
): Promise<string | null> {
  let row: PoolAccountRow;
  try {
    row = await insertPoolAccount(tx, audit, {
      provider: "chatgpt",
      kind: "device_slot",
      label: report.label,
      origin: "device_cli",
      enabled: false,
      deviceId,
      slotId: report.slotId,
      planType: report.planType,
    });
  } catch (err) {
    // A full pool: the slot is reported again by the next sync, once an admin made room.
    if (err instanceof HttpError && err.code === "too_many_accounts") return null;
    throw err;
  }
  if (report.usage !== null) {
    await tx
      .update(accountPoolAccounts)
      .set({ usage: report.usage, usageAt: now.toISOString() })
      .where(eq(accountPoolAccounts.id, row.id));
  }
  await audit.record(tx, {
    action: "account_pool.slot_reported",
    resourceType: "account_pool_account",
    resourceId: row.id,
    deviceId,
    metadata: {
      provider: "chatgpt",
      deviceId,
      slotId: report.slotId,
      label: report.label,
      origin: "device_cli",
      planType: report.planType,
    },
  });
  return row.id;
}

/**
 * Credential state, plan and usage as reported; the label is never replaced by the device's (an admin's, or the
 * admin's rename of a reported one). A credential or plan change is audited `account_pool.account_updated`
 * (`source: device`); a usage reading alone is not (D-09: numbers only, never audited).
 */
async function updateSlot(
  tx: Tx,
  audit: AuditService,
  row: PoolAccountRow,
  report: CodexSlotReport,
  now: Date,
): Promise<boolean> {
  const patch: Partial<typeof accountPoolAccounts.$inferInsert> = {};
  const changed: string[] = [];
  const credentialState = report.signedIn ? "ok" : "needs_sign_in";
  if (credentialState !== row.credentialState) {
    patch.credentialState = credentialState;
    changed.push("credentialState");
  }
  if (report.planType !== null && report.planType !== row.planType) {
    patch.planType = report.planType;
    changed.push("planType");
  }
  if (report.usage !== null && stable(report.usage) !== stable(row.usage)) {
    patch.usage = report.usage;
    patch.usageAt = now.toISOString();
  }
  if (Object.keys(patch).length === 0) return false;
  await tx
    .update(accountPoolAccounts)
    .set({ ...patch, updatedAt: now.toISOString() })
    .where(eq(accountPoolAccounts.id, row.id));
  if (changed.length > 0) {
    await audit.record(tx, {
      action: "account_pool.account_updated",
      resourceType: "account_pool_account",
      resourceId: row.id,
      deviceId: row.deviceId,
      metadata: {
        provider: row.provider,
        kind: row.kind,
        label: row.label,
        changed,
        source: "device",
        ...(patch.credentialState ? { credentialState: patch.credentialState } : {}),
        ...(patch.planType ? { planType: patch.planType } : {}),
      },
    });
  }
  return true;
}

/** JSON with sorted keys (jsonb reorders keys), so an unchanged snapshot compares equal. */
function stable(v: unknown): string {
  return JSON.stringify(v, (_k, value: unknown) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(
          Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)),
        )
      : value,
  );
}
