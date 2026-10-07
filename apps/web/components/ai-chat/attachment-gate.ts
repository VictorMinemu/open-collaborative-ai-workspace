import { AI_TEXT_INLINE_MAX_BYTES, type AiModelOption, INLINE_IMAGE_TYPES } from "@ocw/contracts";

/**
 * What the composer lets a member attach for the selected AI model (05-12, AICHAT-08). It mirrors the API's rule
 * (`checkAttachmentsForModel`), which stays authoritative: images need a vision model, PDFs a model that reads PDFs,
 * text files (text/* and JSON) go to any model up to the inline limit, and nothing else can be sent to a model.
 * Pure: unit-tested, re-run whenever the model changes.
 */

export type AttachmentGate = { ok: true } | { ok: false; reason: string };

const IMAGES = new Set<string>(INLINE_IMAGE_TYPES);
const KB = AI_TEXT_INLINE_MAX_BYTES / 1024;

export type AiFileKind = "image" | "pdf" | "text" | "other";

/** The kind of a file by its (browser-declared) type, as the API classifies it. */
export function aiFileKind(contentType: string): AiFileKind {
  const type = contentType.trim().toLowerCase();
  if (IMAGES.has(type)) return "image";
  if (type === "application/pdf") return "pdf";
  if (type.startsWith("text/") || type === "application/json") return "text";
  return "other";
}

export function attachmentGate(
  model: AiModelOption | null,
  file: { contentType: string; size: number },
): AttachmentGate {
  const refuse = (reason: string): AttachmentGate => ({ ok: false, reason });
  switch (aiFileKind(file.contentType)) {
    case "image":
      return model && !model.caps.vision ? refuse(`${model.label} can't read images`) : { ok: true };
    case "pdf":
      return model && !model.caps.pdf ? refuse(`${model.label} can't read PDFs`) : { ok: true };
    case "text":
      return file.size > AI_TEXT_INLINE_MAX_BYTES
        ? refuse(`Text files over ${KB} KB can't be sent`)
        : { ok: true };
    default:
      return refuse("This file type can't be sent to a model");
  }
}

/** "GPT-6 Astra reads images, PDFs and text files": the paperclip's hint for the selected model. */
export function readableSummary(model: AiModelOption | null): string {
  if (!model) return "Attach files";
  const kinds = [model.caps.vision ? "images" : null, model.caps.pdf ? "PDFs" : null, "text files"].filter(
    (k): k is string => k !== null,
  );
  const list = kinds.length > 1 ? `${kinds.slice(0, -1).join(", ")} and ${kinds.at(-1)}` : kinds[0];
  return `${model.label} reads ${list}${kinds.length === 1 ? " only" : ""}`;
}
