import { randomUUID } from "node:crypto";
import {
  BOT_FILE_LIMITS,
  type BotFileLimit,
  INLINE_IMAGE_TYPES,
  PROMPT_FILES_UPDATE_DEVICE,
  type PromptFile,
  PromptFile as PromptFileSchema,
  promptAttachmentRoutes,
  promptFileDenySentence,
  promptFilePath,
  promptFileTooLargeSentence,
  type RuntimeModel,
  WORK_PROMPT_MAX_IMAGES,
  workSessionFilePathRefusal,
} from "@ocw/contracts";
import { attachments, botWorkSessionFiles, devices, type Tx, tenantOf } from "@ocw/db";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { HttpError } from "../../lib/errors";
import type { AttachmentRow } from "../artifact";
import type { AuditService } from "../audit";
import { catalogFor } from "./controls";
import { checkImageBudget, currentSessionModel } from "./images";
import { loadBotFileLimit } from "./policy";
import type { SessionRow } from "./service";

/**
 * Files on a person's Work Zone prompt (ADR-0045). The person who sends the prompt is the actor: every attachment was
 * uploaded by them into the session's conversation (the 06.1 scope) and linked to the prompt under their rights
 * (`linkWorkPromptAttachments`). Images the session's model reads go inline as since 06.1; every other file is copied
 * into the session's working tree before the turn, through ADR-0041's transfer (one `to_device` row of
 * `bot_work_session_files` per file, owned by the prompt; the daemon fetches `GET /api/v1/runtime/files/:id` with its
 * device JWT). Nothing here stores, logs or audits a path or a file name: ids, sizes, a digest and a path length (P1).
 */

const INLINE = new Set<string>(INLINE_IMAGE_TYPES);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A prompt's attachments as they reach the runtime: inline images, and files with the path they are offered at. */
export interface PromptAttachmentPlan {
  inline: AttachmentRow[];
  files: Array<{ row: AttachmentRow; path: string }>;
}

/** An attachment the runtimes take inline: a sniffed PNG, JPEG, GIF or WebP with its renditions (06.1). */
const isInlineImage = (row: Pick<AttachmentRow, "contentType" | "hasRenditions">) =>
  row.hasRenditions && INLINE.has(row.contentType ?? "");

/**
 * Which rows go inline and which into the tree, in the author's order (`promptAttachmentRoutes`): images the model
 * reads (unknown = reads them), the first `WORK_PROMPT_MAX_IMAGES` of them; everything else is a file.
 */
export function planPromptAttachments(
  rows: readonly AttachmentRow[],
  model: Pick<RuntimeModel, "imageInput"> | null,
): PromptAttachmentPlan {
  const routes = promptAttachmentRoutes(
    rows.map((row) => ({ inlineImage: isInlineImage(row) })),
    model?.imageInput,
    WORK_PROMPT_MAX_IMAGES,
  );
  const plan: PromptAttachmentPlan = { inline: [], files: [] };
  rows.forEach((row, i) => {
    if (routes[i] === "inline") plan.inline.push(row);
    else plan.files.push({ row, path: promptFilePath(row.filename) });
  });
  return plan;
}

/** The session device's catalog row for the next turn's model and whether the device takes prompt files. */
async function deviceFacts(
  tx: Tx,
  s: SessionRow,
): Promise<{ model: RuntimeModel | null; promptFiles: boolean }> {
  const [d] = await tx
    .select({ catalog: devices.runtimeCatalog, promptFilesVersion: devices.promptFilesVersion })
    .from(devices)
    .where(eq(devices.id, s.deviceId))
    .limit(1);
  return {
    model: currentSessionModel(catalogFor(d?.catalog, s.runtime), s),
    promptFiles: d?.promptFilesVersion != null,
  };
}

/** 409 `runtime_too_old`: the session's device would drop the files (ADR-0045). */
export const promptFilesRuntimeTooOld = () =>
  new HttpError(409, "runtime_too_old", `${PROMPT_FILES_UPDATE_DEVICE} (Settings › Devices)`);

/**
 * What one file breaks, or null: its name is on the deny list as it would land, or it is over the limit. The
 * sentences are the composer's ("Over the 25 MB limit"); the message names the file the person attached.
 */
