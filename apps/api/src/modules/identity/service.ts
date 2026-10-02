import type { IncomingHttpHeaders } from "node:http";
import { getCurrentAdapter, runWithTransaction } from "@better-auth/core/context";
import type {
  AcceptInvitationRequest,
  CreateInvitationRequest,
  Invitation,
  MeResponse,
  OrgRole,
  PublicInvitation,
  SetupRequest,
} from "@ocw/contracts";
import { instanceSetup, invitation, member, organization, user } from "@ocw/db";
import { fromNodeHeaders } from "better-auth/node";
import { and, asc, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Env } from "../../config/env";
import type { AuthContext } from "../../core";
import { safeEqual } from "../../lib/crypto";
import { conflict, forbidden, gone, HttpError, notFound, unauthorized } from "../../lib/errors";
import type { Auth } from "./auth";

export interface IdentityResult {
  me: MeResponse;
  /** Set-Cookie headers to forward to the browser. */
  cookies: string[];
}

interface AuditInput {
  organizationId: string;
  userId: string | null;
  sessionId?: string | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  metadata?: Record<string, unknown>;
}

const ROLES: readonly OrgRole[] = ["owner", "admin", "member"];
const asRole = (r: string | null | undefined): OrgRole =>
  ROLES.includes(r as OrgRole) ? (r as OrgRole) : "member";

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
    private readonly authDb: NodePgDatabase,
    private readonly env: Env,
  ) {}

  /** Resolve the session cookie → principal. Returns null when unauthenticated. */
  async authenticate(headers: IncomingHttpHeaders): Promise<AuthContext | null> {
    const result = await this.auth.api.getSession({ headers: fromNodeHeaders(headers) }).catch(() => null);
    if (!result) return null;
    const rows = await this.authDb
      .select({ organizationId: member.organizationId, role: member.role })
      .from(member)
      .where(eq(member.userId, result.user.id))
      .orderBy(asc(member.createdAt))
      .limit(5);
    const active = result.session.activeOrganizationId;
    const m = rows.find((r) => r.organizationId === active) ?? rows[0];
    if (!m) return null;
    return {
      userId: result.user.id,
      organizationId: m.organizationId,
      sessionId: result.session.id,
      role: asRole(m.role),
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
   * AUTH-01: redeem the one-time setup token → first user (owner) + organization. All writes (user, account,
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
        data: { organizationId: org.id, userId, displayName: input.name, email: input.email, role: "owner" },
      });
      await this.auditVia(adapter, {
        organizationId: org.id,
        userId,
        action: "setup.redeemed",
        resourceType: "instance",
      });
      await this.auditVia(adapter, {
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
        organization: { id: out.org.id, name: out.org.name, slug: out.org.slug, role: "owner" },
        sessionId: sessionId ?? "",
      },
    };
  }

  private link(id: string) {
    return `${this.env.OCW_PUBLIC_WEB_URL.replace(/\/$/, "")}/invite/${id}`;
  }

  private toInvitation(row: {
    id: string;
    email: string;
    role: string | null;
    status: string;
    expiresAt: Date | string;
    createdAt?: Date | string | null;
  }): Invitation {
    const status =
      (["pending", "accepted", "rejected", "canceled"] as const).find((s) => s === row.status) ?? "pending";
    return {
      id: row.id,
      email: row.email,
      role: asRole(row.role),
      status,
      expiresAt: new Date(row.expiresAt).toISOString(),
      ...(row.createdAt ? { createdAt: new Date(row.createdAt).toISOString() } : {}),
      link: this.link(row.id),
    };
  }

  /** AUTH-03: owner/admin creates an invitation; returns a copyable link (SMTP optional). */
  async createInvitation(auth: AuthContext, headers: IncomingHttpHeaders, input: CreateInvitationRequest) {
    const ctx = await this.auth.$context;
    return runWithTransaction(ctx.adapter, async () => {
      const adapter = await getCurrentAdapter(ctx.adapter);
      const created = await this.auth.api.createInvitation({
        headers: fromNodeHeaders(headers),
        body: { email: input.email, role: input.role, organizationId: auth.organizationId, resend: true },
      });
      await this.auditVia(adapter, {
        organizationId: auth.organizationId,
        userId: auth.userId,
        sessionId: auth.sessionId,
        action: "invitation.created",
        resourceType: "invitation",
        resourceId: created.id,
        metadata: { email: input.email, role: input.role },
      });
      return this.toInvitation(created);
    });
  }

  async listInvitations(auth: AuthContext): Promise<Invitation[]> {
    const rows = await this.authDb
      .select()
      .from(invitation)
      .where(and(eq(invitation.organizationId, auth.organizationId), eq(invitation.status, "pending")))
      .orderBy(asc(invitation.createdAt));
    return rows.map((r) => this.toInvitation(r));
  }

  async revokeInvitation(auth: AuthContext, headers: IncomingHttpHeaders, id: string) {
    const ctx = await this.auth.$context;
    await runWithTransaction(ctx.adapter, async () => {
      const adapter = await getCurrentAdapter(ctx.adapter);
      const inv = await adapter.findOne<{ organizationId: string; status: string }>({
        model: "invitation",
        where: [{ field: "id", value: id }],
      });
      if (!inv || inv.organizationId !== auth.organizationId) throw notFound("Invitation not found");
      await this.auth.api.cancelInvitation({ headers: fromNodeHeaders(headers), body: { invitationId: id } });
      await this.auditVia(adapter, {
        organizationId: auth.organizationId,
        userId: auth.userId,
        sessionId: auth.sessionId,
        action: "invitation.revoked",
        resourceType: "invitation",
        resourceId: id,
      });
    });
  }

  async getPublicInvitation(id: string): Promise<PublicInvitation> {
    const [row] = await this.authDb
      .select({
        id: invitation.id,
        email: invitation.email,
        role: invitation.role,
        status: invitation.status,
        expiresAt: invitation.expiresAt,
        organizationName: organization.name,
        inviterName: user.name,
      })
      .from(invitation)
      .innerJoin(organization, eq(organization.id, invitation.organizationId))
      .leftJoin(user, eq(user.id, invitation.inviterId))
      .where(eq(invitation.id, id));
    if (!row) throw notFound("Invitation not found");
    const inv = this.toInvitation(row);
    return {
      id: row.id,
      email: row.email,
      organizationName: row.organizationName,
      inviterName: row.inviterName ?? null,
      role: inv.role,
      status: inv.status,
      expired: new Date(row.expiresAt).getTime() < Date.now(),
    };
  }

  /** AUTH-02: accept an invitation by signing up with the INVITATION's email (never client-supplied). */
  async acceptInvitation(id: string, input: AcceptInvitationRequest): Promise<IdentityResult> {
    const ctx = await this.auth.$context;
    const out = await runWithTransaction(ctx.adapter, async () => {
      const adapter = await getCurrentAdapter(ctx.adapter);
      const inv = await adapter.findOne<{
        id: string;
        organizationId: string;
        email: string;
        role: string | null;
        status: string;
        expiresAt: Date;
      }>({ model: "invitation", where: [{ field: "id", value: id }] });
      if (!inv) throw notFound("Invitation not found");
      if (inv.status !== "pending")
        throw conflict("This invitation is no longer valid", "invitation_not_pending");
      if (new Date(inv.expiresAt).getTime() < Date.now())
        throw gone("This invitation has expired", "invitation_expired");
      const existing = await adapter.findOne({
        model: "user",
        where: [{ field: "email", value: inv.email.toLowerCase() }],
      });
      if (existing)
        throw conflict("An account with this email already exists; sign in instead", "account_exists");

      const { headers, response } = await this.auth.api.signUpEmail({
        body: { name: input.name, email: inv.email, password: input.password },
        returnHeaders: true,
      });
      const userId = response.user.id;
      const role = asRole(inv.role);
      await adapter.create({
        model: "member",
        data: { organizationId: inv.organizationId, userId, role, createdAt: new Date() },
      });
      await adapter.update({
        model: "invitation",
        where: [{ field: "id", value: id }],
        update: { status: "accepted" },
      });
      await adapter.create({
        model: "orgMember",
        data: { organizationId: inv.organizationId, userId, displayName: input.name, email: inv.email, role },
      });
      await this.auditVia(adapter, {
        organizationId: inv.organizationId,
        userId,
        action: "user.signed_up",
        resourceType: "user",
        resourceId: userId,
      });
      await this.auditVia(adapter, {
        organizationId: inv.organizationId,
        userId,
        action: "invitation.accepted",
        resourceType: "invitation",
        resourceId: id,
      });
      const org = await adapter.findOne<{ id: string; name: string; slug: string }>({
        model: "organization",
        where: [{ field: "id", value: inv.organizationId }],
      });
      return { headers, userId, role, org, email: inv.email };
    });
    if (!out.org) throw new Error("organization missing");
    return {
      cookies: out.headers.getSetCookie(),
      me: {
        user: { id: out.userId, name: input.name, email: out.email, image: null },
        organization: { id: out.org.id, name: out.org.name, slug: out.org.slug, role: out.role },
        sessionId: (await this.sessionIdFromCookies(out.headers.getSetCookie())) ?? "",
      },
    };
  }

  private async sessionIdFromCookies(cookies: string[]): Promise<string | null> {
    const cookie = cookies.map((c) => c.split(";")[0]).join("; ");
    const s = await this.auth.api.getSession({ headers: new Headers({ cookie }) }).catch(() => null);
    return s?.session.id ?? null;
  }

  private async auditVia(
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
}
