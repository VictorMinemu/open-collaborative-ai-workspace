import { WORK_BROWSER_AUDIT } from "@ocw/contracts";
import { type Tx, workBrowsers, workSessions } from "@ocw/db";
import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type { Core } from "../../core";
import { BROWSER_SWEEP_MS } from "../browser";
import type { DeviceHub } from "../device";

/**
 * The Work Zone browser sweep (Phase 07.13; D-23, D-28; the bots' `browser/sweep.ts` shape): every `BROWSER_SWEEP_MS`,
 * members' Work Zone sign-ins whose expiry passed are deleted with their secrets through the SECURITY DEFINER
 * `app.purge_work_browser_signins` (the caller's organization only: no user-less session crosses the owner-only policy
 * otherwise) and each is audited `work_browser.signin_revoked { site, reason: expired }`. A page that still had one
 * loaded is closed on its device (`browser.close { reason: revoked }`) and its loaded fields are cleared, as a revoke
 * does. The organizations with work come from `app.work_browser_sweep_organizations` (ids only); every change happens
 * in that organization's own user-less `withTenant` transaction. One API process sweeps at a time (advisory lock).
 * 07.13-18 adds the lapsed-lease step here.
 */

const PAGE = 200;
/** Any constant shared by every API process (distinct from the bots' sweep); only one of them sweeps at a time. */
const SWEEP_LOCK_KEY = 0x0c3a_1317;

export interface WorkBrowserSweeper {
  /** One pass at `nowMs` (tests pass a clock); how many sign-ins expired. */
  runOnce(nowMs?: number): Promise<{ expired: number }>;
  start(): void;
  stop(): void;
}

/** A session page that had a sign-in loaded which is gone now: its device closes the page. */
export interface ClosedPage {
  sessionId: string;
  deviceId: string;
}

/**
 * The pages among `sessionIds` whose loaded sign-in was deleted (`signin_id` set null by the FK) lose the member too;
 * returns them with their session's device. Runs without a user (the page row is the session's, not the member's).
 */
export async function unlinkGonePages(tx: Tx, sessionIds: string[]): Promise<ClosedPage[]> {
  if (sessionIds.length === 0) return [];
  const rows = await tx
    .update(workBrowsers)
    .set({ signinUserId: null, updatedAt: sql`now()` })
    .where(
      and(
        inArray(workBrowsers.workSessionId, sessionIds),
        isNull(workBrowsers.signinId),
        isNotNull(workBrowsers.signinUserId),
      ),
    )
    .returning({ sessionId: workBrowsers.workSessionId });
  if (rows.length === 0) return [];
  const devices = await tx
    .select({ sessionId: workSessions.id, deviceId: workSessions.deviceId })
    .from(workSessions)
    .where(
      inArray(
        workSessions.id,
        rows.map((r) => r.sessionId),
      ),
    );
  return devices.flatMap((r) => (r.deviceId ? [{ sessionId: r.sessionId, deviceId: r.deviceId }] : []));
}

/** The pages that have a sign-in loaded now (user-less read; candidates for `unlinkGonePages`). */
export async function loadedPages(tx: Tx, signinId?: string): Promise<string[]> {
  const rows = await tx
    .select({ sessionId: workBrowsers.workSessionId })
    .from(workBrowsers)
    .where(signinId ? eq(workBrowsers.signinId, signinId) : isNotNull(workBrowsers.signinId));
  return rows.map((r) => r.sessionId);
}

/** Ends the pages a removed sign-in was loaded in (ephemeral frames; an offline device simply misses it). */
export async function closePages(
  hub: Pick<DeviceHub, "sendBrowserFrame">,
  pages: ClosedPage[],
): Promise<void> {
  for (const page of pages) {
    await hub
      .sendBrowserFrame(page.deviceId, {
        type: "browser.close",
        sessionId: page.sessionId,
        reason: "revoked",
      })
      .catch(() => {});
  }
}

export function createWorkBrowserSweeper(
  core: Core,
  hub: Pick<DeviceHub, "sendBrowserFrame">,
): WorkBrowserSweeper {
  let timer: NodeJS.Timeout | null = null;
  let running: Promise<{ expired: number }> | null = null;

  async function organizations(nowMs: number): Promise<string[]> {
    const out: string[] = [];
    let after: string | null = null;
    const at = new Date(nowMs).toISOString();
    for (;;) {
      const rows: Array<{ organization_id: string }> = (
        await core.db.pool.query<{ organization_id: string }>(
          "select organization_id from app.work_browser_sweep_organizations($1, $2, $3, $4)",
          [at, at, after, PAGE],
        )
      ).rows;
      out.push(...rows.map((r) => r.organization_id));
      if (rows.length < PAGE) return out;
      after = rows.at(-1)?.organization_id ?? null;
    }
  }

  /** One organization's expired sign-ins, in its own user-less transaction. */
  async function purgeOrganization(organizationId: string, nowMs: number) {
    return core.db.withTenant({ organizationId, userId: null }, async (tx) => {
      const loaded = await loadedPages(tx);
      const rows = (
        await tx.execute<{ id: string; user_id: string; site_key: string }>(
          sql`select id, user_id, site_key from app.purge_work_browser_signins(${new Date(nowMs).toISOString()}::timestamptz)`,
        )
      ).rows;
      for (const r of rows) {
        await core.audit.record(tx, {
          action: WORK_BROWSER_AUDIT.signin_revoked,
          actorKind: "system",
          userId: r.user_id,
          resourceType: "work_browser_signin",
          resourceId: r.id,
          metadata: { site: r.site_key, reason: "expired" },
        });
      }
      const closed = rows.length > 0 ? await unlinkGonePages(tx, loaded) : [];
      return { expired: rows.length, closed };
    });
  }

  async function sweep(nowMs: number) {
    const lock = await core.db.pool.connect();
    let expired = 0;
    try {
      const got = await lock.query<{ ok: boolean }>("select pg_try_advisory_lock($1) as ok", [
        SWEEP_LOCK_KEY,
      ]);
      if (!got.rows[0]?.ok) return { expired };
      try {
        for (const organizationId of await organizations(nowMs)) {
          try {
            const result = await purgeOrganization(organizationId, nowMs);
            expired += result.expired;
            await closePages(hub, result.closed);
          } catch (err) {
            core.log.warn(
              { organizationId, error: (err as Error | undefined)?.name },
              "work browser sweep failed",
            );
          }
        }
      } finally {
        await lock.query("select pg_advisory_unlock($1)", [SWEEP_LOCK_KEY]);
      }
    } finally {
      lock.release();
    }
    return { expired };
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
        runOnce().catch((err: Error) =>
          core.log.warn({ error: err?.name }, "work browser sweep pass failed"),
        );
      }, BROWSER_SWEEP_MS);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
