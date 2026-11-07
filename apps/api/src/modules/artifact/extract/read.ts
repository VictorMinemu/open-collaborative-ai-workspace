import { INLINE_IMAGE_TYPES } from "@ocw/contracts";
import type { FastifyBaseLogger } from "fastify";
import type { AttachmentRow } from "../model";
import { AttachmentTooLargeError, readAttachmentBytes } from "../read-bytes";
import { RENDITIONS } from "../renditions";
import { attachmentKey, type ObjectStorage } from "../storage";
import { EXTRACT_LIMITS } from "./limits";
import { attachmentKindOf, cutChars, decodeText } from "./text";

/**
 * Why a stored file could not be read for a bot (a subset of `AttachmentReadRefusal`, kept local: 04 needs nothing
 * from 01; 08 assigns it to the contract type, so the typecheck catches any drift).
 */
export type ExtractRefusal =
  | "unsupported_type"
  | "too_large"
  | "no_text_layer"
  | "encrypted"
  | "extraction_failed"
  | "timeout"
  | "busy"
  | "unavailable";

/** What a bot read gives: raw text (not yet wrapped as untrusted), image bytes, or a fixed refusal code. */
export type AgentRead =
  | { kind: "text"; text: string; chars: number; truncated: boolean; pages?: number }
  | {
      kind: "image";
      mimeType: "image/webp" | "image/png" | "image/jpeg" | "image/gif";
      data: Uint8Array;
      width: number | null;
      height: number | null;
    }
  | { kind: "refused"; code: ExtractRefusal };

export interface AgentReadCaps {
  /** Code units this read may return (the route passes `min(charsPerFile, what the turn has left)`). */
  charsPerFile: number;
  /** The deployment's attachment size limit (`OCW_ATTACHMENT_MAX_BYTES`): the most a whole-object read may buffer. */
  maxBytes: number;
}

const refused = (code: ExtractRefusal): AgentRead => ({ kind: "refused", code });

/**
 * One stored file read for a bot (07.15 D-05, PD-07), from the store with the server's credentials (ADR-0015: no
 * URL is produced). It never executes, evaluates or renders the file; markup and code come back as text. It decides
 * nothing about access: the caller has already decided that this turn may read this row, wraps the text as
 * untrusted (`untrustedFileBlock`, 08) and owns the audit. Every failure is a fixed code; a store or parser error is
 * logged by its name only (its message can quote file text) and never returned.
 */
export async function readAttachmentForAgent(
  storage: ObjectStorage,
  row: AttachmentRow,
  caps: AgentReadCaps,
  opts: { log?: Pick<FastifyBaseLogger, "warn"> } = {},
): Promise<AgentRead> {
  const failed = (err: unknown): AgentRead => {
    opts.log?.warn({ err: { name: (err as Error)?.name } }, "attachment read for a bot failed");
    return refused("unavailable");
  };
  switch (attachmentKindOf(row)) {
    case "text":
      try {
        return await readText(storage, row, caps);
      } catch (err) {
        return failed(err);
      }
    case "image":
      try {
        return await readImage(storage, row);
      } catch (err) {
        if (err instanceof AttachmentTooLargeError) return refused("too_large");
        return failed(err);
      }
    default:
      // `pdf` joins in 07.15-05 (pdfText); everything else cannot be read as text.
      return refused("unsupported_type");
  }
}

type ImageType = Extract<AgentRead, { kind: "image" }>["mimeType"];
const IMAGE_TYPES = new Set<string>(INLINE_IMAGE_TYPES);
const LARGE_EDGE = RENDITIONS.find((r) => r.part === "large.webp")!.size;

/**
 * The size of the stored `large.webp` rendition from the original's oriented dimensions: the box sharp's `fit:
 * "inside"`, `withoutEnlargement` gives at upload (`renderRenditions`, the same settings as `fitImageWithin`).
 * Computed, never decoded: nothing is resized at read time.
 */
function renditionSize(width: number | null, height: number | null) {
  if (width === null || height === null || width <= 0 || height <= 0) return { width: null, height: null };
  const scale = Math.min(1, LARGE_EDGE / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * Image bytes for the model (D-03, D-05): the stored `large.webp` rendition when there is one (EXIF-free, ≤ 2048 px,
 * made by sharp at upload), else the original of an `INLINE_IMAGE_TYPES` image up to
 * `EXTRACT_LIMITS.imageOriginalMaxBytes`, else `too_large` (T-07.15-04-03: no image is decoded or resized here).
 * The image reaches the model only as the tool result's image part (ADR-0029 spike ii), never through OpenClaw's
 * native media.
 */
async function readImage(storage: ObjectStorage, row: AttachmentRow): Promise<AgentRead> {
  const cap = EXTRACT_LIMITS.imageOriginalMaxBytes;
  if (row.hasRenditions) {
    const data = await readAttachmentBytes(storage, row, "large.webp", cap);
    return { kind: "image", mimeType: "image/webp", data, ...renditionSize(row.width, row.height) };
  }
  const type = row.contentType ?? row.declaredType;
  if (!IMAGE_TYPES.has(type)) return refused("unsupported_type");
  if (row.sizeBytes > cap) return refused("too_large");
  const data = await readAttachmentBytes(storage, row, "original", cap);
  return { kind: "image", mimeType: type as ImageType, data, width: row.width, height: row.height };
}

/**
 * Text from one range read of at most `EXTRACT_LIMITS.textReadBytes` bytes of the original, never the whole object
 * (T-07.15-04-01). Truncated when the file is larger than what was read or the text exceeds `charsPerFile`.
 */
async function readText(storage: ObjectStorage, row: AttachmentRow, caps: AgentReadCaps): Promise<AgentRead> {
  const bytes = await storage.rangeGet(
    attachmentKey(row.organizationId, row.conversationId, row.id, "original"),
    EXTRACT_LIMITS.textReadBytes,
  );
  const complete = row.sizeBytes <= bytes.length;
  const decoded = decodeText(bytes, { complete });
  if (decoded === null) return refused("unsupported_type");
  const cut = cutChars(decoded.text, caps.charsPerFile);
  return {
    kind: "text",
    text: cut.text,
    chars: cut.text.length,
    truncated: !complete || cut.truncated,
  };
}
