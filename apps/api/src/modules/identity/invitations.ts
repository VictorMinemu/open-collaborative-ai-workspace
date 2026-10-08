import type { IncomingHttpHeaders } from "node:http";
import { getCurrentAdapter, runWithTransaction } from "@better-auth/core/context";
import {
  AcceptInvitationRequest,
  CreateInvitationRequest,
  IdParams,
  Invitation,
  InvitationList,
  MeResponse,
  Ok,
  PublicInvitation,
} from "@ocw/contracts";
import { invitation, organization, type TenantDb, user } from "@ocw/db";
import { fromNodeHeaders } from "better-auth/node";
import { and, asc, eq } from "drizzle-orm";
import type { FastifyReply } from "fastify";
import type { App, AuthContext } from "../../core";
import { authOf, tenant } from "../../core";
import { conflict, gone, notFound } from "../../lib/errors";
import type { AuditService } from "../audit";
import { createPermissionService, invitationResource } from "../organization";
import type { RealtimeService } from "../realtime";
import { INVITATION_TTL_SECONDS } from "./auth";
import { headersForAuth } from "./client-ip";
import { clientFromRequest } from "./client-kind";
import { asRole, auditVia, type IdentityResult, type IdentityService } from "./service";

const SENSITIVE_RATE = { rateLimit: { max: 30, timeWindow: "1 minute" } };

interface InvitationRow {
  id: string;
  organizationId: string;
  email: string;
  role: string | null;
  status: string;
  expiresAt: Date | string;
  createdAt?: Date | string | null;
  inviterId?: string | null;
}

/**
 * Invitations (AUTH-02/03, ORG-02). Rows live in better-auth's `auth.invitation` table but are written by us
 * through the adapter inside our own transaction (with the audit row): the better-auth organization plugin
 * is no longer an authorization authority, because its `hasPermission` rejects the PRD roles (R12, Pitfall 1).
 */
