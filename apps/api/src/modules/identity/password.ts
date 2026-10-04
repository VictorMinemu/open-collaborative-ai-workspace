import { getCurrentAdapter, runWithTransaction } from "@better-auth/core/context";
import {
  AuthCapabilities,
  ChangePasswordRequest,
  Ok,
  PasswordResetLink,
  RequestPasswordResetRequest,
  ResetPasswordRequest,
  UserIdParams,
} from "@ocw/contracts";
import { orgMembers, user } from "@ocw/db";
import { and, asc, eq } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { type App, authOf, tenant } from "../../core";
import { randomToken } from "../../lib/crypto";
import { badRequest, conflict, HttpError, notFound } from "../../lib/errors";
import { createPermissionService, memberResource, userResource } from "../organization";
import { clientFromRequest } from "./client-kind";
import type { IdentityRouteDeps } from "./routes";
import { auditVia } from "./service";

/** Admin-issued reset links live 24 hours (self-service e-mails live one hour, identity/auth.ts). */
export const RESET_LINK_TTL_SECONDS = 24 * 60 * 60;
const RESET_PREFIX = "reset-password:";

const invalidToken = () =>
  new HttpError(400, "invalid_token", "This reset link is invalid or has expired. Ask for a new one.");

/** better-auth APIError codes are on `body.code`. */
const apiErrorCode = (e: unknown): string | undefined => {
  const code = (e as { body?: { code?: unknown } } | null)?.body?.code;
  return typeof code === "string" ? code : undefined;
};

/**
 * AUTH-04 and D-04: password reset (by e-mail when SMTP is configured, otherwise by an admin-issued
 * single-use link) and change password while signed in. Reset tokens are better-auth verification rows
 * `reset-password:<token>` whose value is the user id; they are consumed once. Tokens and passwords are
 * never logged or audited.
 */
