import { z } from "zod";
import { INLINE_IMAGE_TYPES, MAX_ATTACHMENTS_PER_MESSAGE, sanitizeFilename } from "./attachments";
import {
  BOT_FILE_LIMITS,
  fileSizeLabel,
  isWindowsReservedName,
  type WorkSessionFileDenyReason,
  WorkSessionFilePath,
  workSessionFilePathRefusal,
} from "./work-session-files";

/**
 * Files on a person's Work Zone prompt (ADR-0045). A prompt carries any file its author uploaded into the session's
 * conversation. Images the session's model reads go to it inline, as since 06.1 (at most `WORK_PROMPT_MAX_IMAGES`);
 * every other file, and an image the model cannot read or past the inline cap, is copied into the session's working
 * tree on the device before the turn starts, through the transfer of ADR-0041 (`GET /api/v1/runtime/files/:id` under
 * the device JWT, the one deny list, the per-file limit), and the prompt the runtime receives ends with a note the
 * device writes, listing the repo-relative paths (`withPromptFilesNote`). The person never types that note.
 *
 * Imports only `zod` and leaf contracts (`attachments`, `work-session-files`): `device-link` and `work-session` import
 * this file, never the reverse.
 */

/** Attachments one prompt may carry (images and files together): the chat's per-message cap. */
export const WORK_PROMPT_MAX_ATTACHMENTS = MAX_ATTACHMENTS_PER_MESSAGE;

/**
 * Where a prompt's files land, relative to the session's working tree. Not on the deny list (`.ocw` is neither
 * `.ocw-worktrees` nor a runtime's configuration), so the device's own check accepts it.
 */
export const WORK_PROMPT_UPLOADS_DIR = ".ocw/uploads";

/** Room kept in a file name for the collision suffix (`-12`) inside the 255-character segment bound. */
const NAME_MAX = BOT_FILE_LIMITS.segmentMaxChars - 8;
const DEFAULT_IGNORABLE = /\p{Default_Ignorable_Code_Point}/gu;

/** The extension of a file name (`.pdf`), or "" when it has none (a leading dot is part of the name). */
function splitExtension(name: string): { stem: string; ext: string } {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1 || name.length - dot > 16) return { stem: name, ext: "" };
  return { stem: name.slice(0, dot), ext: name.slice(dot) };
}

/**
 * The name a prompt file gets in the working tree: the attachment's sanitised name (`sanitizeFilename`) made safe for
 * every volume the daemon runs on: compatibility forms folded (NFKC), default-ignorable code points dropped, `:` and an
 * 8.3 short name's `~<digit>` replaced, trailing dots and spaces trimmed, a Windows device name (`CON`, `NUL` …)
 * prefixed with `_`, at most 247 characters keeping the extension. Never empty (`file`). The result is one plain
 * `WorkSessionFilePath` segment.
 */
export function promptFileName(filename: string): string {
  let name = sanitizeFilename(filename.normalize("NFKC"))
    .replace(DEFAULT_IGNORABLE, "")
    .replace(/[/\\:]/g, "_")
    .replace(/~(?=\d)/g, "-")
    .replace(/[. ]+$/u, "")
    .trim();
  if (name.length > NAME_MAX) {
    const { stem, ext } = splitExtension(name);
    name = `${stem.slice(0, NAME_MAX - ext.length).replace(/[. ]+$/u, "")}${ext}`;
  }
  if (!name || name === "." || name === "..") name = "file";
  if (isWindowsReservedName(name)) name = `_${name}`;
  return WorkSessionFilePath.safeParse(name).success ? name : "file";
}

/** The repo-relative path a prompt file is first offered at: `.ocw/uploads/<promptFileName>`. */
export function promptFilePath(filename: string): string {
  return `${WORK_PROMPT_UPLOADS_DIR}/${promptFileName(filename)}`;
}

/**
 * The `n`-th free-name candidate for `path` (n ≥ 1): `spec.pdf` → `spec-1.pdf`, `notes` → `notes-1`,
 * `archive.tar.gz` → `archive.tar-1.gz`. The device tries `path`, then n = 1, 2 … and never overwrites a file.
 */
