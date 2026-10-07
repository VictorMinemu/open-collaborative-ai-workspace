import { INLINE_IMAGE_TYPES } from "@ocw/contracts";
import { type Tx, workSessions } from "@ocw/db";
import { eq } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { authOf, type Core } from "../../core";
import { conflict, notFound } from "../../lib/errors";
import type { AttachmentScope } from "../artifact";
import { AuthzDeniedError, createPermissionService, type ResourceFacts } from "../organization";
import { sessionFacts } from "./facts";

/** Phase 06.1: the refusal for a non-image declared into a session's conversation (400 `images_only`). */
export const IMAGES_ONLY_MESSAGE = "Only images (PNG, JPEG, GIF, WebP) can be attached to a Work Zone prompt";

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
