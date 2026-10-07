import {
  EffectiveSessionSettings,
  INLINE_IMAGE_TYPES,
  type PromptImage,
  type RuntimeCatalog,
  type RuntimeModel,
  WORK_PROMPT_IMAGE_MAX_BYTES,
  WORK_PROMPT_MAX_IMAGES,
} from "@ocw/contracts";
import { type Tx, workSessions } from "@ocw/db";
import { eq } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { authOf, type Core } from "../../core";
import { conflict, HttpError, notFound } from "../../lib/errors";
import {
  type AttachmentPart,
  type AttachmentRow,
  type AttachmentScope,
  attachmentRowsForWorkPrompt,
  fitImageWithin,
  type ObjectStorage,
  readAttachmentBytes,
} from "../artifact";
import { CommandUndeliverableError, type DeviceCommandRow } from "../device";
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

// ------------------------------------------------------------------ dispatch to the device (06.1-02, P-03)

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The longest edge sent to a runtime (06.1 RESEARCH Q2): Anthropic rejects requests with more than 20 images unless
 * every image is at most 2000 px on both sides, and a session's history accumulates images turn after turn.
 */
export const DEVICE_IMAGE_MAX_EDGE = 2000;
/** A PNG original at most this large (and at most DEVICE_IMAGE_MAX_EDGE on both sides) goes as is (P-02). */
export const PNG_ORIGINAL_MAX_BYTES = 1024 * 1024;

type ImageFacts = Pick<
  AttachmentRow,
  "id" | "filename" | "contentType" | "sizeBytes" | "width" | "height" | "largeBytes"
>;

/** Which stored part of an image goes to the device, its type, whether it is resized, and its recorded size. */
export interface ImagePartChoice {
  part: "original" | "large.webp";
  mediaType: PromptImage["mediaType"];
  resize: boolean;
  /** Recorded size of the chosen part (`size_bytes` / `large_bytes`); null when it was never recorded. */
  bytes: number | null;
}

/**
 * P-02: a PNG of at most PNG_ORIGINAL_MAX_BYTES whose oriented width and height are both at most
 * DEVICE_IMAGE_MAX_EDGE goes as the original PNG (clipboard screenshots: lossless text, no camera metadata).
 * Everything else goes as the `large.webp` rendition, resized at dispatch when the original's long edge is above
 * DEVICE_IMAGE_MAX_EDGE (the rendition is 2048 px).
 *
 * Recorded deviation from D-04 ("keep the original type when small") for non-PNG images: EXIF/GPS privacy and
 * single-frame GIF. A JPEG or WebP original can carry camera EXIF/GPS (the rendition strips it), and a GIF must reach
 * the runtimes as a single frame (OpenAI accepts only non-animated GIFs; the rendition is the first frame).
 */
export function chooseImagePart(row: ImageFacts): ImagePartChoice {
  const known = row.width != null && row.height != null;
  const longEdge = known ? Math.max(row.width!, row.height!) : Number.POSITIVE_INFINITY;
  if (
    row.contentType === "image/png" &&
    row.sizeBytes <= PNG_ORIGINAL_MAX_BYTES &&
    longEdge <= DEVICE_IMAGE_MAX_EDGE
  ) {
    return { part: "original", mediaType: "image/png", resize: false, bytes: row.sizeBytes };
  }
  return {
    part: "large.webp",
    mediaType: "image/webp",
    resize: longEdge > DEVICE_IMAGE_MAX_EDGE,
    bytes: row.largeBytes ?? null,
  };
}

const MB = 1024 * 1024;

/**
 * WZ-IMG-02 (P-01, P-03): every image's chosen part fits WORK_PROMPT_IMAGE_MAX_BYTES, judged from the sizes recorded
 * at upload (`size_bytes`, `large_bytes`). Runs in the submit transaction with no storage call and no image work, so
 * nothing slow happens while the session row is locked. Otherwise 400 `image_too_large`.
 */
