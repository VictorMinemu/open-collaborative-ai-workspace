import { z } from "zod";
import { Id, IsoDateTime } from "./common";
import { UnitKind } from "./permissions";

/**
 * Scoped memory files (Phase 07.2, D-01, ADR-0023). Memory is platform-owned Markdown: virtual `.md` files in
 * PostgreSQL per scope (personal, agent, unit = department/team/project, org), with folders derived from paths and a
 * `MEMORY.md` at every scope root. Pure: no Node APIs (the web and the OpenClaw plugin import it too).
 */

export const MemoryScopeKind = z.enum(["personal", "agent", "unit", "org"]);
export type MemoryScopeKind = z.infer<typeof MemoryScopeKind>;

/** The root file of every scope: created with the scope, never deleted or renamed (only edited). */
export const MEMORY_ROOT_FILE = "MEMORY.md";
export const MEMORY_ROOT_TEMPLATE = "# Memory\n";

export const MEMORY_LIMITS = {
  /** UTF-8 bytes of one file's content. */
  fileBytes: 262_144,
  /** Characters (code points) of a whole path. */
  pathChars: 255,
  /** Characters (code points) of one path segment. */
  segmentChars: 64,
  /** Segments of a path, the file name included. */
  depth: 8,
  /** Live (not deleted) files per scope. */
  filesPerScope: 2_000,
  /** UTF-8 bytes of one `MEMORY.md` injected into a bot turn (truncated beyond). */
  turnFileBytes: 8_192,
  proposalTtlDays: 14,
  pendingProposalsPerRequester: 20,
  /** Characters of a proposal's reason (the bot's note). */
  reasonChars: 280,
} as const;

// ---------------------------------------------------------------- paths (MEM-01, Pitfall 4)

/** Why a path or folder was refused. The parser rejects; it never repairs input. */
export const MemoryPathError = z.enum([
  "empty",
  "absolute",
  "backslash",
  "percent",
  "control",
  "dot_segment",
  "empty_segment",
  "trailing_slash",
  "segment_space",
  "segment_charset",
  "segment_length",
  "depth",
  "length",
  "extension",
]);
export type MemoryPathError = z.infer<typeof MemoryPathError>;

export type MemoryPathResult = { ok: true; path: string } | { ok: false; reason: MemoryPathError };
export type MemoryFolderResult =
  | { ok: true; folder: string }
  | { ok: false; reason: MemoryPathError | "missing_slash" };

/** C0/C1 controls (Cc) and format characters (Cf: bidi overrides, zero-width, BOM). */
const CONTROL = /[\p{Cc}\p{Cf}]/u;
/** Letters, digits, space, dot, underscore and hyphen. */
const SEGMENT_CHARSET = /^[\p{L}\p{N} ._-]+$/u;
const DOTS_ONLY = /^\.+$/;

const codePoints = (s: string) => [...s].length;

/** Checks shared by files and folders, on the NFC form, before splitting. */
function checkWhole(s: string): MemoryPathError | null {
  if (s.length === 0) return "empty";
  if (CONTROL.test(s)) return "control";
  if (s.startsWith("/")) return "absolute";
  if (s.includes("\\")) return "backslash";
  if (s.includes("%")) return "percent";
  return null;
}

function checkSegments(segments: readonly string[]): MemoryPathError | null {
  for (const seg of segments) {
    if (seg.length === 0) return "empty_segment";
    if (DOTS_ONLY.test(seg)) return "dot_segment";
    if (seg.startsWith(" ") || seg.endsWith(" ")) return "segment_space";
    if (!SEGMENT_CHARSET.test(seg)) return "segment_charset";
    if (codePoints(seg) > MEMORY_LIMITS.segmentChars) return "segment_length";
  }
  return null;
}

/**
 * A memory file path: repo-style, relative, `/`-separated, NFC. Accepts letters, digits, space, `.`, `_` and `-` in
 * segments of 1-64 characters, at most 8 segments and 255 characters, ending in a lowercase `.md` file name. Rejects
 * (never fixes) absolute paths, backslashes, any `%` (no decoding), control and bidi characters, empty and dot-only
 * segments, trailing slashes and edge spaces; returns the first failing reason.
 */
