import { BROWSER_LIMITS } from "@ocw/contracts";
import { browserContexts, type Tx } from "@ocw/db";
import { and, eq, isNotNull, isNull, lte, or } from "drizzle-orm";
import type { Core } from "../../core";
import type { RedisBus } from "../../lib/redis";
import { type BrowserContextRecord, closeAbandoned } from "./contexts";

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
 *   so the other instances' live views re-read the row and re-decide their viewers at once;
 * - ADR-0029: a lease that ends WITHOUT a hand back (`ABANDONING`: the socket closed, idle, lost access, a dead
 *   instance's lease cleared) after its holder sent input (`lease_input`, recorded by `markInput` before the input
 *   reaches the page) or with a member's session loaded closes the page (`takeover_abandoned`) in the same
 *   transaction, instead of handing it back to the bot and its watchers with whatever the person left in it.
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

/**
 * Lease ends that are no hand back: the person never said they were done. `upstream_failed` (sandboxd refused the take,
 * so no input ever reached the page) and the page's own end (kill switch, page ended) are not abandonment.
 */
export const ABANDONING: ReadonlySet<LeaseEndReason> = new Set(["closed", "idle", "access_lost"]);

/** How a lease ended: null when the person did not hold it; `closed` is the page the end closed (`takeover_abandoned`). */
export interface LeaseEnded {
  closed: BrowserContextRecord | null;
}

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
    .set({ controllerUserId: p.userId, leaseExpiresAt: iso(now + TAKEOVER_MS), leaseInput: false })
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
 * ADR-0029: the holder's first input of the lease (typed, clicked, pasted) is recorded on the row BEFORE it is sent to
 * the page, so an abandoned lease closes the page whichever instance or sweep ends it. False when they no longer hold
 * the lease (the input must then not be sent).
 */
export async function markInput(tx: Tx, p: { contextId: string; userId: string }): Promise<boolean> {
  const rows = await tx
    .update(browserContexts)
    .set({ leaseInput: true })
    .where(
      and(
        eq(browserContexts.id, p.contextId),
        isNull(browserContexts.closedAt),
        eq(browserContexts.controllerUserId, p.userId),
      ),
    )
    .returning({ id: browserContexts.id });
  return rows.length > 0;
}

/** What the lease held when it ended, read under a row lock in the ending transaction. */
async function leaseFacts(tx: Tx, contextId: string) {
  const [row] = await tx
    .select({
      controller: browserContexts.controllerUserId,
      input: browserContexts.leaseInput,
      sessionId: browserContexts.sessionId,
      closedAt: browserContexts.closedAt,
    })
    .from(browserContexts)
    .where(eq(browserContexts.id, contextId))
    .limit(1)
    .for("update");
  return row ?? null;
}

/** The lease ended without a hand back after input, or with a member's session loaded: the page closes (ADR-0029). */
async function closeIfAbandoned(
  tx: Tx,
  core: Pick<Core, "audit" | "realtime">,
  p: { contextId: string; reason: LeaseEndReason },
  facts: { input: boolean; sessionId: string | null; closedAt: unknown },
): Promise<BrowserContextRecord | null> {
  if (!ABANDONING.has(p.reason) || facts.closedAt !== null) return null;
  if (!facts.input && facts.sessionId === null) return null;
  return closeAbandoned(tx, core, { contextId: p.contextId, leaseEnd: p.reason });
}

/**
 * Ends the lease `userId` holds on the page (hand back, a closed socket, idle, lost access, kill switch). Audited
 * `browser.takeover_ended` with the reason; null when they did not hold it (nothing written, nothing audited). A lease
 * abandoned after input (or with a member's session loaded) closes the page in this same transaction (`closed`).
 */
export async function release(
  tx: Tx,
  core: Pick<Core, "audit" | "realtime">,
  p: { contextId: string; userId: string; reason: LeaseEndReason },
): Promise<LeaseEnded | null> {
  const facts = await leaseFacts(tx, p.contextId);
  if (!facts || facts.controller !== p.userId) return null;
  const [row] = await tx
    .update(browserContexts)
    .set({ controllerUserId: null, leaseExpiresAt: null, leaseInput: false })
    .where(and(eq(browserContexts.id, p.contextId), eq(browserContexts.controllerUserId, p.userId)))
    .returning({
      id: browserContexts.id,
      host: browserContexts.host,
      agentId: browserContexts.agentId,
      requestedFor: browserContexts.requestedForUserId,
    });
  if (!row) return null;
  await auditEnded(tx, core, { ...row, actorUserId: p.userId }, p.reason);
  return { closed: await closeIfAbandoned(tx, core, p, facts) };
}

/**
 * A lease whose expiry passed with nobody to release it (the holding instance died): cleared as `idle` and audited
 * once (the conditional UPDATE lets one instance win); abandoned after input (or with a member's session loaded), the
 * page closes with it (ADR-0029). Returns the controller it cleared and the page it closed, or null.
 */
export async function clearExpired(
  tx: Tx,
  core: Pick<Core, "audit" | "realtime">,
  p: { contextId: string; nowMs?: number },
): Promise<(LeaseEnded & { controller: string }) | null> {
  const now = p.nowMs ?? Date.now();
  const before = await leaseFacts(tx, p.contextId);
  const [row] = await tx
    .update(browserContexts)
    .set({ controllerUserId: null, leaseExpiresAt: null, leaseInput: false })
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
  const closed = await closeIfAbandoned(tx, core, { contextId: p.contextId, reason: "idle" }, before);
  return { controller: before.controller, closed };
}

/** A lease is left to its holder's own live view this long past its expiry before the shared sweep clears it. */
export const DEAD_LEASE_GRACE_MS = 60_000;

/**
 * 07.8-28 (WINDOWS #271, #244): the leases of this organization's open pages that expired with nobody to release them
 * (the holding API instance died and no live view reads the row), cleared as `idle` by the browser sweep, each audited
 * once (`clearExpired`). Runs in the organization's own transaction (RLS); returns the pages it cleared, so the caller
 * turns sandboxd's takeover off (or closes the page there when the abandoned lease closed it) and announces them after
 * the commit.
 */
export async function clearDeadLeases(
  tx: Tx,
  core: Pick<Core, "audit" | "realtime">,
  nowMs = Date.now(),
): Promise<Array<{ contextId: string; agentId: string; closed: boolean }>> {
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
  const out: Array<{ contextId: string; agentId: string; closed: boolean }> = [];
  for (const r of rows) {
    const cleared = await clearExpired(tx, core, { contextId: r.id, nowMs });
    if (cleared) out.push({ contextId: r.id, agentId: r.agentId, closed: cleared.closed !== null });
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
