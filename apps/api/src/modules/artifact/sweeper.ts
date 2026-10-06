import { attachments } from "@ocw/db";
import { and, eq, isNull } from "drizzle-orm";
import type { Core } from "../../core";
import { ATTACHMENT_PARTS, attachmentKey, type ObjectStorage } from "./storage";

export const SWEEP_INTERVAL_MS = 10 * 60_000;
const SWEEP_BATCH = 200;
/** Any constant shared by every API process; only one of them sweeps at a time. */
const SWEEP_LOCK_KEY = 0x0c3a_0404;

export interface AttachmentSweeper {
  /** One pass; returns how many attachments were purged (0 when another process holds the lock). */
  runOnce(): Promise<number>;
  start(): void;
  stop(): void;
}

/**
 * Deletes the stored objects of abandoned uploads (pending or rejected for 24 h) and of attachments whose message
 * was deleted 30 days ago, then sets `purged_at`. Candidates come from the SECURITY DEFINER
 * `app.due_attachment_sweeps` (ids only, like the other pre-tenant lookups); every change happens in its own
 * organization's `withTenant` transaction, where the row is re-checked under RLS.
 */
export function createAttachmentSweeper(
  core: Core,
  storage: ObjectStorage,
  opts: { now?: () => Date; intervalMs?: number } = {},
): AttachmentSweeper {
  const now = opts.now ?? (() => new Date());
  let timer: NodeJS.Timeout | null = null;
  let running: Promise<number> | null = null;

  async function sweep(): Promise<number> {
    const client = await core.db.pool.connect();
    try {
      const lock = await client.query<{ ok: boolean }>("select pg_try_advisory_lock($1) as ok", [
        SWEEP_LOCK_KEY,
      ]);
      if (!lock.rows[0]?.ok) return 0;
      try {
        const at = now();
        const due = await client.query<{ id: string; organization_id: string; conversation_id: string }>(
          "select id, organization_id, conversation_id from app.due_attachment_sweeps($1, $2)",
          [SWEEP_BATCH, at.toISOString()],
        );
        let purged = 0;
        for (const row of due.rows) {
          try {
            const done = await core.db.withTenant({ organizationId: row.organization_id }, async (tx) => {
              const [locked] = await tx
                .select({ id: attachments.id })
                .from(attachments)
                .where(and(eq(attachments.id, row.id), isNull(attachments.purgedAt)))
                .for("update");
              if (!locked) return false;
              await storage.remove(
                ATTACHMENT_PARTS.map((p) =>
                  attachmentKey(row.organization_id, row.conversation_id, row.id, p),
                ),
              );
              await tx
                .update(attachments)
                .set({ purgedAt: at.toISOString() })
                .where(eq(attachments.id, row.id));
              return true;
            });
            if (done) purged++;
          } catch (err) {
            core.log.warn(
              { attachmentId: row.id, err: { name: (err as Error)?.name } },
              "attachment sweep failed",
            );
          }
        }
        return purged;
      } finally {
        await client.query("select pg_advisory_unlock($1)", [SWEEP_LOCK_KEY]);
      }
    } finally {
      client.release();
    }
  }

  function runOnce(): Promise<number> {
    running ??= sweep().finally(() => {
      running = null;
    });
    return running;
  }

  return {
    runOnce,
    start() {
      if (timer) return;
      timer = setInterval(() => {
        runOnce().catch((err: Error) =>
          core.log.warn(
            { err: { name: err?.name, message: err?.message } },
            "attachment sweeper pass failed",
          ),
        );
      }, opts.intervalMs ?? SWEEP_INTERVAL_MS);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
