import {
  ASSIGN_REFUSAL_TEXT,
  AssignPreview,
  type AssignRefusal,
  AssignWorkSessionResult,
  EventTypes,
  type SessionEvent,
  type WorkSessionAssign,
} from "@ocw/contracts";
import { conversationMembers, devices, type Tx, withSavepoint, workPrompts, workSessions } from "@ocw/db";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { type App, authOf, type Core, tenant } from "../../core";
import { conflict, forbidden } from "../../lib/errors";
import { type DeviceAccess, deviceFacts, loadDeviceAccess } from "../device";
import type { PermissionService, ResourceFacts } from "../organization";
import { IN_FLIGHT, type SessionRow, type WorkSessionService, wsTopic } from "./service";
import { readers, stillReading } from "./visibility";

/**
 * Assign to me (Phase 07.13.1.1, D-03, D-04, D-05, D-11, D-12, D-13, D-15; ADR-0047). A member takes over a session that
 * runs on a server: one UPDATE of `work_sessions.created_by` under the session lock, so every owner rule (the SQL
 * access rule, the RLS backstop, the resolver's `creator` relation) moves at once (PD-01). Who reads the
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
  /** The queued prompts those people wrote (ids only; the POST cancels them, D-13, PD-05). */
  removedPrompts: string[];
  /** A turn is in flight (it finishes; never cut, D-05). */
  turnRunning: boolean;
}

/**
 * The transfer itself: the readers before, the one UPDATE of `created_by`, the readers after, and what that means for
 * the queue (read, never changed). Writes nothing but `work_sessions` (no service, realtime, hub, audit or
 * notification dependency), so a savepoint that is rolled back leaves no trace of it, in the database or in memory.
 */
export async function computeTransfer(
  tx: Tx,
  perms: PermissionService,
  s: SessionRow,
  toUserId: string,
): Promise<Transfer> {
  const before = (await readers(tx, perms, s)).map((r) => r.userId);
  // IN-01: under RLS a row USING hides is skipped without an error; the transfer must then stop before any audit,
  // role swap, cancelled prompt or timeline line claims an owner that did not move.
  const moved = await tx
    .update(workSessions)
    .set({ createdBy: toUserId, updatedAt: sql`now()` })
    .where(eq(workSessions.id, s.id))
    .returning({ id: workSessions.id });
  if (moved.length !== 1) throw conflict(ASSIGN_REFUSAL_TEXT.not_allowed, "not_allowed");
  const session: SessionRow = { ...s, createdBy: toUserId };
  const still = await stillReading(tx, perms, session, before);
  const removed = before.filter((id) => !still.has(id));
  // Pitfall 3: the dispatcher re-checks an author's device cap, not their audience, so the queued prompts of the
  // people the transfer removes would run in a session they no longer see. A bot's prompt (author_agent_id) is not
  // a person's and stays (bot sessions are refused anyway).
  const prompts =
    removed.length === 0
      ? []
      : await tx
          .select({ id: workPrompts.id })
          .from(workPrompts)
          .where(
            and(
              eq(workPrompts.workSessionId, s.id),
              eq(workPrompts.status, "queued"),
              inArray(workPrompts.authorUserId, removed),
              isNull(workPrompts.authorAgentId),
            ),
          )
          .orderBy(asc(workPrompts.position), asc(workPrompts.createdAt));
  const inFlight = await tx
    .select({ id: workPrompts.id })
    .from(workPrompts)
    .where(and(eq(workPrompts.workSessionId, s.id), inArray(workPrompts.status, IN_FLIGHT)))
    .limit(1);
  return {
    session,
    from: s.createdBy,
    removed,
    removedPrompts: prompts.map((p) => p.id),
    turnRunning: inFlight.length > 0,
  };
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

        // D-13, PD-05: the queued prompts of the people who lost the session go, each audited, in this transaction.
        const cancelled =
          t.removedPrompts.length === 0
            ? []
            : await tx
                .update(workPrompts)
                .set({ status: "cancelled", completedAt: sql`now()` })
                .where(and(inArray(workPrompts.id, t.removedPrompts), eq(workPrompts.status, "queued")))
                .returning();
        for (const p of cancelled) {
          await svc.emitPrompt(tx, p);
          await core.audit.record(tx, {
            action: "work_prompt.cancelled",
            resourceType: "work_prompt",
            resourceId: p.id,
            sessionId: s.id,
            deviceId: s.deviceId,
            clientKind: auth.clientKind,
            metadata: {
              promptId: p.id,
              authorUserId: p.authorUserId,
              cancelledBy: auth.userId,
              cause: "owner_changed",
            },
          });
        }
        // The session's conversation follows its owner (the `joinConversation` shape): new owner `owner`, previous `member`.
        await tx
          .insert(conversationMembers)
          .values(
            [
              { userId: auth.userId, role: "owner" as const },
              { userId: t.from, role: "member" as const },
            ].map((m) => ({
              conversationId: s.conversationId,
              organizationId: s.organizationId,
              memberKind: "user" as const,
              memberId: m.userId,
              role: m.role,
            })),
          )
          .onConflictDoUpdate({
            target: [
              conversationMembers.conversationId,
              conversationMembers.memberKind,
              conversationMembers.memberId,
            ],
            set: { role: sql`excluded.role` },
          });
        // D-05, PD-03: the settings drop to what the new owner may use on the device, between turns; the running turn
        // finishes (no interrupt). The wire reason stays `access_changed` (Pitfall 2); the cause is in the audit only.
        const { downgraded } = await svc.reauthorize(
          tx,
          t.session,
          "access_changed",
          undefined,
          auth.userId,
          {
            interruptInFlight: false,
            cause: "owner_changed",
          },
        );

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
            cancelledPrompts: cancelled.length,
            settingsDowngraded: downgraded,
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
          cancelledPrompts: cancelled.length,
          settingsDowngraded: downgraded,
        };
      }),
  );

  /**
   * The confirm dialog (D-13, D-15, PD-14): the same decision as the POST and, when allowed, what the POST would do,
   * from the same `computeTransfer` run in a savepoint that is always rolled back (its after-commit callbacks dropped
   * with it). Writes nothing; a refusal opens no savepoint.
   */
  app.get(
    "/work-sessions/:id/assign",
    { ...user, schema: { tags, params: SessionParams, response: { 200: AssignPreview } } },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        const { userId } = authOf(req);
        const { s, facts } = await visible(req, tx, req.params.id);
        const { reason } = await checkAssign(tx, perms, req, s, facts);
        if (reason !== null) {
          return {
            allowed: false,
            reason,
            previousOwnerLosesAccess: false,
            othersLosingAccess: 0,
            cancelledPrompts: 0,
            turnRunning: false,
          };
        }
        const t = await withSavepoint(
          tx,
          (sp) => computeTransfer(sp, perms, s, userId),
          () => false,
        );
        return {
          allowed: true,
          reason: null,
          previousOwnerLosesAccess: t.removed.includes(t.from),
          othersLosingAccess: t.removed.filter((id) => id !== t.from).length,
          cancelledPrompts: t.removedPrompts.length,
          turnRunning: t.turnRunning,
        };
      }),
  );
}