export function parseMemoryPath(input: string): MemoryPathResult {
  const s = input.normalize("NFC");
  const whole = checkWhole(s);
  if (whole) return { ok: false, reason: whole };
  if (s.endsWith("/")) return { ok: false, reason: "trailing_slash" };
  const segments = s.split("/");
  const seg = checkSegments(segments);
  if (seg) return { ok: false, reason: seg };
  if (segments.length > MEMORY_LIMITS.depth) return { ok: false, reason: "depth" };
  if (codePoints(s) > MEMORY_LIMITS.pathChars) return { ok: false, reason: "length" };
  const name = segments[segments.length - 1] ?? "";
  if (!name.endsWith(".md") || name.length <= ".md".length) return { ok: false, reason: "extension" };
  return { ok: true, path: s };
}

/**
 * A folder prefix for per-folder rules: the same grammar for its segments, always ending in `/` (so `hr/` can never
 * match `hr-public/`), at most `depth - 1` segments (a file still fits below it).
 */
export function parseMemoryFolder(input: string): MemoryFolderResult {
  const s = input.normalize("NFC");
  const whole = checkWhole(s);
  if (whole) return { ok: false, reason: whole };
  if (!s.endsWith("/")) return { ok: false, reason: "missing_slash" };
  const segments = s.slice(0, -1).split("/");
  const seg = checkSegments(segments);
  if (seg) return { ok: false, reason: seg };
  if (segments.length > MEMORY_LIMITS.depth - 1) return { ok: false, reason: "depth" };
  if (codePoints(s) > MEMORY_LIMITS.pathChars) return { ok: false, reason: "length" };
  return { ok: true, folder: s };
}

/** The case-insensitive uniqueness key of a path or folder (two files never differ only in case). */
export function memoryPathKey(path: string): string {
  return path.normalize("NFC").toLowerCase();
}

/**
 * True when `path` lies under `folder`, compared case-insensitively on segment boundaries: `hr/` covers `HR/a.md` and
 * `hr/x/b.md`, never `hr-public/a.md` nor `hr.md`. A folder without its trailing `/` is read as if it had one.
 */
export function isUnderFolder(path: string, folder: string): boolean {
  const prefix = folder.endsWith("/") ? folder : `${folder}/`;
  return memoryPathKey(path).startsWith(memoryPathKey(prefix));
}

function pathSchema<R extends { ok: true } | { ok: false; reason: string }>(parse: (s: string) => R) {
  return z
    .string()
    .max(1024)
    .overwrite((s) => s.normalize("NFC"))
    .superRefine((s, ctx) => {
      const r = parse(s);
      if (!r.ok) ctx.addIssue({ code: "custom", message: (r as { reason: string }).reason });
    });
}

/** A memory file path (canonical NFC output); the issue message is the `MemoryPathError`. */
export const MemoryPath = pathSchema(parseMemoryPath);
export type MemoryPath = z.infer<typeof MemoryPath>;

/** A folder prefix ending in `/` (canonical NFC output); the issue message is the reason. */
export const MemoryFolder = pathSchema(parseMemoryFolder);
export type MemoryFolder = z.infer<typeof MemoryFolder>;

/** Content of one file, limited in UTF-8 bytes (never characters). */
export const MemoryContent = z
  .string()
  .refine((s) => new TextEncoder().encode(s).length <= MEMORY_LIMITS.fileBytes, {
    message: "memory_file_too_large",
  });
export type MemoryContent = z.infer<typeof MemoryContent>;

// ---------------------------------------------------------------- scopes and files (MEM-01, MEM-02)

/** What the viewer may do in a scope or on a file (the resolver's decision; the web only renders it). */
export const MemoryCapability = z.enum(["read", "write", "promote"]);
export type MemoryCapability = z.infer<typeof MemoryCapability>;

