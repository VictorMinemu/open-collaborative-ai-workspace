// A bot's files in a Work Zone session's tree (07.17.1.1, D-02, D-03, D-04, D-09, PD-09, PD-10).
//
// The only place the absolute form of a moved file's path exists: the server names a repo-relative path, the device
// decides containment against the realpath of the ACTIVE session's cwd (its worktree when isolated) and refuses the
// shared deny list (`@ocw/contracts`) both on the requested path and on the path relative to that real root. Regular
// files only: never a symlink as the final component (`lstat` + `O_NOFOLLOW`), a FIFO, a socket, a device or a folder.
// Bytes only: nothing here decodes, sanitises or executes a file's content (P7). Errors carry a `SessionFileFailure`
// code and at most a number as detail, never a path.

import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  copyFile,
  type FileHandle,
  link,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  statfs,
  unlink,
} from "node:fs/promises";
import { join, relative, sep } from "node:path";
import {
  type SessionFileFailure,
  sessionFileAckError,
  WorkSessionFilePath,
  workSessionFilePathRefusal,
} from "@ocw/contracts";

/** A refused or failed file command: its ack is `sessionFileAckError(code, detail)`. */
export class SessionFileError extends Error {
  constructor(
    readonly code: SessionFileFailure,
    readonly detail?: string,
  ) {
    super(sessionFileAckError(code, detail));
    this.name = "SessionFileError";
  }
}

// Absent on Windows (no such flag there); the `lstat` check before `open` still refuses a link.
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
// A FIFO swapped in after the `lstat` must not block the open; no effect on a regular file.
const O_NONBLOCK = constants.O_NONBLOCK ?? 0;

function errno(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | null)?.code;
}

async function lstatOrNull(p: string): Promise<Stats | null> {
  try {
    return await lstat(p);
  } catch (err) {
    if (errno(err) === "ENOENT" || errno(err) === "ENOTDIR") return null;
    throw err;
  }
}

function inside(root: string, p: string): boolean {
  return p === root || p.startsWith(root + sep);
}

function toPosix(rel: string): string {
  return sep === "/" ? rel : rel.split(sep).join("/");
}

export interface ResolvedSessionPath {
  /** The realpath of the session's cwd. */
  root: string;
  /** The realpath of the target's folder, `root` or inside it. */
  parent: string;
  /** `parent` + the requested base name (never resolved through a link). */
  target: string;
  /** `target` relative to `root`, `/`-separated (what the deny list was decided on a second time). */
  relReal: string;
}

/**
 * Resolves `rel` inside the session's tree `root` (PD-10). `invalid_path` for anything `WorkSessionFilePath` refuses;
 * `path_not_allowed` for the deny list (on `rel` and on the real path), a parent that resolves outside the root, or a
 * folder that would have to be created under a link. With `create: true` missing folders are made one segment at a
 * time, each checked with `lstat` (never through a link); without it a missing folder is `not_found`.
 */
