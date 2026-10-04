import { MeResponse, SetupRequest, SetupStatusResponse } from "@ocw/contracts";
import type { TenantDb } from "@ocw/db";
import { fromNodeHeaders } from "better-auth/node";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { App } from "../../core";
import { authOf } from "../../core";
import type { AuditService } from "../audit";
import type { RealtimeService } from "../realtime";
import type { IdentityService } from "./service";

const SENSITIVE_RATE = { rateLimit: { max: 30, timeWindow: "1 minute" } };

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

export function registerIdentityRoutes(
  app: App,
  deps: {
    identity: IdentityService;
    db: TenantDb;
    audit: AuditService;
    realtime: RealtimeService;
    apiUrl: string;
  },
) {
  const { identity } = deps;

  const setCookies = (reply: FastifyReply, cookies: string[]) => {
    if (cookies.length) reply.header("set-cookie", cookies);
  };

  // ---- better-auth allowlist proxy ----
  for (const route of BETTER_AUTH_ALLOWLIST) {
    app.route({
      method: route.method,
      url: route.path,
      schema: { tags: ["auth"], hide: false },
      config: route.path.includes("sign-in") ? SENSITIVE_RATE : {},
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
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

        if (route.path.endsWith("/sign-in/email") && res.ok) {
          // Audit sign-in (no domain write to share, so "same tx" is vacuous here).
          const userId = (json as { user?: { id?: string } } | null)?.user?.id;
          const orgId = userId ? await identity.organizationOf(userId) : null;
          if (userId && orgId) {
            await deps.db.withTenant({ organizationId: orgId, userId }, (tx) =>
              deps.audit.record(tx, {
                action: "user.signed_in",
                resourceType: "user",
                resourceId: userId,
                clientKind: "web",
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
    { schema: { tags: ["identity"], response: { 200: SetupStatusResponse } } },
    () => identity.setupStatus(),
  );

  app.post(
    "/api/v1/setup",
    {
      config: SENSITIVE_RATE,
      schema: { tags: ["identity"], body: SetupRequest, response: { 200: MeResponse } },
    },
    async (req, reply) => {
      const { me, cookies } = await identity.setup(req.body);
      setCookies(reply, cookies);
      return me;
    },
  );

  // ---- session ----
  app.get(
    "/api/v1/me",
    { preHandler: identity.requireUser, schema: { tags: ["identity"], response: { 200: MeResponse } } },
    (req) => identity.me(authOf(req)),
  );
}