export const MemoryScope = z.object({
  id: Id,
  kind: MemoryScopeKind,
  label: z.string(),
  agentId: Id.nullable(),
  unitId: Id.nullable(),
  unitKind: UnitKind.nullable(),
  viewerCan: z.array(MemoryCapability),
});
export type MemoryScope = z.infer<typeof MemoryScope>;

export const MemoryScopeList = z.object({ scopes: z.array(MemoryScope) });
export type MemoryScopeList = z.infer<typeof MemoryScopeList>;

/** Opens (creating on first use) the caller's personal scope with a bot, or a bot's own scope. */
export const EnsureMemoryScopeRequest = z.object({ kind: z.enum(["personal", "agent"]), agentId: Id });
export type EnsureMemoryScopeRequest = z.infer<typeof EnsureMemoryScopeRequest>;

/** Who changed a file: a person, an agent on behalf of a person, or the workspace itself. */
export const MemoryActor = z.object({
  kind: z.enum(["user", "agent", "system"]),
  id: Id.nullable(),
  displayName: z.string(),
  onBehalfOf: z.object({ id: Id, displayName: z.string() }).nullable(),
});
export type MemoryActor = z.infer<typeof MemoryActor>;

export const MemoryFileMeta = z.object({
  id: Id,
  scopeId: Id,
  path: MemoryPath,
  version: z.number().int().positive(),
  bytes: z.number().int().nonnegative(),
  updatedAt: IsoDateTime,
  updatedBy: MemoryActor,
});
export type MemoryFileMeta = z.infer<typeof MemoryFileMeta>;

/** Metadata only; folders are derived from paths (a folder shows iff it holds a visible file). */
export const MemoryFileList = z.object({ scope: MemoryScope, files: z.array(MemoryFileMeta) });
export type MemoryFileList = z.infer<typeof MemoryFileList>;

export const MemoryFile = MemoryFileMeta.extend({
  content: z.string(),
  viewerCan: z.array(MemoryCapability),
});
export type MemoryFile = z.infer<typeof MemoryFile>;

export const CreateMemoryFileRequest = z.object({ path: MemoryPath, content: MemoryContent });
export type CreateMemoryFileRequest = z.infer<typeof CreateMemoryFileRequest>;

const ExpectedVersion = z.number().int().positive();

export const UpdateMemoryFileRequest = z.object({ content: MemoryContent, expectedVersion: ExpectedVersion });
export type UpdateMemoryFileRequest = z.infer<typeof UpdateMemoryFileRequest>;

export const RenameMemoryFileRequest = z.object({ path: MemoryPath, expectedVersion: ExpectedVersion });
export type RenameMemoryFileRequest = z.infer<typeof RenameMemoryFileRequest>;

export const DeleteMemoryFileQuery = z.object({ expectedVersion: z.coerce.number().int().positive() });
export type DeleteMemoryFileQuery = z.infer<typeof DeleteMemoryFileQuery>;

export const RestoreMemoryRevisionRequest = z.object({
  version: z.number().int().positive(),
  expectedVersion: ExpectedVersion,
});
export type RestoreMemoryRevisionRequest = z.infer<typeof RestoreMemoryRevisionRequest>;

// ---------------------------------------------------------------- history (MEM-02)

export const MemoryRevisionOp = z.enum(["create", "update", "append", "rename", "delete", "restore"]);
export type MemoryRevisionOp = z.infer<typeof MemoryRevisionOp>;

export const MemoryRevisionMeta = z.object({
  version: z.number().int().positive(),
  op: MemoryRevisionOp,
  path: MemoryPath,
  linesAdded: z.number().int().nonnegative(),
  linesRemoved: z.number().int().nonnegative(),
  author: MemoryActor,
  /** Set when an approved proposal wrote this revision. */
  approvalRequestId: Id.nullable(),
  /** Who approved that proposal (07.2-13: "Approved by {person}"); null or absent otherwise. */
  approvedBy: z.object({ id: Id, displayName: z.string() }).nullable().optional(),
  createdAt: IsoDateTime,
});
export type MemoryRevisionMeta = z.infer<typeof MemoryRevisionMeta>;

