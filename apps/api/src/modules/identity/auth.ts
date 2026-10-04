import * as dbSchema from "@ocw/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { jwt, organization } from "better-auth/plugins";
import { asc, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Env } from "../../config/env";
import { clientFromRequest } from "./client-kind";

export const INVITATION_TTL_SECONDS = 7 * 24 * 60 * 60;
/** Access JWT lifetime (AUTH-06). Revoked-session flags in Redis must outlive it (realtime/service.ts). */
export const ACCESS_TOKEN_TTL_SECONDS = 10 * 60;

/** The parts of better-auth's hook context we read: the endpoint context (`headers`) or its `request`. */
interface HookContext {
  headers?: Headers | null;
  request?: { headers?: Headers | null } | null;
}

/**
 * Internal better-auth plugin: exposes our audit table, the org_members projection and the setup singleton
 * as adapter models so identity flows can write them through `getCurrentAdapter()` inside the SAME
 * transaction as better-auth's own writes (better-auth `after` hooks run post-commit — research Pitfall 5).
 */
const ocwInternal = () =>
  ({
    id: "ocw-internal",
    schema: {
      auditEvent: {
        fields: {
          organizationId: { type: "string", required: true },
          actorKind: { type: "string", required: true },
          actorId: { type: "string", required: false },
          userId: { type: "string", required: false },
          sessionId: { type: "string", required: false },
          clientKind: { type: "string", required: false },
          resourceType: { type: "string", required: true },
          resourceId: { type: "string", required: false },
          action: { type: "string", required: true },
          result: { type: "string", required: true },
          metadata: { type: "json", required: false },
        },
      },
      orgMember: {
        fields: {
          organizationId: { type: "string", required: true },
          userId: { type: "string", required: true },
          displayName: { type: "string", required: true },
          email: { type: "string", required: false },
          avatarUrl: { type: "string", required: false },
          role: { type: "string", required: true },
        },
      },
      instanceSetup: {
        fields: {
          organizationId: { type: "string", required: true },
          redeemedBy: { type: "string", required: true },
        },
      },
    },
  }) as const;

export function createAuth(env: Env, authDb: NodePgDatabase) {
  return betterAuth({
    appName: "Open Collaborative AI Workspace",
    baseURL: env.OCW_PUBLIC_API_URL,
    basePath: "/api/auth",
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: [env.OCW_PUBLIC_WEB_URL, env.OCW_PUBLIC_API_URL, ...env.OCW_TRUSTED_ORIGINS],
    telemetry: { enabled: false },
    database: drizzleAdapter(authDb, {
      provider: "pg",
      transaction: true,
      schema: {
        user: dbSchema.user,
        session: dbSchema.session,
        account: dbSchema.account,
        verification: dbSchema.verification,
        organization: dbSchema.organization,
        member: dbSchema.member,
        invitation: dbSchema.invitation,
        auditEvent: dbSchema.auditEvents,
        orgMember: dbSchema.orgMembers,
        instanceSetup: dbSchema.instanceSetup,
        jwks: dbSchema.jwks,
      },
    }),
    emailAndPassword: { enabled: true, minPasswordLength: 12, maxPasswordLength: 256 },
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
      // AUTH-05: which client created the session; derived server-side at creation, never client input.
      additionalFields: {
        clientKind: { type: "string", required: false, input: false },
        clientLabel: { type: "string", required: false, input: false },
      },
    },
    databaseHooks: {
      session: {
        create: {
          before: async (session, context) => {
            const ctx = context as HookContext | null;
            const headers = ctx?.request?.headers ?? ctx?.headers ?? null;
            const client = clientFromRequest(headers ?? { "user-agent": session.userAgent ?? undefined });
            const [membership] = await authDb
              .select({
                organizationId: dbSchema.orgMembers.organizationId,
                deactivatedAt: dbSchema.orgMembers.deactivatedAt,
              })
              .from(dbSchema.orgMembers)
              .where(eq(dbSchema.orgMembers.userId, session.userId))
              .orderBy(asc(dbSchema.orgMembers.joinedAt))
              .limit(1);
            // A deactivated member cannot sign in (T-02-03-04): better-auth answers 401.
            if (membership?.deactivatedAt) return false;
            // During setup and invitation acceptance the membership row does not exist yet (and lives in an
            // uncommitted transaction); those flows set activeOrganizationId themselves.
            return {
              data: {
                ...session,
                clientKind: client.kind,
                clientLabel: client.label,
                ...(membership ? { activeOrganizationId: membership.organizationId } : {}),
              },
            };
          },
        },
      },
    },
    advanced: {
      cookiePrefix: "ocw",
      database: { generateId: "uuid" },
    },
    rateLimit: { enabled: false }, // rate limiting is done by @fastify/rate-limit on the mounted routes
    plugins: [
      // The plugin stores organizations, members (existence only, role "member") and invitation rows; it is
      // NOT an authorization authority: roles live in app.org_members and invitations are written by
      // identity/invitations.ts through the adapter (Phase 2, research R12).
      organization({ invitationExpiresIn: INVITATION_TTL_SECONDS, creatorRole: "member" }),
      ocwInternal(),
      // AUTH-06: short-lived EdDSA access JWTs (GET /api/auth/token) verifiable against GET /api/auth/jwks.
      jwt({
        jwks: {
          keyPairConfig: { alg: "EdDSA", crv: "Ed25519" },
          rotationInterval: 60 * 60 * 24 * 30,
          gracePeriod: 60 * 60 * 24 * 7,
        },
        jwt: {
          issuer: env.OCW_PUBLIC_API_URL,
          audience: env.OCW_PUBLIC_API_URL,
          expirationTime: "10m",
          // The default payload is the whole user object (Pitfall 3): keep the claims minimal.
          definePayload: ({ session }) => ({
            sid: session.id,
            org: session.activeOrganizationId,
            ck: session.clientKind ?? "web",
          }),
        },
        // Otherwise every get-session signs a JWT and exposes it in `set-auth-jwt` (T-02-03-03).
        disableSettingJwtHeader: true,
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