export async function resolveSessionPath(
  root: string,
  rel: string,
  opts: { create: boolean },
): Promise<ResolvedSessionPath> {
  const parsed = WorkSessionFilePath.safeParse(rel);
  if (!parsed.success) throw new SessionFileError("invalid_path");
  if (workSessionFilePathRefusal(parsed.data) !== null) throw new SessionFileError("path_not_allowed");
  let realRoot: string;
  try {
    realRoot = await realpath(root);
  } catch {
    throw new SessionFileError("not_found");
  }
  const segments = parsed.data.split("/");
  const name = segments.pop() as string;
  let cur = realRoot;
  let throughLink = false;
  for (const seg of segments) {
    const next = join(cur, seg);
    const st = await lstatOrNull(next);
    if (st === null) {
      if (!opts.create) throw new SessionFileError("not_found");
      // Never create a folder below a link: its real place was not decided segment by segment.
      if (throughLink) throw new SessionFileError("path_not_allowed");
      try {
        await mkdir(next);
      } catch (err) {
        if (errno(err) !== "EEXIST") throw new SessionFileError("transfer_failed");
      }
      const made = await lstat(next);
      if (made.isSymbolicLink() || !made.isDirectory()) throw new SessionFileError("path_not_allowed");
      cur = next;
      continue;
    }
    if (st.isSymbolicLink()) {
      let real: string;
      try {
        real = await realpath(next);
      } catch {
        throw new SessionFileError("path_not_allowed");
      }
      if (!inside(realRoot, real)) throw new SessionFileError("path_not_allowed");
      const target = await lstat(real);
      if (!target.isDirectory()) throw new SessionFileError(opts.create ? "not_a_file" : "not_found");
      throughLink = true;
      cur = real;
      continue;
    }
    if (!st.isDirectory()) throw new SessionFileError(opts.create ? "not_a_file" : "not_found");
    cur = next;
  }
  let parent: string;
  try {
    parent = await realpath(cur);
  } catch {
    throw new SessionFileError("not_found");
  }
  if (!inside(realRoot, parent)) throw new SessionFileError("path_not_allowed");
  let target = join(parent, name);
  const existing = await lstatOrNull(target);
  if (existing && !existing.isSymbolicLink()) {
    // Review CR-01: a case-insensitive volume opens a file under other spellings of its name, and `join` keeps the
    // requested one. The native realpath names the file as stored, so the second check decides on the real name.
    let stored: string;
    try {
      stored = await realpath(target);
    } catch {
      throw new SessionFileError("not_found");
    }
    if (!inside(parent, stored) || stored === parent) throw new SessionFileError("path_not_allowed");
    target = stored;
  }
  const relReal = toPosix(relative(realRoot, target));
  if (relReal.startsWith("..") || workSessionFilePathRefusal(relReal) !== null) {
    throw new SessionFileError("path_not_allowed");
  }
  return { root: realRoot, parent, target, relReal };
}

/**
 * Opens one regular file of the tree for reading (D-03, PD-10): `not_found`, `not_a_file` (a folder, a link as the
 * final component, a FIFO, a socket or a device), or `too_large` with the size as detail when it is over `maxBytes`,
 * before any byte moves. The caller closes the handle.
 */
export async function openSessionFileForRead(
  root: string,
  rel: string,
  maxBytes: number,
): Promise<{ handle: FileHandle; size: number }> {
  const { target } = await resolveSessionPath(root, rel, { create: false });
  const st = await lstatOrNull(target);
  if (st === null) throw new SessionFileError("not_found");
  if (st.isSymbolicLink() || !st.isFile()) throw new SessionFileError("not_a_file");
  let handle: FileHandle;
  try {
    handle = await open(target, constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  } catch (err) {
    if (errno(err) === "ENOENT") throw new SessionFileError("not_found");
    if (errno(err) === "ELOOP") throw new SessionFileError("not_a_file");
    throw new SessionFileError("transfer_failed");
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) throw new SessionFileError("not_a_file");
    if (opened.size > maxBytes) throw new SessionFileError("too_large", String(opened.size));
    return { handle, size: opened.size };
  } catch (err) {
    await handle.close().catch(() => undefined);
    throw err instanceof SessionFileError ? err : new SessionFileError("transfer_failed");
  }
}

/** The command id as it appears in the temp file's name; anything else is never written. */
const TRANSFER_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** Hard links are not on every file system (exFAT, some network shares): an exclusive copy then. */
const NO_HARD_LINK = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV"]);

export interface WriteSessionFileParams {
  /** The command id (= the transfer id); names the temp file `.ocw-upload-<id>.part`. */
  transferId: string;
  sizeBytes: number;
  /** When set, the bytes' sha256 must equal it. */
  sha256: string | null;
  overwrite: boolean;
  /** The bytes, read only after every check passed (the daemon's GET starts on the first read). */
  body: AsyncIterable<Uint8Array>;
  /** Tests only: the free-space probe (default `fs.promises.statfs`). */
  statfs?: (path: string) => Promise<{ bavail: number | bigint; bsize: number | bigint }>;
}

