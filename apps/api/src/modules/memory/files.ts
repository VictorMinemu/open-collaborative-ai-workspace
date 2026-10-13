import {
  detectSensitive,
  EventTypes,
  isUnderFolder,
  MEMORY_LIMITS,
  MEMORY_ROOT_FILE,
  type MemoryActor as MemoryActorDto,
  type MemoryChangedEvent,
  type MemoryFile,
  type MemoryFileMeta,
  type MemoryRevision,
  type MemoryRevisionMeta,
  type MemoryRevisionOp,
  memoryPathKey,
  parseMemoryFolder,
  parseMemoryPath,
} from "@ocw/contracts";
import { agents, memoryFileRevisions, memoryFiles, memoryProposals, orgMembers, type Tx } from "@ocw/db";
import { diffLines } from "diff";
import { and, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import type { Core } from "../../core";
import { conflict, forbidden, HttpError } from "../../lib/errors";
import { AuthzDeniedError, type PermissionService } from "../organization";
import {
  asActor,
  capabilitiesOf,
  decideMemory,
  filterReadable,
  type MemoryActor,
  personalOwnerOf,
  withPersonalOwner,
} from "./access";
import { createRootFile, type LoadedScope, liveFileCount, loadScope, memoryNotFound } from "./scopes";

/**
 * Memory files (D-01, MEM-01, MEM-02): optimistic versions, one append-only revision and one audit row per change,
 * secrets refused on every write (principle 8, Pitfall 8), per-path decisions by the resolver (MEM-07). Audit rows
 * and events carry ids, versions and byte counts only: a path is content too (Pitfall 3).
 *
 * `withPersonalOwner` (access.ts) is how an agent or an approved apply reads through the human it acts for; this module
 * never calls it for anyone else.
 */
export { withPersonalOwner };

type FileRow = typeof memoryFiles.$inferSelect;
type RevisionRow = typeof memoryFileRevisions.$inferSelect;

export interface FilesDeps {
  core: Core;
  perms: PermissionService;
}

export type WriteFileOp =
  | { op: "create"; scopeId: string; path: string; content: string }
  | { op: "update"; fileId: string; content: string; expectedVersion: number }
  | { op: "rename"; fileId: string; path: string; expectedVersion: number }
  | { op: "delete"; fileId: string; expectedVersion: number }
  | { op: "restore"; fileId: string; version: number; expectedVersion: number };

// ---------------------------------------------------------------- domain errors (contracts MemoryErrorCode)

export const pathInvalid = (reason: string) =>
  new HttpError(400, "memory_path_invalid", `This is not a valid memory path (${reason})`, { reason });
const versionConflict = (currentVersion: number) =>
  new HttpError(409, "memory_version_conflict", "This file changed since you opened it", { currentVersion });
const pathExists = () => conflict("A file with this name already exists here", "memory_path_exists");
const rootFile = () =>
  conflict(`${MEMORY_ROOT_FILE} can be edited but not renamed or deleted`, "memory_root_file");
const scopeFull = () =>
  conflict(
    `This memory is full (${MEMORY_LIMITS.filesPerScope.toLocaleString("en")} files)`,
    "memory_scope_full",
  );
const tooLarge = () => new HttpError(413, "memory_file_too_large", "The file would be over 256 KB");

export function parsePathOrThrow(input: string): string {
  const r = parseMemoryPath(input);
  if (!r.ok) throw pathInvalid(r.reason);
  return r.path;
}

function parseFolderOrThrow(input: string): string {
  const r = parseMemoryFolder(input);
  if (!r.ok) throw pathInvalid(r.reason);
  return r.folder;
}

const ROOT_KEY = memoryPathKey(MEMORY_ROOT_FILE);
/** The scope's root file (`MEMORY.md` at the root, any casing); `sub/MEMORY.md` is an ordinary file. */
export const isRootPath = (path: string) => memoryPathKey(path) === ROOT_KEY;

const byteLength = (s: string) => Buffer.byteLength(s, "utf8");

function assertSize(content: string): number {
  const bytes = byteLength(content);
  if (bytes > MEMORY_LIMITS.fileBytes) throw tooLarge();
  return bytes;
}

/**
 * Detector layer 1 on what the write adds (the whole text when `lines` is omitted): a secret blocks with masked samples
 * and line numbers only (never the value). Every actor, `approved` included.
 */
export function assertNoSecret(content: string, lines?: readonly number[]): void {
  if (lines !== undefined && lines.length === 0) return;
  const { findings } = detectSensitive(content, lines ? { lines } : undefined);
  const block = findings.filter((f) => f.severity === "block");
  if (block.length > 0) {
    throw new HttpError(
      422,
      "secret_detected",
      "This looks like a secret. Secrets can't be stored in memory.",
      {
        findings: block,
      },
    );
  }
}

// ---------------------------------------------------------------- line changes (`diff`)

const countLines = (s: string) => (s === "" ? 0 : s.split("\n").length - (s.endsWith("\n") ? 1 : 0));
const range = (from: number, n: number) => Array.from({ length: n }, (_, i) => from + i);
/** Bounds Myers' edit distance: past it a change counts as a full replacement (no quadratic work on 256 KiB). */
const MAX_EDIT_LENGTH = 2_000;

/** `+N −M` and the 1-based numbers of the added lines in `after`. */
export function lineChanges(
  before: string,
  after: string,
): { added: number; removed: number; addedLines: number[] } {
  const changes = diffLines(before, after, { maxEditLength: MAX_EDIT_LENGTH });
  if (!changes) {
    const added = countLines(after);
    return { added, removed: countLines(before), addedLines: range(1, added) };
  }
  let line = 1;
  let added = 0;
  let removed = 0;
  const addedLines: number[] = [];
  for (const c of changes) {
    if (c.added) {
      addedLines.push(...range(line, c.count));
      added += c.count;
      line += c.count;
    } else if (c.removed) {
      removed += c.count;
    } else {
      line += c.count;
    }
  }
  return { added, removed, addedLines };
}

// ---------------------------------------------------------------- database errors

function pgError(err: unknown): { code?: string; constraint?: string } | undefined {
  const e = err as { code?: unknown; constraint?: unknown; cause?: { code?: unknown; constraint?: unknown } };
  const src = typeof e?.code === "string" ? e : typeof e?.cause?.code === "string" ? e.cause : undefined;
  return src ? { code: src.code as string, constraint: src.constraint as string | undefined } : undefined;
}

/**
 * Runs a write and never lets a driver error escape as is: drizzle's message lists the query parameters (paths and
 * content) and PostgreSQL's detail quotes the failing row, and the error handler logs a 500 with its message. The
 * unique path index becomes `memory_path_exists`; anything else becomes a parameter-free error.
 */
async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof HttpError) throw err;
    const pg = pgError(err);
    if (!pg && !(err instanceof Error && err.name === "DrizzleQueryError")) throw err;
    if (pg?.code === "23505" && pg.constraint === "memory_files_scope_path_uq") throw pathExists();
    throw new Error(
      `memory query failed${pg?.code && /^[0-9A-Z]{5}$/.test(pg.code) ? ` (sqlstate ${pg.code})` : ""}`,
    );
  }
}

