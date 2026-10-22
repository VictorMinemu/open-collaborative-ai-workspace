import { BROWSER_LIMITS } from "@ocw/contracts";
import { browserContexts, type Tx } from "@ocw/db";
import { and, eq, isNotNull, isNull, lte, or } from "drizzle-orm";
import type { Core } from "../../core";
import type { RedisBus } from "../../lib/redis";

/**
 * The takeover lease of a bot's browser page (07.8-16; D-07, D-11 F-5, BRW-03; P-08). One person at a time holds it,
 * recorded on the context row (`controller_user_id`, `lease_expires_at`), so every API instance and the bot's own routes
 * (`takeoverActive`, 07.8-14: the bot answers `paused` and spends no budget) agree. Who may take it is the resolver's
 * `browser.control` (decided by the live view before `take`); this file only keeps the lease consistent:
 *
 * - `take` is one conditional UPDATE: it wins only when nobody holds a live lease, so two people (or two devices of one
 *   person, on two instances) never both control a page;
 * - `keep` pushes the expiry to 10 minutes after the latest input; `release` ends it for the holder only;
 * - every change is audited with ids and the host only (`browser.takeover_started`, `browser.takeover_ended`), never
 *   what the person typed, and announced on the Redis channel `LEASE_CHANNEL` with the organization and context ids,
 *   so the other instances' live views re-read the row and re-decide their viewers at once.
 */

export const TAKEOVER_MS = BROWSER_LIMITS.takeoverMinutes * 60_000;
export const TAKEOVER_WARN_MS = BROWSER_LIMITS.takeoverWarnMinutes * 60_000;

/** Redis channel of lease and context changes: `{"o":<organizationId>,"c":<contextId>}`, ids only. */
export const LEASE_CHANNEL = "ocw:browser:lease";

/** Why a lease ended (audit metadata `reason`). */
export type LeaseEndReason =
  | "released"
  | "closed"
  | "idle"
  | "kill_switch"
  | "access_lost"
  | "context_ended"
  | "upstream_failed";

export type TakeRefusal = "someone_else" | "expired";

export interface Lease {
  contextId: string;
  host: string;
  expiresAt: string;
}

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * Takes the lease of an open page for `userId`: wins only when no live lease exists (none, or an expired one). Returns
 * the lease, or `someone_else` (a live lease is held, by another person or another device of this one) or `expired`
 * (the page is closed or not in this organization). Audited `browser.takeover_started` in the same transaction.
 */
export async function take(
  tx: Tx,
  core: Pick<Core, "audit">,
  p: { contextId: string; userId: string; nowMs?: number },
): Promise<{ lease: Lease } | { refused: TakeRefusal }> {
  const now = p.nowMs ?? Date.now();
  const [row] = await tx
    .update(browserContexts)
    .set({ controllerUserId: p.userId, leaseExpiresAt: iso(now + TAKEOVER_MS) })
    .where(
      and(
        eq(browserContexts.id, p.contextId),
        isNull(browserContexts.closedAt),
        or(isNull(browserContexts.controllerUserId), lte(browserContexts.leaseExpiresAt, iso(now))),
      ),
    )
    .returning({
      id: browserContexts.id,
      host: browserContexts.host,
      agentId: browserContexts.agentId,
      requestedFor: browserContexts.requestedForUserId,
      expiresAt: browserContexts.leaseExpiresAt,
    });
  if (!row) {
    const [open] = await tx
      .select({ id: browserContexts.id })
      .from(browserContexts)
      .where(and(eq(browserContexts.id, p.contextId), isNull(browserContexts.closedAt)))
      .limit(1);
    return { refused: open ? "someone_else" : "expired" };
  }
  await core.audit.record(tx, {
    action: "browser.takeover_started",
    actorKind: "user",
    actorId: p.userId,
    agentId: row.agentId,
    userId: row.requestedFor,
    resourceType: "browser_context",
    resourceId: row.id,
    metadata: { contextId: row.id, host: row.host },
  });
  return { lease: { contextId: row.id, host: row.host, expiresAt: iso(Date.parse(String(row.expiresAt))) } };
}

/** Pushes the holder's lease to 10 minutes after `nowMs` (input or `keep`); false when they no longer hold it. */
export async function keep(
  tx: Tx,
  p: { contextId: string; userId: string; nowMs?: number },
): Promise<{ expiresAt: string } | null> {
  const now = p.nowMs ?? Date.now();
  const [row] = await tx
    .update(browserContexts)
    .set({ leaseExpiresAt: iso(now + TAKEOVER_MS) })
    .where(
      and(
        eq(browserContexts.id, p.contextId),
        isNull(browserContexts.closedAt),
        eq(browserContexts.controllerUserId, p.userId),
      ),
    )
    .returning({ expiresAt: browserContexts.leaseExpiresAt });
  return row ? { expiresAt: iso(Date.parse(String(row.expiresAt))) } : null;
}

/**
 * Ends the lease `userId` holds on the page (hand back, a closed socket, idle, lost access, kill switch). Audited
 * `browser.takeover_ended` with the reason; false when they did not hold it (nothing written, nothing audited).
 */
