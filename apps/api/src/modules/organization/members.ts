import {
  EventTypes,
  type Member,
  MemberDetail,
  MemberDetailList,
  type MemberUnitRef,
  type OrgRole,
  UpdateMemberRoleRequest,
  UserIdParams,
} from "@ocw/contracts";
import { orgMembers, orgUnits, type Tx, unitMemberships } from "@ocw/db";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { type App, authOf, type Core, tenant } from "../../core";
import { badRequest, conflict, notFound } from "../../lib/errors";
import { memberResource } from "./permissions/policy";
import type { PermissionService } from "./permissions/service";

/** The organization must always keep one active member holding this role (D-06, Pitfall 7). */
const GOVERNING_ROLE: OrgRole = "admin";
/** Org roles that cannot lead a unit: demoting to them downgrades every unit lead membership. */
const NON_LEAD_ROLES: readonly OrgRole[] = ["standard", "developer"];

type MemberRow = typeof orgMembers.$inferSelect;

function toMember(r: MemberRow): Member {
  return {
    userId: r.userId,
    displayName: r.displayName,
    email: r.email,
    avatarUrl: r.avatarUrl,
    role: r.role,
    status: r.deactivatedAt ? ("deactivated" as const) : ("active" as const),
    statusEmoji: r.statusEmoji ?? null,
    statusText: r.statusText ?? null,
    joinedAt: new Date(r.joinedAt).toISOString(),
  };
}

/** Public interface for other modules: member lookups inside an existing tenant transaction. */
export async function listMembers(tx: Tx): Promise<Member[]> {
  const rows = await tx.select().from(orgMembers).orderBy(asc(orgMembers.displayName));
  return rows.map(toMember);
}

/** Map of userId → display info for author resolution (users only; agents live in the agent module). */
export async function memberDirectory(tx: Tx): Promise<Map<string, Member>> {
  return new Map((await listMembers(tx)).map((m) => [m.userId, m]));
}

/**
 * Members with their unit chips (ORG-04, ORG-06), ordered by display name. `userIds` narrows the result;
 * units load in one query and are grouped in memory.
 */
export async function loadMemberDetails(tx: Tx, userIds?: readonly string[]): Promise<MemberDetail[]> {
  if (userIds && userIds.length === 0) return [];
  const rows = await tx
    .select()
    .from(orgMembers)
    .where(userIds ? inArray(orgMembers.userId, [...userIds]) : undefined)
    .orderBy(asc(orgMembers.displayName));
  if (rows.length === 0) return [];
  const units = await tx
    .select({
      userId: unitMemberships.userId,
      unitId: orgUnits.id,
      name: orgUnits.name,
      kind: orgUnits.kind,
      role: unitMemberships.role,
    })
    .from(unitMemberships)
    .innerJoin(orgUnits, eq(orgUnits.id, unitMemberships.unitId))
    .where(userIds ? inArray(unitMemberships.userId, [...userIds]) : undefined)
    .orderBy(asc(orgUnits.name));
  const byUser = new Map<string, MemberUnitRef[]>();
  for (const { userId, ...unit } of units) {
    const list = byUser.get(userId) ?? [];
    list.push(unit);
    byUser.set(userId, list);
  }
  return rows.map((r) => ({ ...toMember(r), units: byUser.get(r.userId) ?? [] }));
}

async function memberRow(tx: Tx, userId: string): Promise<MemberRow> {
  const [row] = await tx.select().from(orgMembers).where(eq(orgMembers.userId, userId)).limit(1);
  if (!row) throw notFound("Member not found", "member_not_found");
  return row;
}

async function memberDetail(tx: Tx, userId: string): Promise<MemberDetail> {
  const [detail] = await loadMemberDetails(tx, [userId]);
  if (!detail) throw notFound("Member not found", "member_not_found");
  return detail;
}

/**
 * Last-admin invariant: locks every active admin row of the organization (RLS scopes the statement) so two
 * concurrent demotions or deactivations serialize, then refuses when `userId` is the only one left.
 */
async function assertNotLastAdmin(tx: Tx, userId: string): Promise<void> {
  const res = await tx.execute(
    sql`select user_id from app.org_members where role = ${GOVERNING_ROLE} and deactivated_at is null for update`,
  );
  const admins = (res.rows as Array<{ user_id: string }>).map((r) => r.user_id);
  if (admins.includes(userId) && admins.length === 1) {
    throw conflict("The organization must keep at least one active admin", "last_admin");
  }
}