export function promptFileProblem(
  file: { row: Pick<AttachmentRow, "id" | "filename" | "sizeBytes">; path: string },
  limit: BotFileLimit,
): HttpError | null {
  const reason = workSessionFilePathRefusal(file.path);
  if (reason) {
    return new HttpError(
      400,
      "file_name_not_allowed",
      `${file.row.filename}: ${promptFileDenySentence(reason)}`,
      { attachmentId: file.row.id, reason },
    );
  }
  if (file.row.sizeBytes > limit.bytes) {
    return new HttpError(
      400,
      "file_too_large",
      `${file.row.filename}: ${promptFileTooLargeSentence(limit.bytes)}`,
      { attachmentId: file.row.id, maxBytes: limit.bytes, limitSource: limit.source },
    );
  }
  return null;
}

/**
 * At submit, in the prompt's transaction, after the rows were linked: the plan for the model the next turn runs, the
 * inline images' budget (06.1, 400 `image_too_large`), then for the files the device's support (409
 * `runtime_too_old`), the deny list (400 `file_name_not_allowed`) and the per-file limit, min(the organization's,
 * `OCW_ATTACHMENT_MAX_BYTES`) (400 `file_too_large`). Any refusal rolls the whole submit back.
 */
export async function decidePromptAttachments(
  tx: Tx,
  s: SessionRow,
  rows: readonly AttachmentRow[],
  serverMaxBytes: number,
): Promise<PromptAttachmentPlan> {
  if (rows.length === 0) return { inline: [], files: [] };
  const facts = await deviceFacts(tx, s);
  const plan = planPromptAttachments(rows, facts.model);
  checkImageBudget(plan.inline);
  if (plan.files.length === 0) return plan;
  if (!facts.promptFiles) throw promptFilesRuntimeTooOld();
  const limit = await loadBotFileLimit(tx, null, serverMaxBytes);
  for (const file of plan.files) {
    const problem = promptFileProblem(file, limit);
    if (problem) throw problem;
  }
  return plan;
}

/** Why a queued prompt's files cannot go at dispatch (the arbiter refuses the prompt with it), or null. */
export type PromptFilesDispatchRefusal =
  | "images_not_supported"
  | "runtime_too_old"
  | "file_too_large"
  | "file_unavailable";

/** A queued prompt's attachments as the turn will take them, decided at dispatch (`decidePromptFilesAtDispatch`). */
export interface DispatchPlan extends PromptAttachmentPlan {
  /** The per-file limit that applied (recorded on each ledger row); null without files. */
  limit: BotFileLimit | null;
}

/**
 * At dispatch, with the session LOCKED: the plan for the model the turn runs now (it may have changed while the
 * prompt waited), refused when the device can no longer take its files (`images_not_supported` when they are only
 * images the model cannot read, as before ADR-0045) or a file is over a limit lowered since. Writes nothing: the
 * arbiter may still refuse the turn for another reason (`no_account`) before `openPromptFileTransfers`.
 */
export async function decidePromptFilesAtDispatch(
  tx: Tx,
  s: SessionRow,
  promptId: string,
  rows: readonly AttachmentRow[],
  serverMaxBytes: number,
): Promise<({ ok: true } & DispatchPlan) | { ok: false; reason: PromptFilesDispatchRefusal }> {
  // A file deleted while the prompt waited is no longer among the ready rows: the turn never runs without it.
  const [gone] = await tx
    .select({ id: attachments.id })
    .from(attachments)
    .where(and(eq(attachments.workPromptId, promptId), ne(attachments.status, "ready")))
    .limit(1);
  if (gone) return { ok: false, reason: "file_unavailable" };
  if (rows.length === 0) return { ok: true, inline: [], files: [], limit: null };
  const facts = await deviceFacts(tx, s);
  const plan = planPromptAttachments(rows, facts.model);
  if (plan.files.length === 0) return { ok: true, ...plan, limit: null };
  if (!facts.promptFiles) {
    const onlyImages = plan.files.every((f) => isInlineImage(f.row));
    return { ok: false, reason: onlyImages ? "images_not_supported" : "runtime_too_old" };
  }
  const limit = await loadBotFileLimit(tx, null, serverMaxBytes);
  if (plan.files.some((f) => promptFileProblem(f, limit) !== null))
    return { ok: false, reason: "file_too_large" };
  return { ok: true, ...plan, limit };
}