const lock = (tx: Tx, key: string) =>
  tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);

// ---------------------------------------------------------------- actors: authorship, audit, display

interface Authorship {
  kind: "user" | "agent" | "system";
  id: string | null;
  onBehalfOf: string | null;
  approvalRequestId: string | null;
}

function authorship(actor: MemoryActor): Authorship {
  switch (actor.kind) {
    case "user":
      return { kind: "user", id: actor.userId, onBehalfOf: null, approvalRequestId: null };
    case "agent":
      return {
        kind: "agent",
        id: actor.agentId,
        onBehalfOf: actor.onBehalfOfUserId,
        approvalRequestId: null,
      };
    case "system":
      return { kind: "system", id: null, onBehalfOf: null, approvalRequestId: null };
    case "approved":
      return actor.agentId
        ? {
            kind: "agent",
            id: actor.agentId,
            onBehalfOf: actor.onBehalfOfUserId,
            approvalRequestId: actor.approvalRequestId,
          }
        : {
            kind: "system",
            id: null,
            onBehalfOf: actor.onBehalfOfUserId,
            approvalRequestId: actor.approvalRequestId,
          };
  }
}

function auditActor(actor: MemoryActor) {
  switch (actor.kind) {
    case "user":
      return { actorKind: "user" as const, actorId: actor.userId, userId: actor.userId };
    case "agent":
      return {
        actorKind: "agent" as const,
        actorId: actor.agentId,
        agentId: actor.agentId,
        userId: actor.onBehalfOfUserId,
        clientKind: "agent",
      };
    case "approved":
      return actor.agentId
        ? {
            actorKind: "agent" as const,
            actorId: actor.agentId,
            agentId: actor.agentId,
            userId: actor.onBehalfOfUserId,
          }
        : { actorKind: "system" as const, actorId: null, userId: actor.onBehalfOfUserId };
    case "system":
      return { actorKind: "system" as const, actorId: null };
  }
}

