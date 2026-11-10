import { TEAM_MENTION_LIMITS } from "@ocw/contracts";
import { orgUnits, type Tx } from "@ocw/db";
import { inArray, sql } from "drizzle-orm";

/**
 * Team mention audience (07.17 D-07, D-13, PD-14, AFO-04): who a message's `{ kind: "unit" }` mentions reach. A team
 * or department reaches the active members of every unit of its subtree (`org_units.path @> [unit]`, on
 * `org_units_path_gin`), the author excluded. Ids only: no unit name or handle is read, logged or audited here (P1).
 *
 * Readability is never decided by this module's SQL: the caller passes the resolver's `isReadable` (P-03), which runs
 * before the cap (CR-02), and the service's `eligible` checks again at delivery. Tenant isolation is RLS on `org_units`,
 * `unit_memberships` and `org_members` (the transaction's organization), so another organization's unit id reaches
 * nobody. Bots are never unit members (memberships reference people), so a bot is never in the audience (P4).
 */

const uuidArray = (ids: readonly string[]) => sql`${`{${ids.join(",")}}`}::uuid[]`;

/**
 * How many subtree members one message's team mentions consider before the reader check (07.17 code review CR-02): a
 * generous bound on the work, never the recipient cap. The cap (`TEAM_MENTION_LIMITS.recipientsPerMessage`) is taken
 * after readability, so it is never spent on people who cannot read the conversation.
 */
export const TEAM_MENTION_CANDIDATES = 2_000;

/**
 * The people each mentioned unit reaches, in mention order: every person once, under the first unit (in mention order)
 * that reached them, then by user id within a unit (D-13). Readers are decided before the cap (07.17 code review
 * CR-02): candidates are walked in that order through `readable` (the resolver's `isReadable`, supplied by the
 * caller; absent = every candidate, for callers that decide later) until `TEAM_MENTION_LIMITS.recipientsPerMessage`
 * people are kept. In a private channel only its user members are candidates at all (the resolver reads private
 * channels for members only, so this narrows and never decides). Units that reach nobody (or only the author, or only
 * people already listed) are left out.
 */
export async function teamMentionAudience(
  tx: Tx,
  p: {
    unitIds: string[];
    authorUserId: string | null;
    /** The channel the message is in: unless it is public, only its user members are candidates. */
    conversationId?: string | null;
    /** Whether a candidate can read the conversation (decided before the cap). */
    readable?: ((userId: string) => Promise<boolean>) | null;
  },
): Promise<Array<{ unitId: string; userIds: string[] }>> {
  const unitIds = [...new Set(p.unitIds)];
  if (unitIds.length === 0) return [];
  const conversationId = p.conversationId ?? null;
  const res = await tx.execute(sql`
    select um.user_id, (array_agg(m.unit_id order by m.ord))[1] as unit_id, min(m.ord) as ord
    from unnest(${uuidArray(unitIds)}) with ordinality as m(unit_id, ord)
    join app.org_units mu on mu.id = m.unit_id and mu.kind in ('team', 'department')
    join app.org_units u on u.organization_id = mu.organization_id and u.path @> array[m.unit_id]
    join app.unit_memberships um on um.unit_id = u.id and um.organization_id = u.organization_id
    join app.org_members om
      on om.user_id = um.user_id and om.organization_id = um.organization_id and om.deactivated_at is null
    where ${p.authorUserId === null ? sql`true` : sql`um.user_id <> ${p.authorUserId}::uuid`}
      and ${
        conversationId === null
          ? sql`true`
          : sql`(
              exists (select 1 from app.conversations c where c.id = ${conversationId}::uuid and c.visibility = 'public')
              or exists (
                select 1 from app.conversation_members cm
                where cm.conversation_id = ${conversationId}::uuid and cm.member_kind = 'user'
                  and cm.member_id = um.user_id))`
      }
    group by um.user_id
    order by min(m.ord), um.user_id
    limit ${TEAM_MENTION_CANDIDATES}`);
  const byUnit = new Map<string, string[]>();
  let kept = 0;
  for (const r of res.rows as Array<{ user_id: string; unit_id: string }>) {
    if (kept >= TEAM_MENTION_LIMITS.recipientsPerMessage) break;
    if (p.readable && !(await p.readable(r.user_id))) continue;
    const list = byUnit.get(r.unit_id) ?? [];
    list.push(r.user_id);
    byUnit.set(r.unit_id, list);
    kept += 1;
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
