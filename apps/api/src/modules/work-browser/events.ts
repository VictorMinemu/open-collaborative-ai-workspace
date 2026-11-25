import {
  type BrowserEventFrame,
  type HelloFrame,
  WORK_BROWSER_AUDIT,
  type WorkBrowserAction,
  type WorkBrowserAuditAction,
  type WorkBrowserLaunchFailure,
  type WorkBrowserRefusal,
} from "@ocw/contracts";
import { type Tx, workBrowsers, workPrompts, workSessions } from "@ocw/db";
import { and, eq, sql } from "drizzle-orm";
import type { Core } from "../../core";
import type { DeviceHub, DeviceRef } from "../device";
import { announceLease } from "./lease";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The `browser.event` handler (07.13 D-14, PD-24, PD-25): what the device says happened to one of ITS sessions' page,
 * applied in the device's tenant. The session is locked and must run on the link's device (T-07.13-08-01): a frame
 * naming another device's session changes nothing and audits nothing. The session's `work_browsers` row follows the
 * page, and every event is audited in the same transaction as `actorKind: "device"` for the author of the prompt the
 * frame names (`userId`, only from the same session's prompts, T-07.13-08-05). Audit metadata is built from the
 * frame's origin and enum codes only (T-07.13-08-02): never a path, a query, a title or text.
 */
export function onBrowserEvent(core: Core) {
  return async (device: DeviceRef, frame: BrowserEventFrame): Promise<void> => {
    await core.db.withTenant({ organizationId: device.organizationId, userId: null }, (tx) =>
      applyBrowserEvent(core, tx, device, frame),
    );
  };
}

async function applyBrowserEvent(core: Core, tx: Tx, device: DeviceRef, frame: BrowserEventFrame) {
  const [session] = await tx
    .select({ id: workSessions.id, deviceId: workSessions.deviceId })
    .from(workSessions)
    .where(eq(workSessions.id, frame.sessionId))
    .for("update");
  if (!session || session.deviceId !== device.deviceId) return;

  const audit = await applyKind(core, tx, device, frame);
  if (!audit) return;

  const author = await promptAuthor(tx, session.id, frame.promptId);
  await core.audit.record(tx, {
    action: audit.action,
    resourceType: "work_session",
    resourceId: session.id,
    actorKind: "device",
    actorId: device.deviceId,
    deviceId: device.deviceId,
    sessionId: session.id,
    userId: author?.userId ?? null,
    agentId: author?.agentId ?? null,
    result: audit.result,
    metadata: audit.metadata,
  });
}

/** The `work_browser.*` row one event writes; metadata only from the origin and the frame's enum fields. */
interface EventAudit {
  action: WorkBrowserAuditAction;
  result: "success" | "denied";
  metadata: Record<string, string>;
}

/** Why a page ended without an explicit close (wording as the bots' `BrowserEndReason`). */
type EndReason = "crashed" | "takeover_abandoned";

/**
 * The kind → row transition and audit table (D-14, PD-24):
 *
 * | kind | row | audit |
 * | --- | --- | --- |
 * | `opened`, `navigated` | open on `origin` | `.opened` / `.navigated { origin }` |
 * | `acted` | unchanged | `.acted { origin, action }` |
 * | `refused` | unchanged | `.refused { origin, action?, refusal?, failure? }`, result `denied` |
 * | `closed` | closed, lease cleared | `.closed { origin }` (+ `.takeover_ended { page_ended }` under a lease) |
 * | `crashed`, `takeover_abandoned` | closed, lease cleared | `.closed { origin, endReason }` (idem) |
 * | `takeover_abandoned` on a row the API already closed (07.13-18) | unchanged | none |
 * | `signin_loaded` | unchanged (the load already recorded it, 07.13-17) | none |
 * | `signin_unloaded` | `signin_id` / `signin_user_id` cleared (07.13-17, PD-17) | none |
 *
 * A close without an origin audits the page's last origin.
 */
async function applyKind(
  core: Core,
  tx: Tx,
  device: DeviceRef,
  frame: BrowserEventFrame,
): Promise<EventAudit | null> {
  switch (frame.kind) {
    case "opened":
    case "navigated":
      await upsertOpen(tx, device, frame);
      return {
        action: WORK_BROWSER_AUDIT[frame.kind],
        result: "success",
        metadata: metadataOf({ origin: frame.origin }),
      };
    case "acted":
      return {
        action: WORK_BROWSER_AUDIT.acted,
        result: "success",
        metadata: metadataOf({ origin: frame.origin, action: frame.action }),
      };
    case "refused":
      return {
        action: WORK_BROWSER_AUDIT.refused,
        result: "denied",
        metadata: metadataOf({
          origin: frame.origin,
          action: frame.action,
          refusal: frame.refusal,
          failure: frame.failure,
        }),
      };
    case "closed":
    case "crashed":
    case "takeover_abandoned": {
      const before = await pageBefore(tx, frame.sessionId);
      // 07.13-18: the API closed the page itself when it abandoned the takeover (and audited it then): the device's
      // echo changes nothing more.
      if (frame.kind === "takeover_abandoned" && before?.state === "closed") return null;
      const last = await closeRow(tx, frame.sessionId);
      if (before?.leaseId && before.controller) await leaseEndedWithPage(core, tx, device, frame, before);
      const endReason: EndReason | null = frame.kind === "closed" ? null : frame.kind;
      return {
        action: WORK_BROWSER_AUDIT.closed,
        result: "success",
        metadata: metadataOf({ origin: frame.origin ?? last, endReason }),
      };
    }
    case "signin_loaded":
      // Recorded and audited by the API when it answered the load (`load.ts`, 07.13-17): the device's echo adds nothing.
      return null;
    case "signin_unloaded":
      // PD-17: the device re-sealed (or dropped) the member's state and closed that context; the page is public again,
      // so the live view's privacy gate and the member-only approvals end with it. Not audited (the load was).
      await tx
        .update(workBrowsers)
        .set({ signinId: null, signinUserId: null, updatedAt: sql`now()` })
        .where(eq(workBrowsers.workSessionId, frame.sessionId));
      return null;
  }
}

/**
 * The only audit metadata builder: the fixed keys below, each an origin or an enum code (typed so no free text can be
 * passed); absent values are left out.
 */
function metadataOf(fields: {
  origin?: string | null;
  action?: WorkBrowserAction | undefined;
  refusal?: WorkBrowserRefusal | undefined;
  failure?: WorkBrowserLaunchFailure | undefined;
  endReason?: EndReason | null;
}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ["origin", "action", "refusal", "failure", "endReason"] as const) {
    const value = fields[key];
    if (value) out[key] = value;
  }
  return out;
}

