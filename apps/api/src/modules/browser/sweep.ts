import type { Core } from "../../core";
import type { SandboxdClient } from "../sandbox";
import { PURGE_AFTER_MS, purgeExpired } from "./sessions";
import { expireSignIns } from "./signin";
import { announce } from "./takeover";

/**
 * The browser sweep (07.8-21; D-08, R7, R9): every 30 s, sign-in cards that waited 15 minutes expire (their pages are
 * released from the hold, in sandboxd too) and sessions expired for 7 days are purged with their secrets. The
 * organizations with work come from the SECURITY DEFINER `app.browser_sweep_organizations` (ids only); every change
 * happens in that organization's own user-less `withTenant` transaction. One API process sweeps at a time.
 */

export const BROWSER_SWEEP_MS = 30_000;
const PAGE = 200;
/** Any constant shared by every API process; only one of them sweeps at a time. */
const SWEEP_LOCK_KEY = 0x0c3a_0821;

export interface BrowserSweeper {
  /** One pass at `nowMs` (tests pass a clock); how many sign-ins expired and sessions were purged. */
  runOnce(nowMs?: number): Promise<{ expired: number; purged: number }>;
  start(): void;
  stop(): void;
}

export function createBrowserSweeper(core: Core, client: SandboxdClient | null): BrowserSweeper {
  let timer: NodeJS.Timeout | null = null;
  let running: Promise<{ expired: number; purged: number }> | null = null;

  async function organizations(nowMs: number): Promise<string[]> {
    const out: string[] = [];
    let after: string | null = null;
    for (;;) {
      const rows: Array<{ organization_id: string }> = (
        await core.db.pool.query<{ organization_id: string }>(
          "select organization_id from app.browser_sweep_organizations($1, $2, $3, $4)",
          [new Date(nowMs).toISOString(), new Date(nowMs - PURGE_AFTER_MS).toISOString(), after, PAGE],
        )
      ).rows;
      out.push(...rows.map((r) => r.organization_id));
      if (rows.length < PAGE) return out;
      after = rows.at(-1)?.organization_id ?? null;
    }
  }

  async function sweep(nowMs: number) {
    const lock = await core.db.pool.connect();
    let expired = 0;
    let purged = 0;
    try {
      const got = await lock.query<{ ok: boolean }>("select pg_try_advisory_lock($1) as ok", [
        SWEEP_LOCK_KEY,
      ]);
      if (!got.rows[0]?.ok) return { expired, purged };
      try {
        for (const organizationId of await organizations(nowMs)) {
          try {
            const result = await core.db.withTenant({ organizationId, userId: null }, async (tx) => ({
              released: await expireSignIns(tx, core, nowMs),
              purged: await purgeExpired(tx, core, nowMs),
            }));
            expired += result.released.length;
            purged += result.purged;
            for (const page of result.released) {
              await client
                ?.call(
                  "contextHold",
                  {
                    target: { orgId: organizationId, agentId: page.agentId },
                    contextId: page.contextId,
                    hold: false,
                    reason: null,
                  },
                  { timeoutMs: 15_000 },
                )
                .catch(() => {});
              await announce(core.bus, organizationId, page.contextId);
            }
          } catch (err) {
            core.log.warn(
              { organizationId, error: (err as Error | undefined)?.name },
              "browser sweep failed",
            );
          }
        }
      } finally {
        await lock.query("select pg_advisory_unlock($1)", [SWEEP_LOCK_KEY]);
      }
    } finally {
      lock.release();
    }
    return { expired, purged };
  }

  function runOnce(nowMs = Date.now()) {
    running ??= sweep(nowMs).finally(() => {
      running = null;
    });
    return running;
  }

  return {
    runOnce,
    start() {
      if (timer) return;
      timer = setInterval(() => {
        runOnce().catch((err: Error) => core.log.warn({ error: err?.name }, "browser sweep pass failed"));
      }, BROWSER_SWEEP_MS);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
