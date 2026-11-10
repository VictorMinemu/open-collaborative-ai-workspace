import { TEAM_MENTION_LIMITS } from "@ocw/contracts";
import { orgUnits, type Tx } from "@ocw/db";
import { inArray, sql } from "drizzle-orm";

/**
 * Team mention audience (07.17 D-07, D-13, PD-14, AFO-04): who a message's `{ kind: "unit" }` mentions reach. A team
 * or department reaches the active members of every unit of its subtree (`org_units.path @> [unit]`, on
 * `org_units_path_gin`), the author excluded. Ids only: no unit name or handle is read, logged or audited here (P1).
 *
 * Readability is NOT decided here: the service offers these people `team_mention` and `eligible` (the resolver's
 * `isReadable`) keeps only those who can read the conversation (P-03). Tenant isolation is RLS on `org_units`,
 * `unit_memberships` and `org_members` (the transaction's organization), so another organization's unit id reaches
 * nobody. Bots are never unit members (memberships reference people), so a bot is never in the audience (P4).
 */

const uuidArray = (ids: readonly string[]) => sql`${`{${ids.join(",")}}`}::uuid[]`;

/**
 * The people each mentioned unit reaches, in mention order: every person once, under the first unit (in mention order)
 * that reached them, at most `TEAM_MENTION_LIMITS.recipientsPerMessage` people per message, the first by user id
 * (D-13). Units that reach nobody (or only the author, or only people already listed) are left out.
 */
export async function teamMentionAudience(
  tx: Tx,
  p: { unitIds: string[]; authorUserId: string | null },
): Promise<Array<{ unitId: string; userIds: string[] }>> {
  const unitIds = [...new Set(p.unitIds)];
  if (unitIds.length === 0) return [];
  const res = await tx.execute(sql`
    select um.user_id, (array_agg(m.unit_id order by m.ord))[1] as unit_id
    from unnest(${uuidArray(unitIds)}) with ordinality as m(unit_id, ord)
    join app.org_units mu on mu.id = m.unit_id and mu.kind in ('team', 'department')
    join app.org_units u on u.organization_id = mu.organization_id and u.path @> array[m.unit_id]
    join app.unit_memberships um on um.unit_id = u.id and um.organization_id = u.organization_id
    join app.org_members om
      on om.user_id = um.user_id and om.organization_id = um.organization_id and om.deactivated_at is null
    where ${p.authorUserId === null ? sql`true` : sql`um.user_id <> ${p.authorUserId}::uuid`}
    group by um.user_id
    order by um.user_id
    limit ${TEAM_MENTION_LIMITS.recipientsPerMessage}`);
  const byUnit = new Map<string, string[]>();
  for (const r of res.rows as Array<{ user_id: string; unit_id: string }>) {
    const list = byUnit.get(r.unit_id) ?? [];
    list.push(r.user_id);
    byUnit.set(r.unit_id, list);
  }
  return unitIds.flatMap((unitId) => {
    const userIds = byUnit.get(unitId);
    return userIds ? [{ unitId, userIds }] : [];
  });
}

/** What a `team_mention` shows of its unit (`Notification.unit`), read at delivery and at read time. */
export interface TeamMentionUnit {
  id: string;
  handle: string;
  name: string;
}

/** The units a set of `team_mention` rows name, by id (a unit that is gone is simply absent: `unit: null`). */
export async function teamMentionUnits(
  tx: Tx,
  ids: ReadonlyArray<string | null>,
): Promise<Map<string, TeamMentionUnit>> {
  const wanted = [...new Set(ids.filter((id): id is string => id !== null))];
  if (wanted.length === 0) return new Map();
  const rows = await tx
    .select({ id: orgUnits.id, handle: orgUnits.handle, name: orgUnits.name })
    .from(orgUnits)
    .where(inArray(orgUnits.id, wanted));
  return new Map(rows.map((r) => [r.id, r]));
}
