import { MemoryPreferences, SessionMemorySummary } from "@ocw/contracts";
import {
  approvalRequests,
  orgMembers,
  type Tx,
  workMemoryPrefs,
  workSessionMemory,
  workSessions,
} from "@ocw/db";
import { eq, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { type App, authOf, type Core, tenant } from "../../core";
import { conflict, forbidden } from "../../lib/errors";
import type { ModelGateway } from "../model-gateway";
import { AuthzDeniedError, type PermissionService } from "../organization";
import { sessionFacts } from "../work-session";
import { canMapFor, unitForSession } from "./session-unit";
import { hasNewWork, summaryModelFor } from "./summarize";

/**
 * Work Zone → memory routes (Phase 07.6, AUTO-06, D-06, D-07, D-10, D-11; UI-SPEC R7, surface 9).
 *
 *   GET  /work-sessions/:id/memory          the session's summary state, per viewer (`canPropose`, `canMap`, model)
 *   POST /work-sessions/:id/memory/propose  the owner asks for a summary (202; the job writes it)
 *   GET  /me/preferences                    the caller's Work Zone memory preference (automatic proposals, off)
 *   PUT  /me/preferences                    changes it (audited)
 *
 * Every session route first loads the session in the caller's tenant transaction (RLS + the audience backstop) and
 * decides `work_session.read` on `sessionFacts` (`app.work_session_access`, the one audience rule), hidden as the 404 of
 * a missing session, before reading anything else (D-11). Only the owner proposes and pays.
 */

const SESSION_NOT_FOUND = "Work session not found";
const SessionParams = z.object({ id: z.uuid() });
const Accepted = z.object({ ok: z.literal(true) });

export interface WorkMemoryRouteDeps {
  core: Core;
  perms: PermissionService;
  gateway: ModelGateway;
}

type SessionRow = typeof workSessions.$inferSelect;

/** The session as the caller may read it, or the 404 of a missing session (also for one outside its audience). */
async function readable(
  req: FastifyRequest,
  tx: Tx,
  perms: PermissionService,
  id: string,
): Promise<SessionRow> {
  const { userId } = authOf(req);
  const [s] = await tx.select().from(workSessions).where(eq(workSessions.id, id)).limit(1);
  if (!s) {
    throw new AuthzDeniedError(
      { permission: "work_session.read", layer: "resource", reason: "not_in_audience" },
      { hideAs404: true, message: SESSION_NOT_FOUND },
    );
  }
  await perms.assertCan(req, tx, "work_session.read", await sessionFacts(tx, userId, s), {
    hideAs404: true,
  });
  return s;
}

/** The per-viewer summary state of one session (the only surface carrying `canPropose` / `canMap`, D-11). */
async function summaryFor(
  tx: Tx,
  deps: WorkMemoryRouteDeps,
  s: SessionRow,
  viewerId: string,
): Promise<SessionMemorySummary> {
  const [mem] = await tx
    .select()
    .from(workSessionMemory)
    .where(eq(workSessionMemory.workSessionId, s.id))
    .limit(1);
  const now = await unitForSession(tx, s.id);
  const isOwner = viewerId === s.createdBy;
  const newWork = await hasNewWork(tx, s.id, mem?.summarizedSeq ?? null);
  const unitName = async (unitId: string | null) => {
    if (!unitId) return null;
    if (now?.unitId === unitId) return { id: unitId, name: now.unitName };
    const res = await tx.execute(sql`select name from app.org_units where id = ${unitId}::uuid`);
    const name = (res.rows[0] as { name?: string } | undefined)?.name;
    return name ? { id: unitId, name } : null;
  };

  let status: SessionMemorySummary["status"] = now ? "none" : "unmapped";
  let unit = now ? { id: now.unitId, name: now.unitName } : null;
  let decidedBy: SessionMemorySummary["decidedBy"] = null;
  let decisionNote: string | null = null;
  const proposalId = mem?.approvalId ?? null;
  const nothingNew = mem?.status === "proposed" && !newWork;
  if (mem?.status === "writing") {
    status = "writing";
    unit = (await unitName(mem.unitId)) ?? unit;
  } else if (mem?.status === "failed") {
    // A failure is shown while the session can still be summarized there; unlinked since, it reads as unmapped.
    if (now) status = "failed";
  } else if (mem?.status === "proposed" && (nothingNew || now)) {
    // The last proposal stands until new work can be proposed (P-15): then the strip offers Propose again.
    if (nothingNew) {
      const [approval] = mem.approvalId
        ? await tx
            .select({
              status: approvalRequests.status,
              decidedBy: approvalRequests.decidedBy,
              decisionNote: approvalRequests.decisionNote,
            })
            .from(approvalRequests)
            .where(eq(approvalRequests.id, mem.approvalId))
            .limit(1)
        : [];
      status =
        approval?.status === "applied" || approval?.status === "approved"
          ? "applied"
          : approval?.status === "denied"
            ? "denied"
            : approval?.status === "pending"
              ? "pending"
              : "failed";
      unit = (await unitName(mem.unitId)) ?? unit;
      if (approval?.decidedBy) {
        const [who] = await tx
          .select({ displayName: orgMembers.displayName })
          .from(orgMembers)
          .where(eq(orgMembers.userId, approval.decidedBy))
          .limit(1);
        decidedBy = { id: approval.decidedBy, displayName: who?.displayName ?? "Former member" };
        decisionNote = approval.decisionNote ?? null;
      }
    }
  }

  const model = isOwner ? await summaryModelFor(tx, deps.gateway, viewerId) : null;
  return {
    status,
    unit,
    proposalId,
    auto: mem?.auto ?? false,
    nothingNew,
    decidedBy,
    decisionNote,
    canPropose: isOwner,
    // Meaningful only while unmapped; decided with 07.9's linking rule, never a role or `memory.promote` (D-10).
    canMap: now === null ? await canMapFor(tx, deps.perms, viewerId, s) : false,
    model: model ? { label: model.label, metered: model.metered, plan: model.plan } : null,
  };
}

export function registerWorkMemoryRoutes(app: App, deps: WorkMemoryRouteDeps): void {
  const { core, perms } = deps;
  const user = { config: { authz: "user" as const }, onRequest: core.identity.requireUser };
  const tags = ["work-session"];

  app.get(
    "/work-sessions/:id/memory",
    { ...user, schema: { tags, params: SessionParams, response: { 200: SessionMemorySummary } } },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        const s = await readable(req, tx, perms, req.params.id);
        return summaryFor(tx, deps, s, authOf(req).userId);
      }),
  );

  app.post(
    "/work-sessions/:id/memory/propose",
    { ...user, schema: { tags, params: SessionParams, response: { 202: Accepted } } },
    async (req, reply) => {
      await core.db.withTenant(tenant(req), async (tx) => {
        const s = await readable(req, tx, perms, req.params.id);
        // Only the owner proposes, and pays (D-07).
        if (authOf(req).userId !== s.createdBy) {
          throw forbidden("Only the person who started this session can propose it", "not_session_owner");
        }
        if (s.status !== "completed" && s.status !== "archived") {
          throw conflict("The session has not ended", "session_not_finished");
        }
        if (!(await unitForSession(tx, s.id))) {
          throw conflict("This repository isn't linked to a project's memory", "session_unmapped");
        }
        const [mem] = await tx
          .select()
          .from(workSessionMemory)
          .where(eq(workSessionMemory.workSessionId, s.id))
          .limit(1);
        if (mem?.status === "writing") return;
        if (!(await hasNewWork(tx, s.id, mem?.summarizedSeq ?? null))) {
          throw conflict("Already proposed. Nothing new since then.", "nothing_new");
        }
        await core.jobs.sendInTx(
          tx,
          "work_session.summarize",
          { organizationId: s.organizationId, workSessionId: s.id, mode: "manual" },
          { singletonKey: `ws:${s.id}:${s.lastLocalSeq}:manual` },
        );
      });
      return reply.status(202).send({ ok: true as const });
    },
  );

  app.get(
    "/me/preferences",
    {
      ...user,
      preHandler: perms.requirePermission("work_session.read"),
      schema: { tags, response: { 200: MemoryPreferences } },
    },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        const [row] = await tx
          .select({ autoPropose: workMemoryPrefs.autoPropose })
          .from(workMemoryPrefs)
          .where(eq(workMemoryPrefs.userId, authOf(req).userId))
          .limit(1);
        return { autoProposeSessionSummaries: row?.autoPropose ?? false };
      }),
  );

  app.put(
    "/me/preferences",
    {
      ...user,
      preHandler: perms.requirePermission("work_session.read"),
      schema: { tags, body: MemoryPreferences, response: { 200: MemoryPreferences } },
    },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        const { userId } = authOf(req);
        const autoPropose = req.body.autoProposeSessionSummaries;
        const [before] = await tx
          .select({ autoPropose: workMemoryPrefs.autoPropose })
          .from(workMemoryPrefs)
          .where(eq(workMemoryPrefs.userId, userId))
          .limit(1);
        await tx
          .insert(workMemoryPrefs)
          .values({ organizationId: tenant(req).organizationId, userId, autoPropose })
          .onConflictDoUpdate({
            target: [workMemoryPrefs.organizationId, workMemoryPrefs.userId],
            set: { autoPropose, updatedAt: sql`now()` },
          });
        if ((before?.autoPropose ?? false) !== autoPropose) {
          await core.audit.record(tx, {
            action: "work_memory.preferences_updated",
            resourceType: "user",
            resourceId: userId,
            metadata: { autoProposeSessionSummaries: autoPropose },
          });
        }
        return { autoProposeSessionSummaries: autoPropose };
      }),
  );
}
