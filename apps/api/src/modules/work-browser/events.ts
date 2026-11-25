import { type BrowserEventFrame, WORK_BROWSER_AUDIT } from "@ocw/contracts";
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

  switch (frame.kind) {
    case "opened":
    case "navigated":
      await upsertOpen(tx, device, frame);
      break;
    default:
      return;
  }

  const author = await promptAuthor(tx, session.id, frame.promptId);
  await core.audit.record(tx, {
    action: WORK_BROWSER_AUDIT[frame.kind],
    resourceType: "work_session",
    resourceId: session.id,
    actorKind: "device",
    actorId: device.deviceId,
    deviceId: device.deviceId,
    sessionId: session.id,
    userId: author?.userId ?? null,
    agentId: author?.agentId ?? null,
    result: "success",
    metadata: frame.origin ? { origin: frame.origin } : {},
  });
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