/**
 * Right before the prompt command is enqueued: one ledger row per file (owned by the prompt, `to_device`, the
 * attachment's size and sha256, the path's length only, the longest transfer deadline, so a turn held at the
 * runtime's update gate still finds its files) and the `files` the command carries.
 */
export async function openPromptFileTransfers(
  tx: Tx,
  s: SessionRow,
  promptId: string,
  plan: DispatchPlan,
): Promise<PromptFile[]> {
  const limit = plan.limit;
  if (plan.files.length === 0 || !limit) return [];
  const files: PromptFile[] = [];
  for (const { row, path } of plan.files) {
    const transferId = randomUUID();
    await tx.insert(botWorkSessionFiles).values({
      id: transferId,
      organizationId: tenantOf(tx).organizationId,
      workSessionId: s.id,
      workPromptId: promptId,
      deviceId: s.deviceId,
      conversationId: s.conversationId,
      direction: "to_device",
      attachmentId: row.id,
      maxBytes: limit.bytes,
      limitSource: limit.source,
      sizeBytes: row.sizeBytes,
      sha256: row.sha256,
      pathLength: path.length,
      // The database's clock: the transfer route compares `expires_at` with its `now()`.
      expiresAt: sql`now() + ${BOT_FILE_LIMITS.transferMaxMs} * interval '1 millisecond'`,
    });
    files.push(PromptFileSchema.parse({ transferId, path, sizeBytes: row.sizeBytes, sha256: row.sha256 }));
  }
  return files;
}

/** The transfer ids a stored `prompt` command lists in `files` (ids only), or none. */
export function promptFileTransferIds(payload: Record<string, unknown>): string[] {
  const files = payload.files;
  if (!Array.isArray(files)) return [];
  return files
    .map((f) => (f as { transferId?: unknown } | null)?.transferId)
    .filter((id): id is string => typeof id === "string" && UUID_RE.test(id));
}

/**
 * When the device answered a prompt command (or the hub could not send it): each of its files is `done` when the
 * device acked the prompt and the transfer route served the file in full (`streamed`), else `failed`. One
 * `work_session.file_upload` audit row per file: the author, the device, the session, the prompt and attachment ids,
 * the size, the sha256 and the path's length (never a path or a name, P1); `error` for a file that did not land.
 */
export async function finishPromptFiles(
  tx: Tx,
  audit: AuditService,
  s: SessionRow,
  command: { payload: Record<string, unknown> },
  ok: boolean,
  authorUserId: string | null,
): Promise<void> {
  const ids = promptFileTransferIds(command.payload);
  if (ids.length === 0) return;
  const rows = await tx
    .select()
    .from(botWorkSessionFiles)
    .where(and(inArray(botWorkSessionFiles.id, ids), eq(botWorkSessionFiles.workSessionId, s.id)))
    .for("update");
  for (const row of rows) {
    if (row.status === "done" || row.status === "failed") continue;
    // The device acks only after it checked the bytes' size and sha256 and landed the file; the transfer route records
    // `streamed` just after its response finished, so a row still `streaming` at an ok has landed too (never `pending`).
    const landed = ok && (row.status === "streamed" || row.status === "streaming");
    await tx
      .update(botWorkSessionFiles)
      .set(
        landed
          ? { status: "done", completedAt: sql`now()` }
          : { status: "failed", failure: row.failure ?? "transfer_failed", completedAt: sql`now()` },
      )
      .where(eq(botWorkSessionFiles.id, row.id));
    await audit.record(tx, {
      action: "work_session.file_upload",
      resourceType: "work_session",
      resourceId: s.id,
      userId: authorUserId,
      deviceId: s.deviceId,
      sessionId: s.id,
      result: landed ? "success" : "error",
      metadata: {
        transferId: row.id,
        promptId: row.workPromptId,
        attachmentId: row.attachmentId,
        bytes: row.sizeBytes,
        sha256: row.sha256,
        pathLength: row.pathLength,
        direction: "to_device",
        ...(landed ? {} : { failure: row.failure ?? "transfer_failed" }),
      },
    });
  }
}
