import { INLINE_IMAGE_TYPES, type ModelControl } from "@ocw/contracts";

/**
 * What the Work Zone composer lets a controller attach (06.1, D-05, P-06, P-08). It mirrors the API, which stays
 * authoritative (400 `images_only`, `images_not_supported`; the slash guard): only the four image types, only when the
 * session's current model does not report that it can't read images (absent = unknown = allowed, as on the server),
 * and never with a `/` command. Pure: unit-tested, re-run whenever the model or the text changes.
 */

export type ImageGate = { ok: true } | { ok: false; reason: string };

export const IMAGES_ONLY_REASON = "Only images (PNG, JPEG, GIF, WebP) can be sent to a session";
export const SLASH_REASON = "Images can't be sent with a / command";

const IMAGES = new Set<string>(INLINE_IMAGE_TYPES);

export function imageGate(input: {
  /** `currentModelControl(session, controls)`; null or undefined while unknown. */
  model: ModelControl | null | undefined;
  /** Omitted: may the session take images at all (the paperclip). */
  file?: { contentType: string };
  /** The prompt text starts with `/` (a session command, never queued with images). */
  slashCommand?: boolean;
}): ImageGate {
  if (input.file && !IMAGES.has(input.file.contentType.trim().toLowerCase())) {
    return { ok: false, reason: IMAGES_ONLY_REASON };
  }
  if (input.model?.imageInput === false) {
    return { ok: false, reason: `${input.model.displayName} can't read images` };
  }
  if (input.slashCommand) return { ok: false, reason: SLASH_REASON };
  return { ok: true };
}