export function registerPasswordRoutes(app: App, deps: IdentityRouteDeps): void {
  const { identity } = deps;
  const { env } = identity;
  const perms = createPermissionService({ db: deps.db, audit: deps.audit });
  const resetLink = (token: string) =>
    `${env.OCW_PUBLIC_WEB_URL}/reset-password?token=${encodeURIComponent(token)}`;

  /** The member row of a user (first organization), read on the auth plane. */
  const membershipOf = async (userId: string) => {
    const [m] = await identity.authDb
      .select({ organizationId: orgMembers.organizationId, deactivatedAt: orgMembers.deactivatedAt })
      .from(orgMembers)
      .where(eq(orgMembers.userId, userId))
      .orderBy(asc(orgMembers.joinedAt))
      .limit(1);
    return m ?? null;
  };

  app.get(
    "/api/v1/auth/capabilities",
    {
      config: { authz: "public" },
      schema: { tags: ["identity"], response: { 200: AuthCapabilities } },
    },
    async () => ({ passwordResetEmail: Boolean(env.OCW_SMTP_URL) }),
  );

  app.post(
    "/api/v1/password-reset/request",
    {
      config: { authz: "public", rateLimit: { max: 5, timeWindow: "1 minute" } },
      schema: { tags: ["identity"], body: RequestPasswordResetRequest, response: { 200: Ok } },
    },
    async (req) => {
      // Always the same answer, whether or not the address exists (T-02-09-04).
      if (!env.OCW_SMTP_URL) return { ok: true as const };
      const email = req.body.email.trim().toLowerCase();
      const [account] = await identity.authDb
        .select({ id: user.id })
        .from(user)
        .where(eq(user.email, email))
        .limit(1);
      const membership = account ? await membershipOf(account.id) : null;
      // A deactivated member cannot sign in, so they get no reset e-mail either. Unknown addresses still go
      // through better-auth, which simulates the lookup.
      if (membership?.deactivatedAt) return { ok: true as const };
      try {
        await identity.auth.api.requestPasswordReset({
          body: { email, redirectTo: `${env.OCW_PUBLIC_WEB_URL}/reset-password` },
        });
      } catch (err) {
        // A failing SMTP server must not reveal which addresses exist; the body (with the link) is never logged.
        req.log.warn({ code: apiErrorCode(err) }, "password reset e-mail could not be sent");
        return { ok: true as const };
      }
      if (account && membership) {
        await deps.db.withTenant({ organizationId: membership.organizationId, userId: null }, (tx) =>
          deps.audit.record(tx, {
            action: "password.reset_requested",
            resourceType: "user",
            resourceId: account.id,
            actorKind: "system",
            userId: null,
            sessionId: null,
            clientKind: clientFromRequest(req.headers).kind,
            metadata: { ip: req.ip },
          }),
        );
      }
      return { ok: true as const };
    },
  );

  app.post(
    "/api/v1/password-reset",
    {
      config: { authz: "public", rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: { tags: ["identity"], body: ResetPasswordRequest, response: { 200: Ok } },
    },
    async (req) => {
      const { token, newPassword } = req.body;
      const ctx = await identity.auth.$context;
      const verification = await ctx.internalAdapter.findVerificationValue(`${RESET_PREFIX}${token}`);
      if (!verification || new Date(verification.expiresAt).getTime() < Date.now()) throw invalidToken();
      const userId = verification.value;
      const membership = await membershipOf(userId);
      const organizationId = membership?.organizationId ?? (await identity.instanceOrganizationId());
      if (!organizationId) throw invalidToken();
      const sessionIds = (await identity.sessions.list(userId)).map((s) => s.id);
      try {
        await runWithTransaction(ctx.adapter, async () => {
          // Consumes the token, sets the password and deletes every session of the user (revokeSessionsOnPasswordReset),
          // all inside this transaction together with the audit row (A9).
          await identity.auth.api.resetPassword({ body: { token, newPassword } });
          await auditVia(await getCurrentAdapter(ctx.adapter), {
            organizationId,
            userId,
            sessionId: null,
            clientKind: clientFromRequest(req.headers).kind,
            action: "password.reset_completed",
            resourceType: "user",
            resourceId: userId,
            metadata: { revokedSessions: sessionIds.length },
          });
        });
      } catch (err) {
        const code = apiErrorCode(err);
        if (code === "INVALID_TOKEN" || code === "USER_NOT_FOUND") throw invalidToken();
        throw err;
      }
      await deps.realtime.publishRevocation({ sessionIds, userId, reason: "password_reset" });
      return { ok: true as const };
    },
  );

  app.post(
    "/api/v1/members/:userId/password-reset-link",
    {
      config: { authz: "user" },
      preHandler: identity.requireUser,
      schema: { tags: ["identity"], params: UserIdParams, response: { 200: PasswordResetLink } },
    },
    async (req, reply) => {
      const auth = authOf(req);
      const target = req.params.userId;
      const member = await deps.db.withTenant(tenant(req), async (tx) => {
        await perms.assertCan(req, tx, "member.manage", memberResource(target, auth.userId));
        const [m] = await tx
          .select({ deactivatedAt: orgMembers.deactivatedAt })
          .from(orgMembers)
          .where(and(eq(orgMembers.organizationId, auth.organizationId), eq(orgMembers.userId, target)))
          .limit(1);
        return m ?? null;
      });
      if (target === auth.userId) {
        throw badRequest("Change your own password in Settings › Account", "use_change_password");
      }
      if (!member) throw notFound("Member not found", "member_not_found");
      if (member.deactivatedAt) throw conflict("Reactivate the member first", "member_deactivated");

      const token = randomToken(32);
      const expiresAt = new Date(Date.now() + RESET_LINK_TTL_SECONDS * 1000);
      const ctx = await identity.auth.$context;
      await runWithTransaction(ctx.adapter, async () => {
        const adapter = await getCurrentAdapter(ctx.adapter);
        // The newest link wins: earlier reset links (and pending reset e-mails) of this user stop working.
        await adapter.deleteMany({
          model: "verification",
          where: [
            { field: "value", value: target },
            { field: "identifier", value: RESET_PREFIX, operator: "starts_with" },
          ],
        });
        await ctx.internalAdapter.createVerificationValue({
          identifier: `${RESET_PREFIX}${token}`,
          value: target,
          expiresAt,
        });
        await auditVia(adapter, {
          organizationId: auth.organizationId,
          userId: auth.userId,
          sessionId: auth.sessionId,
          clientKind: auth.clientKind,
          action: "password.reset_link_issued",
          resourceType: "user",
          resourceId: target,
          metadata: { targetUserId: target, expiresAt: expiresAt.toISOString() },
        });
      });
      // Shown once in a copy dialog; never cached anywhere (T-02-09-03).
      reply.header("cache-control", "no-store");
      return { link: resetLink(token), expiresAt: expiresAt.toISOString() };
    },
  );

  app.post(
    "/api/v1/me/password",
    {
      config: { authz: "user", rateLimit: { max: 10, timeWindow: "1 minute" } },
      preHandler: identity.requireUser,
      schema: { tags: ["identity"], body: ChangePasswordRequest, response: { 200: Ok } },
    },
    async (req: FastifyRequest<{ Body: ChangePasswordRequest }>) => {
      const auth = authOf(req);
      await deps.db.withTenant(tenant(req), (tx) =>
        perms.assertCan(req, tx, "account.manage", userResource(auth.userId, auth.userId)),
      );
      const { currentPassword, newPassword, revokeOtherSessions } = req.body;
      const ctx = await identity.auth.$context;
      // Verified against the credential account directly, so this works for cookie and Bearer callers alike
      // (better-auth's change-password endpoint needs a cookie session).
      const account = await ctx.internalAdapter.findCredentialAccount(auth.userId);
      const valid = account?.password
        ? await ctx.password.verify({ hash: account.password, password: currentPassword })
        : false;
      if (!valid) throw badRequest("The current password is not correct", "invalid_password");
      const hash = await ctx.password.hash(newPassword);
      const revoked = await runWithTransaction(ctx.adapter, async () => {
        await ctx.internalAdapter.updatePassword(auth.userId, hash);
        const ids = revokeOtherSessions
          ? await identity.sessions.deleteAllForUser(auth.userId, { exceptSessionId: auth.sessionId })
          : [];
        await auditVia(await getCurrentAdapter(ctx.adapter), {
          organizationId: auth.organizationId,
          userId: auth.userId,
          sessionId: auth.sessionId,
          clientKind: auth.clientKind,
          action: "password.changed",
          resourceType: "user",
          resourceId: auth.userId,
          metadata: { revokedOtherSessions: ids.length },
        });
        return ids;
      });
      // Session ids only: the caller's current session stays signed in.
      if (revoked.length) {
        await deps.realtime.publishRevocation({ sessionIds: revoked, reason: "password_changed" });
      }
      return { ok: true as const };
    },
  );
}
