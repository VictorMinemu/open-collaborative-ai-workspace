import { AI_STALE_AFTER_MS } from "@ocw/contracts";
import type { Core } from "../../core";
import { createModelGateway, type ModelGateway } from "../model-gateway";
import { startNextAlone } from "./queue";
import type { RunLoop } from "./run-loop";

export const GENERATION_SWEEP_INTERVAL_MS = 15_000;
const SWEEP_BATCH = 100;
/** Any constant shared by every API process; only one of them sweeps at a time (attachments use 0x0c3a_0404). */
const SWEEP_LOCK_KEY = 0x0c3a_0506;

export interface GenerationSweeper {
  /** One pass; returns how many generations were finalized (0 when another process holds the lock). */
  runOnce(): Promise<number>;
  start(): void;
  stop(): void;
}

/**
 * D-05, P-07: no answer stays `running` after its process died. A running generation whose heartbeat is older than
 * `AI_STALE_AFTER_MS` (the run loop beats every 10 s) is finalized `interrupted`: its last flushed `partial_text`
 * becomes the message body, the message is `completed`, an estimated usage record is written and
 * `message.updated` / `ai_chat.updated` are appended. Candidates come from the SECURITY DEFINER
 * `app.stale_ai_generations` (ids only); every change happens in that row's organization `withTenant` transaction,
 * re-checked under `for update` (T-05-06-05). A generation this process still streams is never swept.
 *
 * Shared chats (06-06, P-08): in the same pass, under the same lock, a queue with nothing running (a crash between a
 * finalize and the next start, or a first author who was at the concurrency cap) is started by `startNext` in its
 * organization's `withTenant` transaction; candidates come from the ids-only `app.pending_ai_queues`.
 */
export function createGenerationSweeper(
  core: Core,
  deps: { runLoop: RunLoop; gateway?: ModelGateway; now?: () => Date; intervalMs?: number },
): GenerationSweeper {
  const now = deps.now ?? (() => new Date());
  const queue = { core, runLoop: deps.runLoop, gateway: deps.gateway ?? createModelGateway(core) };
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
        const before = new Date(now().getTime() - AI_STALE_AFTER_MS);
        const stale = await client.query<{ id: string; organization_id: string }>(
          "select id, organization_id from app.stale_ai_generations($1, $2)",
          [SWEEP_BATCH, before.toISOString()],
        );
        let finalized = 0;
        for (const row of stale.rows) {
          // Still streaming here (e.g. a long event-loop stall): the run loop finalizes it itself.
          if (deps.runLoop.textOf(row.id) !== null) continue;
          try {
            if (await deps.runLoop.finalizeStale(row.organization_id, row.id, before)) finalized++;
          } catch (err) {
            core.log.warn(
              { generationId: row.id, err: { name: (err as Error)?.name } },
              "ai generation sweep failed",
            );
          }
        }
        if (finalized > 0) core.log.info({ finalized }, "interrupted stale ai generations");
        const idle = await client.query<{ organization_id: string; conversation_id: string }>(
          "select organization_id, conversation_id from app.pending_ai_queues($1)",
          [SWEEP_BATCH],
        );
        let started = 0;
        for (const row of idle.rows) {
          try {
            if (await startNextAlone(queue, row.organization_id, row.conversation_id)) started++;
          } catch (err) {
            core.log.warn({ err: { name: (err as Error)?.name } }, "ai queue sweep failed");
          }
        }
        if (started > 0) core.log.info({ started }, "started idle ai chat queues");
        return finalized;
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
          core.log.warn({ err: { name: err?.name } }, "ai generation sweeper pass failed"),
        );
      }, deps.intervalMs ?? GENERATION_SWEEP_INTERVAL_MS);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