/** The page's row before a close (the session row is locked by the caller): its state and lease, ids only. */
async function pageBefore(tx: Tx, sessionId: string) {
  const [row] = await tx
    .select({
      state: workBrowsers.state,
      origin: workBrowsers.origin,
      leaseId: workBrowsers.leaseId,
      controller: workBrowsers.controllerUserId,
    })
    .from(workBrowsers)
    .where(eq(workBrowsers.workSessionId, sessionId))
    .limit(1);
  return row ?? null;
}

/**
 * 07.13-18 (D-28): a page that ended under a person's takeover lease ends the lease with it; audited
 * `work_browser.takeover_ended { origin, reason: page_ended }` (the page's own end is no abandonment: it closed anyway).
 */
async function leaseEndedWithPage(
  core: Core,
  tx: Tx,
  device: DeviceRef,
  frame: BrowserEventFrame,
  before: { origin: string | null; controller: string | null },
): Promise<void> {
  const origin = frame.origin ?? before.origin;
  await core.audit.record(tx, {
    action: WORK_BROWSER_AUDIT.takeover_ended,
    resourceType: "work_session",
    resourceId: frame.sessionId,
    actorKind: "device",
    actorId: device.deviceId,
    deviceId: device.deviceId,
    sessionId: frame.sessionId,
    userId: before.controller,
    metadata: { ...(origin ? { origin } : {}), reason: "page_ended", saved: false, abandoned: false },
  });
}

/**
 * What a page that ended leaves on its row: closed, any lease cleared (the four lease columns together, 07.13-03) and
 * no member's sign-in loaded (MD-01: a closed page holds none, so neither the live view's privacy nor the member-only
 * approvals keep naming that member). A pending hand-back upload stays: it is one-use, bound to its member and origin,
 * and lapses in 5 minutes (the device may PUT it right after its own close).
 */
const CLOSED_ROW = {
  state: "closed" as const,
  closedAt: sql`coalesce(${workBrowsers.closedAt}, now())`,
  updatedAt: sql`now()`,
  leaseId: null,
  controllerUserId: null,
  leaseExpiresAt: null,
  leaseInput: false,
  signinId: null,
  signinUserId: null,
};

/**
 * The page ended: its row becomes `CLOSED_ROW`. Returns the origin the page was last on (a `BrowserOrigin` by the
 * row's check), null when the session had no page row.
 */
async function closeRow(tx: Tx, sessionId: string): Promise<string | null> {
  const [row] = await tx
    .update(workBrowsers)
    .set(CLOSED_ROW)
    .where(eq(workBrowsers.workSessionId, sessionId))
    .returning({ origin: workBrowsers.origin });
  return row?.origin ?? null;
}

/**
 * MD-01: the device's hello, reconciled with the API's page rows of the device's own sessions (in the device's tenant,
 * every row locked). The device's word is what its link sent, never more than it: with `browserPages`, a page it does
 * not list is closed (as a crash: `work_browser.closed { origin, endReason: crashed }`, plus `.takeover_ended
 * { page_ended }` under a lease), a listed one it holds no sign-in in loses the one recorded, and a listed one with a
 * sign-in the API never recorded is reported for `browser.close { revoked }` (dropped unsaved: the API cannot say whose
 * it is). Without it (an older daemon), only the pages of sessions missing from `hello.sessions` are closed; with
 * neither, nothing changes. Returns the sessions whose row changed and those whose page the device must drop.
 */
