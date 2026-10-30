import { devices, orgMembers, orgUnits, type Tx, workProjectRepos, workSessions } from "@ocw/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import { deviceFacts, loadDeviceAccess } from "../device";
import { type PermissionService, workProjectResource } from "../organization";
import { sessionFactsForUsers } from "../work-session";

/**
 * Where a Work Zone session's memory goes and who hears about it (Phase 07.6, AUTO-06, D-10, D-11; ADR-0030/0031).
 *
 * - The unit is 07.9's: `work_sessions.project_id → work_project_repos.unit_id`, read here and never written (linking
 *   and unlinking are 07.9's routes and audits). A session whose repository is linked to no team project is unmapped.
 * - `canMapFor` reuses 07.9's linking rule through the resolver: `work_project.manage` on a team project (as
 *   `GET /work-projects` decides its manageable rows) and `device.use` on the session's device (as
 *   `POST /work-projects/:unitId/repos` checks). It never reads a role or `memory.promote`.
 * - `memoryRecipients` decides who reads the session exactly as the session's own fan-out does: the audience facts of
 *   `app.work_session_access` (through `sessionFactsForUsers`, the only caller of the rule) and `work_session.read`
 *   for each active member. Frames go to their own `user:` topics only, never `ws:` or `org:`.
 */

export type SessionRef = Pick<typeof workSessions.$inferSelect, "id" | "createdBy" | "deviceId">;

/** The team project the session's repository is linked to (07.9), or null when unmapped. */
export async function unitForSession(
  tx: Tx,
  sessionId: string,
): Promise<{ unitId: string; unitName: string } | null> {
  const [row] = await tx
    .select({ unitId: orgUnits.id, unitName: orgUnits.name })
    .from(workSessions)
    .innerJoin(workProjectRepos, eq(workProjectRepos.projectId, workSessions.projectId))
    .innerJoin(orgUnits, and(eq(orgUnits.id, workProjectRepos.unitId), eq(orgUnits.kind, "project")))
    .where(eq(workSessions.id, sessionId))
    .limit(1);
  return row ?? null;
}

/**
 * Whether `viewerId` may link the session's repository to a team project through 07.9's flow: `work_project.manage` on
 * at least one team project and `device.use` on the session's device, both decided by the resolver.
 */
export async function canMapFor(
  tx: Tx,
  perms: PermissionService,
  viewerId: string,
  session: SessionRef,
): Promise<boolean> {
  const principal = { kind: "user" as const, userId: viewerId };
  const [device] = await tx.select().from(devices).where(eq(devices.id, session.deviceId)).limit(1);
  if (!device) return false;
  const usable = await perms.decide(
    tx,
    principal,
    "device.use",
    deviceFacts(device, viewerId, await loadDeviceAccess(tx, viewerId)),
  );
  if (!usable.allowed) return false;
  const projects = await tx
    .select({
      id: orgUnits.id,
      path: orgUnits.path,
      access: sql<string | null>`app.work_project_access(${orgUnits.id}, ${viewerId}::uuid)`,
    })
    .from(orgUnits)
    .where(eq(orgUnits.kind, "project"));
  if (projects.length === 0) return false;
  const managed = await perms.filterFor(tx, principal, projects, "work_project.manage", (p) =>
    workProjectResource(p, viewerId),
  );
  return managed.length > 0;
}

/**
 * The people who read the session now (sorted ids): every active member decided on `work_session.read` with the
 * session's audience facts. The recipients of `work_session_memory.updated`, each on their own `user:` topic.
 */
export async function memoryRecipients(
  tx: Tx,
  perms: PermissionService,
  session: SessionRef,
): Promise<string[]> {
  const members = (
    await tx.select({ userId: orgMembers.userId }).from(orgMembers).where(isNull(orgMembers.deactivatedAt))
  ).map((m) => m.userId);
  if (members.length === 0) return [];
  const facts = await sessionFactsForUsers(tx, session, members);
  return perms.usersAllowed(tx, {
    candidates: members,
    permission: "work_session.read",
    resourceFor: (userId) => {
      const f = facts.get(userId);
      if (!f) throw new Error("session facts missing for a member");
      return f;
    },
  });
}