export function checkImageBudget(rows: ImageFacts[]): void {
  const limit = `images can be at most ${WORK_PROMPT_IMAGE_MAX_BYTES / MB} MB`;
  for (const row of rows) {
    const { bytes } = chooseImagePart(row);
    if (bytes === null) {
      throw new HttpError(400, "image_too_large", `${row.filename} has no recorded size; ${limit}`, {
        attachmentId: row.id,
        maxBytes: WORK_PROMPT_IMAGE_MAX_BYTES,
      });
    }
    if (bytes > WORK_PROMPT_IMAGE_MAX_BYTES) {
      throw new HttpError(
        400,
        "image_too_large",
        `${row.filename} is ${(bytes / MB).toFixed(1)} MB after resizing; ${limit}`,
        { attachmentId: row.id, bytes, maxBytes: WORK_PROMPT_IMAGE_MAX_BYTES },
      );
    }
  }
}

/** A prompt's image is gone (deleted, missing from storage, unreadable or over the cap): its prompt fails visibly. */
export class ImageUnavailableError extends CommandUndeliverableError {
  constructor() {
    // Never the storage error's text: only this fixed reason reaches logs, the command row and the audit.
    super("image_unavailable", "An attached image is no longer available");
  }
}

/** What one image of a prompt command sends, chosen inside the flush transaction (database work only). */
export interface PreparedImage {
  row: AttachmentRow;
  part: AttachmentPart;
  mediaType: PromptImage["mediaType"];
  resize: boolean;
}

/** The plan `hydratePromptImages` follows; `images: null` means an image of the prompt is no longer there. */
export interface PromptImagesPlan {
  images: PreparedImage[] | null;
}

/** The attachment ids a stored `prompt` command carries (ids only, request order), or none. */
export function imageIdsOf(payload: Record<string, unknown>): string[] {
  const ids = payload.imageAttachmentIds;
  if (!Array.isArray(ids)) return [];
  return ids
    .filter((id): id is string => typeof id === "string" && UUID_RE.test(id))
    .slice(0, WORK_PROMPT_MAX_IMAGES);
}

/**
 * Step 1 of sending a prompt command, INSIDE the hub's flush transaction: reads the prompt's linked rows and picks
 * each image's part. No storage call, no image work. Undefined for every other command and for a prompt without
 * images (sent exactly as stored).
 */
export async function preparePromptImages(
  tx: Tx,
  command: DeviceCommandRow,
): Promise<PromptImagesPlan | undefined> {
  if (command.kind !== "prompt") return undefined;
  const ids = imageIdsOf(command.payload);
  if (ids.length === 0) return undefined;
  const promptId = String(command.payload.promptId ?? "");
  const rows = UUID_RE.test(promptId) ? await attachmentRowsForWorkPrompt(tx, promptId) : [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const images: PreparedImage[] = [];
  for (const id of ids) {
    const row = byId.get(id);
    if (!row) return { images: null };
    const { part, mediaType, resize } = chooseImagePart(row);
    images.push({ row, part, mediaType, resize });
  }
  return { images };
}

/**
 * Step 2, AFTER the flush transaction committed: reads each chosen part from object storage (capped at
 * WORK_PROMPT_IMAGE_MAX_BYTES), fits it within DEVICE_IMAGE_MAX_EDGE when needed, and returns the payload to send, with `images` (base64) and without
 * `imageAttachmentIds`. The result is never stored. Any failure is `ImageUnavailableError`.
 */
export async function hydratePromptImages(
  storage: ObjectStorage | null,
  command: DeviceCommandRow,
  plan: PromptImagesPlan,
): Promise<Record<string, unknown>> {
  const { imageAttachmentIds: _ids, ...payload } = command.payload;
  if (!plan.images || !storage) throw new ImageUnavailableError();
  const images: PromptImage[] = [];
  for (const image of plan.images) {
    let bytes: Uint8Array;
    try {
      bytes = await readAttachmentBytes(storage, image.row, image.part, WORK_PROMPT_IMAGE_MAX_BYTES);
      if (image.resize) bytes = await fitImageWithin(bytes, DEVICE_IMAGE_MAX_EDGE);
    } catch {
      throw new ImageUnavailableError();
    }
    if (bytes.length === 0 || bytes.length > WORK_PROMPT_IMAGE_MAX_BYTES) throw new ImageUnavailableError();
    images.push({ mediaType: image.mediaType, dataBase64: Buffer.from(bytes).toString("base64") });
  }
  return { ...payload, images };
}
