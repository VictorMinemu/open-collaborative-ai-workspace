import type { AccountsSyncFrame, CodexSlotReport } from "@ocw/contracts";
import { accountPoolAccounts, type Tx } from "@ocw/db";
import { and, eq, isNull } from "drizzle-orm";
import type { AuditService } from "../audit";
import type { PoolAccountRow } from "./store";

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

/** Applies a device's `accounts.sync` to its slot rows; writes and audits only what really changed. */
export async function applySlotsSync(
  tx: Tx,
  _audit: AuditService,
  device: { deviceId: string },
  frame: AccountsSyncFrame,
  opts: SlotsSyncOptions = {},
): Promise<SlotsSyncResult> {
  const now = opts.now ?? new Date();
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
  const result: SlotsSyncResult = { created: [], updated: [], removed: [] };
  for (const report of frame.codexSlots) {
    const row = bySlot.get(report.slotId);
    if (!row) continue;
    if (await updateSlot(tx, row, report, now)) result.updated.push(row.id);
  }
  return result;
}

/** Credential state, plan and usage as reported; the label is never replaced by the device's. */
async function updateSlot(tx: Tx, row: PoolAccountRow, report: CodexSlotReport, now: Date): Promise<boolean> {
  const patch: Partial<typeof accountPoolAccounts.$inferInsert> = {};
  const credentialState = report.signedIn ? "ok" : "needs_sign_in";
  if (credentialState !== row.credentialState) patch.credentialState = credentialState;
  if (report.planType !== null && report.planType !== row.planType) patch.planType = report.planType;
  if (report.usage !== null && stable(report.usage) !== stable(row.usage)) {
    patch.usage = report.usage;
    patch.usageAt = now.toISOString();
  }
  if (Object.keys(patch).length === 0) return false;
  await tx
    .update(accountPoolAccounts)
    .set({ ...patch, updatedAt: now.toISOString() })
    .where(eq(accountPoolAccounts.id, row.id));
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
