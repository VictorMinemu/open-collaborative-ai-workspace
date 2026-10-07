import {
  EffectiveSessionSettings,
  INLINE_IMAGE_TYPES,
  type RuntimeCatalog,
  type RuntimeModel,
} from "@ocw/contracts";
import { type Tx, workSessions } from "@ocw/db";
import { eq } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { authOf, type Core } from "../../core";
import { conflict, HttpError, notFound } from "../../lib/errors";
import type { AttachmentScope } from "../artifact";
import { AuthzDeniedError, createPermissionService, type ResourceFacts } from "../organization";
import { sessionFacts } from "./facts";

/** Phase 06.1: the refusal for a non-image declared into a session's conversation (400 `images_only`). */
export const IMAGES_ONLY_MESSAGE = "Only images (PNG, JPEG, GIF, WebP) can be attached to a Work Zone prompt";

/** 400 `images_not_supported` (D-05, P-08): the session's model says it cannot read images. */
export const imagesNotSupported = (m: RuntimeModel) =>
  new HttpError(400, "images_not_supported", `${m.displayName} can't read images`, { model: m.id });

/**
 * The catalog row of the model the session's next turn runs (P-08), the composer's rule (`sessionModel` in the web's
 * model-picker): while a change is pending, the requested model (the device applies it before the next turn);
 * otherwise the model the device reports running (matched by `id` or `resolvedModel`, preferring the requested row),
 * else the requested one, else the catalog default. Null when the catalog does not list it (unknown).
 */
export function currentSessionModel(
  catalog: RuntimeCatalog | null,
  session: Pick<typeof workSessions.$inferSelect, "model" | "effectiveSettings" | "settingsPending">,
): RuntimeModel | null {
  if (!catalog) return null;
  const models = catalog.models;
  const requested = session.model ?? null;
  const wanted = requested
    ? (models.find((m) => m.id === requested) ?? null)
    : (models.find((m) => m.isDefault) ?? null);
  if (session.settingsPending) return wanted;
  const effective = EffectiveSessionSettings.safeParse(session.effectiveSettings);
  const runningId = effective.success ? effective.data.model : null;
  if (!runningId) return wanted;
  const exact = models.find((m) => m.id === runningId);
  if (exact) return exact;
  const resolved = models.filter((m) => m.resolvedModel === runningId);
  return resolved.find((m) => m.id === requested) ?? resolved.find((m) => !m.legacy) ?? resolved[0] ?? wanted;
}

type ScopedSession = Pick<typeof workSessions.$inferSelect, "id" | "createdBy" | "deviceId" | "status">;

/**
 * The artifact module's `work_session` scope (06.1, P-04): a session's images live in its conversation and follow
 * the session, not the channel rules. Read = `work_session.read` on the session, hidden as 404 (the `ws` topic's
 * decision); upload = readable, not archived, `work_session.prompt` on the session and org-level
 * `attachment.upload`, images only. The Phase 4 routes and URLs stay unchanged (D-01).
 */
export function createWorkSessionAttachmentScope(core: Core): AttachmentScope {
  const perms = createPermissionService(core);

  async function readable(
    req: FastifyRequest,
    tx: Tx,
    conversationId: string,
    notFoundMessage: string,
  ): Promise<{ session: ScopedSession; facts: ResourceFacts }> {
    // RLS scopes the lookup to the caller's organization: another tenant's session is simply missing.
    const [session] = await tx
      .select({
        id: workSessions.id,
        createdBy: workSessions.createdBy,
        deviceId: workSessions.deviceId,
        status: workSessions.status,
      })
      .from(workSessions)
      .where(eq(workSessions.conversationId, conversationId))
      .limit(1);
    if (!session) throw notFound(notFoundMessage);
    const facts = await sessionFacts(tx, authOf(req).userId, session);
    try {
      await perms.assertCan(req, tx, "work_session.read", facts, { hideAs404: true });
    } catch (err) {
      // Hidden must read exactly like missing (same status, code and message).
      if (err instanceof AuthzDeniedError && err.hidden) {
        throw new AuthzDeniedError(err.denial, { hideAs404: true, message: notFoundMessage });
      }
      throw err;
    }
    return { session, facts };
  }

  return {
    async assertRead(req, tx, conversationId, notFoundMessage) {
      await readable(req, tx, conversationId, notFoundMessage);
    },

    async assertUpload(req, tx, conversationId, notFoundMessage) {
      const { session, facts } = await readable(req, tx, conversationId, notFoundMessage);
      if (session.status === "archived") throw conflict("This session is archived", "session_archived");
      await perms.assertCan(req, tx, "work_session.prompt", facts);
      await perms.assertCan(req, tx, "attachment.upload");
      return { allowedTypes: INLINE_IMAGE_TYPES, typeMessage: IMAGES_ONLY_MESSAGE };
    },
  };
}
