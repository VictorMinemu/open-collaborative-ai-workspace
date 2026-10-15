import {
  type AgentChannelSandboxDeleteResponse,
  type AgentChannelSandboxReadResponse,
  type AgentChannelSandboxWriteResponse,
  SANDBOX_LIMITS,
  type SandboxdFilePathRequest,
  type SandboxdFilesDelete,
  type SandboxdFilesDownload,
  type SandboxdFilesList,
  type SandboxdFilesRead,
  type SandboxdFilesUpload,
  type SandboxdFilesWrite,
  type SandboxdTarget,
  type SandboxFileEntry,
  type SandboxFileList,
} from "@ocw/contracts";
import { type RunOptions, type RunResult, SandboxdFailure, type Sandboxes } from "./sandboxes";
import { OCW_FILES } from "./spec";

export { OCW_FILES };

/**
 * People's and bots' file operations on a bot's workspace (07.8-09, D-01, D-04, Pitfalls 4-5).
 *
 * Every operation is one exec of `ocw-files` as 10001 in the bot's running `sbx`, or in its network-none `files`
 * helper when the `sbx` is stopped or killed. The helper resolves each workspace-relative path with `realpath` and
 * refuses anything outside `/workspace`, including through a symlink. There is no Docker archive API here (it writes
 * as root with the tar's uid and follows bot-controlled symlinks). Paths go as one argv item, content only on stdin
 * and stdout; nothing here logs a path or a byte of content.
 */

export interface FilesQuota {
  /** Refuses (`disk_full`) when `incoming` bytes do not fit under the bot's soft quota; called before any write. */
  assertRoom(target: SandboxdTarget, incoming: number): Promise<void>;
  /** Re-measures after a delete, so a `disk_full` sandbox clears once enough is gone. */
  afterChange(target: SandboxdTarget): Promise<void>;
}

export interface FilesDeps {
  sandboxes: Pick<Sandboxes, "workspace" | "run">;
  quota: FilesQuota;
}

export interface Files {
  list(input: SandboxdFilesList): Promise<SandboxFileList>;
  stat(input: SandboxdFilePathRequest): Promise<SandboxFileEntry>;
  read(input: SandboxdFilesRead): Promise<AgentChannelSandboxReadResponse>;
  write(input: SandboxdFilesWrite): Promise<AgentChannelSandboxWriteResponse>;
  remove(input: SandboxdFilesDelete): Promise<AgentChannelSandboxDeleteResponse>;
  /** People's upload and the F-8 import: the decoded bytes stream into the helper's stdin, no temp file here. */
  upload(input: SandboxdFilesUpload): Promise<{ path: string; size: number }>;
  download(input: SandboxdFilePathRequest): Promise<SandboxdFilesDownload>;
}

/** `ocw-files` exit codes (infra/sandbox/sbx/ocw-files). */
export const HELPER_EXIT = {
  ok: 0,
  usage: 2,
  outside: 3,
  notFound: 4,
  exists: 5,
  wrongKind: 6,
  notEmpty: 7,
  failed: 8,
} as const;

/** Upload, import and download may take longer than a listing. */
const TRANSFER_TIMEOUT_MS = 300_000;

function helperFailure(code: number): SandboxdFailure {
  switch (code) {
    case HELPER_EXIT.outside:
      return new SandboxdFailure("invalid_path", 422, "the path is outside the workspace");
    case HELPER_EXIT.wrongKind:
      return new SandboxdFailure("invalid_path", 422, "the path names the wrong kind of entry");
    case HELPER_EXIT.notFound:
      return new SandboxdFailure("not_found", 404, "no such file or folder");
    case HELPER_EXIT.exists:
      return new SandboxdFailure("exists", 409, "the file exists");
    case HELPER_EXIT.notEmpty:
      return new SandboxdFailure("busy", 409, "the folder is not empty");
    default:
      return new SandboxdFailure("docker_unavailable", 500, "the file operation failed");
  }
}

const tooLarge = () => new SandboxdFailure("too_large", 413, "the content is too large");

/** `ocw-files` mtimes are `%T@` (seconds with a fraction). */
function isoOf(seconds: string): string {
  const s = Number.parseFloat(seconds);
  return new Date(Number.isFinite(s) && s >= 0 ? Math.round(s * 1000) : 0).toISOString();
}

const utf8Strict = new TextDecoder("utf-8", { fatal: true });

/** Text is valid UTF-8 without NUL; anything else goes as base64. */
function asText(bytes: Buffer): string | null {
  if (bytes.includes(0)) return null;
  try {
    return utf8Strict.decode(bytes);
  } catch {
    return null;
  }
}

function joinPath(dir: string, name: string): string {
  return dir === "" ? name : `${dir}/${name}`;
}

function baseName(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? path : path.slice(i + 1);
}

/** Bytewise order, folders first (the people's tree and the bot see the same order). */
function compareEntries(a: SandboxFileEntry, b: SandboxFileEntry): number {
  if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
  return Buffer.compare(Buffer.from(a.name), Buffer.from(b.name));
}

/** One `name/kind/size/mtime` record; names never contain `/`. */
function parseRecord(dir: string, rec: string): SandboxFileEntry | null {
  const parts = rec.split("/");
  if (parts.length !== 4) return null;
  const [rawName, kind, size, mtime] = parts as [string, string, string, string];
  const name = asText(Buffer.from(rawName, "latin1"));
  if (!name || name.length > 255 || name === "." || name === "..") return null;
  const path = joinPath(dir, name);
  if (path.length > SANDBOX_LIMITS.pathMaxChars) return null;
  const isDir = kind === "d";
  const bytes = Number.parseInt(size, 10);
  return {
    path,
    name,
    kind: isDir ? "dir" : "file",
    size: isDir ? null : Number.isFinite(bytes) && bytes >= 0 ? bytes : 0,
    modifiedAt: isoOf(mtime),
    hidden: name.startsWith("."),
  };
}

