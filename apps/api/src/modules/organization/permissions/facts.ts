import { agents, devices, orgMembers, orgUnits, permissionRules, type Tx, unitMemberships } from "@ocw/db";
import { asc, eq, inArray } from "drizzle-orm";
import type { PrincipalFacts, RuleFact } from "./resolve";

/** Who is asking. Users come from the session, cells from the cell token, devices from the device token. */
export type PrincipalRef =
  | { kind: "user"; userId: string }
  | { kind: "agent"; agentId: string; onBehalfOfUserId?: string }
  | { kind: "cell"; cellId: string }
  | { kind: "device"; deviceId: string };

const NO_UNITS = { memberUnitPaths: [] as const, leadOfUnitIds: new Set<string>() };

/**
 * Loads the principal's facts inside the caller's tenant transaction (RLS scopes every read). The only DB
 * code of the resolver: everything it returns is plain data for resolve.ts.
 */
export async function loadPrincipalFacts(tx: Tx, ref: PrincipalRef): Promise<PrincipalFacts> {
  switch (ref.kind) {
    case "user": {
      // Sequential: one transaction = one connection (pg rejects concurrent queries on a client).
      const [row] = await tx
        .select({ role: orgMembers.role, deactivatedAt: orgMembers.deactivatedAt })
        .from(orgMembers)
        .where(eq(orgMembers.userId, ref.userId))
        .limit(1);
      const units = await tx
        .select({ unitId: unitMemberships.unitId, role: unitMemberships.role, path: orgUnits.path })
        .from(unitMemberships)
        .innerJoin(orgUnits, eq(orgUnits.id, unitMemberships.unitId))
        .where(eq(unitMemberships.userId, ref.userId))
        .orderBy(asc(unitMemberships.unitId));
      return {
        kind: "user",
        id: ref.userId,
        orgRole: row?.role ?? null,
        // No membership row in this tenant = not a member: deny everything.
        deactivated: !row || row.deactivatedAt !== null,
        memberUnitPaths: units.map((u) => u.path),
        leadOfUnitIds: new Set(units.filter((u) => u.role === "lead").map((u) => u.unitId)),
      };
    }
    case "agent": {
      const [row] = await tx
        .select({ status: agents.status, deletedAt: agents.deletedAt })
        .from(agents)
        .where(eq(agents.id, ref.agentId))
        .limit(1);
      const deactivated = !row || row.status === "disabled" || row.deletedAt !== null;
      return { kind: "agent", id: ref.agentId, orgRole: null, deactivated, ...NO_UNITS };
    }
    case "cell":
      // The cell is authenticated by its token; it has no disabled state of its own.
      return { kind: "cell", id: ref.cellId, orgRole: null, deactivated: false, ...NO_UNITS };
    case "device": {
      const [row] = await tx
        .select({ revokedAt: devices.revokedAt })
        .from(devices)
        .where(eq(devices.id, ref.deviceId))
        .limit(1);
      return {
        kind: "device",
        id: ref.deviceId,
        orgRole: null,
        deactivated: !row || row.revokedAt !== null,
        ...NO_UNITS,
      };
    }
  }
}

/**
 * The facts of many users at once (reader counts, deciders): one membership query and one unit-membership query for
 * every id, each user's facts equal to `loadPrincipalFacts`. Ids that are not members of the tenant are absent.
 */
export async function loadPrincipalFactsMany(
  tx: Tx,
  userIds: readonly string[],
): Promise<Map<string, PrincipalFacts>> {
  const out = new Map<string, PrincipalFacts>();
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return out;
  const members = await tx
    .select({ userId: orgMembers.userId, role: orgMembers.role, deactivatedAt: orgMembers.deactivatedAt })
    .from(orgMembers)
    .where(inArray(orgMembers.userId, ids));
  const units = await tx
    .select({
      userId: unitMemberships.userId,
      unitId: unitMemberships.unitId,
      role: unitMemberships.role,
      path: orgUnits.path,
    })
    .from(unitMemberships)
    .innerJoin(orgUnits, eq(orgUnits.id, unitMemberships.unitId))
    .where(inArray(unitMemberships.userId, ids))
    .orderBy(asc(unitMemberships.userId), asc(unitMemberships.unitId));
  for (const m of members) {
    const mine = units.filter((u) => u.userId === m.userId);
    out.set(m.userId, {
      kind: "user",
      id: m.userId,
      orgRole: m.role,
      deactivated: m.deactivatedAt !== null,
      memberUnitPaths: mine.map((u) => u.path),
      leadOfUnitIds: new Set(mine.filter((u) => u.role === "lead").map((u) => u.unitId)),
    });
  }
  return out;
}

/** Every explicit allow/deny rule of the tenant (RLS scopes the read). */
export async function loadRules(tx: Tx): Promise<RuleFact[]> {
  const rows = await tx.select().from(permissionRules);
  return rows.map((r) => ({
    id: r.id,
    scopeUnitId: r.scopeUnitId,
    subjectKind: r.subjectKind,
    subjectId: r.subjectId,
    permission: r.permission,
    tool: r.tool,
    pathPrefix: r.pathPrefix,
    effect: r.effect,
  }));
}