async function writeAll(handle: FileHandle, chunk: Uint8Array): Promise<void> {
  let off = 0;
  while (off < chunk.byteLength) {
    const { bytesWritten } = await handle.write(chunk, off, chunk.byteLength - off);
    off += bytesWritten;
  }
}

/**
 * Writes one file into the session's tree (D-02, D-13, PD-10). Checks, in order and before any byte is read: the path
 * (`resolveSessionPath` with `create: true`), the target (`not_a_file` for a folder, a link or anything but a regular
 * file; `exists` without `overwrite`) and the free space (`no_space`). Then the bytes go to a temp file in the
 * target's folder (`wx`, 0o644), counted and hashed (`mismatch` past or short of `sizeBytes`, or another sha256), and
 * land with `link` (no overwrite: an existing file is `exists`, atomically) or `rename` (overwrite). The temp file is
 * gone after every outcome. A body failure is `transfer_failed`, or the `SessionFileError` it threw.
 */
export async function writeSessionFile(root: string, rel: string, p: WriteSessionFileParams): Promise<void> {
  if (!TRANSFER_ID.test(p.transferId)) throw new SessionFileError("transfer_failed");
  const { parent, target } = await resolveSessionPath(root, rel, { create: true });
  const existing = await lstatOrNull(target);
  if (existing) {
    if (existing.isSymbolicLink() || !existing.isFile()) throw new SessionFileError("not_a_file");
    if (!p.overwrite) throw new SessionFileError("exists");
  }
  const free = await (p.statfs ?? statfs)(parent).catch(() => null);
  if (free && Number(free.bavail) * Number(free.bsize) < p.sizeBytes) throw new SessionFileError("no_space");

  const tmp = join(parent, `.ocw-upload-${p.transferId}.part`);
  let handle: FileHandle;
  try {
    handle = await open(tmp, "wx", 0o644);
  } catch {
    throw new SessionFileError("transfer_failed");
  }
  let handleOpen = true;
  let tmpLeft = true;
  try {
    const hash = createHash("sha256");
    let n = 0;
    try {
      for await (const chunk of p.body) {
        n += chunk.byteLength;
        if (n > p.sizeBytes) throw new SessionFileError("mismatch");
        hash.update(chunk);
        await writeAll(handle, chunk);
      }
    } catch (err) {
      if (err instanceof SessionFileError) throw err;
      if (errno(err) === "ENOSPC") throw new SessionFileError("no_space");
      throw new SessionFileError("transfer_failed");
    }
    if (n !== p.sizeBytes) throw new SessionFileError("mismatch");
    if (p.sha256 !== null && hash.digest("hex") !== p.sha256) throw new SessionFileError("mismatch");
    await handle.chmod(0o644);
    await handle.close();
    handleOpen = false;
    if (!p.overwrite) {
      try {
        await link(tmp, target);
      } catch (err) {
        if (errno(err) === "EEXIST") throw new SessionFileError("exists");
        if (!NO_HARD_LINK.has(errno(err) ?? "")) throw err;
        try {
          await copyFile(tmp, target, constants.COPYFILE_EXCL);
        } catch (copyErr) {
          if (errno(copyErr) === "EEXIST") throw new SessionFileError("exists");
          throw copyErr;
        }
      }
    } else {
      const now = await lstatOrNull(target);
      if (now && (now.isSymbolicLink() || !now.isFile())) throw new SessionFileError("not_a_file");
      await rename(tmp, target);
      tmpLeft = false;
    }
  } catch (err) {
    if (err instanceof SessionFileError) throw err;
    throw new SessionFileError(errno(err) === "ENOSPC" ? "no_space" : "transfer_failed");
  } finally {
    if (handleOpen) await handle.close().catch(() => undefined);
    if (tmpLeft) await unlink(tmp).catch(() => undefined);
  }
}
