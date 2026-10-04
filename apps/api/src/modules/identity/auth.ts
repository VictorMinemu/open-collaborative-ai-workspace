import * as dbSchema from "@ocw/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { organization } from "better-auth/plugins";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Env } from "../../config/env";

export const INVITATION_TTL_SECONDS = 7 * 24 * 60 * 60;

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
      },
    }),
    emailAndPassword: { enabled: true, minPasswordLength: 12, maxPasswordLength: 256 },
    session: { expiresIn: 60 * 60 * 24 * 7, updateAge: 60 * 60 * 24 },
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
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
