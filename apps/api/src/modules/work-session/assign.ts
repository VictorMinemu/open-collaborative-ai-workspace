import {
  ASSIGN_REFUSAL_TEXT,
  type AssignRefusal,
  AssignWorkSessionResult,
  EventTypes,
  type SessionEvent,
  type WorkSessionAssign,
} from "@ocw/contracts";
import { devices, type Tx, workSessions } from "@ocw/db";
import { eq, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { type App, authOf, type Core, tenant } from "../../core";
import { conflict, forbidden } from "../../lib/errors";
import { type DeviceAccess, deviceFacts, loadDeviceAccess } from "../device";
import type { PermissionService, ResourceFacts } from "../organization";
import { type SessionRow, type WorkSessionService, wsTopic } from "./service";
import { readers, stillReading } from "./visibility";

/**
 * Assign to me (Phase 07.13.1.1, D-03, D-04, D-05, D-11, D-12, D-13, D-15; ADR-0047). A member takes over a session that
 * runs on a server: one UPDATE of `work_sessions.created_by` under the session lock, so every owner rule (the SQL rule
 * `app.work_session_access`, the RLS backstop, the resolver's `creator` relation) moves at once (PD-01). Who reads the
 * session afterwards comes only from the SQL rule (`readers` / `stillReading`), never from a TypeScript copy of it.
 *
 * Only a server (`devices.host_kind = 'service'`, exactly; null and desktop refused), only a person who may prompt the
 * session and use its device, never a bot's session or an archived one. The creator stays in the history: the
 * `work_session.created` audit row, the `work_session.assigned` row and the `session.owner_changed` timeline event.
 */

const SessionParams = z.object({ id: z.uuid() });

type DeviceRow = typeof devices.$inferSelect;

/** What the decision reads of the session (the row, or the detail's DTO with the bot that started it). */
export type AssignSession = Pick<SessionRow, "id" | "createdBy" | "deviceId" | "status" | "startedByAgentId">;

interface AssignCheck {
  reason: AssignRefusal | null;
  device: DeviceRow | null;
  access: DeviceAccess | null;
}

/**
 * The checks in order (PD-02): may prompt the session (a revoked device is said as such), not a bot's session, not
 * archived, not already the caller's, the device not revoked and a server, and the caller may use it. Reads only.
 */
async function checkAssign(
  tx: Tx,
  perms: PermissionService,
  req: FastifyRequest,
  s: AssignSession,
  facts: ResourceFacts,
): Promise<AssignCheck> {
  const { userId } = authOf(req);
  const refuse = (reason: AssignRefusal, device: DeviceRow | null = null): AssignCheck => ({
    reason,
    device,
    access: null,
  });
  if (!(await perms.can(req, tx, "work_session.prompt", facts))) {
    const { denial } = await perms.decide(tx, { kind: "user", userId }, "work_session.prompt", facts);
    return refuse(denial?.reason === "device_revoked" ? "device_revoked" : "not_allowed");
  }
  if (s.startedByAgentId) return refuse("bot_session");
  if (s.status === "archived") return refuse("archived");
  if (s.createdBy === userId) return refuse("already_owner");
  const [d] = await tx.select().from(devices).where(eq(devices.id, s.deviceId));
  if (!d || d.revokedAt !== null) return refuse("device_revoked", d ?? null);
  // Pitfall 4: an older daemon reports nothing (null); only a device that said it runs as a service is a server.
  if (d.hostKind !== "service") return refuse("not_on_server", d);
  const access = await loadDeviceAccess(tx, userId);
  if (!(await perms.can(req, tx, "device.use", deviceFacts(d, userId, access)))) {
    return { reason: "device_not_shared", device: d, access };
  }
  return { reason: null, device: d, access };
}

/** Whether the caller may Assign the session to themselves, and the first reason why not (PD-14). Reads only. */
export async function decideAssign(
  tx: Tx,
  perms: PermissionService,
  req: FastifyRequest,
  s: AssignSession,
  facts: ResourceFacts,
): Promise<WorkSessionAssign> {
  const { reason } = await checkAssign(tx, perms, req, s, facts);
  return { allowed: reason === null, reason };
}

/** What moving the owner does, computed before any side effect (the POST applies it; the preview discards it). */
export interface Transfer {
  /** The session row as it is after the UPDATE (a new object; the caller's row is never mutated). */
  session: SessionRow;
  from: string;
  /** People who read the session before and no longer do (the previous owner included when they lose it). */
  removed: string[];
}

/**
 * The transfer itself: the readers before, the one UPDATE of `created_by`, the readers after. Writes nothing but
 * `work_sessions` (no service, realtime, hub, audit or notification dependency), so a savepoint that is rolled back
 * leaves no trace of it.
 */
export async function computeTransfer(
  tx: Tx,
  perms: PermissionService,
  s: SessionRow,
  toUserId: string,
): Promise<Transfer> {
  const before = (await readers(tx, perms, s)).map((r) => r.userId);
  await tx
    .update(workSessions)
    .set({ createdBy: toUserId, updatedAt: sql`now()` })
    .where(eq(workSessions.id, s.id));
  const session: SessionRow = { ...s, createdBy: toUserId };
  const still = await stillReading(tx, perms, session, before);
  const removed = before.filter((id) => !still.has(id));
  return { session, from: s.createdBy, removed };
}

export interface AssignRouteDeps {
  perms: PermissionService;
  svc: WorkSessionService;
  /** The route's own lock + audience 404 (routes.ts `visible`). */
  visible(req: FastifyRequest, tx: Tx, id: string): Promise<{ s: SessionRow; facts: ResourceFacts }>;
  /** The route's own device-layer denial and sentence (routes.ts `assertDeviceUsable`). */
  assertDeviceUsable(req: FastifyRequest, tx: Tx, d: DeviceRow, access: DeviceAccess): Promise<void>;
}

export function registerAssignRoutes(app: App, core: Core, deps: AssignRouteDeps): void {
  const { perms, svc, visible, assertDeviceUsable } = deps;
  const tags = ["work-session"];
  const user = { config: { authz: "user" as const }, preHandler: core.identity.requireUser };

  app.post(
    "/work-sessions/:id/assign",
    { ...user, schema: { tags, params: SessionParams, response: { 200: AssignWorkSessionResult } } },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        const auth = authOf(req);
        const { s, facts } = await visible(req, tx, req.params.id);
        const check = await checkAssign(tx, perms, req, s, facts);
        switch (check.reason) {
          case null:
            break;
          case "not_allowed":
            // The resolver's own denial (403 with its reason).
            await perms.assertCan(req, tx, "work_session.prompt", facts);
            throw forbidden(ASSIGN_REFUSAL_TEXT.not_allowed, "not_allowed");
          case "device_not_shared":
            await assertDeviceUsable(req, tx, check.device!, check.access!);
            throw forbidden(ASSIGN_REFUSAL_TEXT.device_not_shared, "device_not_shared");
          case "already_owner":
            return {
              session: (await svc.session(tx, s.id))!,
              removedCount: 0,
              cancelledPrompts: 0,
              settingsDowngraded: false,
            };
          default:
            throw conflict(ASSIGN_REFUSAL_TEXT[check.reason], check.reason);
        }
        const d = check.device!;
        const t = await computeTransfer(tx, perms, s, auth.userId);

        await core.audit.record(tx, {
          action: "work_session.assigned",
          resourceType: "work_session",
          resourceId: s.id,
          sessionId: s.id,
          deviceId: s.deviceId,
          clientKind: auth.clientKind,
          // Ids, the device's self-reported host label and counts only (T-07.13.1.1-02-06, -09).
          metadata: {
            from: t.from,
            to: auth.userId,
            visibility: s.visibility,
            hostKind: d.hostKind,
            deviceOwnerId: d.ownerUserId,
            removedCount: t.removed.length,
            cancelledPrompts: 0,
            settingsDowngraded: false,
          },
        });
        // The timeline line (server-only: a device can never write it), as `account.switched` is written.
        const event: SessionEvent = {
          type: "session.owner_changed",
          fromUserId: t.from,
          toUserId: auth.userId,
        };
        await core.realtime.appendEvent(tx, wsTopic(s.id), EventTypes.workSessionEvent, {
          at: new Date().toISOString(),
          event,
        });
        // Re-decides every live `ws:` subscription, the browser live view and the sign-in access watch.
        await core.realtime.appendEvent(tx, wsTopic(s.id), EventTypes.workSessionVisibilityChanged, {
          workSessionId: s.id,
        });
        const session = await svc.emitSession(tx, s.id);
        svc.notifyRemovedAfterCommit(tx, s.id, t.removed);
        return {
          session: session!,
          removedCount: t.removed.length,
          cancelledPrompts: 0,
          settingsDowngraded: false,
        };
      }),
  );
}