type Who = { kind: "user" | "agent" | "system"; id: string | null; onBehalfOf: string | null };

/** Display names for authors in two queries (members, bots); people who left and deleted bots keep a neutral name. */
async function directory(tx: Tx, whos: readonly Who[]): Promise<(w: Who) => MemoryActorDto> {
  const userIds = new Set<string>();
  const agentIds = new Set<string>();
  for (const w of whos) {
    if (w.kind === "user" && w.id) userIds.add(w.id);
    if (w.kind === "agent" && w.id) agentIds.add(w.id);
    if (w.onBehalfOf) userIds.add(w.onBehalfOf);
  }
  const people = userIds.size
    ? await tx
        .select({ id: orgMembers.userId, name: orgMembers.displayName })
        .from(orgMembers)
        .where(inArray(orgMembers.userId, [...userIds]))
    : [];
  const bots = agentIds.size
    ? await tx
        .select({ id: agents.id, name: agents.name })
        .from(agents)
        .where(inArray(agents.id, [...agentIds]))
    : [];
  const personName = new Map(people.map((p) => [p.id, p.name]));
  const botName = new Map(bots.map((b) => [b.id, b.name]));
  const person = (id: string) => personName.get(id) ?? "Former member";
  return (w) => ({
    kind: w.kind,
    id: w.id,
    displayName:
      w.kind === "system"
        ? "Workspace"
        : w.kind === "agent"
          ? (botName.get(w.id ?? "") ?? "Deleted bot")
          : person(w.id ?? ""),
    onBehalfOf: w.onBehalfOf ? { id: w.onBehalfOf, displayName: person(w.onBehalfOf) } : null,
  });
}

const fileWho = (f: FileRow): Who => ({
  kind: f.updatedByKind,
  id: f.updatedById,
  onBehalfOf: f.onBehalfOfUserId,
});
const revisionWho = (r: RevisionRow): Who => ({
  kind: r.authorKind,
  id: r.authorId,
  onBehalfOf: r.onBehalfOfUserId,
});

const iso = (v: string) => new Date(v).toISOString();

function toMeta(f: FileRow, who: (w: Who) => MemoryActorDto): MemoryFileMeta {
  return {
    id: f.id,
    scopeId: f.scopeId,
    path: f.path,
    version: f.version,
    bytes: f.bytes,
    updatedAt: iso(f.updatedAt),
    updatedBy: who(fileWho(f)),
  };
}

function toRevisionMeta(r: RevisionRow, who: (w: Who) => MemoryActorDto): MemoryRevisionMeta {
  return {
    version: r.version,
    op: r.op,
    path: r.path,
    linesAdded: r.linesAdded,
    linesRemoved: r.linesRemoved,
    author: who(revisionWho(r)),
    approvalRequestId: r.approvalRequestId,
    createdAt: iso(r.createdAt),
  };
}

// ---------------------------------------------------------------- the service functions

