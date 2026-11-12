import { botWorkSessionFiles, type Tx } from "@ocw/db";
import { and, eq, inArray, sql } from "drizzle-orm";

/**
 * The bot file transfer ledger (`app.bot_work_session_files`, 07.17.1.1 D-05, D-06, D-08, PD-05): one row per transfer
 * the API enqueued for a bot's move of one file between a chat and its Work Zone session. The transfer id IS the device
 * command id, so the daemon names the transfer by the command it received and nothing else. The row stores the bounds
 * and the ids, never the repo-relative path or a file name (only its length, P1).
 *
 * A device may use a row only while it is `pending`, before `expires_at`, and only once: the claim moves it to
 * `streaming` under `FOR UPDATE`, so a replay finds it gone.
 */

export type TransferRow = typeof botWorkSessionFiles.$inferSelect;
export type NewTransfer = typeof botWorkSessionFiles.$inferInsert;
export type TransferDirection = TransferRow["direction"];
export type TransferStatus = TransferRow["status"];

/** Which row a device asks for: its id, the device the JWT names and the direction of the route it called. */
export interface TransferFor {
  id: string;
  deviceId: string;
  direction: TransferDirection;
}

/** Insert one ledger row in the caller's tenant transaction (the row's organization is the tenant's). */
export async function insertTransfer(tx: Tx, row: NewTransfer): Promise<TransferRow> {
  const [inserted] = await tx.insert(botWorkSessionFiles).values(row).returning();
  return inserted!;
}

async function selectFor(
  tx: Tx,
  p: TransferFor,
  lock: boolean,
): Promise<{ row: TransferRow; expired: boolean } | null> {
  const query = tx
    .select({ row: botWorkSessionFiles, expired: sql<boolean>`${botWorkSessionFiles.expiresAt} <= now()` })
    .from(botWorkSessionFiles)
    .where(eq(botWorkSessionFiles.id, p.id))
    .limit(1);
  const [found] = lock ? await query.for("update") : await query;
  return found ?? null;
}

/**
 * The rule both reads share: null when the row is absent (RLS hides another organization's), names another device or
 * the other direction (so a stranger learns nothing about the id); `"gone"` when it is no longer `pending` or its
 * deadline passed.
 */
function decide(
  found: { row: TransferRow; expired: boolean } | null,
  p: TransferFor,
): TransferRow | "gone" | null {
  if (!found) return null;
  const { row, expired } = found;
  if (row.deviceId !== p.deviceId || row.direction !== p.direction) return null;
  if (row.status !== "pending" || expired) return "gone";
  return row;
}

/** The row a device may use, without a lock (a pre-check; the claim decides). */
export async function readTransferForDevice(tx: Tx, p: TransferFor): Promise<TransferRow | "gone" | null> {
  return decide(await selectFor(tx, p, false), p);
}

/**
 * The same rule under `FOR UPDATE`, then the row moves to `streaming`: the single use of a transfer. Returns the row as
 * it was claimed (status `streaming`).
 */
export async function claimTransferForDevice(tx: Tx, p: TransferFor): Promise<TransferRow | "gone" | null> {
  const decided = decide(await selectFor(tx, p, true), p);
  if (decided === null || decided === "gone") return decided;
  const [claimed] = await tx
    .update(botWorkSessionFiles)
    .set({ status: "streaming" })
    .where(eq(botWorkSessionFiles.id, decided.id))
    .returning();
  return claimed!;
}

export type TransferPatch = Partial<
  Pick<NewTransfer, "status" | "failure" | "sizeBytes" | "sha256" | "completedAt">
>;

/**
 * Update one row. With `opts.from`, only while the row is in one of those statuses (a stream that ends after the
 * deadline sweep already failed the row never brings it back). Returns whether a row changed.
 */
export async function markTransfer(
  tx: Tx,
  id: string,
  patch: TransferPatch,
  opts: { from?: readonly TransferStatus[] } = {},
): Promise<boolean> {
  const where = opts.from
    ? and(eq(botWorkSessionFiles.id, id), inArray(botWorkSessionFiles.status, [...opts.from]))
    : eq(botWorkSessionFiles.id, id);
  const rows = await tx
    .update(botWorkSessionFiles)
    .set(patch)
    .where(where)
    .returning({ id: botWorkSessionFiles.id });
  return rows.length > 0;
}