export const MemoryRevision = MemoryRevisionMeta.extend({ content: z.string() });
export type MemoryRevision = z.infer<typeof MemoryRevision>;

export const MemoryRevisionList = z.object({ revisions: z.array(MemoryRevisionMeta) });
export type MemoryRevisionList = z.infer<typeof MemoryRevisionList>;

// ---------------------------------------------------------------- search (D-03)

/** `GET /api/v1/memory/search`: always restricted to the files the caller may read. */
export const MemorySearchQuery = z.object({ q: z.string().trim().min(1).max(200), scopeId: Id.optional() });
export type MemorySearchQuery = z.infer<typeof MemorySearchQuery>;

export const MemorySearchHit = z.object({ fileId: Id, scopeId: Id, path: MemoryPath, snippet: z.string() });
export type MemorySearchHit = z.infer<typeof MemorySearchHit>;

export const MemorySearchResult = z.object({ hits: z.array(MemorySearchHit) });
export type MemorySearchResult = z.infer<typeof MemorySearchResult>;

// ---------------------------------------------------------------- sensitive data (MEM-05, D-06)

/** What the detector found. Secrets block every write; the rest is shown to the approver (never auto-approved). */
export const SensitiveFindingKind = z.enum([
  "secret",
  "iban",
  "payment_card",
  "es_nif",
  "es_nie",
  "email",
  "phone",
  "person",
  "location",
  "ip_address",
  /** The extended (Presidio) scan did not answer in time: the human still decides, with this warning shown. */
  "extended_scan_unavailable",
  "extended_scan_partial",
]);
export type SensitiveFindingKind = z.infer<typeof SensitiveFindingKind>;

/** Never a raw value: `samples` are masked by `maskSample`, `lines` are 1-based line numbers. */
export const SensitiveFinding = z.object({
  kind: SensitiveFindingKind,
  severity: z.enum(["block", "warn", "info"]),
  source: z.enum(["builtin", "presidio"]),
  count: z.number().int().nonnegative(),
  samples: z.array(z.string().max(80)).max(3),
  lines: z.array(z.number().int().positive()).max(20),
});
export type SensitiveFinding = z.infer<typeof SensitiveFinding>;

/** A highlighted finding: UTF-16 offsets `[start, end)` into the scanned text. */
export const SensitiveSpan = z
  .object({
    kind: SensitiveFindingKind,
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
  })
  .refine((s) => s.end > s.start, { message: "end must be after start" });
export type SensitiveSpan = z.infer<typeof SensitiveSpan>;

const DOT = "•";
const HIDDEN = DOT.repeat(4);

function maskWord(w: string): string {
  const first = [...w][0] ?? "";
  return `${first}${DOT.repeat(3)}`;
}

function maskRaw(kind: SensitiveFindingKind, value: string): string {
  const v = value.trim();
  switch (kind) {
    case "iban": {
      const c = v.replace(/\s+/g, "").toUpperCase();
      return c.length >= 15 ? `${c.slice(0, 4)} ${HIDDEN} ${c.slice(-4)}` : HIDDEN;
    }
    case "payment_card": {
      const d = v.replace(/\D/g, "");
      return d.length >= 12 ? `${HIDDEN} ${d.slice(-4)}` : HIDDEN;
    }
    case "es_nif":
    case "es_nie": {
      const c = v.replace(/[\s-]/g, "").toUpperCase();
      return c.length >= 8 ? `${DOT.repeat(c.length - 4)}${c.slice(-4)}` : HIDDEN;
    }
    case "email": {
      const at = v.lastIndexOf("@");
      if (at < 1 || at === v.length - 1) return HIDDEN;
      return `${maskWord(v.slice(0, at))}${v.slice(at)}`;
    }
    case "phone": {
      const d = v.replace(/\D/g, "");
      if (d.length < 8) return HIDDEN;
      const prefix = v.startsWith("+") ? `+${d.slice(0, 2)} ` : "";
      return `${prefix}${DOT.repeat(3)} ${DOT.repeat(3)} ${d.slice(-3)}`;
    }
    case "person":
    case "location":
      return v.length === 0 ? HIDDEN : v.split(/\s+/).map(maskWord).join(" ");
    case "ip_address": {
      const m = /^(\d{1,3})\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.exec(v);
      return m ? `${m[1]}.${DOT.repeat(3)}.${DOT.repeat(3)}.${DOT.repeat(3)}` : HIDDEN;
    }
    case "secret":
      return v.length >= 16 ? `${v.slice(0, 4)}${HIDDEN}` : HIDDEN;
    case "extended_scan_unavailable":
    case "extended_scan_partial":
      return "";
  }
}