export async function release(
  tx: Tx,
  core: Pick<Core, "audit">,
  p: { contextId: string; userId: string; reason: LeaseEndReason },
): Promise<boolean> {
  const [row] = await tx
    .update(browserContexts)
    .set({ controllerUserId: null, leaseExpiresAt: null })
    .where(and(eq(browserContexts.id, p.contextId), eq(browserContexts.controllerUserId, p.userId)))
    .returning({
      id: browserContexts.id,
      host: browserContexts.host,
      agentId: browserContexts.agentId,
      requestedFor: browserContexts.requestedForUserId,
    });
  if (!row) return false;
  await auditEnded(tx, core, { ...row, actorUserId: p.userId }, p.reason);
  return true;
}

/**
 * A lease whose expiry passed with nobody to release it (the holding instance died): cleared as `idle` and audited
 * once (the conditional UPDATE lets one instance win). Returns the controller it cleared, or null.
 */
export async function clearExpired(
  tx: Tx,
  core: Pick<Core, "audit">,
  p: { contextId: string; nowMs?: number },
): Promise<string | null> {
  const now = p.nowMs ?? Date.now();
  const [before] = await tx
    .select({ controller: browserContexts.controllerUserId })
    .from(browserContexts)
    .where(eq(browserContexts.id, p.contextId))
    .limit(1);
  const [row] = await tx
    .update(browserContexts)
    .set({ controllerUserId: null, leaseExpiresAt: null })
    .where(
      and(
        eq(browserContexts.id, p.contextId),
        isNotNull(browserContexts.controllerUserId),
        lte(browserContexts.leaseExpiresAt, iso(now)),
      ),
    )
    .returning({
      id: browserContexts.id,
      host: browserContexts.host,
      agentId: browserContexts.agentId,
      requestedFor: browserContexts.requestedForUserId,
    });
  if (!row || !before?.controller) return null;
  await auditEnded(tx, core, { ...row, actorUserId: null }, "idle");
  return before.controller;
}

/** A lease is left to its holder's own live view this long past its expiry before the shared sweep clears it. */
export const DEAD_LEASE_GRACE_MS = 60_000;

/**
 * 07.8-28 (WINDOWS #271, #244): the leases of this organization's open pages that expired with nobody to release them
 * (the holding API instance died and no live view reads the row), cleared as `idle` by the browser sweep, each audited
 * once (`clearExpired`). Runs in the organization's own transaction (RLS); returns the pages it cleared, so the caller
 * turns sandboxd's takeover off and announces them after the commit.
 */
export async function clearDeadLeases(
  tx: Tx,
  core: Pick<Core, "audit">,
  nowMs = Date.now(),
): Promise<Array<{ contextId: string; agentId: string }>> {
  const rows = await tx
    .select({ id: browserContexts.id, agentId: browserContexts.agentId })
    .from(browserContexts)
    .where(
      and(
        isNull(browserContexts.closedAt),
        isNotNull(browserContexts.controllerUserId),
        lte(browserContexts.leaseExpiresAt, iso(nowMs - DEAD_LEASE_GRACE_MS)),
      ),
    )
    .limit(500);
  const out: Array<{ contextId: string; agentId: string }> = [];
  for (const r of rows) {
    if (await clearExpired(tx, core, { contextId: r.id, nowMs }))
      out.push({ contextId: r.id, agentId: r.agentId });
  }
  return out;
}

/** `browser.takeover_ended` for a lease that ended with its page (closed, killed): ids, the host and the reason. */
export async function auditEnded(
  tx: Tx,
  core: Pick<Core, "audit">,
  row: { id: string; host: string; agentId: string; requestedFor: string; actorUserId: string | null },
  reason: LeaseEndReason,
): Promise<void> {
  await core.audit.record(tx, {
    action: "browser.takeover_ended",
    actorKind: row.actorUserId ? "user" : "system",
    actorId: row.actorUserId,
    agentId: row.agentId,
    userId: row.requestedFor,
    resourceType: "browser_context",
    resourceId: row.id,
    metadata: { contextId: row.id, host: row.host, reason },
  });
}

/** Tells every instance that a page's lease or state changed (ids only); best effort, the poll is the backstop. */
export async function announce(
  bus: Pick<RedisBus, "publish">,
  organizationId: string,
  contextId: string,
): Promise<void> {
  await bus.publish(LEASE_CHANNEL, JSON.stringify({ o: organizationId, c: contextId })).catch(() => {});
}

/** A `LEASE_CHANNEL` message, or null when it is not one. */
export function parseAnnouncement(raw: string): { organizationId: string; contextId: string } | null {
  try {
    const v = JSON.parse(raw) as { o?: unknown; c?: unknown };
    return typeof v.o === "string" && typeof v.c === "string"
      ? { organizationId: v.o, contextId: v.c }
      : null;
  } catch {
    return null;
  }
}

/** True while the row's lease is live at `nowMs`. */
export function leaseLive(
  row: { controllerUserId: string | null; leaseExpiresAt: string | Date | null },
  nowMs = Date.now(),
): boolean {
  return (
    row.controllerUserId !== null &&
    row.leaseExpiresAt !== null &&
    Date.parse(String(row.leaseExpiresAt)) > nowMs
  );
}
