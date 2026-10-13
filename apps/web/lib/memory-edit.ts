import {
  MEMORY_LIMITS,
  type MemoryActor,
  type MemoryPathError,
  type MemoryRevisionMeta,
  parseMemoryFolder,
  SensitiveFinding,
} from "@ocw/contracts";
import { isApiError } from "./api";

/**
 * Pure helpers for memory editing (Phase 07.2, 07.2-12, MEM-02, UI-SPEC "Copywriting"): the words for path errors,
 * secrets and save failures (API codes are never shown), sizes, path arithmetic for the file actions and the history
 * labels. No React, no CodeMirror: unit-tested in `memory-edit.test.ts` and safe to import from the reading pane.
 */

const PATH_ERRORS: Record<MemoryPathError | "missing_slash", string> = {
  empty: "Enter a path.",
  absolute: 'Remove the leading "/".',
  backslash: 'Use "/" between folders.',
  percent: 'Remove "%".',
  control: "Remove hidden or control characters.",
  dot_segment: '"." and ".." aren\'t allowed.',
  empty_segment: 'Remove the double "/".',
  trailing_slash: 'End with a file name, not "/".',
  segment_space: "Remove spaces at the start or end of a name.",
  segment_charset: 'Use letters, numbers, spaces, ".", "_" and "-" only.',
  segment_length: "Each name can have up to 64 characters.",
  depth: "Use at most 8 levels of folders.",
  length: "The path can have up to 255 characters.",
  extension: "File names end in .md (lowercase).",
  missing_slash: 'End the folder with "/".',
};

export function pathErrorText(reason: MemoryPathError | "missing_slash"): string {
  return PATH_ERRORS[reason];
}

export const PATH_EXISTS = "A file with this name already exists.";
export const ROOT_FILE_NOTE = "MEMORY.md is the scope's main file. You can edit it, not rename or delete it.";
export const SAVE_FAILED = "Couldn't save. Your changes are still here.";

/** "This looks like a secret on line 12." / "on lines 12 and 30." / up to 3 numbers, then "and N more". */
export function secretHeadline(lines: readonly number[]): string {
  if (lines.length === 0) return "This looks like a secret.";
  if (lines.length === 1) return `This looks like a secret on line ${lines[0]}.`;
  if (lines.length <= 3) {
    const head = lines.slice(0, -1).join(", ");
    return `This looks like a secret on lines ${head} and ${lines[lines.length - 1]}.`;
  }
  return `This looks like a secret on lines ${lines.slice(0, 3).join(", ")} and ${lines.length - 3} more.`;
}

/** `error.details[key]` when the API sent an object with it. */
function detail(details: unknown, key: string): unknown {
  return details && typeof details === "object" ? (details as Record<string, unknown>)[key] : undefined;
}

/** The masked findings of a 422 `secret_detected` (block severity only, as the API sends them). */
export function secretFindings(err: unknown): { lines: number[]; samples: string[] } | null {
  if (!isApiError(err) || err.code !== "secret_detected") return null;
  const raw = detail(err.details, "findings");
  const findings = (Array.isArray(raw) ? raw : []).flatMap((f) => {
    const parsed = SensitiveFinding.safeParse(f);
    return parsed.success ? [parsed.data] : [];
  });
  const lines = [...new Set(findings.flatMap((f) => f.lines))].sort((a, b) => a - b);
  const samples = [...new Set(findings.flatMap((f) => f.samples))];
  return { lines, samples };
}

/** Plain words for a failed write (UI-SPEC "Edit, save and guard"); the draft is never lost on an error. */
export function saveErrorText(err: unknown): string {
  if (!isApiError(err)) return SAVE_FAILED;
  switch (err.code) {
    case "memory_file_too_large":
      return "This file is over 256 KB. Split it into smaller files.";
    case "memory_scope_full":
      return "This memory holds 2,000 files, the most it can. Delete or merge files first.";
    case "memory_path_exists":
      return PATH_EXISTS;
    case "memory_root_file":
      return ROOT_FILE_NOTE;
    case "memory_path_invalid": {
      const reason = detail(err.details, "reason");
      return typeof reason === "string" && reason in PATH_ERRORS
        ? pathErrorText(reason as MemoryPathError)
        : "This path isn't valid.";
    }
    case "memory_not_found":
      return "This file doesn't exist or you can't open it";
    default:
      if (err.status === 403) return "You can't change this file.";
      return SAVE_FAILED;
  }
}

const encoder = new TextEncoder();
export const utf8Bytes = (s: string) => encoder.encode(s).length;

const LIMIT_KB = MEMORY_LIMITS.fileBytes / 1024;

/** "12 KB of 256 KB" (rounded up, so a non-empty file is never "0 KB"). */
export function formatSize(bytes: number): string {
  return `${Math.ceil(bytes / 1024)} KB of ${LIMIT_KB} KB`;
}

/** Above 90% of the limit the size line turns red (UI-SPEC "Desktop Edit mode"). */
export function isNearFull(bytes: number): boolean {
  return bytes > MEMORY_LIMITS.fileBytes * 0.9;
}

/** `clients/acme.md` → `clients/`; a root file → "". */
export function parentFolder(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i + 1);
}

export function fileName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** A new file starts with its stem as the heading. */
export function newFileContent(path: string): string {
  return `# ${fileName(path).replace(/\.md$/u, "")}\n`;
}

/** "meetings" or "clients/meetings/" → the folder and its INDEX.md (a missing trailing "/" is added, not refused). */
export function folderIndexPath(
  input: string,
): { ok: true; folder: string; path: string } | { ok: false; reason: MemoryPathError | "missing_slash" } {
  const trimmed = input.length > 0 && !input.endsWith("/") ? `${input}/` : input;
  const parsed = parseMemoryFolder(trimmed);
  if (!parsed.ok) return parsed;
  return { ok: true, folder: parsed.folder, path: `${parsed.folder}INDEX.md` };
}

/** Rename when only the last segment changed, move otherwise. */
export function moveKind(from: string, to: string): "same" | "rename" | "move" {
  if (from === to) return "same";
  return parentFolder(from) === parentFolder(to) ? "rename" : "move";
}

export function actorLabel(actor: MemoryActor): string {
  if (actor.kind === "system") return "Workspace";
  if (actor.kind === "agent" && actor.onBehalfOf)
    return `${actor.displayName} for ${actor.onBehalfOf.displayName}`;
  return actor.displayName;
}

const OPS: Record<MemoryRevisionMeta["op"], string> = {
  create: "Created",
  update: "Edited",
  append: "Added to",
  rename: "Renamed",
  delete: "Deleted",
  restore: "Restored",
};

/** The history row's op; a rename names the previous file when the older revision is known. */
export function revisionOpLabel(rev: MemoryRevisionMeta, older?: MemoryRevisionMeta): string {
  if (rev.op === "rename" && older && older.path !== rev.path) return `Renamed from ${fileName(older.path)}`;
  return OPS[rev.op];
}

const lines = (n: number, word: string) => `${n} ${n === 1 ? "line" : "lines"} ${word}`;

/** "Version 5, Added to, by Scout for Sam Lee, 2 minutes ago, 2 lines added, 0 removed" (UI-SPEC a11y). */
export function revisionAccessibleName(rev: MemoryRevisionMeta, op: string, age: string): string {
  return `Version ${rev.version}, ${op}, by ${actorLabel(rev.author)}, ${age}, ${lines(rev.linesAdded, "added")}, ${rev.linesRemoved} removed`;
}
