import type { IncomingHttpHeaders } from "node:http";
import { getCurrentAdapter, runWithTransaction } from "@better-auth/core/context";
import type { DeviceAccessToken, MeResponse, SetupRequest } from "@ocw/contracts";
import { instanceSetup, member, organization, orgMembers, user } from "@ocw/db";
import { fromNodeHeaders } from "better-auth/node";
import { and, asc, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Env } from "../../config/env";
import type { AuthContext } from "../../core";
import { safeEqual } from "../../lib/crypto";
import { conflict, HttpError, unauthorized } from "../../lib/errors";
import type { Auth } from "./auth";
import { type Authenticator, asRole, createAuthenticator } from "./authenticate";
import { clientFromRequest } from "./client-kind";
import { createTokenService, type TokenService } from "./jwt";
import { createSessionStore, type SessionStore } from "./session-store";

/** The realtime surface identity needs: the revoked-session deny-list (Redis, TTL longer than a JWT). */
export interface RevocationCheck {
  isSessionRevoked(sessionId: string): Promise<boolean>;
}

export { asRole } from "./authenticate";

export interface IdentityResult {
  me: MeResponse;
  /** Set-Cookie headers to forward to the browser. */
  cookies: string[];
}

export interface AuditInput {
  organizationId: string;
  userId: string | null;
  sessionId?: string | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  metadata?: Record<string, unknown>;
  /** Client of the acting session; defaults to "web". */
  clientKind?: string | null;
}

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return base || "org";
}

export class IdentityService {
  /** Session list/delete for 02-07 (deactivation) and 02-09 (sessions, password); never returns secrets. */
  readonly sessions: SessionStore;
  private readonly authn: Authenticator;
  /** Fastify preHandler: 401 unless signed in; sets `req.auth`. */
  readonly requireUser: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

  /** jose verifier over the cached JWKS (AUTH-06); also signs device tokens. */
  readonly tokens: TokenService;

  constructor(
    readonly auth: Auth,
    readonly authDb: NodePgDatabase,
    readonly env: Env,
    private readonly revocations: RevocationCheck,
  ) {
    this.tokens = createTokenService({ auth, env });
    this.authn = createAuthenticator(auth, authDb, (token) => this.verifyAccessToken(token));
    this.sessions = createSessionStore(auth);
    this.requireUser = this.authn.requireUser;
  }

  /** Resolve the session cookie → principal. Returns null when unauthenticated or deactivated. */
  authenticate(headers: IncomingHttpHeaders): Promise<AuthContext | null> {
    return this.authn.authenticate(headers);
  }

  /**
   * AUTH-06: a user access JWT → principal. Verifies signature, issuer, audience and expiry against the
   * cached JWKS, then rejects revoked sessions (Redis deny-list) and missing or deactivated members.
   * Null on any failure; the token is never logged.
   */
  async verifyAccessToken(token: string): Promise<AuthContext | null> {
    const claims = await this.tokens.verifyUserToken(token);
    if (!claims) return null;
    if (await this.revocations.isSessionRevoked(claims.sid)) return null;
    const m = await this.memberOf(claims.org, claims.sub);
    if (!m || m.deactivatedAt) return null;
    return {
      userId: claims.sub,
      organizationId: claims.org,
      sessionId: claims.sid,
      name: m.name,
      email: m.email,
      clientKind: claims.ck,
    };
  }

  /** A 10-minute device JWT for the Device Link (02-11); a separate credential class from user tokens. */
  signDeviceAccessToken(input: { deviceId: string; organizationId: string }): Promise<DeviceAccessToken> {
    return this.tokens.signDeviceToken(input);
  }

  /** Device JWT → its device and organization; null for user tokens and every invalid token. */
  verifyDeviceAccessToken(token: string): Promise<{ deviceId: string; organizationId: string } | null> {
    return this.tokens.verifyDeviceToken(token);
  }

  /** True while the session row exists and has not expired (the long-lived socket recheck, Pitfall 5). */
  isSessionActive(sessionId: string): Promise<boolean> {
    return this.sessions.isActive(sessionId);
  }

  /** True while the user is a member of the organization and not deactivated. */
  async isMemberActive(organizationId: string, userId: string): Promise<boolean> {
    const m = await this.memberOf(organizationId, userId);
    return !!m && !m.deactivatedAt;
  }

  private async memberOf(organizationId: string, userId: string) {
    const [m] = await this.authDb
      .select({
        role: orgMembers.role,
        deactivatedAt: orgMembers.deactivatedAt,
        // Same source as the cookie path (auth.user), so both credentials yield the same principal.
        name: user.name,
        email: user.email,
      })
      .from(orgMembers)
      .innerJoin(user, eq(user.id, orgMembers.userId))
      .where(and(eq(orgMembers.organizationId, organizationId), eq(orgMembers.userId, userId)))
      .limit(1);
    return m ?? null;
  }

  /** First organization the user belongs to (one org per instance in MVP 0). */
  async organizationOf(userId: string): Promise<string | null> {
    const [m] = await this.authDb
      .select({ organizationId: member.organizationId })
      .from(member)
      .where(eq(member.userId, userId))
      .orderBy(asc(member.createdAt))
      .limit(1);
    return m?.organizationId ?? null;
  }