export function promptFileCollisionPath(path: string, n: number): string {
  const slash = path.lastIndexOf("/");
  const dir = slash === -1 ? "" : path.slice(0, slash + 1);
  const { stem, ext } = splitExtension(path.slice(slash + 1));
  return `${dir}${stem}-${n}${ext}`;
}

/** Why a prompt file's name is refused, as the composer and the API say it (the shared deny list's reasons). */
export function promptFileDenySentence(reason: WorkSessionFileDenyReason): string {
  return reason === "secret"
    ? "Keys and credential files can't be attached; keep them in the secret store"
    : "This file name is reserved for the repository or the runtime's settings";
}

/** The deny-list reason for a file name as it would land in the tree, or null when it may go. */
export function promptFileRefusal(filename: string): WorkSessionFileDenyReason | null {
  return workSessionFilePathRefusal(promptFilePath(filename));
}

/** `file_too_large` for a prompt file: "Over the 25 MB limit". */
export function promptFileTooLargeSentence(maxBytes: number): string {
  return `Over the ${fileSizeLabel(maxBytes)} limit`;
}

/** How the device's sentence for a prompt file that did not land starts (the prompt's ack error). */
export const PROMPT_FILE_FAILURE_PREFIX = "Could not copy ";

/** A device that does not announce `hello.promptFiles` cannot receive files on a prompt (409 `runtime_too_old`). */
export const PROMPT_FILES_UPDATE_DEVICE = "Update this device to attach files";

/**
 * How one attachment of a prompt reaches the runtime: `inline` (an image the model reads, while fewer than `maxInline`
 * went inline before it) or `file` (copied into the working tree). `imageInput` is the model's flag: absent = unknown =
 * reads images, as everywhere else.
 */
export function promptAttachmentRoutes(
  items: ReadonlyArray<{ inlineImage: boolean }>,
  imageInput: boolean | undefined,
  maxInline: number,
): Array<"inline" | "file"> {
  let inline = 0;
  return items.map((item) => {
    if (item.inlineImage && imageInput !== false && inline < maxInline) {
      inline++;
      return "inline";
    }
    return "file";
  });
}

const INLINE = new Set<string>(INLINE_IMAGE_TYPES);

/** True for a content type the runtimes take inline (PNG, JPEG, GIF, WebP), ignoring case and spaces. */
export function isInlineImageType(contentType: string): boolean {
  return INLINE.has(contentType.trim().toLowerCase());
}

/** `GET /work-sessions/:id/controls`'s `files`: whether the session's device takes prompt files, and the limit. */
export const PromptFilesControl = z.object({
  /** The device announced `hello.promptFiles` (else the composer says `PROMPT_FILES_UPDATE_DEVICE`). */
  supported: z.boolean(),
  /** min(the organization's limit, `OCW_ATTACHMENT_MAX_BYTES`), per file. */
  maxBytes: z.number().int().positive(),
});
export type PromptFilesControl = z.infer<typeof PromptFilesControl>;

// ---------------------------------------------------------------- the note the runtime reads

/** The first line of the note: structural, written by the device, never by the person. */
export const PROMPT_FILES_NOTE_HEADER = "Attached files (in the working tree):";

/** The note listing `paths` (repo-relative), one per line, or "" for none. */
export function promptFilesNote(paths: readonly string[]): string {
  if (paths.length === 0) return "";
  return [PROMPT_FILES_NOTE_HEADER, ...paths.map((p) => `- ${p}`)].join("\n");
}

/** The prompt text a runtime receives: the person's text, a blank line, then the note (unchanged without files). */
export function withPromptFilesNote(text: string, paths: readonly string[]): string {
  const note = promptFilesNote(paths);
  return note ? `${text}\n\n${note}` : text;
}

/** The paths of a note at the end of `text` (what a test runtime reports back), or none. */
export function promptFilesNotePaths(text: string): string[] {
  const at = text.lastIndexOf(`\n${PROMPT_FILES_NOTE_HEADER}\n`);
  if (at === -1) return [];
  return text
    .slice(at + PROMPT_FILES_NOTE_HEADER.length + 2)
    .split("\n")
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2));
}
