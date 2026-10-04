// authz-legacy: 02-15 migrates this file to the resolver (requireRole and AuthContext.role)
import type { IncomingHttpHeaders } from "node:http";
import type { ClientKind, OrgRole } from "@ocw/contracts";
import { member, orgMembers } from "@ocw/db";
import { fromNodeHeaders } from "better-auth/node";
import { and, asc, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { AuthContext } from "../../core";
import { forbidden, unauthorized } from "../../lib/errors";
import type { Auth } from "./auth";
import { clientFromUserAgent } from "./client-kind";

const ROLES: readonly OrgRole[] = ["standard", "developer", "lead", "admin"];
/** Unknown or missing roles fall back to the least privileged role. */
export const asRole = (r: string | null | undefined): OrgRole =>
  ROLES.includes(r as OrgRole) ? (r as OrgRole) : "standard";

const SESSION_CLIENT_KINDS: readonly ClientKind[] = ["web", "desktop", "mobile"];

export interface Authenticator {
  /** Session cookie → principal; null when unauthenticated, not a member, or deactivated. */
  authenticate(headers: IncomingHttpHeaders): Promise<AuthContext | null>;
  /** Fastify preHandler: 401 unless signed in; sets `req.auth`. */
  requireUser(req: FastifyRequest, reply: FastifyReply): Promise<void>;
  /** Legacy preHandler factory (one of the org roles); 02-15 deletes it. */
  requireRole(...roles: OrgRole[]): (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
}

export function createAuthenticator(auth: Auth, authDb: NodePgDatabase): Authenticator {
  async function authenticate(headers: IncomingHttpHeaders): Promise<AuthContext | null> {
    const result = await auth.api.getSession({ headers: fromNodeHeaders(headers) }).catch(() => null);
    if (!result) return null;
    // auth.member says which organizations the user belongs to (existence only); the organization role and
    // the deactivation flag come from the app.org_members projection, the single source of truth (D-06).
    const rows = await authDb
      .select({ organizationId: member.organizationId })
      .from(member)
      .where(eq(member.userId, result.user.id))
      .orderBy(asc(member.createdAt))
      .limit(5);
    const active = result.session.activeOrganizationId;
    const m = rows.find((r) => r.organizationId === active) ?? rows[0];
    if (!m) return null;
    const [projection] = await authDb
      .select({ role: orgMembers.role, deactivatedAt: orgMembers.deactivatedAt })
      .from(orgMembers)
      .where(and(eq(orgMembers.organizationId, m.organizationId), eq(orgMembers.userId, result.user.id)))
      .limit(1);
    // A deactivated member's existing sessions stop authenticating immediately (T-02-03-04).
    if (!projection || projection.deactivatedAt) return null;
    const stored = SESSION_CLIENT_KINDS.find((k) => k === result.session.clientKind);
    return {
      userId: result.user.id,
      organizationId: m.organizationId,
      sessionId: result.session.id,
      role: asRole(projection.role),
      name: result.user.name,
      email: result.user.email,
      clientKind: stored ?? clientFromUserAgent(result.session.userAgent).kind,
    };
  }

  const requireUser = async (req: FastifyRequest, _reply: FastifyReply) => {
    const ctx = await authenticate(req.headers);
    if (!ctx) throw unauthorized();
    req.auth = ctx;
  };

  const requireRole =
    (...roles: OrgRole[]) =>
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (!req.auth) await requireUser(req, reply);
      if (!req.auth || !roles.includes(req.auth.role)) throw forbidden("This action requires an admin");
    };

  return { authenticate, requireUser, requireRole };
}
