import { getCurrentAdapter, runWithTransaction } from "@better-auth/core/context";
import { IdParams, Ok, type SessionInfo, SessionList } from "@ocw/contracts";
import type { FastifyRequest } from "fastify";
import { type App, authOf, tenant } from "../../core";
import { badRequest, notFound } from "../../lib/errors";
import { createPermissionService, userResource } from "../organization";
import type { IdentityRouteDeps } from "./routes";
import { auditVia } from "./service";
import type { SessionRecord } from "./session-store";

/** Explicit fields only: the session secret never leaves the server (Pitfall 9). */
function toSessionInfo(s: SessionRecord, currentSessionId: string): SessionInfo {
  return {
    id: s.id,
    clientKind: s.clientKind,
    clientLabel: s.clientLabel,
    ipAddress: s.ipAddress,
    createdAt: s.createdAt,
    lastActiveAt: s.updatedAt,
    current: s.id === currentSessionId,
  };
}

/**
 * AUTH-05: the caller's own sessions. better-auth's list/revoke endpoints are never routed because they
 * expose session secrets; these routes read explicit columns, delete only the caller's rows, audit in the
 * same auth-plane transaction and fan the revocation out after it commits.
 */
export function registerSessionRoutes(app: App, deps: IdentityRouteDeps): void {
  const { identity } = deps;
  const perms = createPermissionService({ db: deps.db, audit: deps.audit });

  /** Every route here acts on the caller's own account (`account.manage` via the `self` relation). */
  const assertSelf = (req: FastifyRequest) => {
    const auth = authOf(req);
    return deps.db.withTenant(tenant(req), (tx) =>
      perms.assertCan(req, tx, "account.manage", userResource(auth.userId, auth.userId)),
    );
  };

  app.get(
    "/api/v1/me/sessions",
    {
      config: { authz: "user" },
      preHandler: identity.requireUser,
      schema: { tags: ["identity"], response: { 200: SessionList } },
    },
    async (req) => {
      const auth = authOf(req);
      await assertSelf(req);
      const sessions = await identity.sessions.list(auth.userId);
      return { sessions: sessions.map((s) => toSessionInfo(s, auth.sessionId)) };
    },
  );

  app.delete(
    "/api/v1/me/sessions/:id",
    {
      config: { authz: "user" },
      preHandler: identity.requireUser,
      schema: { tags: ["identity"], params: IdParams, response: { 200: Ok } },
    },
    async (req) => {
      const auth = authOf(req);
      await assertSelf(req);
      const { id } = req.params;
      if (id === auth.sessionId) {
        throw badRequest("Use sign out to end the session you are using", "current_session");
      }
      const ctx = await identity.auth.$context;
      await runWithTransaction(ctx.adapter, async () => {
        // Filtered by the caller's user id: someone else's session id is indistinguishable from none (IDOR).
        if (!(await identity.sessions.delete(auth.userId, id))) {
          throw notFound("Session not found", "session_not_found");
        }
        await auditVia(await getCurrentAdapter(ctx.adapter), {
          organizationId: auth.organizationId,
          userId: auth.userId,
          sessionId: auth.sessionId,
          clientKind: auth.clientKind,
          action: "session.revoked",
          resourceType: "session",
          resourceId: id,
          metadata: { revokedSessionId: id, scope: "one" },
        });
      });
      // Session ids only: a `userId` would make consumers (the /ws gateway) close the caller's own sockets too.
      await deps.realtime.publishRevocation({ sessionIds: [id], reason: "session_revoked" });
      return { ok: true as const };
    },
  );

  app.post(
    "/api/v1/me/sessions/revoke-others",
    {
      config: { authz: "user" },
      preHandler: identity.requireUser,
      schema: { tags: ["identity"], response: { 200: Ok } },
    },
    async (req) => {
      const auth = authOf(req);
      await assertSelf(req);
      const ctx = await identity.auth.$context;
      const revoked = await runWithTransaction(ctx.adapter, async () => {
        const ids = await identity.sessions.deleteAllForUser(auth.userId, {
          exceptSessionId: auth.sessionId,
        });
        await auditVia(await getCurrentAdapter(ctx.adapter), {
          organizationId: auth.organizationId,
          userId: auth.userId,
          sessionId: auth.sessionId,
          clientKind: auth.clientKind,
          action: "session.revoked",
          resourceType: "user",
          resourceId: auth.userId,
          metadata: { revokedSessionIds: ids, scope: "others" },
        });
        return ids;
      });
      if (revoked.length) {
        await deps.realtime.publishRevocation({ sessionIds: revoked, reason: "session_revoked" });
      }
      return { ok: true as const };
    },
  );
}
