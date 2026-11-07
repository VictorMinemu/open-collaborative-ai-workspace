import type { FastifyBaseLogger } from "fastify";
import type { AttachmentRow } from "../model";
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
    default:
      return refused("unsupported_type");
  }
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
