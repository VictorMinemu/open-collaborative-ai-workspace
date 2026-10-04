import { MeResponse, SetupRequest, SetupStatusResponse } from "@ocw/contracts";
import { orgMembers, type TenantDb, user } from "@ocw/db";
import { fromNodeHeaders } from "better-auth/node";
import { asc, eq } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { App, AuthContext } from "../../core";
import { authOf } from "../../core";
import type { AuditService } from "../audit";
import { createPermissionService } from "../organization";
import type { RealtimeService } from "../realtime";
import { clientFromRequest } from "./client-kind";
import type { IdentityService } from "./service";

const SENSITIVE_RATE = { rateLimit: { max: 30, timeWindow: "1 minute" } };
/** RFC 5321 caps an address at 320 characters; anything longer is cut before it reaches the audit log. */
const MAX_AUDITED_EMAIL = 320;

/** What every identity route module receives (identity/index.ts). */
export interface IdentityRouteDeps {
  identity: IdentityService;
  db: TenantDb;
  audit: AuditService;
  realtime: RealtimeService;
  apiUrl: string;
  /** Sign-in attempts per IP per minute (env OCW_SIGNIN_RATE_LIMIT_PER_MINUTE, default 30). */
  signInRatePerMinute?: number;
}

/**
 * better-auth endpoints we expose. Everything else (public sign-up, org create, …) is simply not routed.
 * Never add the session-listing or session-revoking endpoints: they return session tokens (Pitfall 9).
 */
const BETTER_AUTH_ALLOWLIST: Array<{ method: "GET" | "POST"; path: string }> = [
  { method: "POST", path: "/api/auth/sign-in/email" },
  { method: "POST", path: "/api/auth/sign-out" },
  { method: "GET", path: "/api/auth/get-session" },
  // AUTH-06: the session cookie buys a 10-minute access JWT; the JWKS is public by design.
  { method: "GET", path: "/api/auth/token" },
  { method: "GET", path: "/api/auth/jwks" },
];