export function createInvitationService(identity: IdentityService) {
  const link = (id: string) => `${identity.env.OCW_PUBLIC_WEB_URL.replace(/\/$/, "")}/invite/${id}`;

  const toInvitation = (row: Omit<InvitationRow, "organizationId">): Invitation => {
    const status =
      (["pending", "accepted", "rejected", "canceled"] as const).find((s) => s === row.status) ?? "pending";
    return {
      id: row.id,
      email: row.email,
      role: asRole(row.role),
      status,
      expiresAt: new Date(row.expiresAt).toISOString(),
      ...(row.createdAt ? { createdAt: new Date(row.createdAt).toISOString() } : {}),
      link: link(row.id),
      inviterId: row.inviterId ?? null,
    };
  };

  return {
    /** The pending invitation of the caller's organization for an e-mail, if any (authorization input). */
    async findPending(auth: AuthContext, rawEmail: string): Promise<Invitation | null> {
      const [row] = await identity.authDb
        .select()
        .from(invitation)
        .where(
          and(
            eq(invitation.organizationId, auth.organizationId),
            eq(invitation.email, rawEmail.trim().toLowerCase()),
            eq(invitation.status, "pending"),
          ),
        )
        .limit(1);
      return row ? toInvitation(row) : null;
    },

    /** An invitation of the caller's organization (404 otherwise); authorization input for revoke. */
    async getInvitation(auth: AuthContext, id: string): Promise<Invitation> {
      const [row] = await identity.authDb
        .select()
        .from(invitation)
        .where(and(eq(invitation.id, id), eq(invitation.organizationId, auth.organizationId)))
        .limit(1);
      if (!row) throw notFound("Invitation not found");
      return toInvitation(row);
    },

    /** Creates (or refreshes the pending) invitation for an e-mail; returns a copyable link (SMTP optional). */
    async createInvitation(auth: AuthContext, input: CreateInvitationRequest): Promise<Invitation> {
      const ctx = await identity.auth.$context;
      const email = input.email.trim().toLowerCase();
      return runWithTransaction(ctx.adapter, async () => {
        const adapter = await getCurrentAdapter(ctx.adapter);
        const existingUser = await adapter.findOne<{ id: string }>({
          model: "user",
          where: [{ field: "email", value: email }],
        });
        if (existingUser) {
          const existingMember = await adapter.findOne({
            model: "member",
            where: [
              { field: "organizationId", value: auth.organizationId },
              { field: "userId", value: existingUser.id },
            ],
          });
          if (existingMember) throw conflict("This person is already a member", "already_member");
        }
        const expiresAt = new Date(Date.now() + INVITATION_TTL_SECONDS * 1000);
        const pending = await adapter.findOne<InvitationRow>({
          model: "invitation",
          where: [
            { field: "organizationId", value: auth.organizationId },
            { field: "email", value: email },
            { field: "status", value: "pending" },
          ],
        });
        let row: InvitationRow;
        if (pending) {
          row = (await adapter.update<InvitationRow>({
            model: "invitation",
            where: [{ field: "id", value: pending.id }],
            // Whoever refreshes it chose the role, so they become its inviter (and may revoke it).
            update: { role: input.role, expiresAt, inviterId: auth.userId },
          })) ?? { ...pending, role: input.role, expiresAt, inviterId: auth.userId };
        } else {
          row = await adapter.create<Record<string, unknown>, InvitationRow>({
            model: "invitation",
            data: {
              organizationId: auth.organizationId,
              email,
              role: input.role,
              status: "pending",
              expiresAt,
              inviterId: auth.userId,
              createdAt: new Date(),
            },
          });
        }
        await auditVia(adapter, {
          organizationId: auth.organizationId,
          userId: auth.userId,
          sessionId: auth.sessionId,
          clientKind: auth.clientKind,
          action: "invitation.created",
          resourceType: "invitation",
          resourceId: row.id,
          metadata: { email, role: input.role, ...(pending ? { refreshed: true } : {}) },
        });
        return toInvitation(row);
      });
    },

    async listInvitations(auth: AuthContext): Promise<Invitation[]> {
      const rows = await identity.authDb
        .select()
        .from(invitation)
        .where(and(eq(invitation.organizationId, auth.organizationId), eq(invitation.status, "pending")))
        .orderBy(asc(invitation.createdAt));
      return rows.map((r) => toInvitation(r));
    },

    async revokeInvitation(auth: AuthContext, id: string): Promise<void> {
      const ctx = await identity.auth.$context;
      await runWithTransaction(ctx.adapter, async () => {
        const adapter = await getCurrentAdapter(ctx.adapter);
        const inv = await adapter.findOne<InvitationRow>({
          model: "invitation",
          where: [{ field: "id", value: id }],
        });
        if (!inv || inv.organizationId !== auth.organizationId) throw notFound("Invitation not found");
        if (inv.status !== "pending")
          throw conflict("This invitation is no longer pending", "invitation_not_pending");
        await adapter.update({
          model: "invitation",
          where: [{ field: "id", value: id }],
          update: { status: "canceled" },
        });
        await auditVia(adapter, {
          organizationId: auth.organizationId,
          userId: auth.userId,
          sessionId: auth.sessionId,
          clientKind: auth.clientKind,
          action: "invitation.revoked",
          resourceType: "invitation",
          resourceId: id,
          metadata: { email: inv.email, role: asRole(inv.role) },
        });
      });
    },

    async getPublicInvitation(id: string): Promise<PublicInvitation> {
      const [row] = await identity.authDb
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
      const inv = toInvitation(row);
      return {
        id: row.id,
        email: row.email,
        organizationName: row.organizationName,
        inviterName: row.inviterName ?? null,
        role: inv.role,
        status: inv.status,
        expired: new Date(row.expiresAt).getTime() < Date.now(),
      };
    },

    /** AUTH-02: accept an invitation by signing up with the INVITATION's email (never client-supplied). */
    async acceptInvitation(
      id: string,
      input: AcceptInvitationRequest,
      headers?: IncomingHttpHeaders,
    ): Promise<IdentityResult> {
      const ctx = await identity.auth.$context;
      const out = await runWithTransaction(ctx.adapter, async () => {
        const adapter = await getCurrentAdapter(ctx.adapter);
        const inv = await adapter.findOne<InvitationRow>({
          model: "invitation",
          where: [{ field: "id", value: id }],
        });
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

        // The request headers reach the session.create hook, which records the client kind and label.
        const signUp = await identity.auth.api.signUpEmail({
          body: { name: input.name, email: inv.email, password: input.password },
          returnHeaders: true,
          ...(headers ? { headers: fromNodeHeaders(headers) } : {}),
        });
        const userId = signUp.response.user.id;
        const role = asRole(inv.role);
        // auth.member is existence-only; the organization role lives in app.org_members.
        await adapter.create({
          model: "member",
          data: { organizationId: inv.organizationId, userId, role: "member", createdAt: new Date() },
        });
        await adapter.update({
          model: "invitation",
          where: [{ field: "id", value: id }],
          update: { status: "accepted" },
        });
        await adapter.create({
          model: "orgMember",
          data: {
            organizationId: inv.organizationId,
            userId,
            displayName: input.name,
            email: inv.email,
            role,
          },
        });
        // The session predates the membership, so the hook could not set the org; the first JWT needs it.
        await adapter.update({
          model: "session",
          where: [{ field: "userId", value: userId }],
          update: { activeOrganizationId: inv.organizationId },
        });
        const clientKind = clientFromRequest(headers).kind;
        await auditVia(adapter, {
          organizationId: inv.organizationId,
          userId,
          clientKind,
          action: "user.signed_up",
          resourceType: "user",
          resourceId: userId,
        });
        await auditVia(adapter, {
          organizationId: inv.organizationId,
          userId,
          clientKind,
          action: "invitation.accepted",
          resourceType: "invitation",
          resourceId: id,
          metadata: { role },
        });
        const org = await adapter.findOne<{ id: string; name: string; slug: string }>({
          model: "organization",
          where: [{ field: "id", value: inv.organizationId }],
        });
        return { headers: signUp.headers, userId, role, org, email: inv.email };
      });
      if (!out.org) throw new Error("organization missing");
      return {
        cookies: out.headers.getSetCookie(),
        me: {
          user: { id: out.userId, name: input.name, email: out.email, image: null },
          organization: { id: out.org.id, name: out.org.name, slug: out.org.slug, role: out.role },
          sessionId: (await identity.sessionIdFromCookies(out.headers.getSetCookie())) ?? "",
        },
      };
    },
  };
}

