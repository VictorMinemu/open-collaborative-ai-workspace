import { agentMemberData, type Tx, tenantOf } from "@ocw/db";
import { and, eq, sql } from "drizzle-orm";

/**
 * Sticky member data (07.8-28, WINDOWS #292, ADR-0029; D-11, D-13, P-11). `agent_turns.member_data` used to hold only
 * for the turn that loaded a member's sealed browser session. The bot's history in that conversation (its OpenClaw
 * transcript in a DM, the reply it wrote into the chat window) may still hold what it read signed in, so a later turn
 * could write it into a team bot's shared workspace or send it to another host. Decision: once a member session was
 * loaded in a (bot, conversation), every later turn of that bot there starts with member data, until the bot's history
 * for that conversation is gone (the row cascades with the bot and with the conversation).
 *
 * Every function runs in the caller's tenant transaction (RLS): another organization's pair does not exist.
 */

/** At most this many sites are remembered for one pair (the table's check); a full list fails closed (see below). */
export const MEMBER_DATA_SITES_MAX = 64;

export interface StickyMemberData {
  /** The site keys (hosts) whose sessions were loaded here. Empty = unknown: every host is cross-site (fail closed). */
  sites: string[];
}

/** The pair's sticky member data, or null when no member session was ever loaded by this bot in this conversation. */
export async function stickyMemberData(
  tx: Tx,
  p: { agentId: string; conversationId: string },
): Promise<StickyMemberData | null> {
  const [row] = await tx
    .select({ sites: agentMemberData.sites })
    .from(agentMemberData)
    .where(and(eq(agentMemberData.agentId, p.agentId), eq(agentMemberData.conversationId, p.conversationId)))
    .limit(1);
  return row ? { sites: row.sites } : null;
}

/**
 * Records that this turn loaded (or operates a page with) a member's session for `site` in its conversation: from now
 * on every turn of this bot there has member data. Idempotent; a site is added once. The FKs are composite with the
 * transaction's organization, so another organization's bot or conversation id fails the insert (never a row there).
 */
export async function recordMemberData(
  tx: Tx,
  p: { agentId: string; conversationId: string; eventId: string; site: string | null },
): Promise<void> {
  const sites = p.site ? [p.site] : [];
  await tx
    .insert(agentMemberData)
    .values({
      organizationId: tenantOf(tx).organizationId,
      agentId: p.agentId,
      conversationId: p.conversationId,
      sites,
      firstEventId: p.eventId,
    })
    .onConflictDoUpdate({
      target: [agentMemberData.organizationId, agentMemberData.agentId, agentMemberData.conversationId],
      set: {
        // Add the site once; past the cap the list is kept as it is (the check would refuse a longer one).
        sites: sql`case
          when ${p.site}::text is null or ${p.site}::text = any(${agentMemberData.sites})
            or cardinality(${agentMemberData.sites}) >= ${MEMBER_DATA_SITES_MAX}
          then ${agentMemberData.sites}
          else array_append(${agentMemberData.sites}, ${p.site}::text) end`,
        updatedAt: sql`now()`,
      },
    });
}

/**
 * D-13 with sticky member data: whether `host` is another site than the member data of this turn may stay on. The
 * page's loaded session decides when there is one; otherwise the sites loaded in this conversation. With member data
 * and no known site, every host is another site (fail closed).
 */
export function crossSiteFor(p: {
  memberData: boolean;
  host: string;
  sessionSite: string | null;
  stickySites: readonly string[];
}): boolean {
  if (!p.memberData) return false;
  if (p.sessionSite !== null) return p.host !== p.sessionSite;
  return !p.stickySites.includes(p.host);
}