  /**
   * The instance's organization (MVP 0 runs one org per instance). Used to bind operator-level bearer
   * credentials such as OCW_CELL_TOKEN before any tenant is known. Null until /setup has run.
   */
  async instanceOrganizationId(): Promise<string | null> {
    const [org] = await this.authDb
      .select({ id: organization.id })
      .from(organization)
      .orderBy(asc(organization.createdAt))
      .limit(1);
    return org?.id ?? null;
  }

  async me(auth: AuthContext): Promise<MeResponse> {
    const [org] = await this.authDb
      .select()
      .from(organization)
      .where(eq(organization.id, auth.organizationId));
    const [u] = await this.authDb.select().from(user).where(eq(user.id, auth.userId));
    // The principal carries no role (02-15); the display role is read from the org_members projection.
    const [m] = await this.authDb
      .select({ role: orgMembers.role })
      .from(orgMembers)
      .where(and(eq(orgMembers.organizationId, auth.organizationId), eq(orgMembers.userId, auth.userId)))
      .limit(1);
    if (!org || !u || !m) throw unauthorized();
    return {
      user: { id: u.id, name: u.name, email: u.email, image: u.image ?? null },
      organization: { id: org.id, name: org.name, slug: org.slug, role: asRole(m.role) },
      sessionId: auth.sessionId,
    };
  }

  async setupStatus(): Promise<{ setupComplete: boolean }> {
    const rows = await this.authDb.select({ id: instanceSetup.id }).from(instanceSetup).limit(1);
    return { setupComplete: rows.length > 0 };
  }

  /**
   * AUTH-01: redeem the one-time setup token → first user (Organization Admin) + organization. All writes (user, account,
   * session, organization, member, setup flag, org_members projection, audit) commit atomically.
   */
  async setup(
    input: SetupRequest,
    hooks: { beforeCommit?: () => Promise<void> | void } = {},
    headers?: IncomingHttpHeaders,
  ): Promise<IdentityResult> {
    if (!safeEqual(input.token, this.env.OCW_SETUP_TOKEN)) {
      throw new HttpError(401, "invalid_setup_token", "The setup token is not valid");
    }
    if ((await this.setupStatus()).setupComplete)
      throw conflict("This instance is already set up", "already_set_up");
    const ctx = await this.auth.$context;
    const out = await runWithTransaction(ctx.adapter, async () => {
      const adapter = await getCurrentAdapter(ctx.adapter);
      // The request headers reach the session.create hook, which records the client kind and label.
      const signUp = await this.auth.api.signUpEmail({
        body: { name: input.name, email: input.email, password: input.password },
        returnHeaders: true,
        ...(headers ? { headers: fromNodeHeaders(headers) } : {}),
      });
      const userId = signUp.response.user.id;
      const org = await this.auth.api.createOrganization({
        body: { name: input.orgName, slug: `${slugify(input.orgName)}-${userId.slice(0, 6)}`, userId },
      });
      if (!org) throw new Error("organization was not created");
      // Unique `singleton` column: a concurrent second redemption fails here and rolls everything back.
      await adapter.create({ model: "instanceSetup", data: { organizationId: org.id, redeemedBy: userId } });
      await adapter.create({
        model: "orgMember",
        data: { organizationId: org.id, userId, displayName: input.name, email: input.email, role: "admin" },
      });
      // The session was created before the membership existed, so the hook could not set the org: set it
      // here so the first access JWT already carries the `org` claim.
      await adapter.update({
        model: "session",
        where: [{ field: "userId", value: userId }],
        update: { activeOrganizationId: org.id },
      });
      const clientKind = clientFromRequest(headers).kind;
      await auditVia(adapter, {
        organizationId: org.id,
        userId,
        clientKind,
        action: "setup.redeemed",
        resourceType: "instance",
      });
      await auditVia(adapter, {
        organizationId: org.id,
        userId,
        clientKind,
        action: "organization.created",
        resourceType: "organization",
        resourceId: org.id,
        metadata: { name: input.orgName },
      });
      await hooks.beforeCommit?.();
      return { headers: signUp.headers, userId, org };
    });
    const sessionId = await this.sessionIdFromCookies(out.headers.getSetCookie());
    return {
      cookies: out.headers.getSetCookie(),
      me: {
        user: { id: out.userId, name: input.name, email: input.email, image: null },
        organization: { id: out.org.id, name: out.org.name, slug: out.org.slug, role: "admin" },
        sessionId: sessionId ?? "",
      },
    };
  }

  async sessionIdFromCookies(cookies: string[]): Promise<string | null> {
    const cookie = cookies.map((c) => c.split(";")[0]).join("; ");
    const s = await this.auth.api.getSession({ headers: new Headers({ cookie }) }).catch(() => null);
    return s?.session.id ?? null;
  }
}

/**
 * Writes one audit row through the better-auth adapter, so it joins the CURRENT auth-plane transaction
 * (`runWithTransaction` + `getCurrentAdapter`): the audit row commits or rolls back with the change.
 */
export async function auditVia(
  adapter: { create(args: { model: string; data: Record<string, unknown> }): Promise<unknown> },
  e: AuditInput,
): Promise<void> {
  await adapter.create({
    model: "auditEvent",
    data: {
      organizationId: e.organizationId,
      actorKind: e.userId ? "user" : "system",
      actorId: e.userId,
      userId: e.userId,
      sessionId: e.sessionId ?? null,
      clientKind: e.clientKind ?? "web",
      resourceType: e.resourceType,
      resourceId: e.resourceId ?? null,
      action: e.action,
      result: "success",
      metadata: e.metadata ?? {},
    },
  });
}
