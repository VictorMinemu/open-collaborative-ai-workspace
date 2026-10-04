import { getCurrentAdapter, runWithTransaction } from "@better-auth/core/context";
import { EventTypes, Profile, UpdateProfileRequest } from "@ocw/contracts";
import { orgMembers, user } from "@ocw/db";
import { and, eq } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { type App, type AuthContext, authOf, tenant } from "../../core";
import { notFound } from "../../lib/errors";
import { createPermissionService, userResource } from "../organization";
import { asRole } from "./authenticate";
import type { IdentityRouteDeps } from "./routes";
import { auditVia } from "./service";

type ProfileField = "displayName" | "avatarUrl" | "statusEmoji" | "statusText";
const PROFILE_FIELDS: readonly ProfileField[] = ["displayName", "avatarUrl", "statusEmoji", "statusText"];

/**
 * ORG-06: the caller's own profile. The display name and avatar live on both auth.user (better-auth's view)
 * and app.org_members (what chat and the member directory read); status lives on org_members only. Avatar
 * upload waits for object storage (Phase 4); an emoji or an https URL is accepted today.
 */
export function registerProfileRoutes(app: App, deps: IdentityRouteDeps): void {
  const { identity } = deps;
  const perms = createPermissionService({ db: deps.db, audit: deps.audit });

  const assertSelf = (req: FastifyRequest) => {
    const auth = authOf(req);
    return deps.db.withTenant(tenant(req), (tx) =>
      perms.assertCan(req, tx, "account.manage", userResource(auth.userId, auth.userId)),
    );
  };

  const readProfile = async (auth: AuthContext): Promise<Profile> => {
    const [row] = await identity.authDb
      .select({
        name: user.name,
        email: user.email,
        image: user.image,
        displayName: orgMembers.displayName,
        avatarUrl: orgMembers.avatarUrl,
        statusEmoji: orgMembers.statusEmoji,
        statusText: orgMembers.statusText,
        role: orgMembers.role,
      })
      .from(user)
      .innerJoin(
        orgMembers,
        and(eq(orgMembers.userId, user.id), eq(orgMembers.organizationId, auth.organizationId)),
      )
      .where(eq(user.id, auth.userId))
      .limit(1);
    if (!row) throw notFound("Profile not found", "profile_not_found");
    return {
      userId: auth.userId,
      displayName: row.displayName || row.name,
      email: row.email,
      avatarUrl: row.avatarUrl ?? row.image ?? null,
      statusEmoji: row.statusEmoji ?? null,
      statusText: row.statusText || null,
      role: asRole(row.role),
    };
  };

  app.get(
    "/api/v1/me/profile",
    {
      config: { authz: "user" },
      preHandler: identity.requireUser,
      schema: { tags: ["identity"], response: { 200: Profile } },
    },
    async (req) => {
      await assertSelf(req);
      return readProfile(authOf(req));
    },
  );

  app.patch(
    "/api/v1/me/profile",
    {
      config: { authz: "user" },
      preHandler: identity.requireUser,
      schema: { tags: ["identity"], body: UpdateProfileRequest, response: { 200: Profile } },
    },
    async (req) => {
      const auth = authOf(req);
      await assertSelf(req);
      const current = await readProfile(auth);
      const next: Partial<Record<ProfileField, string | null>> = {};
      for (const field of PROFILE_FIELDS) {
        const v = req.body[field];
        if (v === undefined) continue;
        // An empty status text clears it, like null.
        const value = field === "statusText" && v === "" ? null : v;
        if (value !== current[field]) next[field] = value;
      }
      const changed = PROFILE_FIELDS.filter((f) => f in next);
      if (changed.length === 0) return current;

      const ctx = await identity.auth.$context;
      await runWithTransaction(ctx.adapter, async () => {
        const adapter = await getCurrentAdapter(ctx.adapter);
        const userUpdate: Record<string, unknown> = {};
        if ("displayName" in next) userUpdate.name = next.displayName;
        if ("avatarUrl" in next) userUpdate.image = next.avatarUrl;
        if (Object.keys(userUpdate).length) {
          await adapter.update({
            model: "user",
            where: [{ field: "id", value: auth.userId }],
            update: { ...userUpdate, updatedAt: new Date() },
          });
        }
        await adapter.update({
          model: "orgMember",
          where: [
            { field: "userId", value: auth.userId },
            { field: "organizationId", value: auth.organizationId },
          ],
          update: next,
        });
        await auditVia(adapter, {
          organizationId: auth.organizationId,
          userId: auth.userId,
          sessionId: auth.sessionId,
          clientKind: auth.clientKind,
          action: "user.profile_updated",
          resourceType: "user",
          resourceId: auth.userId,
          // Field names only: the values are the member's own and already visible in the directory.
          metadata: { fields: changed },
        });
      });
      // After the profile commits: everyone in the organization refreshes names, avatars and status live.
      await deps.db.withTenant(tenant(req), (tx) =>
        deps.realtime.appendEvent(tx, `org:${auth.organizationId}`, EventTypes.memberUpdated, {
          userId: auth.userId,
          changed,
        }),
      );
      return readProfile(auth);
    },
  );
}
