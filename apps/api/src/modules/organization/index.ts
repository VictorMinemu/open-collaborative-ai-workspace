import { type Member, MemberList } from "@ocw/contracts";
import { orgMembers, type Tx } from "@ocw/db";
import { asc } from "drizzle-orm";
import { type ApiModule, type Core, tenant } from "../../core";

/** Public interface for other modules: member lookups inside an existing tenant transaction. */
export async function listMembers(tx: Tx): Promise<Member[]> {
  const rows = await tx.select().from(orgMembers).orderBy(asc(orgMembers.displayName));
  return rows.map((r) => ({
    userId: r.userId,
    displayName: r.displayName,
    email: r.email,
    avatarUrl: r.avatarUrl,
    role: r.role,
    status: r.deactivatedAt ? ("deactivated" as const) : ("active" as const),
    statusEmoji: r.statusEmoji ?? null,
    statusText: r.statusText ?? null,
    joinedAt: new Date(r.joinedAt).toISOString(),
  }));
}

/** Map of userId → display info for author resolution (users only; agents live in the agent module). */
export async function memberDirectory(tx: Tx): Promise<Map<string, Member>> {
  return new Map((await listMembers(tx)).map((m) => [m.userId, m]));
}

export function createOrganizationModule(core: Core): ApiModule {
  return {
    name: "organization",
    register(app) {
      app.get(
        "/members",
        {
          preHandler: core.identity.requireUser,
          schema: { tags: ["organization"], response: { 200: MemberList } },
        },
        async (req) => ({ members: await core.db.withTenant(tenant(req), listMembers) }),
      );
    },
  };
}