export async function reconcileHello(
  core: Core,
  device: DeviceRef,
  hello: HelloFrame,
): Promise<{ changed: string[]; drop: string[] }> {
  const none = { changed: [], drop: [] };
  if (!hello.browser) return none;
  const reported = hello.browserPages
    ? new Map(hello.browserPages.map((p) => [p.sessionId.toLowerCase(), p.signedIn]))
    : null;
  const alive = hello.sessions ? new Set(hello.sessions.map((s) => s.toLowerCase())) : null;
  if (!reported && !alive) return none;
  return core.db.withTenant({ organizationId: device.organizationId, userId: null }, async (tx) => {
    const rows = await tx
      .select({
        sessionId: workBrowsers.workSessionId,
        state: workBrowsers.state,
        origin: workBrowsers.origin,
        leaseId: workBrowsers.leaseId,
        controller: workBrowsers.controllerUserId,
        signinUserId: workBrowsers.signinUserId,
      })
      .from(workBrowsers)
      .innerJoin(workSessions, eq(workSessions.id, workBrowsers.workSessionId))
      .where(eq(workSessions.deviceId, device.deviceId))
      .for("update", { of: workBrowsers });
    const changed: string[] = [];
    const drop: string[] = [];
    for (const row of rows) {
      const id = row.sessionId.toLowerCase();
      const open = reported ? reported.has(id) : alive?.has(id) !== false;
      if (!open) {
        if (row.state !== "open" && !row.signinUserId && !row.leaseId) continue;
        await tx.update(workBrowsers).set(CLOSED_ROW).where(eq(workBrowsers.workSessionId, row.sessionId));
        const frame: BrowserEventFrame = {
          type: "browser.event",
          sessionId: row.sessionId,
          promptId: null,
          kind: "crashed",
          origin: row.origin as BrowserEventFrame["origin"],
        };
        if (row.leaseId && row.controller) await leaseEndedWithPage(core, tx, device, frame, row);
        if (row.state === "open") {
          await core.audit.record(tx, {
            action: WORK_BROWSER_AUDIT.closed,
            resourceType: "work_session",
            resourceId: row.sessionId,
            actorKind: "device",
            actorId: device.deviceId,
            deviceId: device.deviceId,
            sessionId: row.sessionId,
            metadata: metadataOf({ origin: row.origin, endReason: "crashed" }),
          });
        }
        changed.push(row.sessionId);
        continue;
      }
      const signedIn = reported?.get(id);
      if (signedIn === false && row.signinUserId) {
        await tx
          .update(workBrowsers)
          .set({ signinId: null, signinUserId: null, updatedAt: sql`now()` })
          .where(eq(workBrowsers.workSessionId, row.sessionId));
        changed.push(row.sessionId);
      } else if (signedIn === true && !row.signinUserId) {
        drop.push(row.sessionId);
      }
    }
    // A page the device holds a sign-in in with no row at all is as unknown as one with no sign-in recorded.
    if (reported) {
      const known = new Set(rows.map((r) => r.sessionId.toLowerCase()));
      for (const [id, signedIn] of reported) if (signedIn && !known.has(id)) drop.push(id);
    }
    return { changed, drop };
  });
}

/** The `onHello` device handler (MD-01): reconcile, then tell every instance (ids only) and the device what changed. */
export function onDeviceHello(core: Core, hub: Pick<DeviceHub, "sendBrowserFrame">) {
  return async (device: DeviceRef, hello: HelloFrame): Promise<void> => {
    const { changed, drop } = await reconcileHello(core, device, hello);
    for (const sessionId of changed) await announceLease(core.bus, device.organizationId, sessionId);
    for (const sessionId of drop) {
      await hub
        .sendBrowserFrame(device.deviceId, { type: "browser.close", sessionId, reason: "revoked" })
        .catch(() => {});
    }
  };
}

/** `opened` / `navigated`: the session's page is open on `origin` (a new page after a closed one restarts its clock). */
async function upsertOpen(tx: Tx, device: DeviceRef, frame: BrowserEventFrame): Promise<void> {
  await tx
    .insert(workBrowsers)
    .values({
      workSessionId: frame.sessionId,
      organizationId: device.organizationId,
      state: "open",
      origin: frame.origin,
    })
    .onConflictDoUpdate({
      target: workBrowsers.workSessionId,
      set: {
        state: "open",
        origin: frame.origin,
        openedAt: sql`case when ${workBrowsers.state} = 'closed' then now() else ${workBrowsers.openedAt} end`,
        updatedAt: sql`now()`,
        closedAt: null,
      },
    });
}

/**
 * The person (and, for a bot's own prompt, the bot) whose turn the frame names: only a prompt of the SAME session
 * counts, so a device can never attribute its page to another session's author. Null outside a turn.
 */
async function promptAuthor(
  tx: Tx,
  sessionId: string,
  promptId: string | null,
): Promise<{ userId: string; agentId: string | null } | null> {
  if (!promptId || !UUID.test(promptId)) return null;
  const [row] = await tx
    .select({ userId: workPrompts.authorUserId, agentId: workPrompts.authorAgentId })
    .from(workPrompts)
    .where(and(eq(workPrompts.id, promptId), eq(workPrompts.workSessionId, sessionId)));
  return row ?? null;
}