export function registerIdentityRoutes(app: App, deps: IdentityRouteDeps) {
  const signInRate = { rateLimit: { max: deps.signInRatePerMinute ?? 30, timeWindow: "1 minute" } };
  const { identity } = deps;
  const perms = createPermissionService({ db: deps.db, audit: deps.audit });

  /**
   * ORG-05: a failed sign-in is audited in its own transaction (nothing else is written). The organization is
   * the one of the user owning that e-mail, else the instance's; before setup there is nowhere to write it.
   * The attempted password is never read here.
   */
  const auditFailedSignIn = async (req: FastifyRequest, status: number, json: unknown) => {
    const raw = (req.body as { email?: unknown } | null)?.email;
    const email = typeof raw === "string" ? raw.trim().toLowerCase().slice(0, MAX_AUDITED_EMAIL) : "";
    const [account] = email
      ? await identity.authDb.select({ id: user.id }).from(user).where(eq(user.email, email)).limit(1)
      : [];
    const [membership] = account
      ? await identity.authDb
          .select({ organizationId: orgMembers.organizationId })
          .from(orgMembers)
          .where(eq(orgMembers.userId, account.id))
          .orderBy(asc(orgMembers.joinedAt))
          .limit(1)
      : [];
    const organizationId = membership?.organizationId ?? (await identity.instanceOrganizationId());
    if (!organizationId) return;
    const code = (json as { code?: unknown } | null)?.code;
    const userId = membership ? (account?.id ?? null) : null;
    await deps.db.withTenant({ organizationId, userId: null }, (tx) =>
      deps.audit.record(tx, {
        action: "user.sign_in_failed",
        resourceType: "user",
        resourceId: userId,
        result: "denied",
        actorKind: "system",
        userId,
        sessionId: null,
        clientKind: clientFromRequest(req.headers).kind,
        metadata: { email, ip: req.ip, reason: typeof code === "string" ? code : String(status) },
      }),
    );
  };

  /** ORG-05: sign-out is audited in its own transaction; the session id is flagged revoked everywhere. */
  const auditSignOut = async (principal: AuthContext) => {
    const { organizationId, userId, sessionId, clientKind } = principal;
    await deps.db.withTenant({ organizationId, userId, sessionId, clientKind }, (tx) =>
      deps.audit.record(tx, { action: "user.signed_out", resourceType: "session", resourceId: sessionId }),
    );
    // Session ids only: the user's other sessions stay valid.
    await deps.realtime.publishRevocation({ sessionIds: [sessionId], reason: "signed_out" });
  };

  const setCookies = (reply: FastifyReply, cookies: string[]) => {
    if (cookies.length) reply.header("set-cookie", cookies);
  };

  // ---- better-auth allowlist proxy ----
  for (const route of BETTER_AUTH_ALLOWLIST) {
    app.route({
      method: route.method,
      url: route.path,
      schema: { tags: ["auth"], hide: false },
      config: { authz: "public", ...(route.path.includes("sign-in") ? signInRate : {}) },
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const isSignIn = route.path.endsWith("/sign-in/email");
        const isSignOut = route.path.endsWith("/sign-out");
        // Resolve who is signing out before better-auth deletes the session.
        const signingOut = isSignOut ? await identity.authenticate(req.headers) : null;
        const url = new URL(req.url, deps.apiUrl);
        const body = req.method === "GET" ? undefined : JSON.stringify(req.body ?? {});
        const headers = fromNodeHeaders(req.headers);
        if (body !== undefined) headers.set("content-type", "application/json");
        headers.delete("content-length");
        const res = await identity.auth.handler(new Request(url, { method: req.method, headers, body }));
        reply.status(res.status);
        res.headers.forEach((value, key) => {
          if (!["set-cookie", "content-length", "content-encoding", "transfer-encoding"].includes(key)) {
            reply.header(key, value);
          }
        });
        setCookies(reply, res.headers.getSetCookie());
        const text = await res.text();
        let json: unknown = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch {
          json = { message: "Unexpected auth response" };
        }

        if (isSignIn && !res.ok) await auditFailedSignIn(req, res.status, json);
        if (isSignOut && res.ok && signingOut) await auditSignOut(signingOut);
        if (isSignIn && res.ok) {
          // Audit sign-in (no domain write to share, so "same tx" is vacuous here).
          const userId = (json as { user?: { id?: string } } | null)?.user?.id;
          const orgId = userId ? await identity.organizationOf(userId) : null;
          if (userId && orgId) {
            await deps.db.withTenant({ organizationId: orgId, userId }, (tx) =>
              deps.audit.record(tx, {
                action: "user.signed_in",
                resourceType: "user",
                resourceId: userId,
                clientKind: clientFromRequest(req.headers).kind,
              }),
            );
          }
        }
        return reply.type("application/json; charset=utf-8").send(json);
      },
    });
  }

  // ---- setup ----
  app.get(
    "/api/v1/setup/status",
    { config: { authz: "public" }, schema: { tags: ["identity"], response: { 200: SetupStatusResponse } } },
    () => identity.setupStatus(),
  );

  app.post(
    "/api/v1/setup",
    {
      config: { authz: "public", ...SENSITIVE_RATE },
      schema: { tags: ["identity"], body: SetupRequest, response: { 200: MeResponse } },
    },
    async (req, reply) => {
      const { me, cookies } = await identity.setup(req.body, {}, req.headers);
      setCookies(reply, cookies);
      return me;
    },
  );

  // ---- session ----
  app.get(
    "/api/v1/me",
    {
      config: { authz: "user" },
      preHandler: [identity.requireUser, perms.requirePermission("org.read")],
      schema: { tags: ["identity"], response: { 200: MeResponse } },
    },
    (req) => identity.me(authOf(req)),
  );
}