/**
 * The masked sample a finding shows: `ES91 •••• 1332`, `•••• 1111`, `•••••678Z`, `a•••@acme.com`, `+34 ••• ••• 678`,
 * `A••• P•••`, `sk-a••••`. Never the full value: a value too short to mask meaningfully becomes `••••`. Shared by
 * detector layer 1 (contracts) and the Presidio client (API).
 */
export function maskSample(kind: SensitiveFindingKind, value: string): string {
  const out = maskRaw(kind, value);
  const raw = value.trim();
  return raw.length > 0 && out.includes(raw) ? HIDDEN : out;
}

// ---------------------------------------------------------------- proposals (MEM-05, MEM-06)

export const MemoryProposalOp = z.enum(["create", "replace", "append"]);
export type MemoryProposalOp = z.infer<typeof MemoryProposalOp>;

const NamedRef = z.object({ id: Id, displayName: z.string() });

/** What an approver sees for a `memory.write` approval (the kind's view; filtered for the viewer by the API). */
export const MemoryProposalView = z.object({
  proposalId: Id,
  scope: z.object({ id: Id, kind: MemoryScopeKind, label: z.string() }),
  path: MemoryPath,
  op: MemoryProposalOp,
  /** The version the agent based its proposal on; null for a new file. */
  baseVersion: z.number().int().positive().nullable(),
  /** The file's live version now; differs from `baseVersion` when someone edited it meanwhile. */
  currentVersion: z.number().int().positive().nullable(),
  base: z.string().nullable(),
  proposed: z.string(),
  linesAdded: z.number().int().nonnegative(),
  linesRemoved: z.number().int().nonnegative(),
  findings: z.array(SensitiveFinding).max(50),
  /** Highlighted findings: offsets into `proposed` (UI-SPEC R5). */
  spans: z.array(SensitiveSpan).max(200),
  /** How many people could read the file once applied. */
  readerCount: z.number().int().nonnegative(),
  /** The agent read web or tool content during the turn that proposed this. */
  tainted: z.boolean(),
  reason: z.string().max(MEMORY_LIMITS.reasonChars).nullable(),
  requestedBy: z.object({ agent: NamedRef, forUser: NamedRef }),
});
export type MemoryProposalView = z.infer<typeof MemoryProposalView>;

// ---------------------------------------------------------------- realtime and errors

/**
 * `memory.changed`: ids and a version, never a path or content. Private memory: its owner's `user:<id>` stream only.
 * Shared memory: the `user:<id>` stream of each person who may read the file, or once the `org:<id>` stream when the
 * whole organization may (WINDOWS 157).
 */
export const MemoryChangedEvent = z.object({ scopeId: Id, fileId: Id, version: z.number().int().positive() });
export type MemoryChangedEvent = z.infer<typeof MemoryChangedEvent>;

export const MemoryErrorCode = z.enum([
  "memory_path_invalid",
  "memory_version_conflict",
  "memory_path_exists",
  "memory_root_file",
  "memory_file_too_large",
  "memory_scope_full",
  "secret_detected",
  "memory_not_found",
]);
export type MemoryErrorCode = z.infer<typeof MemoryErrorCode>;
