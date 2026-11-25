import { randomUUID } from "node:crypto";
import { type BrowserLeaseFrame, WORK_BROWSER_AUDIT } from "@ocw/contracts";
import { type Tx, workBrowsers, workPrompts, workSessions } from "@ocw/db";
import { and, desc, eq, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import type { Core } from "../../core";
import type { RedisBus } from "../../lib/redis";
import { TAKEOVER_MS, TAKEOVER_WARN_MS } from "../browser";
import type { DeviceHub } from "../device";
import type { PermissionService } from "../organization";
import { sessionFacts } from "../work-session";

export { TAKEOVER_MS, TAKEOVER_WARN_MS };

/**
 * The takeover lease of a Work Zone session's page (07.13-18; D-20, D-22, D-28, PD-14, PD-15; WZB-08, WZB-09): the
 * bots' lease rules (`modules/browser/takeover.ts`) on the session's `work_browsers` row, where every API instance, the
 * sweep and the device agree on it. The lease columns (`lease_id`, `controller_user_id`, `lease_expires_at`) are set and
 * cleared together (07.13-03); `lease_input` records that the holder sent input in this lease BEFORE the input reaches
 * the device.
 *
 * - **Who takes it** (D-20, PD-14): a person who may prompt the session (`work_session.prompt` on the session resource,
 *   the resolver's) AND asked its in-flight turn (else its last one). A bot's turn has no human asker: nobody takes it.
 * - **One holder:** `take` is one conditional UPDATE, winning only while nobody holds a lease (a lapsed lease without
 *   input is taken over; a lapsed one WITH input waits for the sweep, which closes that page first).
 * - **How it ends** (`endWorkLease`): the hand back (`released`, with or without `save`), the socket closing
 *   (`closed`), 10 minutes without input (`idle`), lost access (`access_lost`), or the device unreachable at take
 *   (`upstream_failed`). An end that is no hand back (`ABANDONING`) after input is ABANDONED (ADR-0029): the page row is
 *   closed in the same transaction (`work_browser.closed { endReason: takeover_abandoned }`), so no viewer ever sees
 *   what the person left in it, and the device is told `browser.lease { abandoned }` (it closes the page).
 * - **The hand back that saves** (D-22, PD-15): `release { save: true }` mints the one-use upload in the same
 *   transaction (the four `upload_*` columns together: the member, the page's origin, 5 minutes); the device then gets
 *   `browser.handback { save: true, uploadId }` and PUTs the site's state (07.13-17 seals it).
 *
 * Audited with the origin and flags only (`work_browser.takeover_started { origin }`, `.takeover_ended { origin,
 * reason, saved, abandoned }`), never what the person typed. Lease changes are announced on `WORK_LEASE_CHANNEL` with
 * ids only.
 */

/** Redis channel of a session page's lease changes: `{"o":<organizationId>,"s":<sessionId>}`, ids only. */
export const WORK_LEASE_CHANNEL = "ocw:wb:lease";

/** The hand-back upload is usable this long (PD-15). */
export const UPLOAD_MS = 5 * 60_000;

/** A lease is left to its holder's own live view this long past its expiry before the shared sweep clears it. */
export const DEAD_LEASE_GRACE_MS = 60_000;

/** Why a lease ended (audit metadata `reason`). `page_ended` is the device's own close (`events.ts`). */
export type WorkLeaseEndReason = "released" | "closed" | "idle" | "access_lost" | "upstream_failed";

/** Ends that are no hand back: after input they abandon the page (ADR-0029). */
export const ABANDONING: ReadonlySet<WorkLeaseEndReason> = new Set(["closed", "idle", "access_lost"]);

export type WorkTakeRefusal = "not_allowed" | "someone_else" | "expired";

export interface WorkLease {
  sessionId: string;
  leaseId: string;
  deviceId: string;
  origin: string | null;
  expiresAt: string;
}

/** How a lease ended: what the device is told, and the upload minted by a saving hand back. */
export interface WorkLeaseEnded {
  sessionId: string;
  leaseId: string;
  deviceId: string;
  state: "released" | "abandoned";
  /** `release { save: true }` on a page with an origin: the one-use upload id. */
  uploadId: string | null;
}

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * The person whose turn the session runs now (its in-flight prompt), else whose turn it ran last; null for a bot's turn
 * (`author_agent_id`) or a session without one. Read in the caller's transaction.
 */
export async function askerOf(tx: Tx, sessionId: string): Promise<string | null> {
  const pick = { userId: workPrompts.authorUserId, agentId: workPrompts.authorAgentId };
  const [inFlight] = await tx
    .select(pick)
    .from(workPrompts)
    .where(
      and(eq(workPrompts.workSessionId, sessionId), inArray(workPrompts.status, ["dispatched", "running"])),
    )
    .orderBy(desc(workPrompts.dispatchedAt))
    .limit(1);
  const [p] = inFlight
    ? [inFlight]
    : await tx
        .select(pick)
        .from(workPrompts)
        .where(and(eq(workPrompts.workSessionId, sessionId), isNotNull(workPrompts.dispatchedAt)))
        .orderBy(desc(workPrompts.dispatchedAt), desc(workPrompts.position))
        .limit(1);
  return p && p.agentId === null ? p.userId : null;
}

/**
 * What `userId` may do with the session's page (in their own tenant transaction, RLS and the audience backstop apply):
 * `prompt` = the resolver's `work_session.prompt`; `take` = that AND they asked the in-flight or last turn (D-20).
 */
export async function leaseRights(
  tx: Tx,
  perms: PermissionService,
  p: { sessionId: string; userId: string },
): Promise<{ prompt: boolean; take: boolean; deviceId: string | null }> {
  const [row] = await tx
    .select({ id: workSessions.id, createdBy: workSessions.createdBy, deviceId: workSessions.deviceId })
    .from(workSessions)
    .where(eq(workSessions.id, p.sessionId))
    .limit(1);
  if (!row) return { prompt: false, take: false, deviceId: null };
  const decided = await perms.decide(
    tx,
    { kind: "user", userId: p.userId },
    "work_session.prompt",
    await sessionFacts(tx, p.userId, row),
  );
  if (!decided.allowed) return { prompt: false, take: false, deviceId: row.deviceId };
  return { prompt: true, take: (await askerOf(tx, p.sessionId)) === p.userId, deviceId: row.deviceId };
}

/**
 * Takes the lease of the session's open page for `userId` (in their tenant transaction): the asker rule first, then one
 * conditional UPDATE that wins only while no lease is held (or a lapsed one without input). Audited
 * `work_browser.takeover_started { origin }` in the same transaction.
 */
export async function takeWorkLease(
  tx: Tx,
  core: Pick<Core, "audit">,
  perms: PermissionService,
  p: { sessionId: string; userId: string; nowMs?: number },
): Promise<{ lease: WorkLease } | { refused: WorkTakeRefusal }> {
  const now = p.nowMs ?? Date.now();
  const rights = await leaseRights(tx, perms, p);
  if (!rights.take || !rights.deviceId) return { refused: "not_allowed" };
  const leaseId = randomUUID();
  const [row] = await tx
    .update(workBrowsers)
    .set({
      controllerUserId: p.userId,
      leaseId,
      leaseExpiresAt: iso(now + TAKEOVER_MS),
      leaseInput: false,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(workBrowsers.workSessionId, p.sessionId),
        eq(workBrowsers.state, "open"),
        or(
          isNull(workBrowsers.leaseId),
          and(lte(workBrowsers.leaseExpiresAt, iso(now)), eq(workBrowsers.leaseInput, false)),
        ),
      ),
    )
    .returning({ origin: workBrowsers.origin, expiresAt: workBrowsers.leaseExpiresAt });
  if (!row) {
    const [open] = await tx
      .select({ id: workBrowsers.workSessionId })
      .from(workBrowsers)
      .where(and(eq(workBrowsers.workSessionId, p.sessionId), eq(workBrowsers.state, "open")))
      .limit(1);
    return { refused: open ? "someone_else" : "expired" };
  }
  await core.audit.record(tx, {
    action: WORK_BROWSER_AUDIT.takeover_started,
    actorKind: "user",
    actorId: p.userId,
    userId: p.userId,
    deviceId: rights.deviceId,
    sessionId: p.sessionId,
    resourceType: "work_session",
    resourceId: p.sessionId,
    metadata: row.origin ? { origin: row.origin } : {},
  });
  return {
    lease: {
      sessionId: p.sessionId,
      leaseId,
      deviceId: rights.deviceId,
      origin: row.origin,
      expiresAt: iso(Date.parse(String(row.expiresAt))),
    },
  };
}

/** The holder's lease, where it is still theirs. */
const held = (p: { sessionId: string; leaseId: string; userId: string }) =>
  and(
    eq(workBrowsers.workSessionId, p.sessionId),
    eq(workBrowsers.state, "open"),
    eq(workBrowsers.leaseId, p.leaseId),
    eq(workBrowsers.controllerUserId, p.userId),
  );

/** Pushes the holder's lease to 10 minutes after `nowMs`; null when they no longer hold it. */
export async function keepWorkLease(
  tx: Tx,
  p: { sessionId: string; leaseId: string; userId: string; nowMs?: number },
): Promise<{ expiresAt: string } | null> {
  const now = p.nowMs ?? Date.now();
  const [row] = await tx
    .update(workBrowsers)
    .set({ leaseExpiresAt: iso(now + TAKEOVER_MS), updatedAt: sql`now()` })
    .where(held(p))
    .returning({ expiresAt: workBrowsers.leaseExpiresAt });
  return row ? { expiresAt: iso(Date.parse(String(row.expiresAt))) } : null;
}

/**
 * ADR-0029: the holder's first input that may leave something in the page is recorded on the row (and the lease pushed
 * to 10 minutes after it) BEFORE it reaches the device, so an abandoned lease closes the page whichever instance or
 * sweep ends it. Null when they no longer hold the lease (the input must then not be sent).
 */
export async function markWorkLeaseInput(
  tx: Tx,
  p: { sessionId: string; leaseId: string; userId: string; nowMs?: number },
): Promise<{ expiresAt: string } | null> {
  const now = p.nowMs ?? Date.now();
  const [row] = await tx
    .update(workBrowsers)
    .set({ leaseInput: true, leaseExpiresAt: iso(now + TAKEOVER_MS), updatedAt: sql`now()` })
    .where(held(p))
    .returning({ expiresAt: workBrowsers.leaseExpiresAt });
  return row ? { expiresAt: iso(Date.parse(String(row.expiresAt))) } : null;
}

/**
 * Ends lease `leaseId` of the session's page (run in the session's tenant without a user: a holder who lost access
 * still ends their lease). `userId` = the holder the end is for (null: the sweep's); the lease must be theirs. Returns
 * null when it was not (nothing written, nothing audited). See the file comment for abandonment and `save`.
 */
export async function endWorkLease(
  tx: Tx,
  core: Pick<Core, "audit">,
  p: {
    sessionId: string;
    leaseId: string;
    userId: string | null;
    reason: WorkLeaseEndReason;
    save?: boolean;
    nowMs?: number;
  },
): Promise<WorkLeaseEnded | null> {
  const now = p.nowMs ?? Date.now();
  const [facts] = await tx
    .select({
      controller: workBrowsers.controllerUserId,
      leaseId: workBrowsers.leaseId,
      input: workBrowsers.leaseInput,
      origin: workBrowsers.origin,
      state: workBrowsers.state,
      deviceId: workSessions.deviceId,
    })
    .from(workBrowsers)
    .innerJoin(workSessions, eq(workSessions.id, workBrowsers.workSessionId))
    .where(eq(workBrowsers.workSessionId, p.sessionId))
    .limit(1)
    .for("update", { of: workBrowsers });
  if (!facts || facts.leaseId !== p.leaseId || !facts.controller) return null;
  if (p.userId !== null && facts.controller !== p.userId) return null;
  const abandoned = ABANDONING.has(p.reason) && facts.input && facts.state === "open";
  const saving =
    p.reason === "released" && p.save === true && facts.origin !== null && facts.state === "open";
  const uploadId = saving ? randomUUID() : null;
  await tx
    .update(workBrowsers)
    .set({
      leaseId: null,
      controllerUserId: null,
      leaseExpiresAt: null,
      leaseInput: false,
      updatedAt: sql`now()`,
      ...(uploadId
        ? {
            uploadId,
            uploadUserId: facts.controller,
            uploadOrigin: facts.origin,
            uploadExpiresAt: iso(now + UPLOAD_MS),
          }
        : {}),
      ...(abandoned
        ? { state: "closed" as const, closedAt: sql`coalesce(${workBrowsers.closedAt}, now())` }
        : {}),
    })
    .where(and(eq(workBrowsers.workSessionId, p.sessionId), eq(workBrowsers.leaseId, p.leaseId)));
  const origin = facts.origin ? { origin: facts.origin } : {};
  const who = {
    actorKind: p.userId ? ("user" as const) : ("system" as const),
    actorId: p.userId,
    userId: facts.controller,
    deviceId: facts.deviceId,
    sessionId: p.sessionId,
    resourceType: "work_session",
    resourceId: p.sessionId,
  };
  await core.audit.record(tx, {
    ...who,
    action: WORK_BROWSER_AUDIT.takeover_ended,
    metadata: { ...origin, reason: p.reason, saved: uploadId !== null, abandoned },
  });
  if (abandoned) {
    // The page ends here (ADR-0029); the device's own `takeover_abandoned` echo audits nothing again (`events.ts`).
    await core.audit.record(tx, {
      ...who,
      action: WORK_BROWSER_AUDIT.closed,
      metadata: { ...origin, endReason: "takeover_abandoned" },
    });
  }
  return {
    sessionId: p.sessionId,
    leaseId: p.leaseId,
    deviceId: facts.deviceId,
    state: abandoned ? "abandoned" : "released",
    uploadId,
  };
}

/** The holder's hand back (`release { save }`): `endWorkLease` with `released`. */
export function releaseWorkLease(
  tx: Tx,
  core: Pick<Core, "audit">,
  p: { sessionId: string; leaseId: string; userId: string; save: boolean; nowMs?: number },
): Promise<WorkLeaseEnded | null> {
  return endWorkLease(tx, core, { ...p, reason: "released" });
}

/**
 * The leases of this organization's pages that lapsed with nobody to end them (the holding API instance died): each
 * ended as `idle` by the sweep (`endWorkLease`, so one after input abandons its page), audited once. Runs in the
 * organization's own user-less transaction; returns what the caller tells the devices after the commit.
 */
export async function sweepLapsedLeases(
  tx: Tx,
  core: Pick<Core, "audit">,
  nowMs = Date.now(),
): Promise<WorkLeaseEnded[]> {
  const rows = await tx
    .select({ sessionId: workBrowsers.workSessionId, leaseId: workBrowsers.leaseId })
    .from(workBrowsers)
    .where(
      and(
        isNotNull(workBrowsers.leaseId),
        lte(workBrowsers.leaseExpiresAt, iso(nowMs - DEAD_LEASE_GRACE_MS)),
      ),
    )
    .limit(500);
  const out: WorkLeaseEnded[] = [];
  for (const r of rows) {
    if (!r.leaseId) continue;
    const ended = await endWorkLease(tx, core, {
      sessionId: r.sessionId,
      leaseId: r.leaseId,
      userId: null,
      reason: "idle",
      nowMs,
    });
    if (ended) out.push(ended);
  }
  return out;
}

/**
 * Tells the device how a lease ended (ephemeral; an offline device simply misses it): `browser.handback { save: true,
 * uploadId }` for a saving hand back, else `browser.lease { released | abandoned }`.
 */
export async function tellDeviceEnded(
  hub: Pick<DeviceHub, "sendBrowserFrame">,
  ended: WorkLeaseEnded,
): Promise<void> {
  const frame = ended.uploadId
    ? ({
        type: "browser.handback",
        sessionId: ended.sessionId,
        leaseId: ended.leaseId,
        save: true,
        uploadId: ended.uploadId,
      } as const)
    : ({
        type: "browser.lease",
        sessionId: ended.sessionId,
        leaseId: ended.leaseId,
        state: ended.state,
      } satisfies BrowserLeaseFrame);
  await hub.sendBrowserFrame(ended.deviceId, frame).catch(() => {});
}

/** Tells every instance that a session page's lease changed (ids only); best effort, the poll is the backstop. */
export async function announceLease(
  bus: Pick<RedisBus, "publish">,
  organizationId: string,
  sessionId: string,
): Promise<void> {
  await bus.publish(WORK_LEASE_CHANNEL, JSON.stringify({ o: organizationId, s: sessionId })).catch(() => {});
}

/** A `WORK_LEASE_CHANNEL` message, or null when it is not one. */
export function parseLeaseAnnouncement(raw: string): { organizationId: string; sessionId: string } | null {
  try {
    const v = JSON.parse(raw) as { o?: unknown; s?: unknown };
    return typeof v.o === "string" && typeof v.s === "string"
      ? { organizationId: v.o, sessionId: v.s }
      : null;
  } catch {
    return null;
  }
}