export type InvitationService = ReturnType<typeof createInvitationService>;

/**
 * GET/POST /api/v1/invitations, DELETE /api/v1/invitations/:id, public lookup and accept.
 *
 * Every authenticated route is decided by the permission resolver. The auth plane cannot open withTenant, so
 * each decision runs first in a short `db.withTenant`, then the auth-plane transaction writes the rows.
 * Invitations target the organization only (D-05): units are assigned after the person joins.
 */
export function registerInvitationRoutes(
  app: App,
  deps: {
    identity: IdentityService;
    invitations: InvitationService;
    db: TenantDb;
    audit: AuditService;
    realtime: RealtimeService;
  },
) {
  const { identity, invitations, db } = deps;
  const perms = createPermissionService({ db, audit: deps.audit });
  const setCookies = (reply: FastifyReply, cookies: string[]) => {
    if (cookies.length) reply.header("set-cookie", cookies);
  };
  const resourceOf = (inv: Pick<Invitation, "inviterId" | "role">, viewerId: string) =>
    invitationResource({ inviterId: inv.inviterId, role: inv.role }, viewerId);

  app.get(
    "/api/v1/invitations",
    {
      config: { authz: "user" },
      preHandler: [identity.requireUser, perms.requirePermission("invitation.read")],
      schema: { tags: ["identity"], response: { 200: InvitationList } },
    },
    async (req) => {
      const auth = authOf(req);
      const list = await invitations.listInvitations(auth);
      // One transaction for the whole list; facts load once and each item is decided in memory.
      const withViewerCan = await db.withTenant(tenant(req), async (tx) => {
        const out: Invitation[] = [];
        for (const inv of list) {
          const viewerCan = await perms.viewerCan(req, tx, resourceOf(inv, auth.userId), [
            "invitation.revoke",
          ]);
          out.push({ ...inv, viewerCan });
        }
        return out;
      });
      return { invitations: withViewerCan };
    },
  );

  app.post(
    "/api/v1/invitations",
    {
      config: { authz: "user" },
      preHandler: identity.requireUser,
      schema: { tags: ["identity"], body: CreateInvitationRequest, response: { 200: Invitation } },
    },
    async (req) => {
      const auth = authOf(req);
      const pending = await invitations.findPending(auth, req.body.email);
      await db.withTenant(tenant(req), async (tx) => {
        // Role ceiling (INVITABLE_ROLES) is the invitation.create precondition in policy.ts.
        await perms.assertCan(
          req,
          tx,
          "invitation.create",
          invitationResource({ inviterId: auth.userId, role: req.body.role }, auth.userId),
        );
        // Refreshing someone else's pending invitation replaces it: that needs revoke rights on it too.
        if (pending) await perms.assertCan(req, tx, "invitation.revoke", resourceOf(pending, auth.userId));
      });
      return invitations.createInvitation(auth, req.body);
    },
  );

  app.delete(
    "/api/v1/invitations/:id",
    {
      config: { authz: "user" },
      preHandler: identity.requireUser,
      schema: { tags: ["identity"], params: IdParams, response: { 200: Ok } },
    },
    async (req) => {
      const auth = authOf(req);
      const inv = await invitations.getInvitation(auth, req.params.id);
      await db.withTenant(tenant(req), (tx) =>
        perms.assertCan(req, tx, "invitation.revoke", resourceOf(inv, auth.userId)),
      );
      await invitations.revokeInvitation(auth, req.params.id);
      return { ok: true as const };
    },
  );

  app.get(
    "/api/v1/invitations/:id",
    {
      config: { authz: "public" },
      schema: { tags: ["identity"], params: IdParams, response: { 200: PublicInvitation } },
    },
    (req) => invitations.getPublicInvitation(req.params.id),
  );

  app.post(
    "/api/v1/invitations/:id/accept",
    {
      config: { ...SENSITIVE_RATE, authz: "public" },
      schema: {
        tags: ["identity"],
        params: IdParams,
        body: AcceptInvitationRequest,
        response: { 200: MeResponse },
      },
    },
    async (req, reply) => {
      const { me, cookies } = await invitations.acceptInvitation(
        req.params.id,
        req.body,
        headersForAuth(req),
      );
      // Durable org-wide event so member lists update live (EventTypes.memberJoined).
      await deps.db.withTenant({ organizationId: me.organization.id, userId: me.user.id }, (tx) =>
        deps.realtime.appendEvent(tx, `org:${me.organization.id}`, "member.joined", {
          userId: me.user.id,
          displayName: me.user.name,
          role: me.organization.role,
        }),
      );
      setCookies(reply, cookies);
      return me;
    },
  );
}
