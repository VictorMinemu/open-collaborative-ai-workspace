import {
  type BrowserEventFrame,
  WORK_BROWSER_AUDIT,
  type WorkBrowserAction,
  type WorkBrowserAuditAction,
  type WorkBrowserLaunchFailure,
  type WorkBrowserRefusal,
} from "@ocw/contracts";
import { type Tx, workBrowsers, workPrompts, workSessions } from "@ocw/db";
import { and, eq, sql } from "drizzle-orm";
import type { Core } from "../../core";
import type { DeviceRef } from "../device";

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

  const audit = await applyKind(tx, device, frame);
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
 * | `closed` | closed, lease cleared | `.closed { origin }` |
 * | `crashed`, `takeover_abandoned` | closed, lease cleared | `.closed { origin, endReason }` |
 * | `signin_loaded`, `signin_unloaded` | (07.13-17) | none |
 *
 * A close without an origin audits the page's last origin.
 */
async function applyKind(tx: Tx, device: DeviceRef, frame: BrowserEventFrame): Promise<EventAudit | null> {
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
      const last = await closeRow(tx, frame.sessionId);
      const endReason: EndReason | null = frame.kind === "closed" ? null : frame.kind;
      return {
        action: WORK_BROWSER_AUDIT.closed,
        result: "success",
        metadata: metadataOf({ origin: frame.origin ?? last, endReason }),
      };
    }
    case "signin_loaded":
    case "signin_unloaded":
      // Applied by the sign-in load (07.13-17); nothing here.
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

/**
 * The page ended: the row is closed and any lease on it cleared (the four lease columns together, 07.13-03). Returns
 * the origin the page was last on (a `BrowserOrigin` by the row's check), null when the session had no page row.
 */
async function closeRow(tx: Tx, sessionId: string): Promise<string | null> {
  const [row] = await tx
    .update(workBrowsers)
    .set({
      state: "closed",
      closedAt: sql`coalesce(${workBrowsers.closedAt}, now())`,
      updatedAt: sql`now()`,
      leaseId: null,
      controllerUserId: null,
      leaseExpiresAt: null,
      leaseInput: false,
    })
    .where(eq(workBrowsers.workSessionId, sessionId))
    .returning({ origin: workBrowsers.origin });
  return row?.origin ?? null;
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
