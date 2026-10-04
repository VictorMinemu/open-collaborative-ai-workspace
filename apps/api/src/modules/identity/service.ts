// authz-legacy: 02-15 migrates this file to the resolver
import type { IncomingHttpHeaders } from "node:http";
import { getCurrentAdapter, runWithTransaction } from "@better-auth/core/context";
import type { MeResponse, OrgRole, SetupRequest } from "@ocw/contracts";
import { instanceSetup, member, organization, orgMembers, user } from "@ocw/db";
import { fromNodeHeaders } from "better-auth/node";
import { and, asc, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Env } from "../../config/env";
import type { AuthContext } from "../../core";
import { safeEqual } from "../../lib/crypto";
import { conflict, forbidden, HttpError, unauthorized } from "../../lib/errors";
import type { Auth } from "./auth";

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
}

const ROLES: readonly OrgRole[] = ["standard", "developer", "lead", "admin"];
/** Unknown or missing roles fall back to the least privileged role. */
export const asRole = (r: string | null | undefined): OrgRole =>
  ROLES.includes(r as OrgRole) ? (r as OrgRole) : "standard";

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
  constructor(
    readonly auth: Auth,
    readonly authDb: NodePgDatabase,
    readonly env: Env,
  ) {}

  /** Resolve the session cookie → principal. Returns null when unauthenticated. */
  async authenticate(headers: IncomingHttpHeaders): Promise<AuthContext | null> {
    const result = await this.auth.api.getSession({ headers: fromNodeHeaders(headers) }).catch(() => null);
    if (!result) return null;
    // auth.member says which organizations the user belongs to (existence only); the organization role
    // comes from the app.org_members projection, the single source of truth (D-06, research R12/R13).
    const rows = await this.authDb
      .select({ organizationId: member.organizationId })
      .from(member)
      .where(eq(member.userId, result.user.id))
      .orderBy(asc(member.createdAt))
      .limit(5);
    const active = result.session.activeOrganizationId;
    const m = rows.find((r) => r.organizationId === active) ?? rows[0];
    if (!m) return null;
    const [projection] = await this.authDb
      .select({ role: orgMembers.role })
      .from(orgMembers)
      .where(and(eq(orgMembers.organizationId, m.organizationId), eq(orgMembers.userId, result.user.id)))
      .limit(1);
    return {
      userId: result.user.id,
      organizationId: m.organizationId,
      sessionId: result.session.id,
      role: asRole(projection?.role),
      name: result.user.name,
      email: result.user.email,
    };
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

  /** Fastify preHandler: 401 unless signed in; sets `req.auth`. */
  requireUser = async (req: FastifyRequest, _reply: FastifyReply) => {
    const auth = await this.authenticate(req.headers);
    if (!auth) throw unauthorized();
    req.auth = auth;
  };

  /** Fastify preHandler factory: requires one of the org roles (implies requireUser). */
  requireRole =
    (...roles: OrgRole[]) =>
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (!req.auth) await this.requireUser(req, reply);
      if (!req.auth || !roles.includes(req.auth.role)) throw forbidden("This action requires an admin");
    };

  async me(auth: AuthContext): Promise<MeResponse> {
    const [org] = await this.authDb
      .select()
      .from(organization)
      .where(eq(organization.id, auth.organizationId));
    const [u] = await this.authDb.select().from(user).where(eq(user.id, auth.userId));
    if (!org || !u) throw unauthorized();
    return {
      user: { id: u.id, name: u.name, email: u.email, image: u.image ?? null },
      organization: { id: org.id, name: org.name, slug: org.slug, role: auth.role },
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
  ): Promise<IdentityResult> {
    if (!safeEqual(input.token, this.env.OCW_SETUP_TOKEN)) {
      throw new HttpError(401, "invalid_setup_token", "The setup token is not valid");
    }
    if ((await this.setupStatus()).setupComplete)
      throw conflict("This instance is already set up", "already_set_up");
    const ctx = await this.auth.$context;
    const out = await runWithTransaction(ctx.adapter, async () => {
      const adapter = await getCurrentAdapter(ctx.adapter);
      const { headers, response } = await this.auth.api.signUpEmail({
        body: { name: input.name, email: input.email, password: input.password },
        returnHeaders: true,
      });
      const userId = response.user.id;
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
      await auditVia(adapter, {
        organizationId: org.id,
        userId,
        action: "setup.redeemed",
        resourceType: "instance",
      });
      await auditVia(adapter, {
        organizationId: org.id,
        userId,
        action: "organization.created",
        resourceType: "organization",
        resourceId: org.id,
        metadata: { name: input.orgName },
      });
      await hooks.beforeCommit?.();
      return { headers, userId, org };
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
      clientKind: "web",
      resourceType: e.resourceType,
      resourceId: e.resourceId ?? null,
      action: e.action,
      result: "success",
      metadata: e.metadata ?? {},
    },
  });
}