export function createFileOps(d: FilesDeps) {
  const { core, perms } = d;

  async function requireRead(tx: Tx, actor: MemoryActor, scope: LoadedScope, path?: string): Promise<void> {
    if (!(await decideMemory(perms, tx, actor, "memory.read", scope.facts, path)).allowed)
      throw memoryNotFound();
  }

  /** 403 with the resolver's denial (audited by the error handler); callers already proved the actor may read. */
  async function requireWrite(tx: Tx, actor: MemoryActor, scope: LoadedScope, path: string): Promise<void> {
    const r = await decideMemory(perms, tx, actor, "memory.write", scope.facts, path);
    if (!r.allowed) throw new AuthzDeniedError(r.denial);
  }

  async function loadLiveFile(tx: Tx, fileId: string): Promise<FileRow> {
    const [f] = await tx
      .select()
      .from(memoryFiles)
      .where(and(eq(memoryFiles.id, fileId), isNull(memoryFiles.deletedAt)))
      .limit(1);
    if (!f) throw memoryNotFound();
    return f;
  }

  async function findByPath(
    tx: Tx,
    scopeId: string,
    path: string,
    exceptId?: string,
  ): Promise<FileRow | null> {
    const [f] = await tx
      .select()
      .from(memoryFiles)
      .where(
        and(
          eq(memoryFiles.scopeId, scopeId),
          isNull(memoryFiles.deletedAt),
          sql`lower(${memoryFiles.path}) = lower(${path})`,
          ...(exceptId ? [ne(memoryFiles.id, exceptId)] : []),
        ),
      )
      .limit(1);
    return f ?? null;
  }

  /** A readable live file and its scope, or 404 (missing, deleted, another tenant's, or not readable). */
  async function readable(tx: Tx, actor: MemoryActor, fileId: string) {
    const file = await loadLiveFile(tx, fileId);
    const scope = await loadScope(tx, file.scopeId);
    await requireRead(tx, actor, scope, file.path);
    return { file, scope };
  }

  async function toFile(tx: Tx, actor: MemoryActor, scope: LoadedScope, f: FileRow): Promise<MemoryFile> {
    const who = await directory(tx, [fileWho(f)]);
    return {
      ...toMeta(f, who),
      content: f.content,
      viewerCan: await capabilitiesOf(perms, tx, actor, scope.facts, f.path),
    };
  }

  async function recordChange(
    tx: Tx,
    actor: MemoryActor,
    action: string,
    scope: LoadedScope,
    f: FileRow,
  ): Promise<void> {
    await core.audit.record(tx, {
      action,
      resourceType: "memory_file",
      resourceId: f.id,
      ...auditActor(actor),
      metadata: {
        scopeId: scope.row.id,
        scopeKind: scope.row.kind,
        fileId: f.id,
        version: f.version,
        bytes: f.bytes,
        actorKind: actor.kind,
        ...(actor.kind === "approved" ? { approvalRequestId: actor.approvalRequestId } : {}),
      },
    });
    // Ids only, and only to the owner of private memory (Pitfall 7); shared viewers refetch and rely on 409.
    const owner = scope.row.personalOwnerUserId;
    if (owner) {
      const ev: MemoryChangedEvent = { scopeId: scope.row.id, fileId: f.id, version: f.version };
      await core.realtime.appendEvent(tx, `user:${owner}`, EventTypes.memoryChanged, ev);
    }
  }

  async function addRevision(
    tx: Tx,
    f: FileRow,
    op: MemoryRevisionOp,
    changes: { added: number; removed: number },
    a: Authorship,
  ): Promise<void> {
    await guarded(() =>
      tx.insert(memoryFileRevisions).values({
        organizationId: f.organizationId,
        fileId: f.id,
        scopeId: f.scopeId,
        version: f.version,
        op,
        path: f.path,
        content: f.content,
        linesAdded: changes.added,
        linesRemoved: changes.removed,
        authorKind: a.kind,
        authorId: a.id,
        onBehalfOfUserId: a.onBehalfOf,
        approvalRequestId: a.approvalRequestId,
      }),
    );
  }

  /** A new file (checks done by the caller: decisions; here: size, secrets, uniqueness, the scope's file limit). */
  async function createFile(
    tx: Tx,
    actor: MemoryActor,
    scope: LoadedScope,
    path: string,
    content: string,
  ): Promise<FileRow> {
    const bytes = assertSize(content);
    assertNoSecret(content);
    await lock(tx, `memory:scope:${scope.row.id}`);
    if (await findByPath(tx, scope.row.id, path)) throw pathExists();
    if ((await liveFileCount(tx, scope.row.id)) >= MEMORY_LIMITS.filesPerScope) throw scopeFull();
    const a = authorship(actor);
    const [file] = await guarded(() =>
      tx
        .insert(memoryFiles)
        .values({
          organizationId: scope.row.organizationId,
          scopeId: scope.row.id,
          path,
          content,
          version: 1,
          bytes,
          updatedByKind: a.kind,
          updatedById: a.id,
          onBehalfOfUserId: a.onBehalfOf,
        })
        .returning(),
    );
    if (!file) throw new Error("memory file insert failed");
    await addRevision(tx, file, "create", lineChanges("", content), a);
    await recordChange(tx, actor, "memory.file_created", scope, file);
    return file;
  }

  /**
   * The conditional update every change goes through (T-07.2-08-03): `WHERE version = expected AND deleted_at IS NULL`;
   * a lost race is a 409 with the version that won.
   */
  async function changeFile(
    tx: Tx,
    actor: MemoryActor,
    scope: LoadedScope,
    file: FileRow,
    expectedVersion: number,
    next: { content?: string; path?: string; deleted?: boolean },
    op: MemoryRevisionOp,
    action: string,
    changes: { added: number; removed: number },
  ): Promise<FileRow> {
    if (file.version !== expectedVersion) throw versionConflict(file.version);
    const a = authorship(actor);
    const content = next.content ?? file.content;
    const [updated] = await guarded(() =>
      tx
        .update(memoryFiles)
        .set({
          content,
          path: next.path ?? file.path,
          bytes: byteLength(content),
          version: sql`${memoryFiles.version} + 1`,
          ...(next.deleted ? { deletedAt: sql`now()` } : {}),
          updatedByKind: a.kind,
          updatedById: a.id,
          onBehalfOfUserId: a.onBehalfOf,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(memoryFiles.id, file.id),
            eq(memoryFiles.version, expectedVersion),
            isNull(memoryFiles.deletedAt),
          ),
        )
        .returning(),
    );
    if (!updated) {
      const [current] = await tx
        .select({ version: memoryFiles.version, deletedAt: memoryFiles.deletedAt })
        .from(memoryFiles)
        .where(eq(memoryFiles.id, file.id))
        .limit(1);
      if (!current || current.deletedAt !== null) throw memoryNotFound();
      throw versionConflict(current.version);
    }
    await addRevision(tx, updated, op, changes, a);
    await recordChange(tx, actor, action, scope, updated);
    return updated;
  }

  async function writeFile(tx: Tx, actor: MemoryActor, op: WriteFileOp): Promise<MemoryFile | null> {
    return asActor(tx, actor, async () => {
      if (op.op === "create") {
        const path = parsePathOrThrow(op.path);
        const scope = await loadScope(tx, op.scopeId);
        await requireRead(tx, actor, scope);
        await requireWrite(tx, actor, scope, path);
        const file = await createFile(tx, actor, scope, path, op.content);
        return toFile(tx, actor, scope, file);
      }

      const { file, scope } = await readable(tx, actor, op.fileId);
      await requireWrite(tx, actor, scope, file.path);
      switch (op.op) {
        case "update": {
          assertSize(op.content);
          const changes = lineChanges(file.content, op.content);
          if (file.version === op.expectedVersion) assertNoSecret(op.content, changes.addedLines);
          const updated = await changeFile(
            tx,
            actor,
            scope,
            file,
            op.expectedVersion,
            { content: op.content },
            "update",
            "memory.file_updated",
            changes,
          );
          return toFile(tx, actor, scope, updated);
        }
        case "rename": {
          const path = parsePathOrThrow(op.path);
          if (isRootPath(file.path)) throw rootFile();
          await requireWrite(tx, actor, scope, path);
          if (file.version !== op.expectedVersion) throw versionConflict(file.version);
          await lock(tx, `memory:scope:${scope.row.id}`);
          if (await findByPath(tx, scope.row.id, path, file.id)) throw pathExists();
          const updated = await changeFile(
            tx,
            actor,
            scope,
            file,
            op.expectedVersion,
            { path },
            "rename",
            "memory.file_renamed",
            { added: 0, removed: 0 },
          );
          return toFile(tx, actor, scope, updated);
        }
        case "delete": {
          if (isRootPath(file.path)) throw rootFile();
          await changeFile(
            tx,
            actor,
            scope,
            file,
            op.expectedVersion,
            { deleted: true },
            "delete",
            "memory.file_deleted",
            { added: 0, removed: countLines(file.content) },
          );
          return null;
        }
        case "restore": {
          const [rev] = await tx
            .select()
            .from(memoryFileRevisions)
            .where(and(eq(memoryFileRevisions.fileId, file.id), eq(memoryFileRevisions.version, op.version)))
            .limit(1);
          if (!rev) throw memoryNotFound("Version not found");
          // Its old path may lie under a folder the actor may not read (a file moved out of `hr/`).
          await requireRead(tx, actor, scope, rev.path);
          assertSize(rev.content);
          const changes = lineChanges(file.content, rev.content);
          if (file.version === op.expectedVersion) assertNoSecret(rev.content, changes.addedLines);
          const updated = await changeFile(
            tx,
            actor,
            scope,
            file,
            op.expectedVersion,
            { content: rev.content },
            "restore",
            "memory.file_restored",
            changes,
          );
          return toFile(tx, actor, scope, updated);
        }
      }
    });
  }

  /**
   * Appends `text` as new lines at the end of a file, creating it when missing; concurrent appends to one path are
   * serialised by an advisory lock, so both land with sequential versions (agents' `ocw_memory_write`, legacy save).
   */
  async function appendToFile(
    tx: Tx,
    actor: MemoryActor,
    a: { scopeId: string; path: string; text: string },
  ): Promise<{ fileId: string; version: number }> {
    return asActor(tx, actor, async () => {
      const path = parsePathOrThrow(a.path);
      const scope = await loadScope(tx, a.scopeId);
      await requireRead(tx, actor, scope);
      await requireWrite(tx, actor, scope, path);
      await lock(tx, `memory:file:${scope.row.id}:${memoryPathKey(path)}`);
      const body = a.text.endsWith("\n") ? a.text : `${a.text}\n`;
      const existing = await findByPath(tx, scope.row.id, path);
      if (!existing) {
        const created = await createFile(tx, actor, scope, path, body);
        return { fileId: created.id, version: created.version };
      }
      const content =
        existing.content === "" || existing.content.endsWith("\n")
          ? existing.content + body
          : `${existing.content}\n${body}`;
      assertSize(content);
      const changes = lineChanges(existing.content, content);
      assertNoSecret(content, changes.addedLines);
      const updated = await changeFile(
        tx,
        actor,
        scope,
        existing,
        existing.version,
        { content },
        "append",
        "memory.file_appended",
        changes,
      );
      return { fileId: updated.id, version: updated.version };
    });
  }

  async function readFile(
    tx: Tx,
    actor: MemoryActor,
    ref: { fileId: string } | { scopeId: string; path: string },
  ): Promise<MemoryFile> {
    return asActor(tx, actor, async () => {
      if ("fileId" in ref) {
        const { file, scope } = await readable(tx, actor, ref.fileId);
        return toFile(tx, actor, scope, file);
      }
      const path = parsePathOrThrow(ref.path);
      const scope = await loadScope(tx, ref.scopeId);
      await requireRead(tx, actor, scope, path);
      const file = await findByPath(tx, scope.row.id, path);
      if (!file) throw memoryNotFound();
      return toFile(tx, actor, scope, file);
    });
  }

  /** Metadata of the live files the actor may read (no content), optionally under one folder, by path. */
  async function listReadableFiles(
    tx: Tx,
    actor: MemoryActor,
    scopeId: string,
    folder?: string,
  ): Promise<MemoryFileMeta[]> {
    return asActor(tx, actor, async () => {
      const under = folder === undefined ? undefined : parseFolderOrThrow(folder);
      const scope = await loadScope(tx, scopeId);
      await requireRead(tx, actor, scope);
      const rows = await tx
        .select()
        .from(memoryFiles)
        .where(and(eq(memoryFiles.scopeId, scope.row.id), isNull(memoryFiles.deletedAt)));
      const inFolder = under === undefined ? rows : rows.filter((f) => isUnderFolder(f.path, under));
      const visible = await filterReadable(perms, tx, actor, scope.facts, inFolder, (f) => f.path);
      const who = await directory(tx, visible.map(fileWho));
      return visible
        .sort((x, y) => (memoryPathKey(x.path) < memoryPathKey(y.path) ? -1 : 1))
        .map((f) => toMeta(f, who));
    });
  }

  /** History, newest first; a revision whose path the actor may not read (an old folder) is left out. */
  async function listRevisions(tx: Tx, actor: MemoryActor, fileId: string): Promise<MemoryRevisionMeta[]> {
    return asActor(tx, actor, async () => {
      const { file, scope } = await readable(tx, actor, fileId);
      const rows = await tx
        .select()
        .from(memoryFileRevisions)
        .where(eq(memoryFileRevisions.fileId, file.id))
        .orderBy(desc(memoryFileRevisions.version));
      const visible = await filterReadable(perms, tx, actor, scope.facts, rows, (r) => r.path);
      const who = await directory(tx, visible.map(revisionWho));
      return visible.map((r) => toRevisionMeta(r, who));
    });
  }

  async function readRevision(
    tx: Tx,
    actor: MemoryActor,
    fileId: string,
    version: number,
  ): Promise<MemoryRevision> {
    return asActor(tx, actor, async () => {
      const { file, scope } = await readable(tx, actor, fileId);
      const [rev] = await tx
        .select()
        .from(memoryFileRevisions)
        .where(and(eq(memoryFileRevisions.fileId, file.id), eq(memoryFileRevisions.version, version)))
        .limit(1);
      if (!rev) throw memoryNotFound("Version not found");
      await requireRead(tx, actor, scope, rev.path);
      const who = await directory(tx, [revisionWho(rev)]);
      return { ...toRevisionMeta(rev, who), content: rev.content };
    });
  }

  /**
   * "Forget": the owner of private memory (a personal scope, a personal bot's notebook) deletes every file, revision and
   * proposal of it; the scope keeps its id with a fresh `MEMORY.md`. Audited with counts only. Shared scopes: 403.
   */
  async function forgetScope(
    tx: Tx,
    actor: MemoryActor,
    scopeId: string,
  ): Promise<{ files: number; revisions: number }> {
    return asActor(tx, actor, async () => {
      const scope = await loadScope(tx, scopeId);
      await requireRead(tx, actor, scope);
      const owner = personalOwnerOf(scope.facts);
      if (actor.kind !== "user" || owner === null || owner !== actor.userId) {
        throw forbidden("Only the owner can forget private memory", "memory_forget_owner_only");
      }
      const count = async (table: "memory_files" | "memory_file_revisions" | "memory_proposals") => {
        const res = await tx.execute(
          sql`select count(*)::int as n from ${sql.identifier("app")}.${sql.identifier(table)} where scope_id = ${scope.row.id}`,
        );
        return Number((res.rows[0] as { n: number }).n);
      };
      const files = await count("memory_files");
      const revisions = await count("memory_file_revisions");
      const proposals = await count("memory_proposals");
      await tx.delete(memoryProposals).where(eq(memoryProposals.scopeId, scope.row.id));
      await tx.delete(memoryFiles).where(eq(memoryFiles.scopeId, scope.row.id));
      const rootId = await createRootFile(tx, scope.row);
      await core.audit.record(tx, {
        action: "memory.scope_forgotten",
        resourceType: "memory_scope",
        resourceId: scope.row.id,
        ...auditActor(actor),
        metadata: { scopeId: scope.row.id, scopeKind: scope.row.kind, files, revisions, proposals },
      });
      const ev: MemoryChangedEvent = { scopeId: scope.row.id, fileId: rootId, version: 1 };
      await core.realtime.appendEvent(tx, `user:${owner}`, EventTypes.memoryChanged, ev);
      return { files, revisions };
    });
  }

  return {
    writeFile,
    appendToFile,
    readFile,
    listReadableFiles,
    listRevisions,
    readRevision,
    forgetScope,
  };
}