export function registerMemberRoutes(app: App, core: Core, perms: PermissionService): void {
  app.get(
    "/members",
    {
      config: { authz: "user" },
      preHandler: [core.identity.requireUser, perms.requirePermission("member.read")],
      // Superset of MemberList: clients that parse MemberList keep working.
      schema: { tags: ["organization"], response: { 200: MemberDetailList } },
    },
    async (req) => ({ members: await core.db.withTenant(tenant(req), (tx) => loadMemberDetails(tx)) }),
  );

  /** ORG-06: any member's profile (role, units, status). */
  app.get(
    "/members/:userId",
    {
      config: { authz: "user" },
      preHandler: [core.identity.requireUser, perms.requirePermission("member.read")],
      schema: { tags: ["organization"], params: UserIdParams, response: { 200: MemberDetail } },
    },
    async (req) => core.db.withTenant(tenant(req), (tx) => memberDetail(tx, req.params.userId)),
  );

  /**
   * Deactivation keeps the member's history but ends access: authenticate and the resolver reject them from
   * the commit on; their sessions are deleted and the revocation is fanned out after the commit.
   */
  app.post(
    "/members/:userId/deactivate",
    {
      config: { authz: "user" },
      preHandler: core.identity.requireUser,
      schema: { tags: ["organization"], params: UserIdParams, response: { 200: MemberDetail } },
    },
    async (req) => {
      const auth = authOf(req);
      const { userId } = req.params;
      return core.db.withTenant(tenant(req), async (tx, afterCommit) => {
        await perms.assertCan(req, tx, "member.manage", memberResource(userId, auth.userId));
        const target = await memberRow(tx, userId);
        if (userId === auth.userId)
          throw badRequest("You cannot deactivate yourself", "cannot_deactivate_self");
        if (target.deactivatedAt) throw conflict("This member is already deactivated", "already_deactivated");
        if (target.role === GOVERNING_ROLE) await assertNotLastAdmin(tx, userId);
        await tx.update(orgMembers).set({ deactivatedAt: sql`now()` }).where(eq(orgMembers.userId, userId));
        await core.audit.record(tx, {
          action: "member.deactivated",
          resourceType: "member",
          resourceId: userId,
          metadata: { userId },
        });
        await core.realtime.appendEvent(tx, `org:${auth.organizationId}`, EventTypes.memberUpdated, {
          userId,
          changed: ["status"],
        });
        afterCommit(async () => {
          const sessionIds = await core.identity.sessions.deleteAllForUser(userId);
          await core.realtime.publishRevocation({ sessionIds, userId, reason: "deactivated" });
        });
        return memberDetail(tx, userId);
      });
    },
  );

  app.post(
    "/members/:userId/reactivate",
    {
      config: { authz: "user" },
      preHandler: core.identity.requireUser,
      schema: { tags: ["organization"], params: UserIdParams, response: { 200: MemberDetail } },
    },
    async (req) => {
      const auth = authOf(req);
      const { userId } = req.params;
      return core.db.withTenant(tenant(req), async (tx) => {
        await perms.assertCan(req, tx, "member.manage", memberResource(userId, auth.userId));
        const target = await memberRow(tx, userId);
        if (!target.deactivatedAt) throw conflict("This member is active", "not_deactivated");
        await tx.update(orgMembers).set({ deactivatedAt: null }).where(eq(orgMembers.userId, userId));
        await core.audit.record(tx, {
          action: "member.reactivated",
          resourceType: "member",
          resourceId: userId,
          metadata: { userId },
        });
        await core.realtime.appendEvent(tx, `org:${auth.organizationId}`, EventTypes.memberUpdated, {
          userId,
          changed: ["status"],
        });
        return memberDetail(tx, userId);
      });
    },
  );

  /** ORG-02 / D-06: an admin assigns any of the four PRD roles; effective on the member's next request. */
  app.patch(
    "/members/:userId/role",
    {
      config: { authz: "user" },
      preHandler: core.identity.requireUser,
      schema: {
        tags: ["organization"],
        params: UserIdParams,
        body: UpdateMemberRoleRequest,
        response: { 200: MemberDetail },
      },
    },
    async (req) => {
      const auth = authOf(req);
      const { userId } = req.params;
      const to = req.body.role;
      return core.db.withTenant(tenant(req), async (tx) => {
        await perms.assertCan(req, tx, "member.manage", memberResource(userId, auth.userId));
        const target = await memberRow(tx, userId);
        const from = target.role;
        if (from === to) return memberDetail(tx, userId);
        if (from === GOVERNING_ROLE && to !== GOVERNING_ROLE && !target.deactivatedAt) {
          await assertNotLastAdmin(tx, userId);
        }
        if (NON_LEAD_ROLES.includes(to)) {
          const downgraded = await tx
            .update(unitMemberships)
            .set({ role: "member" })
            .where(and(eq(unitMemberships.userId, userId), eq(unitMemberships.role, "lead")))
            .returning({ unitId: unitMemberships.unitId });
          for (const { unitId } of downgraded) {
            await core.audit.record(tx, {
              action: "unit_membership.role_changed",
              resourceType: "unit",
              resourceId: unitId,
              metadata: { userId, unitId, from: "lead", to: "member", reason: "org_role_changed" },
            });
          }
        }
        await tx.update(orgMembers).set({ role: to }).where(eq(orgMembers.userId, userId));
        await core.audit.record(tx, {
          action: "member.role_changed",
          resourceType: "member",
          resourceId: userId,
          metadata: { userId, from, to },
        });
        await core.realtime.appendEvent(tx, `org:${auth.organizationId}`, EventTypes.memberUpdated, {
          userId,
          changed: ["role"],
        });
        return memberDetail(tx, userId);
      });
    },
  );
}
