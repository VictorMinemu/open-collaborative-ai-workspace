import type { IncomingHttpHeaders } from "node:http";
import type { ClientKind, OrgRole } from "@ocw/contracts";
import { member, orgMembers } from "@ocw/db";
import { fromNodeHeaders } from "better-auth/node";
import { and, asc, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { AuthContext } from "../../core";
import { unauthorized } from "../../lib/errors";
import type { Auth } from "./auth";
import { clientFromUserAgent } from "./client-kind";

const ROLES: readonly OrgRole[] = ["standard", "developer", "lead", "admin"];
/** Unknown or missing roles fall back to the least privileged role. */
export const asRole = (r: string | null | undefined): OrgRole =>
  ROLES.includes(r as OrgRole) ? (r as OrgRole) : "standard";

const SESSION_CLIENT_KINDS: readonly ClientKind[] = ["web", "desktop", "mobile"];

/** Three base64url segments: a compact JWS. Hashed device/cell tokens never look like this. */
const COMPACT_JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/** The `Bearer <jwt>` credential of an Authorization header, or null when absent or not a JWT. */
export function bearerJwt(headers: IncomingHttpHeaders): string | null {
  const m = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(headers.authorization ?? "");
  const value = m?.[1];
  return value && COMPACT_JWT.test(value) ? value : null;
}

export interface Authenticator {
  /**
   * `Authorization: Bearer <access JWT>` or the session cookie → principal; null when unauthenticated, not a
   * member, or deactivated. A presented Bearer JWT is authoritative: when it fails, the cookie is not tried.
   */
  authenticate(headers: IncomingHttpHeaders): Promise<AuthContext | null>;
  /** Fastify preHandler: 401 unless signed in; sets `req.auth`. */
  requireUser(req: FastifyRequest, reply: FastifyReply): Promise<void>;
}

export function createAuthenticator(
  auth: Auth,
  authDb: NodePgDatabase,
  verifyAccessToken: (token: string) => Promise<AuthContext | null>,
): Authenticator {
  async function authenticate(headers: IncomingHttpHeaders): Promise<AuthContext | null> {
    // AUTH-06 / D-01: every user route accepts a short-lived access JWT. Non-JWT bearer values (device or
    // cell tokens) are not user credentials and fall through to the cookie, which they never carry.
    const jwt = bearerJwt(headers);
    if (jwt) return verifyAccessToken(jwt);
    return cookieSession(headers);
  }

  async function cookieSession(headers: IncomingHttpHeaders): Promise<AuthContext | null> {
    const result = await auth.api.getSession({ headers: fromNodeHeaders(headers) }).catch(() => null);
    if (!result) return null;
    // auth.member says which organizations the user belongs to (existence only); the deactivation flag comes
    // from the app.org_members projection, the single source of truth (D-06). The principal carries no role:
    // every authorization decision goes through the permission resolver, which loads it as a fact.
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
      .select({ deactivatedAt: orgMembers.deactivatedAt })
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

  return { authenticate, requireUser };
}
