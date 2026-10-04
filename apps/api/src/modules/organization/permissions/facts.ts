import { orgMembers, permissionRules, type Tx } from "@ocw/db";
import { eq } from "drizzle-orm";
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
      const [row] = await tx
        .select({ role: orgMembers.role, deactivatedAt: orgMembers.deactivatedAt })
        .from(orgMembers)
        .where(eq(orgMembers.userId, ref.userId))
        .limit(1);
      return {
        kind: "user",
        id: ref.userId,
        orgRole: row?.role ?? null,
        // No membership row in this tenant = not a member: deny everything.
        deactivated: !row || row.deactivatedAt !== null,
        ...NO_UNITS,
      };
    }
    case "agent":
      return { kind: "agent", id: ref.agentId, orgRole: null, deactivated: false, ...NO_UNITS };
    case "cell":
      return { kind: "cell", id: ref.cellId, orgRole: null, deactivated: false, ...NO_UNITS };
    case "device":
      return { kind: "device", id: ref.deviceId, orgRole: null, deactivated: false, ...NO_UNITS };
  }
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
    effect: r.effect,
  }));
}