function decodeContent(content: string, encoding: "utf8" | "base64"): Buffer {
  return encoding === "base64" ? Buffer.from(content, "base64") : Buffer.from(content, "utf8");
}

export function createFiles(deps: FilesDeps): Files {
  const { sandboxes, quota } = deps;

  async function helper(target: SandboxdTarget, args: string[], opts?: RunOptions): Promise<RunResult> {
    const handle = await sandboxes.workspace(target);
    const res = await sandboxes.run(handle, [OCW_FILES, ...args], opts);
    if (res.exitCode !== HELPER_EXIT.ok) throw helperFailure(res.exitCode);
    return res;
  }

  async function writeBytes(
    target: SandboxdTarget,
    path: string,
    bytes: Buffer,
    mode: "create" | "overwrite" | "append",
    timeoutMs?: number,
  ) {
    // The soft quota is checked with the decoded size before the helper starts: a refused write leaves no file.
    await quota.assertRoom(target, bytes.length);
    const res = await helper(target, ["write", path, mode], { stdin: bytes, timeoutMs });
    const size = Number.parseInt(res.stdout.toString("utf8").trim(), 10);
    return { path, size: Number.isFinite(size) && size >= 0 ? size : bytes.length };
  }

  return {
    async list(input) {
      const max = SANDBOX_LIMITS.listMaxEntries;
      const res = await helper(input.target, ["list", input.path, input.hidden ? "1" : "0", String(max)], {
        maxStdout: 4 * 1024 * 1024,
      });
      // Records are NUL-terminated; the first is the total count. Names are bytes: decoded strictly as UTF-8.
      const records = res.stdout.toString("latin1").split("\0");
      const total = Number.parseInt(records.shift() ?? "0", 10);
      const entries: SandboxFileEntry[] = [];
      let seen = 0;
      for (const rec of records) {
        if (rec === "") continue;
        seen += 1;
        const entry = parseRecord(input.path, rec);
        if (entry) entries.push(entry);
      }
      entries.sort(compareEntries);
      const shown = entries.slice(0, max);
      const all = Math.max(Number.isFinite(total) ? total : 0, seen);
      return { path: input.path, entries: shown, more: Math.max(0, all - shown.length) };
    },

    async stat(input) {
      const res = await helper(input.target, ["stat", input.path]);
      const entry = parseRecord(
        input.path.includes("/") ? input.path.slice(0, input.path.lastIndexOf("/")) : "",
        `${Buffer.from(baseName(input.path)).toString("latin1")}/${res.stdout.toString("latin1").trim()}`,
      );
      if (!entry) throw helperFailure(HELPER_EXIT.failed);
      return entry;
    },

    async read(input) {
      const limit = Math.min(input.limit, SANDBOX_LIMITS.readMaxBytes);
      const res = await helper(input.target, ["read", input.path, String(input.offset), String(limit)], {
        maxStdout: limit + 64,
      });
      const newline = res.stdout.indexOf(0x0a);
      if (newline < 0) throw helperFailure(HELPER_EXIT.failed);
      const size = Number.parseInt(res.stdout.subarray(0, newline).toString("utf8"), 10);
      const bytes = res.stdout.subarray(newline + 1, newline + 1 + limit);
      const text = asText(bytes);
      return {
        path: input.path,
        content: text ?? bytes.toString("base64"),
        encoding: text === null ? "base64" : "utf8",
        size: Number.isFinite(size) ? size : bytes.length,
        truncated: input.offset + bytes.length < size,
      };
    },

    async write(input) {
      const bytes = decodeContent(input.content, input.encoding);
      if (bytes.length > SANDBOX_LIMITS.writeMaxBytes) throw tooLarge();
      return writeBytes(input.target, input.path, bytes, input.mode);
    },

    async remove(input) {
      const res = await helper(input.target, ["rm", input.path, input.recursive ? "1" : "0"]);
      const deleted = Number.parseInt(res.stdout.toString("utf8").trim(), 10);
      await quota.afterChange(input.target);
      return { path: input.path, deleted: Number.isFinite(deleted) && deleted >= 0 ? deleted : 1 };
    },

    async upload(input) {
      const bytes = Buffer.from(input.data, "base64");
      if (bytes.length > SANDBOX_LIMITS.uploadMaxBytes) throw tooLarge();
      return writeBytes(
        input.target,
        input.path,
        bytes,
        input.overwrite ? "overwrite" : "create",
        TRANSFER_TIMEOUT_MS,
      );
    },

    async download(input) {
      const st = await helper(input.target, ["stat", input.path]);
      const [kind, size] = st.stdout.toString("utf8").trim().split("/");
      if (kind !== "f") throw helperFailure(HELPER_EXIT.wrongKind);
      if (Number.parseInt(size ?? "0", 10) > SANDBOX_LIMITS.uploadMaxBytes) throw tooLarge();
      const res = await helper(input.target, ["cat", input.path], {
        maxStdout: SANDBOX_LIMITS.uploadMaxBytes,
        timeoutMs: TRANSFER_TIMEOUT_MS,
      });
      // The file grew past the limit between stat and cat.
      if (res.overflow) throw tooLarge();
      return {
        path: input.path,
        name: baseName(input.path),
        size: res.stdout.length,
        data: res.stdout.toString("base64"),
      };
    },
  };
}
