import {
  isInlineImageType,
  type ModelControl,
  PROMPT_FILES_UPDATE_DEVICE,
  type PromptFilesControl,
  promptFileDenySentence,
  promptFileRefusal,
  promptFileTooLargeSentence,
  WORK_PROMPT_MAX_ATTACHMENTS,
  WORK_PROMPT_MAX_IMAGES,
} from "@ocw/contracts";

/**
 * What the Work Zone composer lets a controller attach (06.1; ADR-0045: any file). It mirrors the API, which stays
 * authoritative. An image the session's current model reads goes inline (the first `WORK_PROMPT_MAX_IMAGES`; absent =
 * unknown = reads them, as on the server); every other file, and an image the model can't read, is copied into the
 * session's working tree, so it needs a device that takes files, a name off the shared deny list and a size within the
 * per-file limit (`GET /controls`'s `files`; absent while unknown = the API decides alone). Nothing goes with a `/`
 * command. Pure: unit-tested, re-run whenever the model, the device or the text changes.
 */

export type AttachmentRoute = "inline" | "file";
export type AttachmentGate = { ok: true; route: AttachmentRoute | null } | { ok: false; reason: string };

export const SLASH_REASON = "Files can't be sent with a / command";
export const TOO_MANY_REASON = `Up to ${WORK_PROMPT_MAX_ATTACHMENTS} files per prompt`;

export function attachmentGate(input: {
  /** `currentModelControl(session, controls)`; null or undefined while unknown. */
  model: ModelControl | null | undefined;
  /** Omitted: may the session take attachments at all (the paperclip). */
  file?: { contentType: string; name: string; size: number };
  /** Images before this one that go inline (the first `WORK_PROMPT_MAX_IMAGES` do). */
  inlineBefore?: number;
  /** `GET /controls`'s `files`; null or undefined while unknown. */
  files?: PromptFilesControl | null;
  /** The prompt text starts with `/` (a session command, never queued with files). */
  slashCommand?: boolean;
}): AttachmentGate {
  if (input.slashCommand) return { ok: false, reason: SLASH_REASON };
  const file = input.file;
  if (!file) return { ok: true, route: null };
  const inline =
    isInlineImageType(file.contentType) &&
    input.model?.imageInput !== false &&
    (input.inlineBefore ?? 0) < WORK_PROMPT_MAX_IMAGES;
  if (inline) return { ok: true, route: "inline" };
  if (input.files?.supported === false) return { ok: false, reason: PROMPT_FILES_UPDATE_DEVICE };
  const denied = promptFileRefusal(file.name);
  if (denied) return { ok: false, reason: promptFileDenySentence(denied) };
  if (input.files && file.size > input.files.maxBytes) {
    return { ok: false, reason: promptFileTooLargeSentence(input.files.maxBytes) };
  }
  return { ok: true, route: "file" };
}
